#!/usr/bin/env node

/**
 * MetaMe Session Analytics — canonical evidence analytics.
 *
 * Native session discovery and projection live in Engine Session Source
 * Adapters.  This module keeps the historical state/formatting API while its
 * Claude-facing compatibility calls consume canonical events only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { deriveProjectInfo } = require('./utils');
const { sanitizePrompt, isInternalPrompt } = require('./hooks/hook-utils');
const { createClaudeSessionSourceAdapter, createClaudeSessionSourceForFile } = require('./engines/claude-session-source-adapter');
const {
  makeSkeleton: makeCanonicalSkeleton,
  extractEvidence: canonicalEvidenceFromEvents,
  extractPivotPoints: extractCanonicalPivotPoints,
  detectSignificantSession: detectCanonicalSignificantSession,
} = require('./core/canonical-session-analytics');

const HOME = os.homedir();
const STATE_FILE = path.join(HOME, '.metame', 'analytics_state.json');
const STATE_DB = path.join(HOME, '.metame', 'analytics_state.db');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const MIN_FILE_SIZE = 1024;               // 1KB
const CANONICAL_PIPELINE_VERSION = 'canonical-session-v1';
let _stateDb = null;
let _stmtIsProcessed = null;
let _stmtMarkProcessed = null;
let _stmtIsRevisionProcessed = null;
let _stmtMarkRevisionProcessed = null;

/**
 * Initialize analytics state DB.
 */
