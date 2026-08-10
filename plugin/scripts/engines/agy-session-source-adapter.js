'use strict';

/**
 * agy Session Source Adapter.
 *
 * Antigravity owns the conversation protobufs, brain transcript layout, and
 * transcript record vocabulary.  This is the only module that discovers or
 * interprets those artifacts.  Consumers receive opaque Session Sources and
 * canonical events; they never need to know that agy stores a JSONL
 * transcript next to a protobuf conversation.
 */

const os = require('node:os');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const { deriveProjectInfo } = require('../utils');
const { sanitizePrompt, isInternalPrompt } = require('../hooks/hook-utils');
const { wrapSessionSourceAdapter } = require('./session-source-adapter');
const { normalizeCanonicalSessionEvents } = require('../core/canonical-session-event');
const { fingerprintSourceRevision } = require('../core/session-source-revision');
const {
  AGY_SESSION_TOOL_TYPES,
  AGY_KNOWN_RECORD_TYPES,
  assessTranscriptFormat,
  canonicalizeCwd,
  parseConversationCache,
  normalizeTranscriptRecord,
} = require('../core/agy-state');

const ENGINE_ID = 'agy';
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100000;
const DEFAULT_MAX_TEXT = 4000;
const DEFAULT_MAX_TOOL_TEXT = 1600;
const DEFAULT_MAX_TOOL_INPUT = 1200;
const DEFAULT_DISCOVERY_LIMIT = 1000;
const MAX_DISCOVERY_SNAPSHOT_ENTRIES = DEFAULT_DISCOVERY_LIMIT * 100;
const DISCOVERY_CURSOR_VERSION = 1;

function adapterError(code, detail = '') {
  const value = String(code || 'AGY_SESSION_SOURCE_ERROR');
  const normalizedCode = value.startsWith('AGY_')
    ? `session_source_${value.slice(4).toLowerCase()}`
    : value;
  const error = new Error(detail ? `${normalizedCode}:${detail}` : normalizedCode);
  error.code = normalizedCode;
  return error;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function normalizeCwd(value, pathMod, fsMod) {
  const realpath = fsMod.realpathSync && (fsMod.realpathSync.native || fsMod.realpathSync);
  const raw = stringValue(value).trim();
  return raw ? canonicalizeCwd(raw, { path: pathMod, realpath }) : null;
}

function safeSessionId(value) {
  const id = stringValue(value).trim();
  if (!id || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw adapterError('AGY_SESSION_SOURCE_LOCATOR_INVALID', id || 'missing');
  }
  return id;
}

function isPathInside(root, candidate, pathMod) {
  const relative = pathMod.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !pathMod.isAbsolute(relative));
}

function statFile(filePath, fsMod) {
  try {
    const stat = typeof fsMod.lstatSync === 'function' ? fsMod.lstatSync(filePath) : fsMod.statSync(filePath);
    if (stat.isSymbolicLink && stat.isSymbolicLink()) return null;
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function readFileBounded(filePath, fsMod, maxFileSize) {
  let stat;
  try {
    stat = typeof fsMod.lstatSync === 'function' ? fsMod.lstatSync(filePath) : fsMod.statSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw adapterError('AGY_TRANSCRIPT_MISSING');
    throw adapterError('AGY_TRANSCRIPT_UNAVAILABLE', error && error.code);
  }
  if (stat.isSymbolicLink && stat.isSymbolicLink()) {
    throw adapterError('AGY_TRANSCRIPT_INVALID', 'symlink_not_allowed');
  }
  if (!stat.isFile()) throw adapterError('AGY_TRANSCRIPT_INVALID', 'not_a_file');
  if (stat.size > maxFileSize) throw adapterError('AGY_TRANSCRIPT_TOO_LARGE', String(stat.size));
  let bytes;
  try {
    bytes = fsMod.readFileSync(filePath);
  } catch (error) {
    throw adapterError('AGY_TRANSCRIPT_READ_FAILED', error && error.code);
  }
  return { stat, bytes, text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
}

function recordsFromText(text) {
  const records = [];
  let invalidLineCount = 0;
  let partialFinalLine = false;
  const value = String(text || '');
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record');
      records.push({ record, nativeSequence: index });
    } catch {
      const isUnterminatedFinalLine = index === lines.length - 1 && !value.endsWith('\n');
      if (isUnterminatedFinalLine) partialFinalLine = true;
      else invalidLineCount += 1;
    }
  });
  const nextNativeSequence = value
    ? lines.length - (value.endsWith('\n') || partialFinalLine ? 1 : 0)
    : 0;
  return {
    records,
    invalidLineCount,
    partialFinalLine,
    nextNativeSequence,
  };
}

