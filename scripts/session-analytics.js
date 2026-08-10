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
const { getSessionSource, upsertSessionSource } = require('./core/session-source-db');
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
const DEFAULT_DISCOVERY_PAGE_SIZE = 100;
const DEFAULT_DISCOVERY_SCAN_BUDGET = 5000;
const MAX_DISCOVERY_PAGE_SIZE = 1000;
const MAX_DISCOVERY_SCAN_BUDGET = 10000;
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

function completeSourceMetadata(metadata, engineId, sessionId, sourceRevision) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const sourceLocator = Object.hasOwn(metadata, 'sourceLocator')
    ? metadata.sourceLocator
    : metadata.source_locator;
  const sourceSize = Object.hasOwn(metadata, 'sourceSize')
    ? metadata.sourceSize
    : metadata.source_size;
  const project = Object.hasOwn(metadata, 'project')
    ? metadata.project
    : metadata.project_name;
  if (sourceLocator === undefined || sourceSize === undefined || project === undefined) return null;
  return {
    ...metadata,
    engineId,
    nativeSessionId: sessionId,
    sourceHash: sourceRevision,
    sourceLocator,
    sourceSize,
    project: project || '*',
    scope: metadata.scope ?? metadata.project_id ?? null,
    cwd: metadata.cwd ?? metadata.project_path ?? null,
    firstTs: metadata.firstTs ?? metadata.first_ts ?? null,
    lastTs: metadata.lastTs ?? metadata.last_ts ?? null,
    messageCount: metadata.messageCount ?? metadata.message_count ?? 0,
    toolCallCount: metadata.toolCallCount ?? metadata.total_tool_calls ?? metadata.tool_call_count ?? 0,
    toolErrorCount: metadata.toolErrorCount ?? metadata.tool_error_count ?? 0,
    parentNativeSessionId: metadata.parentNativeSessionId ?? metadata.parent_session_id ?? null,
    classification: metadata.classification || (metadata.source === 'subagent' ? 'subagent' : 'conversation'),
  };
}

function extractionRunFor(
  kind,
  sessionId,
  sourceRevision,
  engineId,
  create = false,
  sourceMetadata = null,
) {
  if (!kind || !sessionId || !sourceRevision || !engineId) return null;
  const db = getStateDb();
  let source = getSessionSource(db, {
    engineId,
    nativeSessionId: sessionId,
    sourceRevision,
  });
  if (!source && create) {
    const complete = completeSourceMetadata(sourceMetadata, engineId, sessionId, sourceRevision);
    if (!complete) return null;
    upsertSessionSource(db, complete);
    source = getSessionSource(db, {
      engineId,
      nativeSessionId: sessionId,
      sourceRevision,
    });
  }
  if (!source) return null;
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

function markProcessed(
  kind,
  sessionId,
  sourceRevision = '',
  pipelineVersion = CANONICAL_PIPELINE_VERSION,
  engineId = '',
  sourceMetadata = null,
) {
  if (!sessionId || !sourceRevision || !engineId) return;
  const db = getStateDb();
  const run = extractionRunFor(kind, sessionId, sourceRevision, engineId, true, sourceMetadata);
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

async function readSourceInput(engineId, source, ref, revision) {
  let events;
  let inputRevision = revision;
  let filePath = null;
  if (typeof source.read === 'function') {
    events = [];
    const sourceHash = sourceRevisionOf(ref, revision);
    for await (const event of source.read(ref, sourceHash ? { sourceRevision: sourceHash } : {})) events.push(event);
  } else if (typeof source.readPathEvents === 'function' && typeof source.resolveSessionRefPath === 'function') {
    filePath = source.resolveSessionRefPath(ref);
    const input = source.readPathEvents(filePath, ref);
    inputRevision = input.revision || revision;
    events = input.events;
  } else {
    throw new Error(`session source ${engineId} does not expose a readable source seam`);
  }
  const context = contextFromRevision(engineId, ref, inputRevision);
  return {
    engine: engineId,
    path: filePath,
    source,
    ref,
    revision: inputRevision,
    events,
    context,
    skeleton: makeCanonicalSkeleton(events, context),
    evidence: canonicalEvidenceFromEvents(events, 3000),
  };
}

async function inspectSourceSession(engineId, source, ref) {
  try {
    let revision;
    let filePath = null;
    if (typeof source.inspect === 'function') {
      revision = await source.inspect(ref);
    } else if (typeof source.resolveSessionRefPath === 'function' && typeof source.inspectPath === 'function') {
      filePath = source.resolveSessionRefPath(ref);
      revision = source.inspectPath(filePath, ref);
    } else {
      return null;
    }
    return { engineId, source, ref, revision, filePath };
  } catch { return null; }
}

function boundedDiscoveryValue(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), minimum), maximum);
}

function discoveryPageSize(max, options = {}) {
  const requested = options.discoveryPageSize
    ?? options.discoveryRequest?.pageSize
    ?? options.discoveryRequest?.limit;
  return boundedDiscoveryValue(
    requested,
    Math.min(Math.max(max, 1), DEFAULT_DISCOVERY_PAGE_SIZE),
    1,
    MAX_DISCOVERY_PAGE_SIZE,
  );
}