function getStateDb() {
  if (_stateDb) return _stateDb;
  const dir = path.dirname(STATE_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  _stateDb = new DatabaseSync(STATE_DB);
  _stateDb.exec('PRAGMA journal_mode = WAL');
  _stateDb.exec('PRAGMA busy_timeout = 3000');
  _stateDb.exec(`
    CREATE TABLE IF NOT EXISTS processed_sessions (
      kind         TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, session_id)
    )
  `);
  _stateDb.exec('CREATE INDEX IF NOT EXISTS idx_processed_kind_ts ON processed_sessions(kind, processed_at)');
  _stateDb.exec(`
    CREATE TABLE IF NOT EXISTS processed_source_revisions (
      kind          TEXT NOT NULL,
      engine_id     TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      pipeline_version TEXT NOT NULL,
      processed_at  INTEGER NOT NULL,
      PRIMARY KEY (kind, engine_id, session_id, source_revision, pipeline_version)
    )
  `);
  _stateDb.exec('CREATE INDEX IF NOT EXISTS idx_processed_source_revision ON processed_source_revisions(kind, processed_at)');
  _stateDb.exec('CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)');
  migrateLegacyStateOnce(_stateDb);
  return _stateDb;
}

/**
 * One-time migration from legacy JSON state file.
 */
function migrateLegacyStateOnce(db) {
  try {
    const migrated = db.prepare("SELECT value FROM state_meta WHERE key = 'legacy_json_migrated'").get();
    if (migrated && migrated.value === '1') return;

    if (fs.existsSync(STATE_FILE)) {
      let raw = null;
      try { raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { raw = null; }
      if (raw && typeof raw === 'object') {
        const insert = db.prepare(`
          INSERT INTO processed_sessions (kind, session_id, processed_at)
          VALUES (?, ?, ?)
          ON CONFLICT(kind, session_id) DO UPDATE SET processed_at = excluded.processed_at
        `);
        const tx = db.transaction(() => {
          for (const [sid, ts] of Object.entries(raw.analyzed || {})) {
            insert.run('analyzed', sid, Number(ts) || Date.now());
          }
          for (const [sid, ts] of Object.entries(raw.facts_analyzed || {})) {
            insert.run('facts_analyzed', sid, Number(ts) || Date.now());
          }
        });
        tx();
      }
    }

    db.prepare("INSERT OR REPLACE INTO state_meta (key, value) VALUES ('legacy_json_migrated', '1')").run();
  } catch {
    // non-fatal
  }
}

function isProcessed(kind, sessionId, sourceRevision = '', pipelineVersion = CANONICAL_PIPELINE_VERSION, engineId = 'claude') {
  if (!kind || !sessionId) return false;
  const db = getStateDb();
  if (sourceRevision) {
    if (!_stmtIsRevisionProcessed) {
      _stmtIsRevisionProcessed = db.prepare(
        `SELECT 1 AS ok FROM processed_source_revisions
         WHERE kind = ? AND engine_id = ? AND session_id = ? AND source_revision = ? AND pipeline_version = ? LIMIT 1`
      );
    }
    const row = _stmtIsRevisionProcessed.get(kind, engineId, sessionId, sourceRevision, pipelineVersion);
    return !!(row && row.ok === 1);
  }
  if (!_stmtIsProcessed) {
    _stmtIsProcessed = db.prepare(
      'SELECT 1 AS ok FROM processed_sessions WHERE kind = ? AND session_id = ? LIMIT 1'
    );
  }
  const row = _stmtIsProcessed.get(kind, sessionId);
  return !!(row && row.ok === 1);
}

/**
 * Mark a session as processed in DB.
 */
function markProcessed(kind, sessionId, sourceRevision = '', pipelineVersion = CANONICAL_PIPELINE_VERSION, engineId = 'claude') {
  if (!sessionId) return;
  const db = getStateDb();
  if (sourceRevision) {
    if (!_stmtMarkRevisionProcessed) {
      _stmtMarkRevisionProcessed = db.prepare(`
        INSERT INTO processed_source_revisions (kind, engine_id, session_id, source_revision, pipeline_version, processed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(kind, engine_id, session_id, source_revision, pipeline_version)
        DO UPDATE SET processed_at = excluded.processed_at
      `);
    }
    _stmtMarkRevisionProcessed.run(kind, engineId, sessionId, sourceRevision, pipelineVersion, Date.now());
    return;
  }
  if (!_stmtMarkProcessed) {
    _stmtMarkProcessed = db.prepare(`
      INSERT INTO processed_sessions (kind, session_id, processed_at)
      VALUES (?, ?, ?)
      ON CONFLICT(kind, session_id) DO UPDATE SET processed_at = excluded.processed_at
    `);
  }
  _stmtMarkProcessed.run(kind, sessionId, Date.now());
}

/**
 * Format skeleton as a compact one-liner for injection into the distill prompt.
 * Target: ~60 tokens.
 */
function formatForPrompt(skeleton) {
  if (!skeleton) return '';

  const toolSummary = Object.entries(skeleton.tool_counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');

  const parts = [];
  if (skeleton.project) {
    const projLabel = skeleton.branch ? `${skeleton.project}@${skeleton.branch}` : skeleton.project;
    parts.push(`Proj=${projLabel}`);
  }
  if (skeleton.duration_min > 0) parts.push(`Duration: ${skeleton.duration_min}min`);
  parts.push(`Messages: ${skeleton.message_count}`);
  if (skeleton.total_tool_calls > 0) parts.push(`Tools: ${skeleton.total_tool_calls} (${toolSummary})`);
  if (skeleton.git_committed) parts.push('Git: committed');
  if (Array.isArray(skeleton.models) && skeleton.models.length > 0) {
    const shortModels = skeleton.models.map(m => {
      if (m.includes('opus')) return 'opus';
      if (m.includes('sonnet')) return 'sonnet';
      if (m.includes('haiku')) return 'haiku';
      return m.split('-')[0];
    });
    parts.push(`Model: ${[...new Set(shortModels)].join(',')}`);
  }

  return parts.join(' | ');
}

function findCodexSessionById(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  for (const dbPath of getKnownCodexDbPaths()) {
    const rows = queryCodexThreadRows(dbPath, sid);
    for (const row of rows) {
      if (!row || row.archived || !row.rollout_path) continue;
      const item = codexSessionFromRolloutPath(String(row.rollout_path), sid);
      if (item) return item;
    }
  }
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) return null;
  const stack = [CODEX_SESSIONS_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.name.endsWith(`-${sid}.jsonl`)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size >= MIN_FILE_SIZE && stat.size <= MAX_FILE_SIZE) {
          return { path: fullPath, session_id: sid, mtime: stat.mtimeMs, engine: 'codex' };
        }
      } catch { /* keep searching */ }
    }
  }
  return null;
}

/**
 * Read declared goals from the user's profile.
 * Returns a compact string like "DECLARED_GOALS: focus1 | focus2" (~11 tokens).
 */
