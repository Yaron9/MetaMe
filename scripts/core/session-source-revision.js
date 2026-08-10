'use strict';

const crypto = require('node:crypto');

const SESSION_SOURCE_PROTOCOL_VERSION = 1;
const ENGINE_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function revisionError(code, detail = '') {
  const error = new TypeError(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function normalizeEngineId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!id || !ENGINE_ID_RE.test(id)) throw revisionError('session_source_engine_id_invalid', id || 'missing');
  return id;
}

function normalizeNativeSessionId(value) {
  const id = String(value || '').trim();
  if (!id) throw revisionError('session_source_native_session_id_required');
  return id;
}

function normalizePipelineVersion(value) {
  const version = String(value || '').trim();
  if (!version) throw revisionError('extraction_pipeline_version_required');
  return version;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function cloneJson(value, code = 'session_source_cursor_invalid') {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw revisionError(code);
  }
}

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function stableSerialize(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value, prefix = 'ssr_') {
  return `${prefix}${crypto.createHash('sha256').update(stableSerialize(value)).digest('hex')}`;
}

function normalizeCursor(cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === 'string') return cursor;
  if (typeof cursor === 'boolean') return cursor;
  if (typeof cursor === 'number') {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw revisionError('session_source_cursor_invalid', String(cursor));
    return cursor;
  }
  if (typeof cursor !== 'object') throw revisionError('session_source_cursor_invalid');
  const copy = cloneJson(cursor);
  if (copy === null || Array.isArray(copy)) throw revisionError('session_source_cursor_invalid');
  return copy;
}

function serializeCursor(cursor) {
  const normalized = normalizeCursor(cursor);
  return normalized === null ? null : stableSerialize(normalized);
}

function cursorPosition(cursor) {
  const normalized = normalizeCursor(cursor);
  if (normalized === null) return null;
  if (typeof normalized === 'number') return normalized;
  if (typeof normalized === 'object') {
    for (const key of ['sequence', 'seq', 'offset', 'position', 'index']) {
      const value = Number(normalized[key]);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
  }
  return null;
}

function fingerprintSourceRevision(source = {}) {
  const provided = source.sourceHash || source.source_hash || source.sourceRevision || source.source_revision;
  if (provided !== undefined && provided !== null && String(provided).trim()) return String(provided).trim();
  const content = source.content !== undefined
    ? source.content
    : source.bytes !== undefined
      ? source.bytes
      : source.events !== undefined
        ? source.events
        : {
          sourceSize: source.sourceSize || source.source_size || 0,
          firstTs: source.firstTs || source.first_ts || null,
          lastTs: source.lastTs || source.last_ts || null,
          cursor: normalizeCursor(firstDefined(source.cursor, source.appendCursor, source.append_cursor, source.discoveryCursor, source.discovery_cursor)),
        };
  const value = Buffer.isBuffer(content) ? content : stableSerialize(content);
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) return String(value);
  return new Date(parsed).toISOString();
}

function normalizeNonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeSessionRef(ref = {}, context = {}) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw revisionError('session_source_ref_required');
  }
  const engineId = normalizeEngineId(ref.engineId || ref.engine_id || context.engineId || context.engine_id);
  const nativeSessionId = normalizeNativeSessionId(
    ref.nativeSessionId || ref.native_session_id || ref.sessionId || ref.session_id || context.nativeSessionId,
  );
  const sourceLocator = ref.sourceLocator !== undefined
    ? cloneJson(ref.sourceLocator, 'session_source_locator_invalid')
    : ref.source_locator !== undefined
      ? cloneJson(ref.source_locator, 'session_source_locator_invalid')
      : ref.sourcePath !== undefined
        ? String(ref.sourcePath)
        : ref.source_path !== undefined
          ? String(ref.source_path)
          : null;
  const discoveryCursor = normalizeCursor(firstDefined(ref.discoveryCursor, ref.discovery_cursor));
  return Object.freeze({
    engineId,
    nativeSessionId,
    sourceLocator,
    project: ref.project === undefined ? null : String(ref.project || ''),
    scope: ref.scope === undefined ? null : String(ref.scope || ''),
    cwd: ref.cwd === undefined ? null : String(ref.cwd || ''),
    parentNativeSessionId: ref.parentNativeSessionId || ref.parent_native_session_id || null,
    ...(discoveryCursor === null ? {} : { discoveryCursor }),
  });
}

