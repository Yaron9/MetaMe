#!/usr/bin/env node

/**
 * MetaMe Session Analytics — canonical evidence analytics.
 *
 * Native session discovery and projection belong to the registered Session
 * Source adapters.  This module only selects opaque sources, tracks generic
 * processing identities, and delegates canonical events to engine-neutral
 * analytics.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createClaudeSessionSourceForFile } = require('./engines/claude-session-source-adapter');
const { createBuiltinSessionSourceMap } = require('./engines/session-source-registry');
const {
  makeSkeleton: makeCanonicalSkeleton,
  extractEvidence: canonicalEvidenceFromEvents,
  extractPivotPoints: extractCanonicalPivotPoints,
  detectSignificantSession: detectCanonicalSignificantSession,
} = require('./core/canonical-session-analytics');

const HOME = os.homedir();
const STATE_FILE = path.join(HOME, '.metame', 'analytics_state.json');
const STATE_DB = path.join(HOME, '.metame', 'analytics_state.db');
const CANONICAL_PIPELINE_VERSION = 'canonical-session-v1';
let _stateDb = null;
let _stmtIsProcessed = null;
let _stmtMarkProcessed = null;
let _stmtIsRevisionProcessed = null;
let _stmtMarkRevisionProcessed = null;
let _sessionSources = null;

function getSessionSources() {
  if (!_sessionSources) _sessionSources = createBuiltinSessionSourceMap({ home: HOME });
  return _sessionSources;
}

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
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, session_id)
    )
  `);
  _stateDb.exec('CREATE INDEX IF NOT EXISTS idx_processed_kind_ts ON processed_sessions(kind, processed_at)');
  _stateDb.exec(`
    CREATE TABLE IF NOT EXISTS processed_source_revisions (
      kind TEXT NOT NULL,
      engine_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_revision TEXT NOT NULL,
      pipeline_version TEXT NOT NULL,
      processed_at INTEGER NOT NULL,
      PRIMARY KEY (kind, engine_id, session_id, source_revision, pipeline_version)
    )
  `);
  _stateDb.exec('CREATE INDEX IF NOT EXISTS idx_processed_source_revision ON processed_source_revisions(kind, processed_at)');
  _stateDb.exec('CREATE TABLE IF NOT EXISTS state_meta (key TEXT PRIMARY KEY, value TEXT)');
  migrateLegacyStateOnce(_stateDb);
  return _stateDb;
}

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
          for (const [sessionId, timestamp] of Object.entries(raw.analyzed || {})) {
            insert.run('analyzed', sessionId, Number(timestamp) || Date.now());
          }
          for (const [sessionId, timestamp] of Object.entries(raw.facts_analyzed || {})) {
            insert.run('facts_analyzed', sessionId, Number(timestamp) || Date.now());
          }
        });
        tx();
      }
    }
    db.prepare("INSERT OR REPLACE INTO state_meta (key, value) VALUES ('legacy_json_migrated', '1')").run();
  } catch { /* legacy state is best effort */ }
}

function isProcessed(kind, sessionId, sourceRevision = '', pipelineVersion = CANONICAL_PIPELINE_VERSION, engineId = 'claude') {
  if (!kind || !sessionId) return false;
  const db = getStateDb();
  if (sourceRevision) {
    if (!_stmtIsRevisionProcessed) {
      _stmtIsRevisionProcessed = db.prepare(`
        SELECT 1 AS ok FROM processed_source_revisions
        WHERE kind = ? AND engine_id = ? AND session_id = ? AND source_revision = ? AND pipeline_version = ? LIMIT 1
      `);
    }
    const row = _stmtIsRevisionProcessed.get(kind, engineId, sessionId, sourceRevision, pipelineVersion);
    return !!(row && row.ok === 1);
  }
  if (!_stmtIsProcessed) {
    _stmtIsProcessed = db.prepare('SELECT 1 AS ok FROM processed_sessions WHERE kind = ? AND session_id = ? LIMIT 1');
  }
  const row = _stmtIsProcessed.get(kind, sessionId);
  return !!(row && row.ok === 1);
}

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

