'use strict';

/**
 * Edge orchestration for Project Context.  Retrieval and access selection are
 * supplied by callers; this module only joins the pure contract to a
 * registered Cognitive Host and the existing session-store ledger.
 */

const {
  accessIdentity,
  buildManifest,
  deliveryKey,
  normalizeAccessContext,
} = require('./core/context-manifest');

const PHASES = Object.freeze(['cold_start', 'project_switch', 'refresh']);
const IN_FLIGHT_DELIVERIES = new Map();
const DELIVERY_SCOPE_IDS = new WeakMap();
let nextDeliveryScopeId = 1;

function buildProjectContextManifest(options = {}) {
  return buildManifest(options);
}

function unsupportedResult(reason = 'cognitive_host_unsupported') {
  return { state: 'unsupported', reason };
}

function isThenable(value) {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof value.then === 'function';
}

function failedProjection(error, manifest) {
  return {
    state: 'failed',
    error: error && error.message ? String(error.message).slice(0, 300) : 'project_context_failed',
    manifest,
  };
}

function normalizeProjectionResult(result, manifest) {
  if (!result || !['projected', 'unsupported', 'failed'].includes(result.state)) {
    return { state: 'failed', error: 'invalid_project_context_result', manifest };
  }
  return { ...result, manifest };
}

function projectContext(options = {}) {
  const adapter = options.adapter || options.cognitiveHost;
  if (!adapter || typeof adapter.projectContext !== 'function') return unsupportedResult();
  const phase = PHASES.includes(options.phase) ? options.phase : 'cold_start';
  const manifest = options.manifest || buildProjectContextManifest(options);
  if (!manifest || !manifest.project) return { state: 'empty', manifest };
  try {
    const result = adapter.projectContext({ manifest, phase });
    if (isThenable(result)) {
      return Promise.resolve(result)
        .then(value => normalizeProjectionResult(value, manifest))
        .catch(error => failedProjection(error, manifest));
    }
    return normalizeProjectionResult(result, manifest);
  } catch (error) {
    return failedProjection(error, manifest);
  }
}

function currentDeliveryLedger(options = {}) {
  if (options.ledger && typeof options.ledger === 'object' && !Array.isArray(options.ledger)) {
    return { ...options.ledger };
  }
  if (options.sessionStore && typeof options.sessionStore.getContextDeliveryLedger === 'function') {
    try {
      const ledger = options.sessionStore.getContextDeliveryLedger(
        options.logicalSessionId || options.chatId,
        options.engine || options.host,
      );
      if (ledger && typeof ledger === 'object' && !Array.isArray(ledger)) return { ...ledger };
    } catch { /* keep the delivery result useful when the ledger is unavailable */ }
  }
  return {};
}

function deliveryAlreadyRecorded(options, key) {
  const ledger = currentDeliveryLedger(options);
  return {
    recorded: Object.prototype.hasOwnProperty.call(ledger, key),
    ledger,
  };
}

function objectScopeId(value) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  let id = DELIVERY_SCOPE_IDS.get(value);
  if (!id) {
    id = `scope-${nextDeliveryScopeId}`;
    nextDeliveryScopeId += 1;
    DELIVERY_SCOPE_IDS.set(value, id);
  }
  return id;
}

function inFlightKey(options, key) {
  const sessionId = options.logicalSessionId || options.chatId || null;
  const engine = options.engine || options.host || null;
  const storeId = objectScopeId(options.sessionStore);
  const ledgerId = storeId ? null : objectScopeId(options.ledger);
  return JSON.stringify({
    delivery: key,
    logical_session: sessionId == null ? null : String(sessionId),
    engine: engine == null ? null : String(engine),
    persistence: storeId ? `session-store:${storeId}` : (ledgerId ? `ledger:${ledgerId}` : 'ephemeral'),
  });
}

