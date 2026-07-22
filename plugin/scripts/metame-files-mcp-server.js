#!/usr/bin/env node

'use strict';

/**
 * metame-files-mcp-server.js — the file map + cleanup-suggestion surface.
 *
 * Gives any MCP-capable agent fast local-file location (thin wrappers over
 * Spotlight's system-maintained index — no bespoke index to build or sync)
 * plus cleanup suggestion scans (large / stale / duplicate files) and a
 * strictly gated quarantine pipeline for acting on them:
 *
 *   claude mcp add metame-files -- node ~/.metame/metame-files-mcp-server.js
 *
 * Safety contract:
 *  - discovery and scan tools are read-only; proposal, preview and restore tools
 *    may write private metadata; cleanup_execute is the only cleanup action;
 *  - cleanup_execute takes NO paths — only a batch manifest produced by
 *    cleanup_propose (its raw token is returned once and only its hash is
 *    persisted). Same-volume files move atomically into an opaque quarantine
 *    path and remain restorable; cross-volume candidates fail closed;
 *  - Mole is optional and bounded to `analyze --json` and `clean --dry-run`;
 *    its output never bypasses the native proposal and protection gates;
 *  - deployment discipline: do NOT allowlist cleanup_execute — the host's
 *    per-call permission prompt is the final "user present" gate.
 *
 * Hand-written newline-delimited JSON-RPC (no SDK dependency — repo
 * discipline). Pure logic lives in core/file-map-*.js; this file owns
 * process spawning, fs side effects, and transport only.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const spotlight = require('./core/file-map-spotlight');
const { loadFileMapConfig, expandHome } = require('./core/file-map-config');
const protect = require('./core/file-map-protect');
const overviewCore = require('./core/file-map-overview');
const dupesCore = require('./core/file-map-dupes');
const storageCore = require('./core/file-map-storage');
const manifestCore = require('./core/file-map-manifest');
const auditCore = require('./core/file-map-audit');
const quarantineCore = require('./core/file-map-quarantine');
const executionCore = require('./core/file-map-execution');
const moleCore = require('./core/file-map-mole');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const CONFIG_PATH = path.join(METAME_DIR, 'file-map.yaml');
const DEFAULT_CONFIG_PATH = path.join(__dirname, 'file-map-default.yaml');
const FILE_MAP_DIR = path.join(METAME_DIR, 'file-map');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'metame-files', version: '1.0.0' };

const READ_ONLY = { readOnlyHint: true, destructiveHint: false };
const WRITES_METADATA = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };
const USER_CONSENT_PHRASE = 'USER CONFIRMED';
const EXECUTION_LEASE_MS = 5 * 60 * 1000;

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'file_search',
    description: 'Locate local files instantly via the macOS Spotlight index (no directory walking). Combines keyword/content search with name, kind, recency and size filters. Use this INSTEAD of ls/find when looking for files.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords (matches file names and file CONTENT), or a raw Spotlight expression if it contains kMDItem' },
        name: { type: 'string', description: 'Filename substring match only' },
        root: { type: 'string', description: 'Limit to this directory (default ~)' },
        kind: { type: 'string', enum: ['document', 'image', 'audio', 'video', 'archive', 'code', 'app', 'folder'] },
        modified_within_days: { type: 'number', description: 'Only files modified in the last N days' },
        min_size_mb: { type: 'number', description: 'Only files larger than N MB' },
        limit: { type: 'number', description: 'Max results (default 50, cap 200)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
        count_only: { type: 'boolean', description: 'Return only the match count' },
      },
    },
  },
  {
    name: 'file_overview',
    description: 'The "home map": a compact structural overview (directory tree with sizes, file counts, top file types) of the configured roots. Load this FIRST to understand how the machine\'s files are organized before searching or proposing organization. Cached for 24h; pass refresh:true to rescan.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Map a single directory instead of the configured roots' },
        refresh: { type: 'boolean', description: 'Force a rescan, ignoring the cache' },
        format: { type: 'string', enum: ['markdown', 'json'], description: 'Default markdown (~8KB budget)' },
        depth: { type: 'number', description: 'Directory depth (default from config, cap 4)' },
      },
    },
  },
  {
    name: 'file_last_used',
    description: 'Check when specific files were last opened (Spotlight kMDItemLastUsedDate — the only reliable last-used signal on macOS; APFS atime is not trustworthy). Use to verify staleness before proposing cleanup.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths (max 100)' },
      },
      required: ['paths'],
    },
  },
  {
    name: 'scan_large',
    description: 'Scan for large files under a directory via Spotlight, sorted by size descending. Entries matching the protection list are flagged protected (they cannot be proposed for cleanup).',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to scan (default ~)' },
        min_size_mb: { type: 'number', description: 'Minimum size in MB (default 100)' },
        limit: { type: 'number', description: 'Max results (default 50, cap 200)' },
      },
    },
  },
  {
    name: 'scan_duplicates',
    description: 'Find duplicate files under a directory (uses fclones when installed, otherwise a built-in size→head-hash→full-hash funnel). Groups are sorted by wasted bytes. Report-only — pair with cleanup_propose to act.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to scan (required — full-disk duplicate scans are not allowed)' },
        min_size_mb: { type: 'number', description: 'Minimum file size in MB (default 1)' },
        limit_groups: { type: 'number', description: 'Max groups returned (default 50, cap 200)' },
      },
      required: ['root'],
    },
  },
  {
    name: 'scan_stale',
    description: 'Find zombie files: larger than min_size_mb AND not opened for unused_days (or never recorded as used by Spotlight). Each result carries a confidence level — confirmed_stale (last-used date is old) vs never_recorded (no usage data; weaker evidence). Recently modified files are excluded.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Directory to scan (default ~)' },
        unused_days: { type: 'number', description: 'Staleness threshold in days (default 180)' },
        min_size_mb: { type: 'number', description: 'Minimum size in MB (default 10)' },
        limit: { type: 'number', description: 'Max results (default 50, cap 200)' },
      },
    },
  },
  {
    name: 'storage_assess',
    description: 'Read-only macOS storage assessment: disk baseline, Time Machine snapshots, categorized storage footprints, running-app/tool guards, cloud warnings, and an optional low-risk-first plan for a target reclaim amount. It never moves, deletes, prunes, or clears anything.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        target_reclaim_gb: { type: 'number', description: 'Optional amount of space to plan for reclaiming; the plan is advisory and never authorizes cleanup' },
        min_report_mb: { type: 'number', description: 'Hide measured categories below this size (default 500 MB; target planning still considers them)' },
        du_budget_seconds: { type: 'number', description: 'Maximum wall-clock budget for category sizing (default 45s, cap 120s)' },
        include_mole_analysis: { type: 'boolean', description: 'Optionally augment the native assessment with read-only `mo analyze --json` output' },
        mole_root: { type: 'string', description: 'Root passed to Mole analysis (default ~; must stay inside configured roots)' },
      },
    },
  },
  {
    name: 'mole_cleanup_preview',
    description: 'Run the fixed non-destructive command `mo clean --dry-run`, then normalize its fresh clean-list for review. This tool never installs Mole, never runs a real cleanup, and never auto-proposes candidates.',
    annotations: WRITES_METADATA,
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Run a new dry-run before reading the list (default true)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
        limit: { type: 'number', description: 'Candidates returned (default 100, cap 200/config cap)' },
      },
    },
  },
  {
    name: 'cleanup_propose',
    description: 'Stage a cleanup batch: candidate paths are validated against the hard protection net (system dirs, ~/Library, .git, recently-modified, symlinks, roots containment), snapshotted (size/mtime/inode) and written to a manifest with a one-time token. NOTHING is moved or deleted. Present the returned summary to the user; only after their explicit consent may cleanup_execute be called.',
    annotations: WRITES_METADATA,
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of cleanup candidates' },
        reason: { type: 'string', description: 'Why these files should go — shown to the user and audited' },
        source: { type: 'string', enum: ['scan_large', 'scan_stale', 'scan_duplicates', 'manual'] },
      },
      required: ['paths', 'reason'],
    },
  },
  {
    name: 'cleanup_execute',
    description: 'Execute a previously proposed batch. Takes NO paths — only the batch_id + one-time token from cleanup_propose, plus confirm:"USER CONFIRMED" (only pass this after the user explicitly approved the presented batch). Every item is re-verified against its snapshot; drifted items are skipped. Same-volume files are atomically moved to recoverable quarantine; cross-volume candidates are skipped. Undo quarantined items with cleanup_restore.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'From cleanup_propose' },
        token: { type: 'string', description: 'One-time token from cleanup_propose' },
        confirm: { type: 'string', description: 'Must be exactly "USER CONFIRMED" — asserts the user saw the batch and consented' },
      },
      required: ['batch_id', 'token', 'confirm'],
    },
  },
  {
    name: 'cleanup_restore',
    description: 'Restore an executed batch (or a subset of its paths) from quarantine back to the original locations. If a target path is occupied, the file is restored alongside it with a .restored-<ts> suffix.',
    annotations: WRITES_METADATA,
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional subset of original paths to restore' },
      },
      required: ['batch_id'],
    },
  },
  {
    name: 'cleanup_status',
    description: 'Read-only view of the cleanup pipeline: pending proposals (with expiry), in-flight executions, executed batches (restorable or not), quarantine footprint, batches past retention (purge-due), external tool availability, and optionally the audit tail.',
    annotations: READ_ONLY,
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'Show one batch in full detail' },
        audit_tail: { type: 'number', description: 'Also return the last N audit records (max 100)' },
      },
    },
  },
  {
    name: 'cleanup_purge',
    description: 'Move quarantined batches that are past their retention window to the macOS Trash (final deletion only ever happens when the user empties the Trash). Requires an explicit batch_id or all_due:true — check purge_due in cleanup_status first and confirm with the user.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: { type: 'string', description: 'Purge one executed batch' },
        all_due: { type: 'boolean', description: 'Purge every batch past retention' },
      },
    },
  },
];

// ── Process helpers (side effects live here, not in core/) ───────────────────

/**
 * Spawn a command and collect separator-delimited lines from stdout only
 * (mdfind writes parser noise to stderr). Kills the child as soon as `limit`
 * lines are collected or `timeoutMs` elapses, returning what was gathered.
 */
