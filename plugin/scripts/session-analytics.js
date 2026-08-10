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
const { createBuiltinSessionSourceMap } = require('./engines/session-source-registry');
const {
  ensureExtractionRunSchema,
  getExtractionRun,
  ensureExtractionRun,
  claimExtractionLease,
  completeExtractionRun,
} = require('./core/extraction-run-db');
const { upsertSessionSource } = require('./core/session-source-db');
const {
  makeSkeleton: makeCanonicalSkeleton,
  extractEvidence: canonicalEvidenceFromEvents,
  extractPivotPoints: extractCanonicalPivotPoints,
  detectSignificantSession: detectCanonicalSignificantSession,
} = require('./core/canonical-session-analytics');

const HOME = os.homedir();
const CANONICAL_PIPELINE_VERSION = 'canonical-session-v1';
const PIPELINE_VERSIONS = Object.freeze({
  analyzed: `${CANONICAL_PIPELINE_VERSION}:analytics`,
  facts_analyzed: `${CANONICAL_PIPELINE_VERSION}:facts`,
});
let _stateDb = null;
let _sessionSources = null;

function getSessionSources() {
  if (!_sessionSources) _sessionSources = createBuiltinSessionSourceMap({ home: HOME });
  return _sessionSources;
}

function getStateDb() {
  if (_stateDb) return _stateDb;
  const dbPath = path.join(HOME, '.metame', 'memory.db');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  _stateDb = new DatabaseSync(dbPath);
  _stateDb.exec('PRAGMA journal_mode = WAL');
  _stateDb.exec('PRAGMA busy_timeout = 3000');
  ensureExtractionRunSchema(_stateDb);
  return _stateDb;
}

function pipelineVersionForKind(kind) {
  return PIPELINE_VERSIONS[kind] || `${CANONICAL_PIPELINE_VERSION}:${String(kind || 'unknown').trim() || 'unknown'}`;
}

function extractionRunFor(kind, sessionId, sourceRevision, engineId, create = false) {
  if (!kind || !sessionId || !sourceRevision || !engineId) return null;
  const db = getStateDb();
  const source = upsertSessionSource(db, {
    engineId,
    nativeSessionId: sessionId,
    sourceHash: sourceRevision,
    project: '*',
  });
  const options = {
    sessionSourceId: source.id,
    pipelineVersion: pipelineVersionForKind(kind),
  };
  if (create) ensureExtractionRun(db, options);
  return getExtractionRun(db, options);
}

function isProcessed(kind, sessionId, sourceRevision = '', pipelineVersion = CANONICAL_PIPELINE_VERSION, engineId = '') {
  if (!kind || !sessionId || !sourceRevision || !engineId) return false;
  const run = extractionRunFor(kind, sessionId, sourceRevision, engineId);
  return !!run && ['completed', 'skipped'].includes(run.status);
}

function markProcessed(kind, sessionId, sourceRevision = '', pipelineVersion = CANONICAL_PIPELINE_VERSION, engineId = '') {
  if (!sessionId || !sourceRevision || !engineId) return;
  const db = getStateDb();
  const run = extractionRunFor(kind, sessionId, sourceRevision, engineId, true);
  if (!run || ['completed', 'skipped'].includes(run.status)) return;
  const leaseToken = `analytics:${pipelineVersionForKind(kind)}:${engineId}:${sessionId}:${sourceRevision}`;
  const lease = claimExtractionLease(db, {
    sessionSourceId: run.session_source_id,
    pipelineVersion: run.pipeline_version,
    leaseToken,
    leaseMs: 60 * 1000,
  });
  if (!lease.claimed) return;
  completeExtractionRun(db, {
    runId: lease.run.id,
    leaseToken,
    metrics: { kind, sourceRevision, pipelineVersion },
  });
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
    const models = [...new Set(skeleton.models.map(model => String(model).trim()).filter(Boolean))];
    if (models.length > 0) parts.push(`Models: ${models.slice(0, 5).join(',')}`);
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

function contextFromCanonicalInput(input) {
  if (!input || typeof input !== 'object') return {};
  if (input.context && typeof input.context === 'object') return input.context;
  const revision = input.revision && typeof input.revision === 'object' ? input.revision : {};
  const ref = input.ref && typeof input.ref === 'object' ? input.ref : {};
  const engineId = input.engine || revision.engineId || ref.engineId || null;
  return {
    engine: engineId,
    source: revision.classification === 'subagent' ? 'subagent' : engineId,
    nativeSessionId: revision.nativeSessionId || ref.nativeSessionId || null,
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

function extractCanonicalSkeleton(input) {
  if (Array.isArray(input)) return makeCanonicalSkeleton(input);
  if (input && Array.isArray(input.events)) return makeCanonicalSkeleton(input.events, contextFromCanonicalInput(input));
  return makeCanonicalSkeleton([], input || {});
}

function extractCanonicalEvidence(input, budget = 3000) {
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

function markCanonicalProcessed(kind, sessionId, sourceRevision = '', engineId = '') {
  markProcessed(kind, sessionId, sourceRevision, CANONICAL_PIPELINE_VERSION, engineId);
}

module.exports = {
  findLatestUnanalyzedSession: findLatestCanonicalSession,
  findSessionById: findCanonicalSessionById,
  buildSessionInputById,
  buildSessionInputBySession,
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
  markAnalyzed: (sessionId, sourceRevision = '', engineId = '') => markCanonicalProcessed('analyzed', sessionId, sourceRevision, engineId),
  markFactsExtracted: (sessionId, sourceRevision = '', engineId = '') => markCanonicalProcessed('facts_analyzed', sessionId, sourceRevision, engineId),
  _internal: {
    getSessionSources,
    isProcessed,
    markProcessed,
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