function persistDelivery(options, key, manifest) {
  const metadata = {
    revision: manifest.revision,
    project: manifest.project,
    delivered_at: options.deliveredAt,
  };
  if (options.sessionStore && typeof options.sessionStore.compareAndSetContextDelivery === 'function') {
    return options.sessionStore.compareAndSetContextDelivery(
      options.logicalSessionId || options.chatId,
      options.engine || options.host,
      key,
      metadata,
    );
  }
  const { compareAndSetDelivery } = require('./core/context-manifest');
  return compareAndSetDelivery(options.ledger || {}, key, metadata);
}

function finalizeDelivery(projected, options, manifest, key) {
  if (!projected || projected.state !== 'projected') {
    return {
      ...projected,
      delivered: false,
      key,
      manifest,
      ledger: currentDeliveryLedger(options),
    };
  }

  let cas;
  try {
    cas = persistDelivery(options, key, manifest);
  } catch (error) {
    return failedProjection(error, manifest);
  }
  if (isThenable(cas)) {
    return Promise.resolve(cas)
      .then(result => finalizeDeliveryResult(projected, result, manifest, key))
      .catch(error => failedProjection(error, manifest));
  }
  return finalizeDeliveryResult(projected, cas, manifest, key);
}

function finalizeDeliveryResult(projected, cas, manifest, key) {
  if (!cas || !cas.delivered) {
    return {
      state: 'skipped',
      reason: 'already_delivered',
      delivered: false,
      key,
      manifest,
      ledger: cas && cas.ledger ? cas.ledger : {},
    };
  }
  return { ...projected, delivered: true, key, ledger: cas.ledger };
}

function trackDelivery(scopeKey, promise, manifest) {
  const existing = IN_FLIGHT_DELIVERIES.get(scopeKey);
  if (existing) return existing;
  const work = Promise.resolve(promise)
    .catch(error => failedProjection(error, manifest))
    .finally(() => {
      if (IN_FLIGHT_DELIVERIES.get(scopeKey) === work) IN_FLIGHT_DELIVERIES.delete(scopeKey);
    });
  IN_FLIGHT_DELIVERIES.set(scopeKey, work);
  return work;
}

function deliverProjectContext(options = {}) {
  const access = normalizeAccessContext(options.access || {});
  const manifest = options.manifest || buildProjectContextManifest({ ...options, access });
  if (!manifest || !manifest.project) return { state: 'empty', delivered: false, manifest };
  const adapter = options.adapter || options.cognitiveHost;
  if (!adapter || typeof adapter.projectContext !== 'function') {
    return { ...unsupportedResult(), delivered: false, manifest };
  }
  const phase = PHASES.includes(options.phase) ? options.phase : 'cold_start';
  const key = deliveryKey({
    host: options.host || access.host,
    nativeSessionId: options.nativeSessionId || options.native_session_id,
    project: manifest.project,
    accessIdentity: accessIdentity(access),
    revision: manifest.revision,
  });
  const scopeKey = inFlightKey(options, key);
  const inFlight = IN_FLIGHT_DELIVERIES.get(scopeKey);
  if (inFlight) return inFlight;
  const prior = deliveryAlreadyRecorded(options, key);
  if (prior.recorded) {
    return {
      state: 'skipped',
      reason: 'already_delivered',
      delivered: false,
      key,
      manifest,
      ledger: prior.ledger,
    };
  }
  const projected = projectContext({ adapter, manifest, phase });
  if (isThenable(projected)) {
    return trackDelivery(
      scopeKey,
      Promise.resolve(projected).then(result => finalizeDelivery(result, options, manifest, key)),
      manifest,
    );
  }
  const finalized = finalizeDelivery(projected, options, manifest, key);
  return isThenable(finalized) ? trackDelivery(scopeKey, finalized, manifest) : finalized;
}

module.exports = {
  PHASES,
  buildProjectContextManifest,
  deliverProjectContext,
  projectContext,
};
