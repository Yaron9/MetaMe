'use strict';

const crypto = require('crypto');
const path = require('path');
const rules = require('./file-map-maintenance-rules');

const DEFAULT_LIMITS = Object.freeze({ maxDepth: 6, maxEntries: 200000, maxMs: 15000, maxCandidates: 5000, limit: 200 });
const SKIP_DIRS = new Set(['.git', '.Trash']);

async function scanMaintenance(deps, options) {
  options = options || {};
  const fsx = deps.fsx;
  const pathx = deps.pathx || path;
  const now = deps.now || Date.now;
  const limits = normalizeLimits(options);
  const state = {
    startedAt: now(),
    now,
    maxMs: limits.maxMs,
    maxEntries: limits.maxEntries,
    visited: 0,
    partial: false,
    seenInodes: new Set(),
  };
  const scanOptions = {
    ...options,
    ...limits,
    recentDays: clamp(options.recentDays, 0, 365, 14),
    minSizeBytes: Math.max(0, Number(options.minSizeBytes) || 0),
    nowMs: state.startedAt,
  };
  const kinds = new Set(scanOptions.kinds || ['artifact', 'installer', 'cache']);
  const all = [];

  for (const root of scanOptions.roots || []) {
    if (budgetSpent(state)) break;
    walkRoot({ fsx, pathx }, root, kinds, scanOptions, state, all);
  }
  if (kinds.has('cache')) {
    scanCaches({ fsx, pathx }, scanOptions.cacheRules || [], scanOptions, state, all);
  }

  if (kinds.has('installer') && deps.listZipEntries) {
    for (const pending of all.filter(item => item._zipPending)) {
      if (budgetSpent(state)) break;
      let entries = null;
      try { entries = await deps.listZipEntries(pending.path, 50); } catch { entries = null; }
      const rule = rules.installerRuleFor(pathx, pending.path, entries);
      if (rule) Object.assign(pending, ruleFields(rule));
    }
  }

  const recentCutoff = state.startedAt - scanOptions.recentDays * 86400000;
  let candidates = all
    .filter(item => !item._zipPending || item.rule_id)
    .map(item => finalizeCandidate(item, recentCutoff))
    .filter(item => scanOptions.includeRecent || !item.recent)
    .filter(item => item.allocated_bytes >= scanOptions.minSizeBytes)
    .sort((a, b) => b.allocated_bytes - a.allocated_bytes || a.path.localeCompare(b.path));
  if (candidates.length > limits.maxCandidates) {
    candidates = candidates.slice(0, limits.maxCandidates);
    state.partial = true;
  }
  const offset = decodeCursor(options.cursor);
  const page = candidates.slice(offset, offset + limits.limit);
  const nextOffset = offset + page.length;
  return {
    candidates: page,
    total: candidates.length,
    partial: state.partial || undefined,
    next_cursor: nextOffset < candidates.length ? encodeCursor(nextOffset) : undefined,
    stats: { visited_entries: state.visited, elapsed_ms: Math.max(0, now() - state.startedAt) },
    _all_candidates: candidates,
  };
}

function walkRoot(io, root, kinds, options, state, out) {
  let canonical;
  try { canonical = io.fsx.realpathSync(root); } catch { return; }
  walk(io, canonical, 0, kinds, options, state, out);
}