function assessFormat(records) {
  const result = assessTranscriptFormat((records || []).map(item => item && item.record));
  return {
    knownRecordCount: result.known,
    unknownRecordCount: result.unknown,
    formatDrift: result.formatDrift,
  };
}

function extractParentSessionId(record) {
  const object = asObject(record);
  if (!object) return '';
  return stringValue(firstDefined(
    object.parentSessionId,
    object.parent_session_id,
    object.parentConversationId,
    object.parent_conversation_id,
  )).trim();
}

function ownershipForSession(cache, sessionId, pathMod, fsMod) {
  const owners = [];
  for (const [cwd, value] of cache.entries()) {
    if (value !== sessionId) continue;
    const normalized = normalizeCwd(cwd, pathMod, fsMod);
    if (normalized && !owners.includes(normalized)) owners.push(normalized);
  }
  if (owners.length === 1) return { cwd: owners[0], state: 'cache' };
  if (owners.length > 1) return { cwd: null, state: 'ambiguous' };
  return { cwd: null, state: 'unavailable' };
}

function readOwnershipCache(cachePath, fsMod) {
  try {
    if (!fsMod.existsSync(cachePath)) return { cache: new Map(), available: false };
    const raw = parseConversationCache(fsMod.readFileSync(cachePath, 'utf8'));
    const cache = new Map();
    for (const [cwd, sessionId] of Object.entries(raw)) {
      const id = stringValue(sessionId).trim();
      if (cwd && id) cache.set(String(cwd), id);
    }
    return { cache, available: true };
  } catch {
    return { cache: new Map(), available: false };
  }
}

function metadataFromRecords(records, sessionId, ownership, pathMod, artifact = {}) {
  let firstTs = null;
  let lastTs = null;
  let parentNativeSessionId = '';
  let sidechain = false;
  for (const item of records.slice(0, 1024)) {
    const record = item.record;
    parentNativeSessionId = parentNativeSessionId || extractParentSessionId(record);
    sidechain = sidechain || !!parentNativeSessionId || record.isSidechain === true || record.is_sidechain === true;
    const timestamp = normalizeTimestamp(firstDefined(
      record.created_at,
      record.createdAt,
      record.timestamp,
      record.ts,
    ));
    if (timestamp && (!firstTs || timestamp < firstTs)) firstTs = timestamp;
    if (timestamp && (!lastTs || timestamp > lastTs)) lastTs = timestamp;
  }
  const cwd = ownership.cwd || null;
  const projectInfo = deriveProjectInfo(cwd);
  const format = assessFormat(records);
  return {
    nativeSessionId: sessionId,
    cwd,
    project: projectInfo.project || null,
    scope: projectInfo.project_id || null,
    parentNativeSessionId: parentNativeSessionId || null,
    classification: sidechain ? 'subagent' : 'conversation',
    firstTs,
    lastTs,
    ownership: ownership.state,
    ownershipAvailable: ownership.state === 'cache',
    conversationAvailable: artifact.conversationAvailable === true,
    ...format,
  };
}

function redactSecrets(text) {
  let value = String(text || '');
  value = value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED_SECRET]');
  value = value.replace(/\b(?:sk-ant-[a-z0-9_-]+|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/gi, '[REDACTED_SECRET]');
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]');
  value = value.replace(/(\b(?:[A-Z0-9]+_)*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|TOKEN)(?:_[A-Z0-9]+)*\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  value = value.replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  return value;
}