function discoveryScanBudget(options = {}) {
  return boundedDiscoveryValue(
    options.discoveryScanBudget,
    DEFAULT_DISCOVERY_SCAN_BUDGET,
    1,
    MAX_DISCOVERY_SCAN_BUDGET,
  );
}

function cursorKey(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return '<start>';
  try { return JSON.stringify(cursor); } catch { return String(cursor); }
}

async function* iterateDiscovery(source, request) {
  if (!source) return;
  const discover = typeof source.discover === 'function'
    ? source.discover.bind(source)
    : typeof source.listSessionRefs === 'function'
      ? source.listSessionRefs.bind(source)
      : null;
  if (!discover) return;
  let result = discover(request);
  if (result && typeof result.then === 'function') result = await result;
  if (!result) return;
  if (typeof result[Symbol.asyncIterator] === 'function') {
    for await (const ref of result) yield ref;
    return;
  }
  if (typeof result[Symbol.iterator] === 'function') {
    for (const ref of result) yield ref;
  }
}

function createDiscoveryState(source, request, pageSize) {
  return {
    source,
    request: { ...(request || {}) },
    pageSize: boundedDiscoveryValue(pageSize, DEFAULT_DISCOVERY_PAGE_SIZE, 1, MAX_DISCOVERY_PAGE_SIZE),
    cursor: request && request.cursor,
    visitedCursors: new Set(),
    scanned: 0,
    exhausted: false,
  };
}

async function readDiscoveryPage(state, scanBudget) {
  if (!state || state.exhausted || scanBudget <= 0) return { refs: [], scanned: 0 };
  const currentKey = cursorKey(state.cursor);
  if (state.visitedCursors.has(currentKey)) {
    state.exhausted = true;
    return { refs: [], scanned: 0 };
  }
  state.visitedCursors.add(currentKey);

  const limit = Math.min(state.pageSize, scanBudget);
  const pageRequest = { ...state.request, limit };
  if (state.cursor === undefined || state.cursor === null || state.cursor === '') delete pageRequest.cursor;
  else pageRequest.cursor = state.cursor;

  const refs = [];
  for await (const ref of iterateDiscovery(state.source, pageRequest)) {
    refs.push(ref);
    state.scanned += 1;
    if (refs.length >= limit) break;
  }
  if (refs.length === 0) {
    state.exhausted = true;
    return { refs, scanned: 0 };
  }

  const currentCursorKey = currentKey;
  const last = refs.at(-1) || {};
  const nextCursor = last.discoveryCursor
    ?? last.discovery_cursor
    ?? last.cursor;
  if (nextCursor === undefined || nextCursor === null || nextCursor === ''
    || cursorKey(nextCursor) === currentCursorKey) {
    state.exhausted = true;
  } else {
    state.cursor = nextCursor;
  }
  return { refs, scanned: refs.length };
}

async function walkDiscoveredRefs(source, request, options = {}) {
  const pageSize = boundedDiscoveryValue(options.pageSize, DEFAULT_DISCOVERY_PAGE_SIZE, 1, MAX_DISCOVERY_PAGE_SIZE);
  const scanBudget = boundedDiscoveryValue(options.scanBudget, DEFAULT_DISCOVERY_SCAN_BUDGET, 1, MAX_DISCOVERY_SCAN_BUDGET);
  const state = createDiscoveryState(source, request, pageSize);
  let scanned = 0;

  while (!state.exhausted && scanned < scanBudget) {
    const page = await readDiscoveryPage(state, scanBudget - scanned);
    scanned += page.scanned;
    for (const ref of page.refs) {
      if (typeof options.onRef === 'function' && await options.onRef(ref)) {
        return { scanned, stopped: true };
      }
    }
  }
  return { scanned, stopped: false };
}