function normalizeSessionRevision(revision = {}, context = {}) {
  if (!revision || typeof revision !== 'object' || Array.isArray(revision)) {
    throw revisionError('session_source_revision_required');
  }
  const ref = normalizeSessionRef({
    ...context,
    ...revision,
    nativeSessionId: revision.nativeSessionId || revision.native_session_id || context.nativeSessionId,
  }, context);
  const sourceHash = fingerprintSourceRevision(revision);
  const cursor = normalizeCursor(firstDefined(
    revision.cursor,
    revision.appendCursor,
    revision.append_cursor,
    revision.discoveryCursor,
    revision.discovery_cursor,
  ));
  const sourceSize = normalizeNonNegativeInteger(revision.sourceSize || revision.source_size, 0);
  const optionalMetadata = {};
  for (const key of [
    'eventCount', 'invalidLineCount', 'unknownRecordCount', 'knownRecordCount',
    'eventLimitExceeded', 'formatDrift', 'conversationAvailable', 'ownershipAvailable', 'ownership',
    'availability', 'lastModified', 'sourceState', 'conversationState',
  ]) {
    if (revision[key] !== undefined) optionalMetadata[key] = revision[key];
  }
  return Object.freeze({
    ...ref,
    sourceHash,
    sourceRevision: sourceHash,
    sourceSize,
    firstTs: normalizeTimestamp(revision.firstTs || revision.first_ts),
    lastTs: normalizeTimestamp(revision.lastTs || revision.last_ts),
    messageCount: normalizeNonNegativeInteger(revision.messageCount || revision.message_count, 0),
    toolCallCount: normalizeNonNegativeInteger(revision.toolCallCount || revision.tool_call_count, 0),
    toolErrorCount: normalizeNonNegativeInteger(revision.toolErrorCount || revision.tool_error_count, 0),
    cursor,
    appendCursor: cursor,
    discoveryCursor: cursor,
    adapterProtocolVersion: normalizeNonNegativeInteger(
      revision.adapterProtocolVersion || revision.adapter_protocol_version,
      SESSION_SOURCE_PROTOCOL_VERSION,
    ) || SESSION_SOURCE_PROTOCOL_VERSION,
    lastIngestedSequence: normalizeNonNegativeInteger(
      revision.lastIngestedSequence || revision.last_ingested_sequence,
      0,
    ),
    classification: revision.classification || 'conversation',
    availability: revision.availability || revision.sourceState || revision.source_state || 'present',
    ...optionalMetadata,
  });
}

function classifySourceRevision(previous, current) {
  if (!current || current.availability === 'missing' || current.missing === true) return 'missing';
  if (!previous) return 'new';
  const previousHash = fingerprintSourceRevision(previous);
  const currentHash = fingerprintSourceRevision(current);
  const previousSize = normalizeNonNegativeInteger(previous.sourceSize || previous.source_size, 0);
  const currentSize = normalizeNonNegativeInteger(current.sourceSize || current.source_size, 0);
  if (previousHash === currentHash) {
    const previousCursor = cursorPosition(firstDefined(previous.cursor, previous.appendCursor, previous.append_cursor, previous.discoveryCursor, previous.discovery_cursor));
    const currentCursor = cursorPosition(firstDefined(current.cursor, current.appendCursor, current.append_cursor, current.discoveryCursor, current.discovery_cursor));
    if (current.replay === true || (previousCursor !== null && currentCursor !== null && currentCursor <= previousCursor)) {
      return 'replayed';
    }
    return 'unchanged';
  }
  if (currentSize < previousSize) return 'truncated';
  if (currentSize > previousSize) return 'grown';
  return 'rewritten';
}

function processingIdentity(input = {}) {
  const engineId = normalizeEngineId(input.engineId || input.engine_id || input.engine);
  const nativeSessionId = normalizeNativeSessionId(
    input.nativeSessionId || input.native_session_id || input.sessionId || input.session_id,
  );
  const sourceHash = fingerprintSourceRevision(input);
  const pipelineVersion = normalizePipelineVersion(input.pipelineVersion || input.pipeline_version);
  // JSON is used instead of a delimiter so an opaque native ID cannot create
  // an ambiguous identity.  It remains readable for diagnostics and stable
  // across process restarts.
  return stableSerialize([engineId, nativeSessionId, sourceHash, pipelineVersion]);
}

function processingId(input) {
  return digest(processingIdentity(input), 'er_');
}

function createProcessingIdentity(input) {
  const engineId = normalizeEngineId(input.engineId || input.engine_id || input.engine);
  const nativeSessionId = normalizeNativeSessionId(
    input.nativeSessionId || input.native_session_id || input.sessionId || input.session_id,
  );
  const sourceHash = fingerprintSourceRevision(input);
  const pipelineVersion = normalizePipelineVersion(input.pipelineVersion || input.pipeline_version);
  const key = processingIdentity({ engineId, nativeSessionId, sourceHash, pipelineVersion });
  return Object.freeze({ engineId, nativeSessionId, sourceHash, pipelineVersion, key, id: digest(key, 'er_') });
}

function advanceCursor(cursor, update = {}) {
  const base = normalizeCursor(cursor);
  const next = update && typeof update === 'object' ? { ...(base && typeof base === 'object' ? base : {}) } : {};
  for (const key of ['revision', 'sourceRevision', 'sequence', 'offset', 'position', 'index']) {
    if (update[key] !== undefined) next[key] = update[key];
  }
  if (base === null && Object.keys(next).length === 0 && typeof update === 'number') return normalizeCursor(update);
  return normalizeCursor(next);
}

module.exports = {
  ENGINE_ID_RE,
  SESSION_SOURCE_PROTOCOL_VERSION,
  normalizeEngineId,
  normalizeNativeSessionId,
  normalizePipelineVersion,
  normalizeCursor,
  serializeCursor,
  fingerprintSourceRevision,
  normalizeSessionRef,
  normalizeSessionRevision,
  classifySourceRevision,
  processingIdentity,
  processingId,
  createProcessingIdentity,
  advanceCursor,
};
