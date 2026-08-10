'use strict';

const {
  wrapSessionSourceAdapter,
} = require('./session-source-adapter');
const {
  fingerprintSourceRevision,
  normalizeSessionRef,
} = require('./session-source-revision');
const {
  claimExtractionLease,
  completeExtractionRun,
  failExtractionRun,
  markSessionSourceMissing,
  updateSessionSourceProgress,
  upsertSessionSource,
} = require('./session-source-db');

const DEFAULT_MAX_EVENTS = 100000;

function ingestionError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function requireIngestionOptions(options) {
  if (!options || typeof options !== 'object') throw ingestionError('session_source_ingestion_options_required');
  if (!options.db) throw ingestionError('session_source_ingestion_database_required');
  if (!options.adapter) throw ingestionError('session_source_ingestion_adapter_required');
  if (!options.sessionRef) throw ingestionError('session_source_ingestion_ref_required');
  if (!options.pipelineVersion && !options.pipeline_version) throw ingestionError('extraction_pipeline_version_required');
}

function sourceMetadata(ref, revision, validation = null) {
  const sourceHash = revision && (revision.sourceHash || revision.sourceRevision)
    || ref.sourceRevision
    || ref.sourceHash
    || fingerprintSourceRevision({
      engineId: ref.engineId,
      nativeSessionId: ref.nativeSessionId,
      sourceLocator: ref.sourceLocator,
    });
  return {
    engineId: ref.engineId,
    nativeSessionId: ref.nativeSessionId,
    project: ref.project || '*',
    scope: ref.scope || null,
    cwd: ref.cwd || null,
    sourceLocator: ref.sourceLocator,
    sourceHash,
    sourceSize: revision && revision.sourceSize || 0,
    firstTs: revision && revision.firstTs || null,
    lastTs: revision && revision.lastTs || null,
    messageCount: revision && revision.messageCount || 0,
    toolCallCount: revision && revision.toolCallCount || 0,
    toolErrorCount: revision && revision.toolErrorCount || 0,
    adapterProtocolVersion: revision && revision.adapterProtocolVersion || 1,
    discoveryCursor: revision && revision.cursor || null,
    lastIngestedSequence: revision && revision.lastIngestedSequence || 0,
    parentNativeSessionId: revision && revision.parentNativeSessionId || ref.parentNativeSessionId || null,
    classification: revision && revision.classification || 'conversation',
    ...(validation && !validation.valid ? {
      sourceState: 'missing',
      status: 'error',
      validationCode: validation.errorCode || validation.code || 'SOURCE_INVALID',
      errorCode: validation.errorCode || validation.code || 'SOURCE_INVALID',
      errorMessage: validation.detail || 'session source is not available',
    } : {}),
  };
}

async function ingestSessionSource(options) {
  requireIngestionOptions(options);
  const source = wrapSessionSourceAdapter(options.adapter, { engineId: options.engineId });
  const ref = normalizeSessionRef(options.sessionRef, { engineId: source.engineId });
  let validation = null;
  if (options.validate !== false) validation = await source.validate(ref);

  let revision = null;
  try {
    revision = await source.inspect(ref);
  } catch (error) {
    if (validation && !validation.valid) {
      const metadata = sourceMetadata(ref, null, validation);
      const saved = upsertSessionSource(options.db, metadata);
      markSessionSourceMissing(options.db, saved.id, validation.errorCode || 'SOURCE_MISSING', validation.detail);
      return { ok: false, reason: validation.errorCode || 'SOURCE_MISSING', validation, sourceId: saved.id, events: [] };
    }
    throw error;
  }

  const metadata = sourceMetadata(ref, revision, validation);
  const saved = upsertSessionSource(options.db, metadata);
  if (validation && !validation.valid) {
    markSessionSourceMissing(options.db, saved.id, validation.errorCode || 'SOURCE_INVALID', validation.detail);
    return { ok: false, reason: validation.errorCode || 'SOURCE_INVALID', validation, sourceId: saved.id, revision, events: [] };
  }

  const lease = claimExtractionLease(options.db, {
    sessionSourceId: saved.id,
    pipelineVersion: options.pipelineVersion || options.pipeline_version,
    leaseMs: options.leaseMs ?? options.lease_ms,
    leaseToken: options.leaseToken ?? options.lease_token,
    now: options.now,
  });
  if (!lease.claimed) {
    return {
      ok: lease.ok,
      skipped: lease.terminal === true,
      reason: lease.reason,
      sourceId: saved.id,
      revision,
      run: lease.run,
      events: [],
    };
  }

  const events = [];
  const maxEvents = Math.min(Math.max(Number(options.maxEvents) || DEFAULT_MAX_EVENTS, 1), DEFAULT_MAX_EVENTS);
  const readCursor = options.cursor !== undefined
    ? options.cursor
    : options.readRequest && options.readRequest.cursor !== undefined
      ? options.readRequest.cursor
      : revision.cursor;
  try {
    for await (const event of source.read({ ...ref, sourceRevision: revision.sourceRevision }, {
      ...(options.readRequest || {}),
      sourceRevision: revision.sourceRevision,
      cursor: readCursor,
    })) {
      if (events.length >= maxEvents) throw ingestionError('SESSION_SOURCE_EVENT_LIMIT');
      events.push(event);
    }
    const lastSequence = events.length ? events[events.length - 1].sequence : revision.lastIngestedSequence;
    updateSessionSourceProgress(options.db, saved.id, {
      discoveryCursor: revision.cursor,
      lastIngestedSequence: lastSequence,
    });
    const completed = completeExtractionRun(options.db, {
      runId: lease.run.id,
      leaseToken: lease.leaseToken,
      metrics: {
        events: events.length,
        sourceBytes: revision.sourceSize,
        lastSequence,
      },
      now: options.now,
    });
    return {
      ok: completed.ok,
      skipped: false,
      sourceId: saved.id,
      revision,
      run: completed.run,
      events,
    };
  } catch (error) {
    const failed = failExtractionRun(options.db, {
      runId: lease.run.id,
      leaseToken: lease.leaseToken,
      errorCode: error.code || 'SESSION_SOURCE_READ_FAILED',
      errorMessage: error.message,
      metrics: { events: events.length, sourceBytes: revision.sourceSize },
      now: options.now,
    });
    return {
      ok: false,
      sourceId: saved.id,
      revision,
      run: failed.run,
      events,
      errorCode: failed.run && failed.run.error_code,
    };
  }
}

async function ingestDiscoveredSessions(options) {
  requireIngestionOptions({ ...options, sessionRef: options.sessionRef || {} });
  const source = wrapSessionSourceAdapter(options.adapter, { engineId: options.engineId });
  const results = [];
  for await (const sessionRef of source.discover(options.discoveryRequest || {})) {
    results.push(await ingestSessionSource({ ...options, sessionRef }));
  }
  return results;
}

module.exports = {
  ingestSessionSource,
  processSessionSource: ingestSessionSource,
  ingestSourceRevision: ingestSessionSource,
  ingestDiscoveredSessions,
  _internal: {
    ingestionError,
    requireIngestionOptions,
    sourceMetadata,
  },
};