function isRecursiveOrInternal(text) {
  const value = String(text || '');
  return !value.trim()
    || isInternalPrompt(value)
    || /<!--\s*(?:FACTS|MEMORY):START\s*-->/i.test(value)
    || /\[上次对话摘要|\b(?:previous|prior|generated)\s+session\s+summary\b/i.test(value)
    || /<task-notification\b/i.test(value);
}

function cleanText(text, maxChars = DEFAULT_MAX_TEXT, { allowInternal = false } = {}) {
  const sanitized = sanitizePrompt(String(text || '')).replace(/\s+/g, ' ').trim();
  if (!allowInternal && isRecursiveOrInternal(sanitized)) return null;
  const redacted = redactSecrets(sanitized);
  if (!redacted.trim()) return null;
  return redacted.slice(0, maxChars);
}

function compactJson(value, maxChars) {
  let text;
  try { text = JSON.stringify(value === undefined ? null : value); } catch { text = '[unserializable]'; }
  return cleanText(text, maxChars, { allowInternal: true }) || '';
}

function eventProvenance(record, nativeSequence, metadata, type) {
  const provenance = {
    nativeSequence,
    nativeEventType: type,
    ...(Number.isSafeInteger(record.step_index) ? { stepIndex: record.step_index } : {}),
    ...(record.source ? { source: String(record.source).slice(0, 40) } : {}),
    ...(Array.isArray(record.truncated_fields) && record.truncated_fields.length > 0
      ? { truncatedFields: record.truncated_fields.map(String).slice(0, 20) }
      : {}),
  };
  if (metadata.parentNativeSessionId) provenance.parentNativeSessionId = metadata.parentNativeSessionId;
  return provenance;
}

function eventTimestamp(record) {
  return normalizeTimestamp(firstDefined(record.created_at, record.createdAt, record.timestamp, record.ts));
}

function normalizedToolOutcome(record, text, type) {
  const status = stringValue(record.status).trim().toUpperCase();
  const exitCodeValue = firstDefined(record.exit_code, record.exitCode);
  const exitCode = exitCodeValue === undefined || exitCodeValue === null || exitCodeValue === ''
    ? null
    : Number(exitCodeValue);
  const error = type === 'ERROR_MESSAGE'
    || !!record.error
    || status === 'ERROR'
    || status === 'FAILED'
    || (Number.isFinite(exitCode) && exitCode !== 0);
  return {
    error,
    ...(status ? { status } : {}),
    ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}),
    ...(text ? { outputChars: Math.min(text.length, DEFAULT_MAX_TOOL_TEXT) } : {}),
  };
}

function projectCanonicalRecords(records, metadata, options = {}) {
  const maxText = Number(options.maxText || DEFAULT_MAX_TEXT);
  const maxToolText = Number(options.maxToolText || DEFAULT_MAX_TOOL_TEXT);
  const maxToolInput = Number(options.maxToolInput || DEFAULT_MAX_TOOL_INPUT);
  const output = [];
  const append = (actor, kind, text, item, extra = {}) => {
    const record = item.record;
    const type = stringValue(record.type).trim().toUpperCase();
    const toolEvent = kind === 'tool_call' || kind === 'tool_result';
    const cleaned = cleanText(text, toolEvent ? maxToolText : maxText, { allowInternal: toolEvent });
    if (!cleaned && kind === 'message') return;
    output.push({
      actor,
      kind,
      timestamp: eventTimestamp(record),
      text: cleaned || '',
      tool: extra.tool || null,
      outcome: extra.outcome || null,
      provenance: eventProvenance(record, item.nativeSequence, metadata, type),
    });
  };

  for (const item of records) {
    const record = item.record;
    const type = stringValue(record.type).trim().toUpperCase();
    if (type === 'USER_INPUT') {
      if (!record.source || String(record.source).toUpperCase() === 'USER_EXPLICIT') {
        append('user', 'message', record.content, item);
      }
      continue;
    }
    if (type === 'PLANNER_RESPONSE') {
      const normalized = normalizeTranscriptRecord(record, { extended: true });
      for (const event of normalized.filter(value => value.type === 'tool_use')) {
        const input = compactJson(event.toolInput, maxToolInput);
        if (input) append('tool', 'tool_call', input, item, { tool: event.toolName });
      }
      const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
      if (calls.length === 0 && String(record.status || '').toUpperCase() === 'DONE') {
        append('assistant', 'message', record.content, item);
      }
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(AGY_SESSION_TOOL_TYPES, type)) {
      const outputText = cleanText(record.content || record.message || record.error, maxToolText, { allowInternal: true }) || '';
      const normalized = normalizeTranscriptRecord(record, { extended: true }).find(value => value.type === 'tool_result');
      append('tool', 'tool_result', outputText, item, {
        tool: normalized ? normalized.toolName : AGY_SESSION_TOOL_TYPES[type],
        outcome: normalizedToolOutcome(record, outputText, type),
      });
    }
  }
  return output;
}