function runLines(cmd, args, { limit = 1000, timeoutMs = 15000, sep = '\0' } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      resolve({ lines: [], truncated: false, error: err.message });
      return;
    }
    const lines = [];
    let buf = '';
    let settled = false;
    let truncated = false;
    let error = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!truncated && buf) {
        for (const part of buf.split(sep)) if (part) lines.push(part);
      }
      resolve({ lines, truncated, error });
    };
    const timer = setTimeout(() => {
      truncated = 'timeout';
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      settle();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf(sep)) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line) lines.push(line);
        if (lines.length >= limit) {
          truncated = 'limit';
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
          settle();
          return;
        }
      }
    });
    child.on('error', (err) => { error = err.message; settle(); });
    child.on('close', () => settle());
  });
}

/** Capture full stdout of a short command (mdls, mdfind -count, du). */
function runCapture(cmd, args, { timeoutMs = 20000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (err, stdout) => {
      resolve({ stdout: stdout || '', error: err ? err.message : null });
    });
  });
}

// ── Handler helpers ──────────────────────────────────────────────────────────

function clamp(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function statSafe(fsx, p) {
  try {
    const st = fsx.statSync(p);
    return { size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() };
  } catch {
    return null;
  }
}

function enrichPath(fsx, p) {
  const st = statSafe(fsx, p);
  if (!st) return { path: p, size: null, mtime: null, stat_error: true };
  return { path: p, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
}

/** sha256 of the first `bytes` of a file — cheap collision filter before full hashing. */
async function hashHead(p, bytes) {
  const fh = await fs.promises.open(p, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
  } finally {
    await fh.close();
  }
}

/** Streaming sha256 of the whole file. */
function hashFull(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(p);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** One mdls spawn resolves kMDItemLastUsedDate for many paths (NUL-separated -raw output). */
async function batchLastUsed(deps, paths) {
  if (!paths.length) return [];
  const { stdout } = await deps.runCapture(
    'mdls',
    ['-name', 'kMDItemLastUsedDate', '-raw', '-nullMarker', '(null)', ...paths],
    { timeoutMs: 20000 }
  );
  return spotlight.parseMdlsRaw(stdout, paths.length).map(spotlight.parseSpotlightDate);
}

function readJsonSafe(fsx, p) {
  try { return JSON.parse(fsx.readFileSync(p, 'utf8')); } catch { return null; }
}

function ensurePrivateDir(fsx, dir) {
  fsx.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (typeof fsx.chmodSync === 'function') fsx.chmodSync(dir, 0o700);
}

/** Unique tmp + fsync + rename. Manifest callers use strict mode. */
function writeJsonAtomic(fsx, p, data, { strict = false } = {}) {
  let tmp = null;
  try {
    ensurePrivateDir(fsx, path.dirname(p));
    tmp = `${p}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const payload = JSON.stringify(data);
    if (typeof fsx.openSync === 'function') {
      const fd = fsx.openSync(tmp, 'wx', 0o600);
      try {
        fsx.writeFileSync(fd, payload);
        if (typeof fsx.fsyncSync === 'function') fsx.fsyncSync(fd);
      } finally {
        fsx.closeSync(fd);
      }
    } else {
      fsx.writeFileSync(tmp, payload, { flag: 'wx', mode: 0o600 });
    }
    fsx.renameSync(tmp, p);
    if (typeof fsx.chmodSync === 'function') fsx.chmodSync(p, 0o600);
    return true;
  } catch (err) {
    if (tmp) {
      try { fsx.unlinkSync(tmp); } catch { /* best effort */ }
    }
    if (strict) throw err;
    return false;
  }
}

/** `du -sk` over dirs, concurrency 4, hard wall-clock budget; late dirs stay unsized. */
async function runDuBatch(deps, dirs, budgetSeconds) {
  const deadline = deps.now() + budgetSeconds * 1000;
  const sizes = new Map();
  const queue = [...dirs];
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const dir = queue.shift();
      const remaining = deadline - deps.now();
      if (remaining <= 0) return;
      const { stdout } = await deps.runCapture('du', ['-sk', '-x', dir], { timeoutMs: remaining });
      const kb = overviewCore.parseDuKb(stdout);
      if (kb != null) sizes.set(dir, kb);
    }
  });
  await Promise.all(workers);
  return sizes;
}

async function buildOverview(deps, cfg, roots, depth) {
  const started = deps.now();
  const structure = overviewCore.scanStructure(
    { fsx: deps.fsx },
    { roots, depth, excludePatterns: cfg.excludePatterns }
  );
  const duTargets = structure.nodes.filter(n => n.d <= Math.min(2, depth)).map(n => n.p);
  const sizes = await runDuBatch(deps, duTargets, cfg.overview.duBudgetSeconds);
  overviewCore.mergeSizes(structure.nodes, sizes);
  const overview = {
    version: 1,
    generated_at: new Date(deps.now()).toISOString(),
    roots,
    depth,
    duration_ms: deps.now() - started,
    nodes: structure.nodes,
    excluded_hits: structure.excludedHits.slice(0, 50),
  };
  if (structure.truncated) overview.truncated = true;
  return overview;
}

// ── Cleanup pipeline helpers ─────────────────────────────────────────────────

function existsL(fsx, p) {
  try { fsx.lstatSync(p); return true; } catch { return false; }
}

function isAssessablePath(deps, cfg, p) {
  if (!protect.isWithinRoots(p, cfg.roots)) return false;
  try {
    const st = deps.fsx.lstatSync(p);
    if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return false;
    const real = typeof deps.fsx.realpathSync === 'function' ? deps.fsx.realpathSync(p) : p;
    return protect.isWithinRoots(real, cfg.roots);
  } catch {
    return false;
  }
}

function auditEvent(deps, record) {
  const file = manifestCore.manifestPaths(deps.fileMapDir).audit;
  try { ensurePrivateDir(deps.fsx, deps.fileMapDir); } catch { /* appendAudit degrades */ }
  auditCore.appendAudit({ fsx: deps.fsx }, file, { ts: new Date(deps.now()).toISOString(), ...record });
}

function manifestFile(deps, kind, batchId) {
  return path.join(manifestCore.manifestPaths(deps.fileMapDir)[kind], `${batchId}.json`);
}

function readManifest(deps, kind, batchId) {
  return readJsonSafe(deps.fsx, manifestFile(deps, kind, batchId));
}

function writeManifest(deps, kind, manifest) {
  writeJsonAtomic(deps.fsx, manifestFile(deps, kind, manifest.batch_id), manifest, { strict: true });
}

function listManifests(deps, kind) {
  const dir = manifestCore.manifestPaths(deps.fileMapDir)[kind];
  let names = [];
  try { names = deps.fsx.readdirSync(dir); } catch { return []; }
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => readJsonSafe(deps.fsx, path.join(dir, n)))
    .filter(m => m && manifestCore.isValidBatchId(m.batch_id));
}

/** Delete expired proposal manifests (metadata only — never touches user files). */
function gcExpiredProposals(deps) {
  for (const m of listManifests(deps, 'proposals')) {
    if (!manifestCore.isExpired(m, deps.now())) continue;
    try { deps.fsx.unlinkSync(manifestFile(deps, 'proposals', m.batch_id)); } catch { continue; }
    auditEvent(deps, { event: 'expire', batch_id: m.batch_id });
  }
}

function leaseFile(deps, batchId) {
  return path.join(manifestCore.manifestPaths(deps.fileMapDir).inflight, `${batchId}.lease`);
}

function acquireExecutionLease(deps, batchId) {
  const file = leaseFile(deps, batchId);
  ensurePrivateDir(deps.fsx, path.dirname(file));
  const existed = existsL(deps.fsx, file);
  const old = readJsonSafe(deps.fsx, file);
  const isPidAlive = deps.isPidAlive || (() => false);
  if (old && !executionCore.canReclaimLease(old, {
    nowMs: deps.now(), leaseMs: EXECUTION_LEASE_MS, isPidAlive,
  })) {
    return { ok: false, error: 'execution-in-progress' };
  }
  if (existed && !old) {
    let stale = false;
    try { stale = deps.now() - deps.fsx.statSync(file).mtimeMs > EXECUTION_LEASE_MS; } catch { /* raced */ }
    if (!stale) return { ok: false, error: 'execution-in-progress' };
  }
  if (existed) {
    try { deps.fsx.unlinkSync(file); } catch { return { ok: false, error: 'execution-in-progress' }; }
  }
  const lease = { pid: deps.pid || process.pid, started_ms: deps.now() };
  try {
    deps.fsx.writeFileSync(file, JSON.stringify(lease), { flag: 'wx', mode: 0o600 });
    if (typeof deps.fsx.chmodSync === 'function') deps.fsx.chmodSync(file, 0o600);
    return { ok: true, file };
  } catch (err) {
    if (err.code === 'EEXIST') return { ok: false, error: 'execution-in-progress' };
    throw err;
  }
}

function releaseExecutionLease(deps, batchId) {
  try { deps.fsx.unlinkSync(leaseFile(deps, batchId)); } catch { /* process crash leaves the lease for recovery */ }
}

function renameSameVolume(fsx, from, to, { privateParent = false } = {}) {
  const parent = path.dirname(to);
  if (privateParent) ensurePrivateDir(fsx, parent);
  else fsx.mkdirSync(parent, { recursive: true });
  const sourceDev = fsx.lstatSync(from).dev;
  const targetDev = fsx.statSync(parent).dev;
  if (sourceDev != null && targetDev != null && sourceDev !== targetDev) {
    const err = new Error('cross-device-quarantine-disabled');
    err.code = 'EXDEV';
    throw err;
  }
  try {
    fsx.renameSync(from, to);
  } catch (err) {
    if (err.code === 'EXDEV') throw Object.assign(new Error('cross-device-quarantine-disabled'), { code: 'EXDEV' });
    throw err;
  }
}

function validateRestoreTarget(deps, cfg, target) {
  const syntax = protect.validatePathSyntax(target);
  if (!syntax.ok) return syntax;
  if (protect.findProtectedMatch(target, cfg.protectedPatterns)) return { ok: false, rule: 'protected-target' };
  let ancestor = path.dirname(target);
  while (!existsL(deps.fsx, ancestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) return { ok: false, rule: 'missing-root-ancestor' };
    ancestor = next;
  }
  let real;
  try { real = deps.fsx.realpathSync(ancestor); } catch { return { ok: false, rule: 'unresolvable-ancestor' }; }
  if (real !== ancestor) return { ok: false, rule: 'symlink-ancestor' };
  const within = cfg.roots.some(root => real === root || protect.isWithinRoots(real, [root]));
  if (!within) return { ok: false, rule: 'outside-roots' };
  if (protect.findProtectedMatch(real, cfg.protectedPatterns)) return { ok: false, rule: 'protected-ancestor' };
  return { ok: true };
}

async function trashViaFinder(deps, p) {
  const script = `tell application "Finder" to delete POSIX file ${JSON.stringify(p)}`;
  const { error } = await deps.runCapture('osascript', ['-e', script], { timeoutMs: 15000 });
  if (error) throw new Error(`Finder trash failed: ${error}`);
}

/** Move every still-valid item of a confirmed manifest into quarantine (or Trash). */
async function executeManifest(deps, cfg, manifest) {
  const io = { lstatSync: p => deps.fsx.lstatSync(p), realpathSync: p => deps.fsx.realpathSync(p), now: deps.now };
  const qroot = manifestCore.manifestPaths(deps.fileMapDir).quarantine;
  for (const item of manifest.items) {
    if (item.result === 'moved' || item.result === 'trashed' || String(item.result || '').startsWith('skipped:')) continue;
    const dest = manifest.method === 'quarantine'
      ? quarantineCore.quarantinePathFor(qroot, manifest.batch_id, item.path)
      : null;
    if (item.result === 'moving') {
      const recovery = executionCore.reconcileMoving({
        sourceExists: existsL(deps.fsx, item.path),
        destinationExists: dest ? existsL(deps.fsx, dest) : false,
        method: manifest.method,
      });
      if (recovery.action === 'complete') {
        item.result = recovery.result;
        if (recovery.result === 'moved') item.quarantine_path = dest;
        writeManifest(deps, 'inflight', manifest);
        auditEvent(deps, { event: 'execute', batch_id: manifest.batch_id, path: item.path, outcome: `recovered:${recovery.result}` });
        continue;
      }
      if (recovery.action === 'conflict') {
        item.result = `skipped:recovery-${recovery.reason}`;
        writeManifest(deps, 'inflight', manifest);
        auditEvent(deps, { event: 'skip', batch_id: manifest.batch_id, path: item.path, outcome: recovery.reason });
        continue;
      }
    }
    const recheck = protect.checkPath(item.path, cfg, io);
    let reason = null;
    if (!recheck.ok) reason = recheck.rule;
    else {
      const drift = manifestCore.verifyItemUnchanged(item, recheck.stat);
      if (!drift.ok) reason = drift.reason;
    }
    if (reason) {
      item.result = `skipped:${reason}`;
      writeManifest(deps, 'inflight', manifest);
      auditEvent(deps, { event: 'skip', batch_id: manifest.batch_id, path: item.path, outcome: reason });
      continue;
    }
    try {
      item.result = 'moving';
      if (dest) item.quarantine_path = dest;
      writeManifest(deps, 'inflight', manifest);
      if (manifest.method === 'trash') {
        await trashViaFinder(deps, item.path);
        item.result = 'trashed';
      } else {
        renameSameVolume(deps.fsx, item.path, dest, { privateParent: true });
        item.result = 'moved';
      }
      writeManifest(deps, 'inflight', manifest);
      auditEvent(deps, {
        event: 'execute', batch_id: manifest.batch_id, path: item.path, outcome: item.result,
        bytes: item.size, method: manifest.method, dest: item.quarantine_path || 'trash',
      });
    } catch (err) {
      item.result = `skipped:${err.code === 'EXDEV' ? 'cross-device-quarantine-disabled' : err.message}`;
      writeManifest(deps, 'inflight', manifest);
      auditEvent(deps, { event: 'execute', batch_id: manifest.batch_id, path: item.path, outcome: 'error', error: err.message });
    }
  }
  return executionCore.summarizeExecution(manifest.items);
}

async function probeTools(deps) {
  const out = {};
  for (const [name, hint] of [
    ['fclones', 'brew install fclones'], ['gdu', 'brew install gdu'], ['mo', 'brew install mole'],
  ]) {
    const { error } = await deps.runCapture(name, ['--version'], { timeoutMs: 3000 });
    out[name] = error ? { available: false, install: hint } : { available: true };
  }
  return out;
}

async function probeMaintenanceTools(deps) {
  const pairs = await Promise.all(storageCore.MAINTENANCE_TOOLS.map(async spec => {
    const { error } = await deps.runCapture(spec.name, spec.args, { timeoutMs: 3000 });
    return [spec.name, { available: !error }];
  }));
  return Object.fromEntries(pairs);
}

async function probeMole(deps) {
  const { stdout, error } = await deps.runCapture('mo', ['--version'], { timeoutMs: 5000 });
  if (error) return { available: false, error, install: 'brew install mole' };
  return { available: true, version: String(stdout || '').trim() || 'unknown' };
}

function validateMoleRoot(deps, cfg, requested) {
  const root = expandHome(String(requested || '~'), deps.home);
  const syntax = protect.validatePathSyntax(root);
  if (!syntax.ok) return { ok: false, error: syntax.rule };
  let st;
  try { st = deps.fsx.lstatSync(root); } catch { return { ok: false, error: 'missing-root' }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: 'root-must-be-real-directory' };
  let real;
  try { real = deps.fsx.realpathSync(root); } catch { return { ok: false, error: 'unresolvable-root' }; }
  if (real !== root) return { ok: false, error: 'symlink-ancestor' };
  const inside = cfg.roots.some(base => root === base || protect.isWithinRoots(root, [base]));
  return inside ? { ok: true, root } : { ok: false, error: 'outside-roots' };
}

async function collectMoleAnalysis(args, deps, cfg) {
  if (!cfg.mole.enabled) return { available: false, disabled: true };
  const rootCheck = validateMoleRoot(deps, cfg, args.mole_root);
  if (!rootCheck.ok) return { available: false, error: rootCheck.error };
  const probe = await probeMole(deps);
  if (!probe.available) return probe;
  const { stdout, error } = await deps.runCapture(
    'mo', ['analyze', '--json', rootCheck.root], { timeoutMs: cfg.mole.analyzeTimeoutMs }
  );
  if (error && !stdout) return { available: true, version: probe.version, error };
  const parsed = moleCore.parseAnalyzeJson(stdout, { limit: 100 });
  return parsed.ok
    ? { available: true, version: probe.version, ...parsed }
    : { available: true, version: probe.version, error: parsed.error };
}

function normalizeMoleCandidates(paths, deps, cfg) {
  const io = { lstatSync: p => deps.fsx.lstatSync(p), realpathSync: p => deps.fsx.realpathSync(p), now: deps.now };
  const seenIdentity = new Set();
  const candidates = [];
  for (const candidatePath of paths) {
    let st = null;
    try { st = deps.fsx.lstatSync(candidatePath); } catch { /* retained as missing advice */ }
    if (st && st.dev != null && st.ino != null) {
      const identity = `${st.dev}:${st.ino}`;
      if (seenIdentity.has(identity)) continue;
      seenIdentity.add(identity);
    }
    const checked = protect.checkPath(candidatePath, cfg, io);
    const isDirectory = !!(st && st.isDirectory());
    const protectionRule = checked.ok
      ? (isDirectory ? 'directory-not-supported' : null)
      : checked.rule;
    candidates.push({
      path: candidatePath,
      size: st ? st.size : null,
      is_directory: isDirectory,
      protection_rule: protectionRule || undefined,
      pipeline_eligible: checked.ok && !isDirectory,
    });
  }
  return candidates;
}

async function collectMolePreview(args, deps, loaded) {
  const cfg = loaded.config;
  if (!cfg.mole.enabled) return { ok: false, error: 'Mole adapter disabled by configuration' };
  const probe = await probeMole(deps);
  if (!probe.available) return { ok: false, error: 'Mole is not installed', install_hint: probe.install };
  const listFile = path.join(deps.home, '.config', 'mole', 'clean-list.txt');
  const refresh = args.refresh !== false;
  const started = deps.now();
  if (refresh) {
    const { error } = await deps.runCapture('mo', ['clean', '--dry-run'], { timeoutMs: cfg.mole.previewTimeoutMs });
    if (error) return { ok: false, error: `Mole dry-run failed: ${error}` };
  }
  let stat;
  let text;
  try {
    stat = deps.fsx.statSync(listFile);
    text = deps.fsx.readFileSync(listFile, 'utf8');
  } catch {
    return { ok: false, error: 'Mole clean-list is unavailable' };
  }
  if (refresh && stat.mtimeMs < started) return { ok: false, error: 'Mole clean-list was not refreshed' };
  if (!refresh && !moleCore.isPreviewFresh(stat.mtimeMs, deps.now(), cfg.mole.previewTtlMs)) {
    return { ok: false, error: 'Mole clean-list is stale — call with refresh:true' };
  }
  const parsedPaths = moleCore.parseCleanList(text, { limit: cfg.mole.maxReturnedCandidates + 1 });
  const sourceTruncated = parsedPaths.length > cfg.mole.maxReturnedCandidates;
  const candidates = normalizeMoleCandidates(parsedPaths.slice(0, cfg.mole.maxReturnedCandidates), deps, cfg);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const limit = clamp(args.limit, 100, 1, Math.min(200, cfg.mole.maxReturnedCandidates));
  return {
    ok: true,
    available: true,
    version: probe.version,
    source: 'mo clean --dry-run',
    generated_at: new Date(stat.mtimeMs).toISOString(),
    preview_path: listFile,
    total_candidates: candidates.length,
    candidate_cap: cfg.mole.maxReturnedCandidates,
    source_truncated: sourceTruncated || undefined,
    total_bytes: candidates.reduce((sum, item) => sum + (item.size || 0), 0),
    returned: candidates.slice(offset, offset + limit).length,
    truncated: offset + limit < candidates.length || undefined,
    candidates: candidates.slice(offset, offset + limit),
    executable: false,
    note: 'Preview only. Review candidates explicitly; this tool never runs a real Mole cleanup or cleanup_propose.',
    ...(loaded.ok ? {} : { config_warning: loaded.error }),
  };
}

async function collectStorageAssessment(args, deps, loaded) {
  const cfg = loaded.config;
  const fullCatalog = storageCore.buildCatalog(deps.home);
  const catalog = fullCatalog.map(category => ({
    ...category,
    paths: category.paths.filter(p => protect.isWithinRoots(p, cfg.roots)),
  }));
  const outsideRoots = fullCatalog.reduce(
    (sum, category) => sum + category.paths.filter(p => !protect.isWithinRoots(p, cfg.roots)).length,
    0
  );
  const paths = [...new Set(catalog.flatMap(category => category.paths))]
    .filter(p => isAssessablePath(deps, cfg, p));
  const budget = clamp(args.du_budget_seconds, cfg.storage.duBudgetSeconds, 5, 120);
  const [sizes, df, snapshots, processList, externalTools] = await Promise.all([
    runDuBatch(deps, paths, budget),
    deps.runCapture('df', ['-kP', '/'], { timeoutMs: 5000 }),
    deps.runCapture('tmutil', ['listlocalsnapshots', '/'], { timeoutMs: 10000 }),
    deps.runCapture('ps', ['-axo', 'comm='], { timeoutMs: 5000 }),
    probeMaintenanceTools(deps),
  ]);
  const reports = storageCore.buildCategoryReports(catalog, sizes, {
    protectedMatch: p => protect.findProtectedMatch(p, cfg.protectedPatterns),
    runningProcesses: storageCore.parseProcessList(processList.stdout),
  });
  const minReportMb = boundedNumber(args.min_report_mb, cfg.storage.minReportMb, 0, 1024 * 1024);
  const thresholdBytes = minReportMb * 1024 ** 2;
  const categories = reports.filter(category => category.total_bytes >= thresholdBytes && category.total_bytes > 0);
  const targetGb = boundedNumber(args.target_reclaim_gb, 0, 0, 1024 * 1024);
  const targetBytes = targetGb * 1024 ** 3;
  const plan = storageCore.buildTargetPlan(reports, targetBytes, cfg.storage.targetMaxCategories);
  const runningApps = [...new Set(reports.flatMap(category => category.running_apps))].sort();
  const scanHints = reports
    .filter(category => category.scan_hint)
    .filter(category => !category.scan_hint.root
      || protect.isWithinRoots(expandHome(category.scan_hint.root, deps.home), cfg.roots))
    .map(category => ({ category: category.id, ...category.scan_hint }));
  return {
    ok: true,
    generated_at: new Date(deps.now()).toISOString(),
    volume: storageCore.parseDfKb(df.stdout),
    volume_error: df.error || undefined,
    local_snapshots: { available: !snapshots.error, ...storageCore.parseSnapshots(snapshots.stdout) },
    categories,
    scan_hints: scanHints,
    scope: { roots: cfg.roots, outside_root_catalog_paths: outsideRoots },
    report_threshold_mb: minReportMb,
    hidden_categories: reports.filter(category => category.total_bytes > 0 && category.total_bytes < thresholdBytes).length,
    running_apps: runningApps,
    process_check_available: !processList.error,
    external_tools: externalTools,
    target_plan: plan || undefined,
    warnings: [
      'This assessment is read-only. Category totals are estimates and some aggregate categories overlap.',
      'Cloud-synced paths require provider-aware eviction; deleting a synced path may delete the cloud copy.',
      'Tool-native prune commands are not recoverable and are intentionally outside cleanup_execute.',
      processList.error ? 'Running-app guard is unavailable; verify manually that related apps are closed before clearing caches.' : null,
      snapshots.error ? 'Local snapshot status is unavailable; verify Time Machine/APFS snapshots separately.' : null,
      outsideRoots ? `${outsideRoots} catalog paths were not scanned because they are outside configured roots.` : null,
    ].filter(Boolean),
    next_step: 'Review a category, narrow it with scan_large/scan_stale/scan_duplicates, then use cleanup_propose for selected unprotected paths.',
    ...(loaded.ok ? {} : { config_warning: loaded.error }),
  };
}

function defaultDeps() {
  return {
    loadConfig: () => loadFileMapConfig({
      fs,
      yaml: require('./resolve-yaml'),
      home: HOME,
      configPath: CONFIG_PATH,
      defaultPath: DEFAULT_CONFIG_PATH,
    }),
    runLines,
    runCapture,
    fsx: fs,
    hashHead,
    hashFull,
    randomHex: (n) => crypto.randomBytes(n).toString('hex'),
    home: HOME,
    fileMapDir: FILE_MAP_DIR,
    now: () => Date.now(),
    pid: process.pid,
    isPidAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    },
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

const handlers = {
  async file_search(args, deps) {
    const query = args.query ? String(args.query) : '';
    const name = args.name ? String(args.name) : '';
    if (!query && !name) return { ok: false, error: 'provide `query` (keywords/content) or `name` (filename substring)' };
    const limit = clamp(args.limit, 50, 1, 200);
    const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
    const opts = {
      query,
      name,
      root: expandHome(String(args.root || '~'), deps.home),
      kind: args.kind,
      modifiedWithinDays: Number(args.modified_within_days) || 0,
      minSizeMb: Number(args.min_size_mb) || 0,
      countOnly: !!args.count_only,
    };
    const spotArgs = spotlight.buildSearchArgs(opts);
    if (!spotArgs) return { ok: false, error: 'empty search' };
    if (opts.countOnly) {
      const { stdout, error } = await deps.runCapture('mdfind', spotArgs, { timeoutMs: 15000 });
      if (error && !stdout) return { ok: false, error };
      return { ok: true, count: spotlight.parseCount(stdout) };
    }
    const { lines, truncated, error } = await deps.runLines('mdfind', spotArgs, { limit: offset + limit + 1, timeoutMs: 15000 });
    if (error && lines.length === 0) return { ok: false, error };
    const page = lines.slice(offset, offset + limit);
    return {
      ok: true,
      results: page.map(p => enrichPath(deps.fsx, p)),
      returned: page.length,
      truncated: truncated === 'timeout' ? 'timeout' : lines.length > offset + limit,
    };
  },

  async file_overview(args, deps) {
    const loaded = deps.loadConfig();
    const cfg = loaded.config;
    const roots = args.root ? [expandHome(String(args.root), deps.home)] : cfg.roots;
    const depth = clamp(args.depth, cfg.overview.depth, 1, 4);
    const format = args.format === 'json' ? 'json' : 'markdown';
    const cachePath = path.join(deps.fileMapDir, 'overview.json');
    let overview = null;
    let cached = false;
    if (!args.refresh) {
      const prev = readJsonSafe(deps.fsx, cachePath);
      if (prev
        && overviewCore.isCacheFresh(prev, cfg.overview.ttlHours, deps.now())
        && overviewCore.cacheMatchesScope(prev, roots, depth)) {
        overview = prev;
        cached = true;
      }
    }
    if (!overview) {
      overview = await buildOverview(deps, cfg, roots, depth);
      writeJsonAtomic(deps.fsx, cachePath, overview);
    }
    const base = {
      ok: true,
      cached,
      generated_at: overview.generated_at,
      ...(loaded.ok ? {} : { config_warning: loaded.error }),
    };
    if (format === 'json') return { ...base, overview };
    return { ...base, markdown: overviewCore.renderOverviewMarkdown(overview, { budgetBytes: 8192, home: deps.home }) };
  },

  async file_last_used(args, deps) {
    const paths = Array.isArray(args.paths)
      ? args.paths.filter(p => typeof p === 'string' && p.startsWith('/')).slice(0, 100)
      : [];
    if (!paths.length) return { ok: false, error: 'paths: non-empty array of absolute paths required (max 100)' };
    const existing = [];
    const items = paths.map(p => {
      const st = statSafe(deps.fsx, p);
      if (!st) return { path: p, exists: false };
      existing.push(p);
      return { path: p, exists: true, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
    });
    const lastUsed = await batchLastUsed(deps, existing);
    const byPath = new Map(existing.map((p, i) => [p, lastUsed[i]]));
    for (const item of items) {
      if (!item.exists) continue;
      item.last_used = byPath.get(item.path) || null;
      item.last_used_known = !!item.last_used;
    }
    return { ok: true, items, note: 'last_used_known=false means Spotlight has no usage record — weaker staleness evidence, not proof of disuse' };
  },

  async scan_large(args, deps) {
    const loaded = deps.loadConfig();
    const cfg = loaded.config;
    const root = expandHome(String(args.root || '~'), deps.home);
    const minSizeMb = Math.max(1, Number(args.min_size_mb) || 100);
    const limit = clamp(args.limit, 50, 1, 200);
    const query = spotlight.buildLargeQuery({ minSizeMb });
    const [scan, count] = await Promise.all([
      deps.runLines('mdfind', ['-onlyin', root, '-0', query], { limit: 2000, timeoutMs: 30000 }),
      deps.runCapture('mdfind', ['-onlyin', root, '-count', query], { timeoutMs: 30000 }),
    ]);
    if (scan.error && scan.lines.length === 0) return { ok: false, error: scan.error };
    const entries = [];
    for (const p of scan.lines) {
      const st = statSafe(deps.fsx, p);
      if (!st) continue;
      entries.push({
        path: p,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        protected: protect.findProtectedMatch(p, cfg.protectedPatterns) ? true : undefined,
      });
    }
    entries.sort((a, b) => b.size - a.size);
    const results = entries.slice(0, limit);
    return {
      ok: true,
      results,
      returned: results.length,
      total_count: spotlight.parseCount(count.stdout),
      listed_bytes: results.reduce((s, e) => s + e.size, 0),
      truncated: scan.truncated || undefined,
      ...(loaded.ok ? {} : { config_warning: loaded.error }),
    };
  },

  async scan_duplicates(args, deps) {
    if (!args.root) return { ok: false, error: 'root is required — full-disk duplicate scans are not allowed' };
    const loaded = deps.loadConfig();
    const cfg = loaded.config;
    const root = expandHome(String(args.root), deps.home);
    if (!statSafe(deps.fsx, root)) return { ok: false, error: `root not found: ${root}` };
    const minSizeBytes = Math.floor(Math.max(0.1, Number(args.min_size_mb) || 1) * 1024 * 1024);
    const limitGroups = clamp(args.limit_groups, 50, 1, 200);

    let engine = 'builtin';
    let groups = null;
    let truncated = false;
    const probe = await deps.runCapture('fclones', ['--version'], { timeoutMs: 3000 });
    if (!probe.error) {
      const res = await deps.runCapture(
        'fclones',
        ['group', root, '--min-size', String(minSizeBytes), '--format', 'json'],
        { timeoutMs: 120000 }
      );
      const parsed = dupesCore.parseFclonesJson(res.stdout);
      if (parsed) { engine = 'fclones'; groups = parsed; }
    }
    if (!groups) {
      const collected = dupesCore.collectCandidates(
        { fsx: deps.fsx },
        { root, minSizeBytes, excludePatterns: cfg.excludePatterns, maxFiles: 50000 }
      );
      truncated = collected.truncated;
      groups = await dupesCore.buildDuplicateGroups(
        dupesCore.groupBySize(collected.files),
        { hashHead: deps.hashHead, hashFull: deps.hashFull }
      );
    }
    const out = {
      ok: true,
      engine,
      groups: groups.slice(0, limitGroups),
      group_count: groups.length,
      total_wasted_bytes: groups.reduce((s, g) => s + g.wasted_bytes, 0),
      ...(loaded.ok ? {} : { config_warning: loaded.error }),
    };
    if (truncated) {
      out.truncated = true;
      out.note = 'scan capped at 50k files — install fclones (`brew install fclones`) for large trees';
    }
    return out;
  },

  async scan_stale(args, deps) {
    const loaded = deps.loadConfig();
    const cfg = loaded.config;
    const root = expandHome(String(args.root || '~'), deps.home);
    const unusedDays = clamp(args.unused_days, 180, 7, 3650);
    const minSizeMb = Math.max(1, Number(args.min_size_mb) || 10);
    const limit = clamp(args.limit, 50, 1, 200);
    const query = spotlight.buildStaleQuery({ unusedDays, minSizeMb });
    const scan = await deps.runLines('mdfind', ['-onlyin', root, '-0', query], { limit: 2000, timeoutMs: 30000 });
    if (scan.error && scan.lines.length === 0) return { ok: false, error: scan.error };
    const recentCutoff = deps.now() - cfg.protectRecentDays * 24 * 3600 * 1000;
    const entries = [];
    for (const p of scan.lines) {
      const st = statSafe(deps.fsx, p);
      if (!st) continue;
      if (st.mtimeMs > recentCutoff) continue; // recently modified is never a zombie
      entries.push({
        path: p,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
        protected: protect.findProtectedMatch(p, cfg.protectedPatterns) ? true : undefined,
      });
    }
    entries.sort((a, b) => b.size - a.size);
    const results = entries.slice(0, limit);
    const lastUsed = await batchLastUsed(deps, results.map(e => e.path));
    results.forEach((e, i) => {
      e.last_used = lastUsed[i] || null;
      e.confidence = e.last_used ? 'confirmed_stale' : 'never_recorded';
    });
    return {
      ok: true,
      results,
      returned: results.length,
      unused_days: unusedDays,
      truncated: scan.truncated || undefined,
      note: 'never_recorded = no Spotlight usage record (weaker evidence than confirmed_stale); verify with the user before proposing cleanup',
      ...(loaded.ok ? {} : { config_warning: loaded.error }),
    };
  },

  async storage_assess(args, deps) {
    const loaded = deps.loadConfig();
    const assessment = await collectStorageAssessment(args, deps, loaded);
    if (args.include_mole_analysis) {
      assessment.mole_analysis = await collectMoleAnalysis(args, deps, loaded.config);
    }
    return assessment;
  },

  async mole_cleanup_preview(args, deps) {
    return collectMolePreview(args, deps, deps.loadConfig());
  },

  async cleanup_propose(args, deps) {
    const loaded = deps.loadConfig();
    if (!loaded.ok) return { ok: false, error: `config invalid — destructive pipeline disabled: ${loaded.error}` };
    const cfg = loaded.config;
    const paths = Array.isArray(args.paths) ? args.paths.filter(p => typeof p === 'string') : [];
    const reason = String(args.reason || '').trim();
    if (!paths.length) return { ok: false, error: 'paths: non-empty array of absolute paths required' };
    if (reason.length < 5) return { ok: false, error: 'reason: a meaningful justification is required — it is shown to the user and audited' };
    const io = { lstatSync: p => deps.fsx.lstatSync(p), realpathSync: p => deps.fsx.realpathSync(p), now: deps.now };
    const validated = protect.validateCandidates(paths, cfg, io);
    const rejectedDirectories = validated.accepted
      .filter(item => item.isDirectory)
      .map(item => ({ path: item.displayPath || item.path, rule: 'directory-not-supported' }));
    const accepted = validated.accepted.filter(item => !item.isDirectory);
    const rejected = [...validated.rejected, ...rejectedDirectories];
    if (!accepted.length) {
      auditEvent(deps, { event: 'reject', outcome: 'all-rejected', reason, rejected: rejected.length });
      return { ok: false, error: 'no candidate survived the protection checks', rejected };
    }
    const limits = manifestCore.checkBatchLimits(accepted, cfg.cleanup);
    if (!limits.ok) return { ok: false, error: limits.error };
    const created = manifestCore.createManifest({
      items: accepted,
      reason,
      source: args.source,
      method: cfg.cleanup.method,
      nowMs: deps.now(),
      ttlMinutes: cfg.cleanup.proposalTtlMinutes,
      randomHex: deps.randomHex,
    });
    const { manifest, token } = created;
    writeManifest(deps, 'proposals', manifest);
    gcExpiredProposals(deps);
    auditEvent(deps, {
      event: 'propose', batch_id: manifest.batch_id, outcome: 'ok', reason, source: manifest.source,
      count: manifest.totals.count, bytes: manifest.totals.bytes, rejected: rejected.length,
    });
    return {
      ok: true,
      batch_id: manifest.batch_id,
      token,
      proposal_version: manifest.version,
      method: manifest.method,
      accepted: manifest.totals.count,
      total_bytes: manifest.totals.bytes,
      rejected,
      expires_at: manifest.expires_at,
      summary_for_user: manifestCore.summarizeForUser(manifest),
    };
  },

  async cleanup_execute(args, deps) {
    if (!manifestCore.isValidBatchId(args.batch_id)) return { ok: false, error: 'invalid batch_id' };
    if (args.confirm !== USER_CONSENT_PHRASE) {
      return { ok: false, error: `confirm must be exactly "${USER_CONSENT_PHRASE}" — pass it only after the user explicitly approved the presented batch` };
    }
    const loaded = deps.loadConfig();
    if (!loaded.ok) return { ok: false, error: `config invalid — destructive pipeline disabled: ${loaded.error}` };
    const proposed = readManifest(deps, 'proposals', args.batch_id);
    const inflight = proposed ? null : readManifest(deps, 'inflight', args.batch_id);
    const manifest = proposed || inflight;
    const sourceKind = proposed ? 'proposals' : 'inflight';
    if (!manifest) {
      return { ok: false, error: 'unknown, already executed, or expired batch — run cleanup_propose again' };
    }
    if (manifest.version !== 2) {
      return { ok: false, error: 'legacy proposal cannot be executed — run cleanup_propose again' };
    }
    if (!manifestCore.verifyToken(manifest, args.token)) {
      auditEvent(deps, { event: 'execute', batch_id: args.batch_id, outcome: 'token-mismatch' });
      return { ok: false, error: 'token mismatch — use the one-time token returned by cleanup_propose' };
    }
    if (sourceKind === 'proposals' && manifestCore.isExpired(manifest, deps.now())) {
      return { ok: false, error: `proposal expired at ${manifest.expires_at} — re-propose to get a fresh snapshot` };
    }
    const lease = acquireExecutionLease(deps, manifest.batch_id);
    if (!lease.ok) return { ok: false, error: lease.error };
    try {
      if (sourceKind === 'proposals') {
        ensurePrivateDir(deps.fsx, manifestCore.manifestPaths(deps.fileMapDir).inflight);
        try {
          deps.fsx.renameSync(
            manifestFile(deps, 'proposals', manifest.batch_id),
            manifestFile(deps, 'inflight', manifest.batch_id)
          );
        } catch {
          return { ok: false, error: 'proposal claim lost to another execution' };
        }
        manifest.status = 'inflight';
        writeManifest(deps, 'inflight', manifest);
      }
      const summary = await executeManifest(deps, loaded.config, manifest);
      manifest.status = 'executed';
      manifest.executed_at = new Date(deps.now()).toISOString();
      writeManifest(deps, 'inflight', manifest);
      ensurePrivateDir(deps.fsx, manifestCore.manifestPaths(deps.fileMapDir).executed);
      deps.fsx.renameSync(
        manifestFile(deps, 'inflight', manifest.batch_id),
        manifestFile(deps, 'executed', manifest.batch_id)
      );
      return {
        ok: true,
        batch_id: manifest.batch_id,
        method: manifest.method,
        moved: summary.moved,
        skipped: summary.skipped,
        bytes_freed: summary.bytesFreed,
        restore_hint: manifest.method === 'trash'
          ? 'items went to the macOS Trash — restore from the Trash in Finder'
          : `cleanup_restore { batch_id: "${manifest.batch_id}" } undoes this batch`,
      };
    } finally {
      releaseExecutionLease(deps, manifest.batch_id);
    }
  },

  async cleanup_restore(args, deps) {
    if (!manifestCore.isValidBatchId(args.batch_id)) return { ok: false, error: 'invalid batch_id' };
    const loaded = deps.loadConfig();
    if (!loaded.ok) return { ok: false, error: `config invalid — restore disabled: ${loaded.error}` };
    const manifest = readManifest(deps, 'executed', args.batch_id);
    if (!manifest) return { ok: false, error: 'unknown executed batch' };
    const plan = quarantineCore.planRestore(manifest, { paths: args.paths });
    if (!plan.length) {
      return {
        ok: false,
        error: manifest.method === 'trash'
          ? 'this batch went to the macOS Trash — restore it from the Trash in Finder'
          : 'nothing restorable in this batch',
      };
    }
    const restored = [];
    const renamed = [];
    const missing = [];
    const errors = [];
    for (const mv of plan) {
      const item = manifest.items.find(it => it.path === mv.path);
      if (!existsL(deps.fsx, mv.from)) {
        missing.push(mv.path);
        item.result = 'restore-missing';
        auditEvent(deps, { event: 'restore', batch_id: manifest.batch_id, path: mv.path, outcome: 'missing' });
        continue;
      }
      let target = mv.to;
      if (existsL(deps.fsx, target)) {
        target = `${mv.to}.restored-${deps.now()}`;
        renamed.push({ path: mv.path, restored_to: target });
      }
      const targetCheck = validateRestoreTarget(deps, loaded.config, target);
      if (!targetCheck.ok) {
        errors.push({ path: mv.path, error: targetCheck.rule });
        auditEvent(deps, { event: 'restore', batch_id: manifest.batch_id, path: mv.path, outcome: 'error', error: targetCheck.rule });
        continue;
      }
      try {
        renameSameVolume(deps.fsx, mv.from, target);
        item.result = 'restored';
        restored.push(target);
        auditEvent(deps, { event: 'restore', batch_id: manifest.batch_id, path: mv.path, outcome: 'ok', dest: target });
      } catch (err) {
        errors.push({ path: mv.path, error: err.message });
        auditEvent(deps, { event: 'restore', batch_id: manifest.batch_id, path: mv.path, outcome: 'error', error: err.message });
      }
    }
    if (!manifest.items.some(it => it.result === 'moved')) manifest.status = 'restored';
    writeManifest(deps, 'executed', manifest);
    return { ok: true, batch_id: manifest.batch_id, restored: restored.length, renamed, missing, errors };
  },

  async cleanup_status(args, deps) {
    const loaded = deps.loadConfig();
    const cfg = loaded.config;
    if (args.batch_id) {
      if (!manifestCore.isValidBatchId(args.batch_id)) return { ok: false, error: 'invalid batch_id' };
      const m = readManifest(deps, 'proposals', args.batch_id)
        || readManifest(deps, 'inflight', args.batch_id)
        || readManifest(deps, 'executed', args.batch_id);
      if (!m) return { ok: false, error: 'unknown batch' };
      const detail = { ok: true, manifest: manifestCore.redactManifest(m) };
      if (m.status === 'proposed') detail.expired = manifestCore.isExpired(m, deps.now());
      return detail;
    }
    const executedRaw = listManifests(deps, 'executed');
    const brief = (m) => ({
      batch_id: m.batch_id, status: m.status, reason: m.reason, method: m.method,
      count: m.totals.count, bytes: m.totals.bytes,
    });
    const out = {
      ok: true,
      proposals: listManifests(deps, 'proposals').map(m => ({
        ...brief(m), expires_at: m.expires_at, expired: manifestCore.isExpired(m, deps.now()),
      })),
      inflight: listManifests(deps, 'inflight').map(brief),
      executed: executedRaw.map(m => ({
        ...brief(m), executed_at: m.executed_at,
        restorable: m.items.some(it => it.result === 'moved'),
      })),
      quarantine_bytes: executedRaw
        .filter(m => m.status === 'executed')
        .reduce((s, m) => s + m.items.filter(it => it.result === 'moved').reduce((s2, it) => s2 + (it.size || 0), 0), 0),
      purge_due: quarantineCore.planPurge(executedRaw, { quarantineDays: cfg.cleanup.quarantineDays, nowMs: deps.now() }).map(m => m.batch_id),
      external_tools: await probeTools(deps),
    };
    if (args.audit_tail) {
      out.audit = auditCore.readAuditTail(
        { fsx: deps.fsx },
        manifestCore.manifestPaths(deps.fileMapDir).audit,
        clamp(args.audit_tail, 10, 1, 100)
      );
    }
    if (!loaded.ok) out.config_warning = loaded.error;
    return out;
  },

  async cleanup_purge(args, deps) {
    const loaded = deps.loadConfig();
    if (!loaded.ok) return { ok: false, error: `config invalid — destructive pipeline disabled: ${loaded.error}` };
    const cfg = loaded.config;
    const executed = listManifests(deps, 'executed');
    let targets;
    if (args.batch_id) {
      if (!manifestCore.isValidBatchId(args.batch_id)) return { ok: false, error: 'invalid batch_id' };
      targets = executed.filter(m => m.batch_id === args.batch_id && m.status === 'executed');
      if (!targets.length) return { ok: false, error: 'unknown or non-purgeable batch (only executed batches can be purged)' };
    } else if (args.all_due) {
      targets = quarantineCore.planPurge(executed, { quarantineDays: cfg.cleanup.quarantineDays, nowMs: deps.now() });
      if (!targets.length) return { ok: true, purged: [], note: 'no batch is past its retention window' };
    } else {
      return { ok: false, error: 'pass batch_id or all_due:true — check purge_due in cleanup_status first' };
    }
    const qroot = manifestCore.manifestPaths(deps.fileMapDir).quarantine;
    const purged = [];
    const failed = [];
    for (const m of targets) {
      const dir = `${qroot}/${m.batch_id}`;
      try {
        if (existsL(deps.fsx, dir)) await trashViaFinder(deps, dir);
        m.status = 'purged';
        writeManifest(deps, 'executed', m);
        purged.push(m.batch_id);
        auditEvent(deps, { event: 'purge', batch_id: m.batch_id, outcome: 'ok' });
      } catch (err) {
        failed.push({ batch_id: m.batch_id, error: err.message });
        auditEvent(deps, { event: 'purge', batch_id: m.batch_id, outcome: 'error', error: err.message });
      }
    }
    return { ok: true, purged, failed, note: 'purged batches went to the macOS Trash — final deletion only happens when the user empties the Trash' };
  },
};

async function callTool(name, args, deps = defaultDeps()) {
  const handler = handlers[name];
  if (!handler) throw Object.assign(new Error(`unknown tool: ${name}`), { code: -32602 });
  return handler(args || {}, deps);
}

// ── Transport: newline-delimited JSON-RPC over stdio ─────────────────────────

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
  }
  if (String(method || '').startsWith('notifications/')) return null;
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(params && params.name, params && params.arguments);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      if (err && err.code === -32602) return rpcError(id, -32602, err.message);
      return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true });
    }
  }
  if (id !== undefined && id !== null) return rpcError(id, -32601, `method not found: ${method}`);
  return null;
}

function hardenStatePermissions({ fsx, fileMapDir, configPath }) {
  const paths = manifestCore.manifestPaths(fileMapDir);
  ensurePrivateDir(fsx, fileMapDir);
  for (const dir of [paths.proposals, paths.inflight, paths.executed, paths.quarantine]) {
    ensurePrivateDir(fsx, dir);
  }
  for (const dir of [paths.proposals, paths.inflight, paths.executed]) {
    let names = [];
    try { names = fsx.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json') && !name.endsWith('.lease')) continue;
      try { fsx.chmodSync(path.join(dir, name), 0o600); } catch { /* best effort */ }
    }
  }
  for (const file of [paths.audit, path.join(fileMapDir, 'overview.json'), configPath]) {
    try { fsx.chmodSync(file, 0o600); } catch { /* optional or not created yet */ }
  }
}

/** First run: materialize the user config from the deployed template. */
function ensureUserConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(DEFAULT_CONFIG_PATH)) {
      fs.mkdirSync(METAME_DIR, { recursive: true });
      fs.copyFileSync(DEFAULT_CONFIG_PATH, CONFIG_PATH);
    }
    hardenStatePermissions({ fsx: fs, fileMapDir: FILE_MAP_DIR, configPath: CONFIG_PATH });
  } catch { /* best-effort — the loader falls back to the template */ }
}

function startStdioServer() {
  ensureUserConfig();
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try {
        const reply = await handleMessage(msg);
        if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
      } catch (err) {
        if (msg.id !== undefined) process.stdout.write(JSON.stringify(rpcError(msg.id, -32603, err.message)) + '\n');
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (require.main === module) startStdioServer();

module.exports = {
  TOOLS,
  handlers,
  callTool,
  handleMessage,
  _private: {
    defaultDeps, runLines, runCapture, ensureUserConfig, hardenStatePermissions, clamp, statSafe,
    runDuBatch, buildOverview, readJsonSafe, writeJsonAtomic,
    ensurePrivateDir, acquireExecutionLease, releaseExecutionLease, renameSameVolume,
    validateRestoreTarget, executeManifest, gcExpiredProposals, listManifests,
  },
};