function walk(io, current, depth, kinds, options, state, out) {
  if (budgetSpent(state)) return;
  let entries;
  try { entries = io.fsx.readdirSync(current, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (budgetSpent(state)) return;
    state.visited += 1;
    const candidatePath = io.pathx.join(current, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (kinds.has('artifact')) {
        const rule = rules.artifactRuleFor(io.fsx, io.pathx, candidatePath);
        if (rule) {
          const measured = measureTree(io, candidatePath, state);
          out.push(buildCandidate(rule, 'artifact', candidatePath, io.pathx.dirname(candidatePath), measured, options));
          continue;
        }
      }
      if (depth < options.maxDepth) walk(io, candidatePath, depth + 1, kinds, options, state, out);
      continue;
    }
    if (!entry.isFile() || !kinds.has('installer')) continue;
    const extension = io.pathx.extname(candidatePath).toLowerCase();
    const rule = rules.installerRuleFor(io.pathx, candidatePath, null);
    if (!rule && extension !== '.zip') continue;
    const measured = measureFile(io.fsx, candidatePath, state);
    if (!measured) continue;
    const candidate = buildCandidate(rule || {}, 'installer', candidatePath, null, measured, options);
    if (!rule) candidate._zipPending = true;
    out.push(candidate);
  }
}

function scanCaches(io, cacheRules, options, state, out) {
  for (const rule of cacheRules) {
    if (budgetSpent(state)) return;
    let stat;
    try { stat = io.fsx.lstatSync(rule.path); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    const measured = measureTree(io, rule.path, state);
    const candidate = buildCandidate(rule, 'cache', rule.path, null, measured, options);
    const running = (rule.processes || []).filter(name => (options.runningProcesses || []).includes(name.toLowerCase()));
    candidate.active_guard = running.length ? { type: 'running_process', processes: running } : null;
    if (candidate.active_guard) candidate.execution_mode = 'report_only';
    candidate.warning = rule.warning;
    out.push(candidate);
  }
}

function measureTree(io, root, state) {
  const total = { logicalBytes: 0, allocatedBytes: 0, newestMtimeMs: 0, stat: null };
  const visit = current => {
    if (budgetSpent(state)) return;
    let stat;
    try { stat = io.fsx.lstatSync(current); } catch { return; }
    if (stat.isSymbolicLink()) return;
    if (!total.stat) total.stat = stat;
    total.newestMtimeMs = Math.max(total.newestMtimeMs, Number(stat.mtimeMs) || 0);
    if (stat.isFile()) {
      addStat(stat, state, total);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try { entries = io.fsx.readdirSync(current); } catch { return; }
    for (const name of entries) {
      state.visited += 1;
      visit(io.pathx.join(current, name));
      if (budgetSpent(state)) return;
    }
  };
  visit(root);
  return total;
}

function measureFile(fsx, file, state) {
  let stat;
  try { stat = fsx.lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  const total = { logicalBytes: 0, allocatedBytes: 0, newestMtimeMs: Number(stat.mtimeMs) || 0, stat };
  addStat(stat, state, total);
  return total;
}

function addStat(stat, state, total) {
  const identity = `${stat.dev}:${stat.ino}`;
  if (state.seenInodes.has(identity)) return;
  state.seenInodes.add(identity);
  total.logicalBytes += Number(stat.size) || 0;
  total.allocatedBytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : (Number(stat.size) || 0);
}

function buildCandidate(rule, kind, candidatePath, projectRoot, measured, options) {
  const stat = measured.stat || {};
  return {
    candidate_id: candidateId(rule.id, candidatePath, stat),
    kind,
    rule_id: rule.id,
    path: candidatePath,
    project_root: projectRoot || undefined,
    logical_bytes: measured.logicalBytes,
    allocated_bytes: measured.allocatedBytes,
    newest_mtime_ms: measured.newestMtimeMs,
    risk: rule.risk,
    recoverability: rule.recoverability,
    execution_mode: rule.executionMode,
    adapter_id: rule.adapterId,
    active_guard: null,
    reasons: [`matched:${rule.id}`],
    snapshot: {
      size: Number(stat.size) || 0,
      mtimeMs: Number(stat.mtimeMs) || 0,
      ino: stat.ino,
      device: stat.dev,
      isDirectory: !!(stat.isDirectory && stat.isDirectory()),
    },
    _zipPending: false,
    _nowMs: options.nowMs,
  };
}

function ruleFields(rule) {
  return {
    rule_id: rule.id,
    risk: rule.risk,
    recoverability: rule.recoverability,
    execution_mode: rule.executionMode,
    adapter_id: rule.adapterId,
    reasons: [`matched:${rule.id}`],
  };
}

function finalizeCandidate(candidate, recentCutoff) {
  const out = { ...candidate, recent: candidate.newest_mtime_ms >= recentCutoff };
  out.age_days = out.newest_mtime_ms ? Math.max(0, Math.floor((candidate._nowMs - out.newest_mtime_ms) / 86400000)) : null;
  delete out._zipPending;
  delete out._nowMs;
  return out;
}

function candidateId(ruleId, candidatePath, stat) {
  return crypto.createHash('sha256')
    .update([ruleId || 'pending', candidatePath, stat.dev, stat.ino, stat.mtimeMs, stat.size].join('\0'))
    .digest('hex').slice(0, 32);
}

function budgetSpent(state) {
  if (state.visited >= state.maxEntries || state.now() - state.startedAt >= state.maxMs) {
    state.partial = true;
    return true;
  }
  return false;
}

function normalizeLimits(options) {
  return {
    maxDepth: clamp(options.maxDepth, 1, 12, DEFAULT_LIMITS.maxDepth),
    maxEntries: clamp(options.maxEntries, 100, 1000000, DEFAULT_LIMITS.maxEntries),
    maxMs: clamp(options.maxMs, 100, 120000, DEFAULT_LIMITS.maxMs),
    maxCandidates: clamp(options.maxCandidates, 1, 20000, DEFAULT_LIMITS.maxCandidates),
    limit: clamp(options.limit, 1, 500, DEFAULT_LIMITS.limit),
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

function encodeCursor(offset) { return Buffer.from(String(offset)).toString('base64url'); }
function decodeCursor(cursor) {
  if (!cursor) return 0;
  const n = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

module.exports = {
  DEFAULT_LIMITS,
  scanMaintenance,
  _internal: { measureTree, measureFile, candidateId, encodeCursor, decodeCursor, normalizeLimits },
};
