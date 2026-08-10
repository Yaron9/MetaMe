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

function buildProjectContextManifest(options = {}) {
  return buildManifest(options);
}

function unsupportedResult(reason = 'cognitive_host_unsupported') {
  return { state: 'unsupported', reason };
}

function projectContext(options = {}) {
  const adapter = options.adapter || options.cognitiveHost;
  if (!adapter || typeof adapter.projectContext !== 'function') return unsupportedResult();
  const phase = PHASES.includes(options.phase) ? options.phase : 'cold_start';
  const manifest = options.manifest || buildProjectContextManifest(options);
  if (!manifest || !manifest.project) return { state: 'empty', manifest };
  try {
    const result = adapter.projectContext({ manifest, phase });
    if (!result || !['projected', 'unsupported', 'failed'].includes(result.state)) {
      return { state: 'failed', error: 'invalid_project_context_result' };
    }
    return { ...result, manifest };
  } catch (error) {
    return {
      state: 'failed',
      error: error && error.message ? String(error.message).slice(0, 300) : 'project_context_failed',
      manifest,
    };
  }
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
  let cas;
  if (options.sessionStore && typeof options.sessionStore.compareAndSetContextDelivery === 'function') {
    cas = options.sessionStore.compareAndSetContextDelivery(
      options.logicalSessionId || options.chatId,
      options.engine || options.host,
      key,
      { revision: manifest.revision, project: manifest.project, delivered_at: options.deliveredAt },
    );
  } else {
    const { compareAndSetDelivery } = require('./core/context-manifest');
    cas = compareAndSetDelivery(options.ledger || {}, key, {
      revision: manifest.revision,
      project: manifest.project,
      delivered_at: options.deliveredAt,
    });
  }
  if (!cas.delivered) return { state: 'skipped', reason: 'already_delivered', delivered: false, key, manifest, ledger: cas.ledger };
  const projected = projectContext({ adapter, manifest, phase });
  return { ...projected, delivered: projected.state === 'projected', key, ledger: cas.ledger };
}

module.exports = {
  PHASES,
  buildProjectContextManifest,
  deliverProjectContext,
  projectContext,
};