function formatForPrompt(skeleton) {
  if (!skeleton) return '';
  const toolSummary = Object.entries(skeleton.tool_counts || {})
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(' ');
  const parts = [];
  if (skeleton.project) {
    const project = skeleton.branch ? `${skeleton.project}@${skeleton.branch}` : skeleton.project;
    parts.push(`Proj=${project}`);
  }
  if (skeleton.duration_min > 0) parts.push(`Duration: ${skeleton.duration_min}min`);
  parts.push(`Messages: ${skeleton.message_count || 0}`);
  if (skeleton.total_tool_calls > 0) parts.push(`Tools: ${skeleton.total_tool_calls} (${toolSummary})`);
  if (skeleton.git_committed) parts.push('Git: committed');
  if (Array.isArray(skeleton.models) && skeleton.models.length > 0) {
    const shortModels = skeleton.models.map(model => {
      if (model.includes('opus')) return 'opus';
      if (model.includes('sonnet')) return 'sonnet';
      if (model.includes('haiku')) return 'haiku';
      return model.split('-')[0];
    });
    parts.push(`Model: ${[...new Set(shortModels)].join(',')}`);
  }
  return parts.join(' | ');
}

function formatGoalContext() {
  try {
    const nowPath = path.join(HOME, '.metame', 'memory', 'NOW.md');
    if (!fs.existsSync(nowPath)) return '';
    const content = fs.readFileSync(nowPath, 'utf8').trim();
    if (!content) return '';
    return `CURRENT_TASK:\n${content.length > 300 ? content.slice(0, 300) + '…' : content}`;
  } catch { return ''; }
}

function sourceRevisionOf(ref, revision) {
  return String(
    (revision && (revision.sourceRevision || revision.sourceHash))
    || (ref && (ref.sourceRevision || ref.sourceHash))
    || '',
  ).trim();
}

function contextFromRevision(engineId, ref, revision) {
  return {
    engine: engineId,
    source: revision.classification === 'subagent' ? 'subagent' : engineId,
    nativeSessionId: revision.nativeSessionId || ref.nativeSessionId,
    sourceRevision: sourceRevisionOf(ref, revision),
    sourceSize: revision.sourceSize || 0,
    sourceLocator: revision.sourceLocator || ref.sourceLocator || null,
    project: revision.project || ref.project || null,
    project_id: revision.scope || ref.scope || null,
    project_path: revision.cwd || ref.cwd || null,
    parentNativeSessionId: revision.parentNativeSessionId || ref.parentNativeSessionId || null,
    first_ts: revision.firstTs || null,
    last_ts: revision.lastTs || null,
    branch: revision.gitBranch || revision.branch || null,
  };
}

function readSourceInput(engineId, source, ref, revision) {
  if (typeof source.readPathEvents !== 'function' || typeof source.resolveSessionRefPath !== 'function') {
    throw new Error(`session source ${engineId} does not expose a synchronous read seam`);
  }
  const filePath = source.resolveSessionRefPath(ref);
  const input = source.readPathEvents(filePath, ref);
  const context = contextFromRevision(engineId, ref, input.revision || revision);
  return {
    engine: engineId,
    path: filePath,
    source,
    ref,
    revision: input.revision || revision,
    events: input.events,
    context,
    skeleton: makeCanonicalSkeleton(input.events, context),
    evidence: canonicalEvidenceFromEvents(input.events, 3000),
  };
}

function canonicalInputFromPath(sessionPath) {
  const source = createClaudeSessionSourceForFile(sessionPath);
  const input = source.readEvents();
  const context = contextFromRevision('claude', input.ref, input.revision);
  return {
    engine: 'claude',
    path: sessionPath,
    source,
    ref: input.ref,
    revision: input.revision,
    events: input.events,
    context,
    skeleton: makeCanonicalSkeleton(input.events, context),
    evidence: canonicalEvidenceFromEvents(input.events, 3000),
  };
}