function discoveryQuery(request = {}) {
  return {
    project: stringValue(request.project || request.projectKey).trim(),
    cwd: stringValue(request.cwd).trim(),
    includeSubagents: request.includeSubagents !== false,
    suppressOwnedSubagents: request.suppressOwnedSubagents === true,
  };
}

function discoveryLimit(request = {}) {
  return Math.min(Math.max(Number(request.limit) || DEFAULT_DISCOVERY_LIMIT, 1), DEFAULT_DISCOVERY_LIMIT);
}

function normalizeSnapshotEntry(value) {
  const object = asObject(value);
  const sessionId = object && stringValue(object.sessionId || object.session_id).trim();
  if (!sessionId) throw adapterError('AGY_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_session');
  safeSessionId(sessionId);
  const sourceKinds = Array.isArray(object.sourceKinds)
    ? [...new Set(object.sourceKinds.map(String).filter(Boolean))].sort()
    : [];
  return { sessionId, sourceKinds };
}

function parseDiscoveryCursor(value) {
  if (value === null || value === undefined) return null;
  let cursor = value;
  if (typeof cursor === 'string') {
    try { cursor = JSON.parse(cursor); } catch { throw adapterError('AGY_SESSION_SOURCE_CURSOR_INVALID', 'json'); }
  }
  const object = asObject(cursor);
  const offset = object && Number(object.offset);
  const accepted = object && Number(object.accepted === undefined ? offset : object.accepted);
  if (!object || Number(object.version) !== DISCOVERY_CURSOR_VERSION
    || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(object.snapshot) || object.snapshot.length > MAX_DISCOVERY_SNAPSHOT_ENTRIES
    || !Number.isSafeInteger(accepted) || accepted < 0 || accepted > DEFAULT_DISCOVERY_LIMIT
    || !asObject(object.query)) {
    throw adapterError('AGY_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_required');
  }
  if (offset > object.snapshot.length) throw adapterError('AGY_SESSION_SOURCE_CURSOR_INVALID', 'offset');
  return {
    version: DISCOVERY_CURSOR_VERSION,
    offset,
    accepted,
    snapshot: object.snapshot.map(normalizeSnapshotEntry),
    query: discoveryQuery(object.query),
  };
}

function sameDiscoveryQuery(left, right) {
  return left.project === right.project
    && left.cwd === right.cwd
    && left.includeSubagents === right.includeSubagents
    && left.suppressOwnedSubagents === right.suppressOwnedSubagents;
}

function makeDiscoveryCursor(snapshot, offset, accepted, query) {
  return { version: DISCOVERY_CURSOR_VERSION, offset, accepted, snapshot, query };
}