function formatGoalContext(_profilePath) {
  // Work state now lives in NOW.md (task whiteboard), not in the profile.
  try {
    const nowPath = path.join(HOME, '.metame', 'memory', 'NOW.md');
    if (!fs.existsSync(nowPath)) return '';
    const content = fs.readFileSync(nowPath, 'utf8').trim();
    if (!content) return '';
    // Truncate to avoid bloating prompts
    const truncated = content.length > 300 ? content.slice(0, 300) + '…' : content;
    return `CURRENT_TASK:\n${truncated}`;
  } catch { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical Claude compatibility facade
// ─────────────────────────────────────────────────────────────────────────────

let _claudeSource = null;

function getClaudeSource() {
  if (!_claudeSource) _claudeSource = createClaudeSessionSourceAdapter({ home: HOME });
  return _claudeSource;
}

function canonicalInputFromPath(sessionPath) {
  const source = createClaudeSessionSourceForFile(sessionPath, { maxFileSize: MAX_FILE_SIZE });
  const input = source.readEvents();
  const { gitBranch, ...canonicalRevisionContext } = input.revision;
  const context = {
    ...canonicalRevisionContext,
    engine: 'claude',
    // Keep native revision keys at the Claude compatibility edge. The
    // canonical analytics core only consumes the stable `branch` field.
    branch: gitBranch || null,
    source: input.revision.classification === 'subagent' ? 'subagent' : 'claude',
    nativeSessionId: input.ref.nativeSessionId,
    sourceRevision: input.revision.sourceRevision,
    sourceLocator: input.ref.sourceLocator,
  };
  return {
    path: sessionPath,
    ref: input.ref,
    revision: input.revision,
    events: input.events,
    skeleton: makeCanonicalSkeleton(input.events, context),
    evidence: canonicalEvidenceFromEvents(input.events, 3000),
  };
}

function sourceRefPath(source, ref) {
  try { return source.resolveSessionRefPath(ref); } catch { return null; }
}

function canonicalClaudeRefs({ includeSubagents = true, limit = 1000 } = {}) {
  const source = getClaudeSource();
  const refs = source.listSessionRefs({ includeSubagents, limit });
  return refs.map(ref => {
    const filePath = sourceRefPath(source, ref);
    if (!filePath) return null;
    let revision;
    try { revision = source.inspectPath(filePath); } catch { return null; }
    return {
      path: filePath,
      session_id: ref.nativeSessionId,
      mtime: revision.lastModified ? Date.parse(revision.lastModified) : 0,
      engine: 'claude',
      ref,
      revision,
    };
  }).filter(Boolean);
}

function dedupeParentSessions(items) {
  const parentIds = new Set(items.map(item => item.session_id));
  return items.filter(item => {
    const parentId = item && item.ref && item.ref.parentNativeSessionId;
    return !parentId || !parentIds.has(parentId);
  });
}

function findLatestCanonicalSession() {
  const items = dedupeParentSessions(canonicalClaudeRefs({ includeSubagents: true }))
    .filter(item => !isProcessed('analyzed', item.session_id, item.revision.sourceRevision));
  items.sort((a, b) => b.mtime - a.mtime);
  return items[0] || null;
}

function findAllCanonicalSessions(kind, limit = 30) {
  const items = dedupeParentSessions(canonicalClaudeRefs({ includeSubagents: true }))
    .filter(item => !isProcessed(kind, item.session_id, item.revision.sourceRevision));
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, limit);
}

function markCanonicalProcessed(kind, sessionId, sourceRevision = '') {
  markProcessed(kind, sessionId, sourceRevision, CANONICAL_PIPELINE_VERSION, 'claude');
}

function extractCanonicalSkeleton(input) {
  if (typeof input === 'string') return canonicalInputFromPath(input).skeleton;
  if (Array.isArray(input)) return makeCanonicalSkeleton(input);
  if (input && Array.isArray(input.events)) return makeCanonicalSkeleton(input.events, input.context || input);
  return makeCanonicalSkeleton([], input || {});
}

function extractCanonicalEvidence(input, budget = 3000) {
  if (typeof input === 'string') return extractCanonicalEvidenceFromPath(input, budget);
  if (Array.isArray(input)) return canonicalEvidenceFromEvents(input, budget);
  return canonicalEvidenceFromEvents(input && input.events, budget);
}

function extractCanonicalEvidenceFromPath(sessionPath, budget) {
  const input = canonicalInputFromPath(sessionPath);
  return canonicalEvidenceFromEvents(input.events, budget);
}

function extractCanonicalPivots(input) {
  if (typeof input === 'string') return extractCanonicalPivotPoints(canonicalInputFromPath(input).events);
  if (Array.isArray(input)) return extractCanonicalPivotPoints(input);
  return extractCanonicalPivotPoints(input && input.events);
}

function summarizeCanonicalSession(skeleton, sourceInput, evidence = null) {
  if (!skeleton || skeleton.duration_min < 20 || skeleton.total_tool_calls < 15) return null;
  const pivots = skeleton.engine === 'codex'
    ? (evidence && Array.isArray(evidence.tool_traces) ? evidence.tool_traces.slice(-3) : [])
    : extractCanonicalPivots(sourceInput);
  return {
    intent: skeleton.intent || skeleton.user_snippets?.[0] || 'Unknown',
    pivots: pivots.slice(0, 3),
    outcome: skeleton.engine === 'codex'
      ? (evidence && evidence.key_results && evidence.key_results.length ? evidence.key_results.at(-1).slice(0, 160) : 'exploratory')
      : (skeleton.git_committed ? 'committed' : 'exploratory'),
  };
}

function findCanonicalSessionById(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  return canonicalClaudeRefs({ includeSubagents: true, limit: 1000 })
    .find(item => item.session_id === id) || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Codex session adapter
// Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (first line only, ~1KB)
// and ~/.codex/history.jsonl (user messages).  Reuses the same state DB with
// a 'codex_facts' key to avoid collisions with Claude session IDs.
// ─────────────────────────────────────────────────────────────────────────────

const CODEX_SESSIONS_ROOT  = path.join(HOME, '.codex', 'sessions');
const CODEX_HISTORY_FILE   = path.join(HOME, '.codex', 'history.jsonl');
const CODEX_GLOBAL_DB      = path.join(HOME, '.codex', 'state_5.sqlite');
const DAEMON_STATE_FILE    = path.join(HOME, '.metame', 'daemon_state.json');
// Matches: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl  (colons replaced with dashes)
const CODEX_ROLLOUT_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

function codexSessionFromRolloutPath(fullPath, fallbackId = '') {
  if (!fullPath) return null;
  const m = path.basename(fullPath).match(CODEX_ROLLOUT_PATTERN);
  const sessionId = fallbackId || (m && m[1]) || '';
  if (!sessionId) return null;
  try {
    const stat = fs.statSync(fullPath);
    if (stat.size < MIN_FILE_SIZE || stat.size > MAX_FILE_SIZE) return null;
    return { path: fullPath, session_id: sessionId, mtime: stat.mtimeMs, engine: 'codex' };
  } catch {
    return null;
  }
}

function loadDaemonSessionCwds() {
  const out = new Set();
  try {
    const raw = JSON.parse(fs.readFileSync(DAEMON_STATE_FILE, 'utf8'));
    const sessions = raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    for (const session of Object.values(sessions)) {
      if (!session || typeof session !== 'object' || !session.cwd) continue;
      out.add(path.resolve(String(session.cwd)));
    }
  } catch { /* optional */ }
  return [...out];
}

function getKnownCodexDbPaths() {
  const out = [];
  const seen = new Set();
  const add = (candidate) => {
    const value = String(candidate || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  add(CODEX_GLOBAL_DB);
  for (const cwd of loadDaemonSessionCwds()) {
    add(path.join(cwd, '.codex', 'state_5.sqlite'));
  }
  return out;
}

function queryCodexThreadRows(dbPath, sessionId = '') {
  let db = null;
  try {
    if (!fs.existsSync(dbPath)) return [];
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readonly: true });
    const sql = `
      SELECT id, rollout_path, updated_at, created_at, archived
      FROM threads
      ${sessionId ? 'WHERE id = ?' : ''}
      ORDER BY updated_at DESC
      LIMIT 500
    `;
    const rows = sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all();
    db.close();
    db = null;
    return rows || [];
  } catch {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    return [];
  }
}

function findCodexSessionsFromStateDb(limit = 30) {
  const results = [];
  const seen = new Set();
  for (const dbPath of getKnownCodexDbPaths()) {
    for (const row of queryCodexThreadRows(dbPath)) {
      if (!row || row.archived || !row.id || !row.rollout_path) continue;
      if (seen.has(row.id) || isProcessed('codex_facts', row.id)) continue;
      const item = codexSessionFromRolloutPath(String(row.rollout_path), String(row.id));
      if (!item) continue;
      item.mtime = Number(row.updated_at || row.created_at || 0) > 0
        ? Number(row.updated_at || row.created_at) * 1000
        : item.mtime;
      seen.add(row.id);
      results.push(item);
    }
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/**
 * Load ~/.codex/history.jsonl into a Map<session_id, [{ts, text}]>.
 * Pass sessionIds to load only the sessions you need — avoids reading the
 * whole file (which grows unbounded) when only a few sessions are relevant.
 *
 * @param {string[]|null} sessionIds - allowlist; null/empty loads everything
 */
function loadCodexHistory(sessionIds = null) {
  const map = new Map();
  const allow = sessionIds && sessionIds.length > 0 ? new Set(sessionIds) : null;
  try {
    if (!fs.existsSync(CODEX_HISTORY_FILE)) return map;
    const lines = fs.readFileSync(CODEX_HISTORY_FILE, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.session_id || !entry.text) continue;
      if (allow && !allow.has(entry.session_id)) continue;
      if (!map.has(entry.session_id)) map.set(entry.session_id, []);
      map.get(entry.session_id).push({ ts: entry.ts, text: entry.text });
    }
  } catch { /* non-fatal */ }
  return map;
}

/**
 * Find all Codex rollout files not yet processed by memory-extract.
 * Filename pattern: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 */
function findAllUnextractedCodexSessions(limit = 30) {
  const byId = new Map();
  for (const item of findCodexSessionsFromStateDb(limit)) {
    byId.set(item.session_id, item);
  }
  if (!fs.existsSync(CODEX_SESSIONS_ROOT)) {
    return [...byId.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }
  const results = [];
  try {
    const years = fs.readdirSync(CODEX_SESSIONS_ROOT).filter(d => /^\d{4}$/.test(d));
    for (const year of years) {
      const yearDir = path.join(CODEX_SESSIONS_ROOT, year);
      const months = fs.readdirSync(yearDir).filter(d => /^\d{2}$/.test(d));
      for (const month of months) {
        const monthDir = path.join(yearDir, month);
        const days = fs.readdirSync(monthDir).filter(d => /^\d{2}$/.test(d));
        for (const day of days) {
          const dayDir = path.join(monthDir, day);
          let files;
          try { files = fs.readdirSync(dayDir); } catch { continue; }
          for (const file of files) {
            if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
            // Extract UUID from: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
            const m = file.match(CODEX_ROLLOUT_PATTERN);
            if (!m) continue;
            const sessionId = m[1];
            if (isProcessed('codex_facts', sessionId)) continue;
            const fullPath = path.join(dayDir, file);
            const item = codexSessionFromRolloutPath(fullPath, sessionId);
            if (item) results.push(item);
          }
        }
      }
    }
  } catch { return []; }
  for (const item of results) {
    if (!byId.has(item.session_id)) byId.set(item.session_id, item);
  }
  results.length = 0;
  results.push(...byId.values());
  results.sort((a, b) => b.mtime - a.mtime);
  return results.slice(0, limit);
}

/**
 * Build { skeleton, evidence } for a Codex session.
 * Reads only the first 2KB of the rollout file (session_meta line) — never
 * loads the full transcript.  Enriches with user messages from historyMap.
 *
 * @param {string} rolloutPath - absolute path to rollout-*.jsonl
 * @param {Map}    historyMap  - returned by loadCodexHistory()
 */
function buildCodexInput(rolloutPath, historyMap = new Map()) {
  let sessionMeta = null;
  let fileSessionId = null;
  const rolloutUsers = [];
  const assistantResults = [];
  const toolTraces = [];
  const fileAnchors = new Set();
  const toolCounts = {};
  let toolErrorCount = 0;
  let firstEventTs = null;
  let lastEventTs = null;

  const addTimestamp = (ts) => {
    if (!ts) return;
    if (!firstEventTs || ts < firstEventTs) firstEventTs = ts;
    if (!lastEventTs || ts > lastEventTs) lastEventTs = ts;
  };

  const messageText = (content, textType) => (Array.isArray(content) ? content : [])
    .filter(item => item && (!textType || item.type === textType) && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
    .trim();

  const recordTool = (payload) => {
    const name = String(payload.name || 'unknown');
    toolCounts[name] = (toolCounts[name] || 0) + 1;
    let input = payload.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { /* retain string */ }
    }
    const compact = typeof input === 'string' ? input : JSON.stringify(input || {});
    toolTraces.push(`${name} ${compact.replace(/\s+/g, ' ').slice(0, 180)}`.trim());
    if (input && typeof input === 'object') {
      for (const key of ['path', 'file_path', 'workdir', 'cwd']) {
        if (typeof input[key] === 'string' && input[key]) fileAnchors.add(input[key]);
      }
    }
  };

  try {
    const m = path.basename(rolloutPath).match(CODEX_ROLLOUT_PATTERN);
    if (m) fileSessionId = m[1];

    const stat = fs.statSync(rolloutPath);
    if (stat.size > MAX_FILE_SIZE) throw new Error('codex rollout exceeds size limit');
    const lines = fs.readFileSync(rolloutPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      addTimestamp(entry.timestamp);
      const payload = entry.payload || {};
      if (entry.type === 'session_meta') {
        sessionMeta = payload;
        addTimestamp(payload.timestamp);
        continue;
      }
      if (entry.type === 'response_item' && payload.type === 'message') {
        const textType = payload.role === 'assistant' ? 'output_text' : 'input_text';
        const text = messageText(payload.content, textType);
        if (payload.role === 'user' && text && text.length <= 6000 && !isInternalPrompt(text)) {
          const clean = sanitizePrompt(text);
          if (clean) rolloutUsers.push({ ts: entry.timestamp, text: clean });
        } else if (payload.role === 'assistant' && text) {
          assistantResults.push(text);
        }
        continue;
      }
      if (entry.type === 'response_item' && payload.type === 'custom_tool_call') {
        recordTool(payload);
        continue;
      }
      if (entry.type === 'response_item' && payload.type === 'custom_tool_call_output') {
        const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output || '');
        if (/"(?:exit_code|code)"\s*:\s*[1-9]|"is_error"\s*:\s*true|process exited with code [1-9]/i.test(output)) {
          toolErrorCount++;
        }
        continue;
      }
      if (entry.type === 'event_msg' && payload.type === 'task_complete' && payload.last_agent_message) {
        assistantResults.push(String(payload.last_agent_message));
      }
    }
  } catch { /* non-fatal */ }

  const sessionId = (sessionMeta && sessionMeta.id) || fileSessionId;
  const cwd = (sessionMeta && sessionMeta.cwd) || null;
  const { project, project_id: projectId } = deriveProjectInfo(cwd || '');
  const isSubagent = !!(sessionMeta && sessionMeta.source
    && typeof sessionMeta.source === 'object' && sessionMeta.source.subagent);

  // User messages from history index (sorted chronologically)
  const historyUsers = (sessionId && historyMap.get(sessionId)) || [];
  const userMsgs = historyUsers.length > 0 ? [...historyUsers] : (isSubagent ? [] : rolloutUsers);
  userMsgs.sort((a, b) => a.ts - b.ts);

  const toIso = (ts) => {
    if (!ts) return null;
    const raw = typeof ts === 'number' ? ts * 1000 : ts;
    const ms = new Date(raw).getTime();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  const firstTs = toIso(userMsgs[0] && userMsgs[0].ts) || firstEventTs || (sessionMeta && sessionMeta.timestamp) || null;
  const lastTs = toIso(userMsgs[userMsgs.length - 1] && userMsgs[userMsgs.length - 1].ts) || lastEventTs || firstTs;
  const durationMs = firstTs && lastTs ? new Date(lastTs).getTime() - new Date(firstTs).getTime() : 0;
  const durationMin = durationMs > 0 ? Math.round(durationMs / 6000) / 10 : 0;

  const skeleton = {
    session_id:    sessionId || path.basename(rolloutPath, '.jsonl'),
    user_snippets: userMsgs.map(m => m.text.slice(0, 200)),
    tool_counts:   toolCounts,
    total_tool_calls: Object.values(toolCounts).reduce((sum, n) => sum + n, 0),
    tool_error_count: toolErrorCount,
    message_count: userMsgs.length,
    duration_min:  durationMin,
    project:       project || 'unknown',
    project_id:    projectId || null,
    project_path:  cwd,
    branch:        null,
    engine:        'codex',
    source:        isSubagent ? 'subagent' : (sessionMeta && sessionMeta.source),
    model_provider: sessionMeta && sessionMeta.model_provider,
    first_ts:      firstTs,
    last_ts:       lastTs,
  };

  const evidence = {
    user_messages: userMsgs.map(m => m.text).filter(Boolean).slice(0, 15),
    tool_traces:   toolTraces.slice(-12),
    key_results:   [...new Set(assistantResults.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(-6),
    file_anchors:  [...new Set([...(cwd ? [cwd] : []), ...fileAnchors])].slice(0, 12),
  };

  return { skeleton, evidence };
}

function buildSessionInputById(sessionId) {
  const claude = buildCanonicalSessionInputById(sessionId);
  if (claude) return claude;
  const codex = findCodexSessionById(sessionId);
  if (!codex) return null;
  const history = loadCodexHistory([codex.session_id]);
  const input = buildCodexInput(codex.path, history);
  return { engine: 'codex', path: codex.path, ...input };
}

/**
 * Mark a Codex session as facts-extracted.
 */
function markCodexFactsExtracted(sessionId) {
  markProcessed('codex_facts', sessionId);
}

function buildCanonicalSessionInputById(sessionId) {
  const item = findCanonicalSessionById(sessionId);
  if (!item) return null;
  const input = canonicalInputFromPath(item.path);
  return {
    engine: 'claude',
    ...input,
    sourceRevision: item.revision.sourceRevision,
  };
}

function buildCanonicalSessionInputByPath(sessionPath) {
  return canonicalInputFromPath(sessionPath);
}

module.exports = {
  findLatestUnanalyzedSession: findLatestCanonicalSession,
  findSessionById: findCanonicalSessionById,
  findCodexSessionById,
  buildSessionInputById,
  buildSessionInputByPath: buildCanonicalSessionInputByPath,
  findAllUnanalyzedSessions: limit => findAllCanonicalSessions('analyzed', limit),
  findAllUnextractedSessions: limit => findAllCanonicalSessions('facts_analyzed', limit),
  extractSkeleton: extractCanonicalSkeleton,
  extractSkeletonFromEvents: (events, context = {}) => makeCanonicalSkeleton(events, context),
  extractEvidence: extractCanonicalEvidence,
  extractEvidenceFromEvents: (events, budget = 3000) => canonicalEvidenceFromEvents(events, budget),
  formatForPrompt,
  formatGoalContext,
  summarizeSession: summarizeCanonicalSession,
  detectSignificantSession: detectCanonicalSignificantSession,
  markAnalyzed: (sessionId, sourceRevision = '') => markCanonicalProcessed('analyzed', sessionId, sourceRevision),
  markFactsExtracted: (sessionId, sourceRevision = '') => markCanonicalProcessed('facts_analyzed', sessionId, sourceRevision),
  // Codex adapter
  loadCodexHistory,
  findAllUnextractedCodexSessions,
  buildCodexInput,
  markCodexFactsExtracted,
  _internal: {
    codexSessionFromRolloutPath,
    queryCodexThreadRows,
  },
};

// Direct execution for testing
if (require.main === module) {
  console.log('🔍 Session Analytics — Testing\n');

  const latest = findLatestCanonicalSession();
  if (!latest) {
    console.log('No unanalyzed sessions found.');
    process.exit(0);
  }

  console.log(`Session: ${latest.session_id}`);
  console.log(`Path: ${latest.path}`);
  console.log(`Modified: ${new Date(latest.mtime).toISOString()}\n`);

  const skeleton = extractCanonicalSkeleton(latest.path);
  console.log('Skeleton:', JSON.stringify(skeleton, null, 2));
  console.log('\nPrompt format:', formatForPrompt(skeleton));

  const goalCtx = formatGoalContext(null);
  if (goalCtx) console.log('Goal context:', goalCtx);
}