function inspectSourceSession(engineId, source, ref) {
  try {
    if (typeof source.resolveSessionRefPath !== 'function' || typeof source.inspectPath !== 'function') return null;
    const filePath = source.resolveSessionRefPath(ref);
    const revision = source.inspectPath(filePath, ref);
    return { engineId, source, ref, revision, filePath };
  } catch { return null; }
}

function listCanonicalSessions(kind = 'analyzed', limit = 30, options = {}) {
  const max = Math.min(Math.max(Number(limit) || 30, 1), 1000);
  const rows = [];
  for (const [engineId, source] of getSessionSources()) {
    const refs = source.listSessionRefs({
      ...(options.discoveryRequest || {}),
      includeSubagents: options.includeSubagents !== false,
      suppressOwnedSubagents: options.suppressOwnedSubagents !== false,
      limit: Math.min(max * 3, 1000),
    });
    for (const ref of refs) {
      const inspected = inspectSourceSession(engineId, source, ref);
      if (!inspected) continue;
      const sourceRevision = sourceRevisionOf(ref, inspected.revision);
      if (!sourceRevision || isProcessed(kind, ref.nativeSessionId, sourceRevision, CANONICAL_PIPELINE_VERSION, engineId)) continue;
      rows.push({
        engine: engineId,
        engineId,
        session_id: ref.nativeSessionId,
        nativeSessionId: ref.nativeSessionId,
        ref,
        revision: inspected.revision,
        source,
        mtime: inspected.revision.lastModified ? Date.parse(inspected.revision.lastModified) : 0,
        path: inspected.filePath || null,
      });
    }
  }
  rows.sort((left, right) => right.mtime - left.mtime || left.engineId.localeCompare(right.engineId) || left.session_id.localeCompare(right.session_id));
  return rows.slice(0, max);
}

function findLatestCanonicalSession() {
  return listCanonicalSessions('analyzed', 1)[0] || null;
}

function findAllCanonicalSessions(kind, limit = 30) {
  return listCanonicalSessions(kind, limit);
}

function findCanonicalSessionById(sessionId, engineId = '') {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const sources = engineId && getSessionSources().has(engineId)
    ? [[engineId, getSessionSources().get(engineId)]]
    : [...getSessionSources()];
  for (const [sourceEngineId, source] of sources) {
    const refs = source.listSessionRefs({ includeSubagents: true, suppressOwnedSubagents: false, limit: 1000 });
    const ref = refs.find(item => item.nativeSessionId === id);
    if (!ref) continue;
    const inspected = inspectSourceSession(sourceEngineId, source, ref);
    if (!inspected) continue;
    return {
      engine: sourceEngineId,
      engineId: sourceEngineId,
      session_id: id,
      nativeSessionId: id,
      ref,
      revision: inspected.revision,
      source,
      path: inspected.filePath || null,
      mtime: inspected.revision.lastModified ? Date.parse(inspected.revision.lastModified) : 0,
    };
  }
  return null;
}

function buildSessionInputById(sessionId) {
  const item = findCanonicalSessionById(sessionId);
  if (!item) return null;
  return readSourceInput(item.engineId, item.source, item.ref, item.revision);
}

function buildSessionInputBySession(session) {
  if (!session || !session.source || !session.ref) return null;
  return readSourceInput(session.engineId || session.engine, session.source, session.ref, session.revision);
}

function extractCanonicalSkeleton(input) {
  if (typeof input === 'string') return canonicalInputFromPath(input).skeleton;
  if (Array.isArray(input)) return makeCanonicalSkeleton(input);
  if (input && Array.isArray(input.events)) return makeCanonicalSkeleton(input.events, input.context || input);
  return makeCanonicalSkeleton([], input || {});
}

function extractCanonicalEvidence(input, budget = 3000) {
  if (typeof input === 'string') {
    return canonicalEvidenceFromEvents(canonicalInputFromPath(input).events, budget);
  }
  if (Array.isArray(input)) return canonicalEvidenceFromEvents(input, budget);
  return canonicalEvidenceFromEvents(input && input.events, budget);
}