function createAgySessionSourceAdapter(options = {}) {
  const fsMod = options.fs || fsDefault;
  const pathMod = options.path || pathDefault;
  const home = options.home || options.HOME || os.homedir();
  const agyHome = pathMod.resolve(options.agyHome || options.antigravityHome || pathMod.join(home, '.gemini', 'antigravity-cli'));
  const brainRoot = pathMod.resolve(options.brainRoot || pathMod.join(agyHome, 'brain'));
  const conversationsRoot = pathMod.resolve(options.conversationsRoot || pathMod.join(agyHome, 'conversations'));
  const cachePath = pathMod.resolve(options.cachePath || pathMod.join(agyHome, 'cache', 'last_conversations.json'));
  const maxFileSize = Number(options.maxFileSize || DEFAULT_MAX_FILE_SIZE);
  const maxEvents = Number(options.maxEvents || DEFAULT_MAX_EVENTS);
  const adapterOptions = {
    maxText: Number(options.maxText || DEFAULT_MAX_TEXT),
    maxToolText: Number(options.maxToolText || DEFAULT_MAX_TOOL_TEXT),
    maxToolInput: Number(options.maxToolInput || DEFAULT_MAX_TOOL_INPUT),
  };

  function transcriptPath(sessionId) {
    const id = safeSessionId(sessionId);
    const candidate = pathMod.resolve(brainRoot, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (!isPathInside(brainRoot, candidate, pathMod)) throw adapterError('AGY_SESSION_SOURCE_LOCATOR_INVALID');
    return candidate;
  }

  function conversationPath(sessionId) {
    const id = safeSessionId(sessionId);
    const candidate = pathMod.resolve(conversationsRoot, `${id}.pb`);
    if (!isPathInside(conversationsRoot, candidate, pathMod)) throw adapterError('AGY_SESSION_SOURCE_LOCATOR_INVALID');
    return candidate;
  }

  function ownership(sessionId) {
    return ownershipForSession(readOwnershipCache(cachePath, fsMod).cache, sessionId, pathMod, fsMod);
  }

  function artifactEntries() {
    const entries = new Map();
    const add = (sessionId, kind, mtimeMs) => {
      const id = stringValue(sessionId).trim();
      if (!id) return;
      const entry = entries.get(id) || { sessionId: id, sourceKinds: new Set(), mtimeMs: 0 };
      entry.sourceKinds.add(kind);
      entry.mtimeMs = Math.max(entry.mtimeMs, Number(mtimeMs) || 0);
      entries.set(id, entry);
    };
    let brainEntries = [];
    try { brainEntries = fsMod.readdirSync(brainRoot, { withFileTypes: true }); } catch { /* optional */ }
    for (const entry of brainEntries) {
      if (!entry || (entry.isSymbolicLink && entry.isSymbolicLink()) || !(entry.isDirectory && entry.isDirectory())) continue;
      const file = transcriptPath(entry.name);
      const stat = statFile(file, fsMod);
      if (stat) add(entry.name, 'transcript', stat.mtimeMs);
    }
    let conversationEntries = [];
    try { conversationEntries = fsMod.readdirSync(conversationsRoot, { withFileTypes: true }); } catch { /* optional */ }
    for (const entry of conversationEntries) {
      if (!entry || (entry.isSymbolicLink && entry.isSymbolicLink()) || !(entry.isFile && entry.isFile())) continue;
      if (!String(entry.name).endsWith('.pb')) continue;
      const stat = statFile(pathMod.join(conversationsRoot, entry.name), fsMod);
      if (stat) add(String(entry.name).slice(0, -3), 'conversation', stat.mtimeMs);
    }
    return [...entries.values()]
      .map(entry => ({ ...entry, sourceKinds: [...entry.sourceKinds].sort() }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs || left.sessionId.localeCompare(right.sessionId));
  }

  function metadataForEntry(entry) {
    const info = ownership(entry.sessionId);
    const projectInfo = deriveProjectInfo(info.cwd);
    return {
      nativeSessionId: entry.sessionId,
      cwd: info.cwd,
      project: projectInfo.project || null,
      scope: projectInfo.project_id || null,
      parentNativeSessionId: null,
      classification: 'conversation',
      ownership: info.state,
      ownershipAvailable: info.state === 'cache',
      conversationAvailable: entry.sourceKinds.includes('conversation'),
    };
  }

  function inspectFile(filePath, expectedSessionId = '') {
    const source = readFileBounded(filePath, fsMod, maxFileSize);
    const parsed = recordsFromText(source.text);
    const sessionId = safeSessionId(expectedSessionId || pathMod.basename(pathMod.dirname(pathMod.dirname(pathMod.dirname(filePath)))));
    const ownershipInfo = ownership(sessionId);
    const artifact = { conversationAvailable: !!statFile(conversationPath(sessionId), fsMod) };
    const metadata = metadataFromRecords(parsed.records, sessionId, ownershipInfo, pathMod, artifact);
    const events = projectCanonicalRecords(parsed.records, metadata, adapterOptions);
    const sourceRevision = fingerprintSourceRevision({ content: source.bytes });
    const timestamps = events.map(event => event.timestamp).filter(Boolean).sort();
    return {
      ...metadata,
      sourceLocator: { sessionId },
      sourceHash: sourceRevision,
      sourceRevision,
      sourceSize: source.bytes.length,
      cursor: { sequence: parsed.nextNativeSequence },
      messageCount: events.filter(event => event.actor === 'user' && event.kind === 'message').length,
      toolCallCount: events.filter(event => event.kind === 'tool_call').length,
      toolErrorCount: events.filter(event => event.kind === 'tool_result' && event.outcome && event.outcome.error).length,
      eventCount: events.length,
      eventLimitExceeded: events.length > maxEvents,
      invalidLineCount: parsed.invalidLineCount,
      partialFinalLine: parsed.partialFinalLine,
      firstTs: timestamps[0] || metadata.firstTs,
      lastTs: timestamps.at(-1) || metadata.lastTs,
      lastModified: source.stat.mtime instanceof Date
        ? source.stat.mtime.toISOString()
        : new Date(Number(source.stat.mtimeMs) || 0).toISOString(),
      availability: 'present',
    };
  }

  function refForEntry(entry, info = null, discoveryCursor = null) {
    const metadata = info || metadataForEntry(entry);
    return {
      engineId: ENGINE_ID,
      nativeSessionId: entry.sessionId,
      sourceLocator: { sessionId: entry.sessionId },
      project: metadata.project || null,
      scope: metadata.scope || null,
      cwd: metadata.cwd || null,
      parentNativeSessionId: metadata.parentNativeSessionId || null,
      sourceRevision: metadata.sourceRevision || null,
      ...(discoveryCursor ? { discoveryCursor } : {}),
    };
  }

  function filterEntry(entry, query) {
    if (!query.project && !query.cwd) return true;
    let info;
    try { info = inspectFile(transcriptPath(entry.sessionId), entry.sessionId); } catch { info = metadataForEntry(entry); }
    return (!query.project || info.project === query.project)
      && (!query.cwd || info.cwd === normalizeCwd(query.cwd, pathMod, fsMod))
      && (query.includeSubagents || info.classification !== 'subagent');
  }

  function freshDiscoverySnapshot(query) {
    return artifactEntries()
      .filter(entry => filterEntry(entry, query))
      .slice(0, MAX_DISCOVERY_SNAPSHOT_ENTRIES)
      .map(entry => ({ sessionId: entry.sessionId, sourceKinds: entry.sourceKinds }));
  }

  function prepareDiscovery(request = {}) {
    const query = discoveryQuery(request);
    const cursor = parseDiscoveryCursor(request.cursor);
    if (cursor) {
      if (!sameDiscoveryQuery(cursor.query, query)) throw adapterError('AGY_SESSION_SOURCE_CURSOR_INVALID', 'query_mismatch');
      return { query, cursor, snapshot: cursor.snapshot };
    }
    return { query, cursor: null, snapshot: freshDiscoverySnapshot(query) };
  }

  function refsForRequest(request = {}) {
    const state = prepareDiscovery(request);
    const limit = discoveryLimit(request);
    const start = state.cursor ? state.cursor.offset : 0;
    const acceptedStart = state.cursor ? state.cursor.accepted : 0;
    const page = [];
    for (let index = start; index < state.snapshot.length && page.length < Math.min(limit, DEFAULT_DISCOVERY_LIMIT - acceptedStart); index += 1) {
      const entry = state.snapshot[index];
      let info;
      try { info = inspectFile(transcriptPath(entry.sessionId), entry.sessionId); } catch { info = metadataForEntry(entry); }
      page.push({ entry, info, snapshotIndex: index });
    }
    const acceptedEnd = acceptedStart + page.length;
    const hasMore = page.length > 0
      && acceptedEnd < DEFAULT_DISCOVERY_LIMIT
      && page[page.length - 1].snapshotIndex + 1 < state.snapshot.length;
    return page.map((item, index) => refForEntry(
      item.entry,
      item.info,
      hasMore && index === page.length - 1
        ? makeDiscoveryCursor(state.snapshot, item.snapshotIndex + 1, acceptedEnd, state.query)
        : null,
    ));
  }

  function resolveSessionRefPath(ref) {
    return transcriptPath(ref && ref.nativeSessionId);
  }

  function inspectPath(filePath, expectedSessionIdOrRef = '') {
    const resolved = pathMod.resolve(String(filePath || ''));
    if (!isPathInside(brainRoot, resolved, pathMod)
      || !resolved.endsWith(pathMod.join('.system_generated', 'logs', 'transcript.jsonl'))) {
      throw adapterError('AGY_SESSION_SOURCE_LOCATOR_INVALID');
    }
    const relative = pathMod.relative(brainRoot, resolved).split(pathMod.sep);
    const sessionId = asObject(expectedSessionIdOrRef)?.nativeSessionId
      || (typeof expectedSessionIdOrRef === 'string' ? expectedSessionIdOrRef : '')
      || relative[0];
    return inspectFile(resolved, sessionId);
  }

  function readFileEvents(ref, request = {}) {
    const filePath = resolveSessionRefPath(ref);
    const revision = inspectFile(filePath, ref.nativeSessionId);
    const requestedRevision = stringValue(request.sourceRevision || request.sourceHash).trim();
    if (requestedRevision && requestedRevision !== revision.sourceRevision) {
      throw adapterError('AGY_SESSION_SOURCE_REVISION_MISMATCH', `${requestedRevision}:${revision.sourceRevision}`);
    }
    const source = readFileBounded(filePath, fsMod, maxFileSize);
    const parsed = recordsFromText(source.text);
    const metadata = metadataFromRecords(
      parsed.records,
      ref.nativeSessionId,
      ownership(ref.nativeSessionId),
      pathMod,
      { conversationAvailable: revision.conversationAvailable },
    );
    const cursor = request.cursor && typeof request.cursor === 'object'
      ? Number(firstDefined(request.cursor.sequence, request.cursor.offset, request.cursor.position))
      : Number(request.cursor);
    const nativeCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null;
    const projected = projectCanonicalRecords(parsed.records, metadata, adapterOptions)
      .filter(event => nativeCursor === null || Number(event.provenance && event.provenance.nativeSequence) >= nativeCursor);
    if (projected.length > maxEvents) throw adapterError('AGY_SESSION_SOURCE_EVENT_LIMIT');
    const events = normalizeCanonicalSessionEvents(projected, {
      engineId: ENGINE_ID,
      nativeSessionId: ref.nativeSessionId,
      sourceRevision: revision.sourceRevision,
    });
    return { ref, revision: { ...revision, sourceLocator: ref.sourceLocator }, events };
  }

  const rawAdapter = {
    engineId: ENGINE_ID,
    protocolVersion: 1,
    probe: () => {
      const hasRoot = fsMod.existsSync(brainRoot) || fsMod.existsSync(conversationsRoot);
      const entries = artifactEntries();
      const sourceCount = entries.filter(entry => entry.sourceKinds.includes('transcript')).length;
      return {
        state: sourceCount > 0 ? 'verified' : hasRoot ? 'reachable' : 'unavailable',
        available: hasRoot,
        reachable: hasRoot,
        verified: sourceCount > 0,
        sourceCount,
        ...(hasRoot && sourceCount === 0 ? { errorCode: 'AGY_TRANSCRIPT_UNAVAILABLE' } : {}),
      };
    },
    discover: function* discover(request = {}) {
      for (const ref of refsForRequest(request)) yield ref;
    },
    inspect(ref) {
      const revision = inspectFile(resolveSessionRefPath(ref), ref.nativeSessionId);
      if (revision.nativeSessionId !== ref.nativeSessionId) {
        throw adapterError('AGY_SESSION_SOURCE_SESSION_ID_MISMATCH', `${ref.nativeSessionId}:${revision.nativeSessionId}`);
      }
      return revision;
    },
    read: function* read(ref, request = {}) {
      const result = readFileEvents(ref, request);
      for (const event of result.events) yield event;
    },
    validate(ref) {
      try {
        const revision = inspectFile(resolveSessionRefPath(ref), ref.nativeSessionId);
        if (revision.nativeSessionId !== ref.nativeSessionId) {
          return { valid: false, errorCode: 'SOURCE_SESSION_ID_MISMATCH', detail: 'native session id does not match locator' };
        }
        if (revision.formatDrift) {
          return { valid: false, errorCode: 'AGY_TRANSCRIPT_FORMAT_DRIFT', detail: 'no recognized agy transcript records' };
        }
        if (revision.eventLimitExceeded) {
          return { valid: false, errorCode: 'AGY_EVENT_LIMIT', detail: 'canonical event cap exceeded' };
        }
        if (revision.invalidLineCount > 0 && revision.eventCount === 0) {
          return { valid: false, errorCode: 'SOURCE_MALFORMED', detail: 'no valid canonical evidence' };
        }
        if (revision.eventCount === 0) {
          return {
            valid: false,
            errorCode: revision.partialFinalLine ? 'SOURCE_PARTIAL' : 'SOURCE_EMPTY',
            detail: revision.partialFinalLine
              ? 'transcript ends with an incomplete JSONL record'
              : 'transcript has no canonical evidence',
          };
        }
        return {
          valid: true,
          state: 'valid',
          ...((revision.unknownRecordCount > 0 || revision.partialFinalLine) ? {
            detail: [
              revision.unknownRecordCount > 0 ? `${revision.unknownRecordCount} unknown records ignored` : '',
              revision.partialFinalLine ? 'incomplete final JSONL record deferred' : '',
            ].filter(Boolean).join('; '),
          } : {}),
        };
      } catch (error) {
        return { valid: false, errorCode: error.code || 'SOURCE_INVALID', detail: error.message };
      }
    },
  };

  const source = wrapSessionSourceAdapter(rawAdapter, { engineId: ENGINE_ID });
  return Object.freeze({
    ...source,
    listSessionRefs: refsForRequest,
    resolveSessionRefPath,
    inspectPath,
    readPathEvents(filePath, expectedSessionIdOrRef = '') {
      const suppliedRef = asObject(expectedSessionIdOrRef) ? expectedSessionIdOrRef : null;
      const relative = pathMod.relative(brainRoot, pathMod.resolve(String(filePath || ''))).split(pathMod.sep);
      const nativeSessionId = suppliedRef?.nativeSessionId || (typeof expectedSessionIdOrRef === 'string' ? expectedSessionIdOrRef : '') || relative[0];
      const ref = suppliedRef || {
        engineId: ENGINE_ID,
        nativeSessionId,
        sourceLocator: { sessionId: nativeSessionId },
      };
      return readFileEvents(ref, { sourceRevision: inspectFile(pathMod.resolve(String(filePath || '')), nativeSessionId).sourceRevision });
    },
    isTrivialSession(skeleton) {
      return !!skeleton && skeleton.message_count < 1;
    },
  });
}

function readAgySessionEvents(source, ref, revision, options = {}) {
  const events = [];
  const request = { ...(options || {}), sourceRevision: revision && (revision.sourceRevision || revision.sourceHash) };
  return (async () => {
    for await (const event of source.read(ref, request)) events.push(event);
    return events;
  })();
}

module.exports = {
  ENGINE_ID,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_EVENTS,
  AGY_TOOL_TYPES: AGY_SESSION_TOOL_TYPES,
  AGY_KNOWN_RECORD_TYPES,
  createAgySessionSourceAdapter,
  createAgySessionSource: createAgySessionSourceAdapter,
  readAgySessionEvents,
  redactSecrets,
  cleanText,
  projectCanonicalRecords,
  _internal: {
    recordsFromText,
    assessFormat,
    metadataFromRecords,
    normalizeSnapshotEntry,
    parseDiscoveryCursor,
    sameDiscoveryQuery,
    safeSessionId,
  },
};
