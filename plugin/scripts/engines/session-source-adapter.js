'use strict';

const {
  SESSION_SOURCE_PROTOCOL_VERSION,
  normalizeEngineId,
  normalizeSessionRef,
  normalizeSessionRevision,
} = require('../core/session-source-revision');
const { normalizeCanonicalSessionEvent } = require('../core/canonical-session-event');

const REQUIRED_OPERATIONS = Object.freeze(['probe', 'discover', 'inspect', 'read', 'validate']);

function adapterError(code, detail = '', cause = null) {
  const error = new TypeError(detail ? `${code}:${detail}` : code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function requireAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw adapterError('session_source_adapter_required');
  const missing = REQUIRED_OPERATIONS.filter(operation => typeof adapter[operation] !== 'function');
  if (missing.length) throw adapterError('session_source_adapter_operations_required', missing.join(','));
}

function inferEngineId(adapter, options = {}) {
  const id = options.engineId
    || adapter.engineId
    || adapter.engine_id
    || (adapter.descriptor && adapter.descriptor.id);
  return normalizeEngineId(id);
}

function normalizeProbe(value, engineId, protocolVersion) {
  const probe = value && typeof value === 'object' ? value : {};
  const state = String(probe.state || (probe.available === false ? 'unavailable' : 'reachable')).trim().toLowerCase();
  return Object.freeze({
    protocolVersion,
    engineId,
    state,
    available: probe.available === undefined ? state !== 'unavailable' && state !== 'missing' : !!probe.available,
    reachable: probe.reachable === undefined ? state === 'reachable' || state === 'verified' : !!probe.reachable,
    verified: !!probe.verified || state === 'verified',
    sourceCount: Number.isSafeInteger(Number(probe.sourceCount)) && Number(probe.sourceCount) >= 0
      ? Number(probe.sourceCount)
      : null,
    errorCode: probe.errorCode || probe.error_code || null,
  });
}

function normalizeValidation(value, ref, protocolVersion) {
  const result = value && typeof value === 'object' ? value : { valid: !!value };
  const valid = result.valid === undefined ? result.ok !== false : !!result.valid;
  const code = result.code || result.errorCode || result.error_code || (valid ? null : 'SESSION_SOURCE_INVALID');
  return Object.freeze({
    protocolVersion,
    engineId: ref.engineId,
    nativeSessionId: ref.nativeSessionId,
    valid,
    state: result.state || (valid ? 'valid' : 'invalid'),
    code,
    errorCode: code,
    detail: result.detail || result.message || null,
  });
}

async function* iterate(value) {
  const resolved = await value;
  if (resolved === null || resolved === undefined) return;
  if (typeof resolved[Symbol.asyncIterator] === 'function') {
    for await (const item of resolved) yield item;
    return;
  }
  if (typeof resolved[Symbol.iterator] === 'function' && typeof resolved !== 'string') {
    for (const item of resolved) yield item;
    return;
  }
  throw adapterError('session_source_stream_invalid');
}

function wrapSessionSourceAdapter(adapter, options = {}) {
  requireAdapter(adapter);
  const engineId = inferEngineId(adapter, options);
  const protocolVersion = Number(options.protocolVersion || adapter.protocolVersion || SESSION_SOURCE_PROTOCOL_VERSION);
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    throw adapterError('session_source_protocol_version_invalid', String(protocolVersion));
  }

  async function probe(sourceContext = {}) {
    try {
      const result = await adapter.probe({ ...sourceContext, engineId, protocolVersion });
      return normalizeProbe(result, engineId, protocolVersion);
    } catch (error) {
      throw adapterError('session_source_probe_failed', engineId, error);
    }
  }

  async function* discover(discoveryRequest = {}) {
    let index = 0;
    try {
      const request = { ...discoveryRequest, engineId, protocolVersion };
      for await (const item of iterate(adapter.discover(request))) {
        const ref = normalizeSessionRef(item, { engineId });
        yield Object.freeze({
          ...ref,
          sourceRevision: item && (item.sourceRevision || item.source_revision || item.sourceHash || item.source_hash) || null,
          discoveryIndex: index,
        });
        index += 1;
      }
    } catch (error) {
      if (error && error.code && error.code.startsWith('session_source_')) throw error;
      throw adapterError('session_source_discover_failed', engineId, error);
    }
  }

  async function inspect(sessionRef) {
    const ref = normalizeSessionRef(sessionRef, { engineId });
    if (ref.engineId !== engineId) throw adapterError('session_source_engine_mismatch', `${ref.engineId}:${engineId}`);
    try {
      const result = await adapter.inspect(ref);
      return normalizeSessionRevision(result || {}, { ...ref, engineId });
    } catch (error) {
      if (error && error.code && error.code.startsWith('session_source_')) throw error;
      throw adapterError('session_source_inspect_failed', ref.nativeSessionId, error);
    }
  }

  async function* read(sessionRef, readRequest = {}) {
    const ref = normalizeSessionRef(sessionRef, { engineId });
    if (ref.engineId !== engineId) throw adapterError('session_source_engine_mismatch', `${ref.engineId}:${engineId}`);
    const sourceRevision = readRequest.sourceRevision
      || readRequest.source_revision
      || readRequest.sourceHash
      || readRequest.source_hash
      || readRequest.revision && (readRequest.revision.sourceRevision || readRequest.revision.sourceHash || readRequest.revision.source_hash)
      || sessionRef.sourceRevision
      || sessionRef.source_revision
      || sessionRef.sourceHash
      || sessionRef.source_hash;
    if (!sourceRevision) throw adapterError('session_source_revision_required', ref.nativeSessionId);
    try {
      let index = 0;
      const request = { ...readRequest, engineId, protocolVersion, sourceRevision };
      for await (const item of iterate(adapter.read(ref, request))) {
        const raw = item && item.event && typeof item.event === 'object' ? item.event : item;
        yield normalizeCanonicalSessionEvent(raw, {
          engineId,
          nativeSessionId: ref.nativeSessionId,
          sourceRevision,
          sequence: index,
        });
        index += 1;
      }
    } catch (error) {
      if (error && error.code && error.code.startsWith('canonical_session_event_')) throw error;
      if (error && error.code && error.code.startsWith('session_source_')) throw error;
      throw adapterError('session_source_read_failed', ref.nativeSessionId, error);
    }
  }

  async function validate(sessionRef) {
    const ref = normalizeSessionRef(sessionRef, { engineId });
    if (ref.engineId !== engineId) throw adapterError('session_source_engine_mismatch', `${ref.engineId}:${engineId}`);
    try {
      return normalizeValidation(await adapter.validate(ref), ref, protocolVersion);
    } catch (error) {
      if (error && error.code && error.code.startsWith('session_source_')) throw error;
      throw adapterError('session_source_validate_failed', ref.nativeSessionId, error);
    }
  }

  return Object.freeze({
    protocolVersion,
    engineId,
    probe,
    discover,
    inspect,
    read,
    validate,
  });
}

function createSessionSourceAdapter(adapter, options) {
  return wrapSessionSourceAdapter(adapter, options);
}

function runSessionSourceConformance(adapter, options = {}) {
  try {
    const seam = wrapSessionSourceAdapter(adapter, options);
    return Object.freeze({
      ok: REQUIRED_OPERATIONS.every(operation => typeof seam[operation] === 'function'),
      engineId: seam.engineId,
      protocolVersion: seam.protocolVersion,
      operations: Object.freeze([...REQUIRED_OPERATIONS]),
      adapter: seam,
    });
  } catch (error) {
    return { ok: false, errorCode: error.code || 'session_source_adapter_invalid', error };
  }
}

module.exports = {
  REQUIRED_OPERATIONS,
  wrapSessionSourceAdapter,
  createSessionSourceAdapter,
  runSessionSourceConformance,
};