async function listCanonicalSessions(kind = 'analyzed', limit = 30, options = {}) {
  const max = Math.min(Math.max(Number(limit) || 30, 1), 1000);
  const rows = [];
  const pageSize = discoveryPageSize(max, options);
  const scanBudget = discoveryScanBudget(options);
  const sourceEntries = [...getSessionSources()].map(([engineId, source]) => ({
    engineId,
    source,
    rows: [],
    state: null,
  }));
  const discoveryRequest = {
      ...(options.discoveryRequest || {}),
      includeSubagents: options.includeSubagents !== false,
      suppressOwnedSubagents: options.suppressOwnedSubagents !== false,
  };
  for (const entry of sourceEntries) {
    entry.state = createDiscoveryState(entry.source, discoveryRequest, pageSize);
  }

  let scanned = 0;
  let active = sourceEntries.length;
  while (scanned < scanBudget && active > 0) {
    let progressed = false;
    for (const entry of sourceEntries) {
      if (scanned >= scanBudget) break;
      if (entry.state.exhausted || entry.rows.length >= max) continue;
      const page = await readDiscoveryPage(entry.state, scanBudget - scanned);
      scanned += page.scanned;
      if (page.scanned > 0) progressed = true;
      for (const ref of page.refs) {
        if (entry.rows.length >= max) break;
        const inspected = await inspectSourceSession(entry.engineId, entry.source, ref);
        if (!inspected) continue;
        const sourceRevision = sourceRevisionOf(ref, inspected.revision);
        if (!sourceRevision || isProcessed(kind, ref.nativeSessionId, sourceRevision, CANONICAL_PIPELINE_VERSION, entry.engineId)) continue;
        entry.rows.push({
          engine: entry.engineId,
          engineId: entry.engineId,
          session_id: ref.nativeSessionId,
          nativeSessionId: ref.nativeSessionId,
          ref,
          revision: inspected.revision,
          source: entry.source,
          mtime: inspected.revision.lastModified ? Date.parse(inspected.revision.lastModified) : 0,
          path: inspected.filePath || null,
        });
      }
    }
    active = sourceEntries.reduce(
      (count, entry) => count + (entry.state.exhausted || entry.rows.length >= max ? 0 : 1),
      0,
    );
    if (!progressed && active > 0) {
      for (const entry of sourceEntries) {
        if (!entry.state.exhausted && entry.rows.length < max) entry.state.exhausted = true;
      }
      break;
    }
  }
  for (const entry of sourceEntries) {
    rows.push(...entry.rows);
  }
  rows.sort((left, right) => right.mtime - left.mtime || left.engineId.localeCompare(right.engineId) || left.session_id.localeCompare(right.session_id));
  return rows.slice(0, max);
}

async function findLatestCanonicalSession() {
  return (await listCanonicalSessions('analyzed', 1))[0] || null;
}

async function findAllCanonicalSessions(kind, limit = 30, options = {}) {
  return listCanonicalSessions(kind, limit, options);
}

async function findCanonicalSessionById(sessionId, engineId = '') {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const sources = engineId && getSessionSources().has(engineId)
    ? [[engineId, getSessionSources().get(engineId)]]
    : [...getSessionSources()];
  for (const [sourceEngineId, source] of sources) {
    let found = null;
    await walkDiscoveredRefs(source, {
      includeSubagents: true,
      suppressOwnedSubagents: false,
    }, {
      pageSize: DEFAULT_DISCOVERY_PAGE_SIZE,
      scanBudget: DEFAULT_DISCOVERY_SCAN_BUDGET,
      onRef: async ref => {
        if (!ref || ref.nativeSessionId !== id) return false;
        const inspected = await inspectSourceSession(sourceEngineId, source, ref);
        if (!inspected) return false;
        found = {
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
        return true;
      },
    });
    if (found) return found;
  }
  return null;
}

async function buildSessionInputById(sessionId) {
  const item = await findCanonicalSessionById(sessionId);
  if (!item) return null;
  return readSourceInput(item.engineId, item.source, item.ref, item.revision);
}

async function buildSessionInputBySession(session) {
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

function markCanonicalProcessed(kind, sessionId, sourceRevision = '', engineId = '', sourceMetadata = null) {
  markProcessed(kind, sessionId, sourceRevision, CANONICAL_PIPELINE_VERSION, engineId, sourceMetadata);
}

module.exports = {
  findLatestUnanalyzedSession: findLatestCanonicalSession,
  findSessionById: findCanonicalSessionById,
  buildSessionInputById,
  buildSessionInputBySession,
  findAllUnanalyzedSessions: (limit, options = {}) => findAllCanonicalSessions('analyzed', limit, options),
  findAllUnextractedSessions: (limit, options = {}) => findAllCanonicalSessions('facts_analyzed', limit, options),
  extractSkeleton: extractCanonicalSkeleton,
  extractSkeletonFromEvents: (events, context = {}) => makeCanonicalSkeleton(events, context),
  extractEvidence: extractCanonicalEvidence,
  extractEvidenceFromEvents: (events, budget = 3000) => canonicalEvidenceFromEvents(events, budget),
  formatForPrompt,
  formatGoalContext,
  summarizeSession: summarizeCanonicalSession,
  detectSignificantSession: detectCanonicalSignificantSession,
  markAnalyzed: (sessionId, sourceRevision = '', engineId = '', sourceMetadata = null) => markCanonicalProcessed('analyzed', sessionId, sourceRevision, engineId, sourceMetadata),
  markFactsExtracted: (sessionId, sourceRevision = '', engineId = '', sourceMetadata = null) => markCanonicalProcessed('facts_analyzed', sessionId, sourceRevision, engineId, sourceMetadata),
  _internal: {
    getSessionSources,
    isProcessed,
    markProcessed,
    completeSourceMetadata,
    listCanonicalSessions,
    walkDiscoveredRefs,
  },
};

if (require.main === module) {
  (async () => {
    const latest = await findLatestCanonicalSession();
    if (!latest) {
      console.log('No unanalyzed sessions found.');
      return;
    }
    const input = await buildSessionInputBySession(latest);
    console.log(`Session: ${latest.session_id}`);
    console.log(`Engine: ${latest.engineId}`);
    console.log('Skeleton:', JSON.stringify(input && input.skeleton, null, 2));
    console.log('Prompt format:', formatForPrompt(input && input.skeleton));
  })().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