function summarizeCanonicalSession(skeleton, sourceInput, evidence = null) {
  if (!skeleton || skeleton.duration_min < 20 || skeleton.total_tool_calls < 15) return null;
  const pivots = extractCanonicalPivotPoints(sourceInput && sourceInput.events ? sourceInput.events : sourceInput);
  const resultEvidence = evidence || (sourceInput && sourceInput.evidence) || {};
  return {
    intent: skeleton.intent || skeleton.user_snippets?.[0] || 'Unknown',
    pivots: pivots.slice(0, 3),
    outcome: skeleton.git_committed
      ? 'committed'
      : (resultEvidence.key_results && resultEvidence.key_results.length ? resultEvidence.key_results.at(-1).slice(0, 160) : 'exploratory'),
  };
}

function markCanonicalProcessed(kind, sessionId, sourceRevision = '', engineId = 'claude') {
  markProcessed(kind, sessionId, sourceRevision, CANONICAL_PIPELINE_VERSION, engineId || 'claude');
}

// Compatibility facades remain deliberately thin: native discovery and
// parsing are implemented by the Codex adapter, not by shared analytics.
function findCodexSessionById(sessionId) {
  return findCanonicalSessionById(sessionId, 'codex');
}

function findAllUnextractedCodexSessions(limit = 30) {
  return listCanonicalSessions('facts_analyzed', 1000)
    .filter(session => session.engineId === 'codex')
    .slice(0, Math.max(Number(limit) || 30, 1));
}

function buildCodexInput(filePath, historyMap = new Map()) {
  const adapterModule = require('./engines/codex-session-source-adapter');
  return adapterModule.buildCodexInput(filePath, historyMap);
}

function loadCodexHistory(sessionIds = null) {
  const source = getSessionSources().get('codex');
  return source && typeof source.loadHistory === 'function' ? source.loadHistory(sessionIds) : new Map();
}

function markCodexFactsExtracted(sessionId, sourceRevision = '') {
  markCanonicalProcessed('facts_analyzed', sessionId, sourceRevision, 'codex');
}

module.exports = {
  findLatestUnanalyzedSession: findLatestCanonicalSession,
  findSessionById: findCanonicalSessionById,
  findCodexSessionById,
  buildSessionInputById,
  buildSessionInputBySession,
  buildSessionInputByPath: canonicalInputFromPath,
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
  markAnalyzed: (sessionId, sourceRevision = '', engineId = 'claude') => markCanonicalProcessed('analyzed', sessionId, sourceRevision, engineId),
  markFactsExtracted: (sessionId, sourceRevision = '', engineId = 'claude') => markCanonicalProcessed('facts_analyzed', sessionId, sourceRevision, engineId),
  loadCodexHistory,
  findAllUnextractedCodexSessions,
  buildCodexInput,
  markCodexFactsExtracted,
  _internal: {
    getSessionSources,
    isProcessed,
    markProcessed,
    queryCodexThreadRows(dbPath, sessionId = '') {
      const source = getSessionSources().get('codex');
      return source && typeof source.queryThreadRows === 'function'
        ? source.queryThreadRows(dbPath, sessionId)
        : [];
    },
    codexSessionFromRolloutPath(filePath, fallbackId = '') {
      const source = getSessionSources().get('codex');
      return source && typeof source.sessionFromRolloutPath === 'function'
        ? source.sessionFromRolloutPath(filePath, fallbackId)
        : null;
    },
  },
};

if (require.main === module) {
  const latest = findLatestCanonicalSession();
  if (!latest) {
    console.log('No unanalyzed sessions found.');
    process.exit(0);
  }
  const input = buildSessionInputBySession(latest);
  console.log(`Session: ${latest.session_id}`);
  console.log(`Engine: ${latest.engineId}`);
  console.log('Skeleton:', JSON.stringify(input && input.skeleton, null, 2));
  console.log('Prompt format:', formatForPrompt(input && input.skeleton));
}
