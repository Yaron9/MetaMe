'use strict';

const path = require('node:path');
const {
  createSessionSourceAdapter,
} = require('./session-source-adapter');
const {
  createEnginePlugin,
} = require('./engine-plugin');
const {
  EXTERNAL_ADAPTER_PROTOCOL_VERSION,
  validateProtocolRecord,
  redactText,
} = require('../core/external-adapter-protocol');
const {
  buildMinimalEnvironment,
  createExternalAdapterClient,
  normalizeExternalAdapterManifest,
  resolveExternalAdapterExecutable,
  resolveSelectedProjectCwd,
} = require('./external-adapter-client');

function pluginError(code, detail = '') {
  const error = new TypeError(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function capabilityState(supported) {
  return { state: supported ? 'configured' : 'unsupported', supported };
}

function hasRuntimeCapability(manifest) {
  return manifest.capabilities.probe && manifest.capabilities.run;
}

function hasSessionSourceCapability(manifest) {
  return manifest.capabilities.probe
    && manifest.capabilities['session.discover']
    && manifest.capabilities['session.inspect']
    && manifest.capabilities['session.read'];
}

function normalizeRunEvent(record) {
  const candidate = record && record.type === 'event' ? record : {
    type: 'event',
    operation: 'run',
    correlationId: 'plugin-event',
    event: record,
  };
  const checked = validateProtocolRecord(candidate);
  if (!checked.valid) throw pluginError('EXTERNAL_ADAPTER_EVENT_INVALID', checked.errors.map(error => error.message).join('; '));
  return Object.freeze({ ...candidate.event });
}

function classifyExternalFailure(failure) {
  const code = String(failure && (failure.code || failure.errorCode) || 'EXTERNAL_ADAPTER_FAILED').toUpperCase();
  const message = redactText(failure && (failure.message || failure.detail) || code, 1024);
  return Object.freeze({ code, message, retryable: /^EXTERNAL_ADAPTER_(TIMEOUT|CRASHED|SPAWN_FAILED)$/.test(code) });
}

function updateNativeSession(previous, observation) {
  const prior = previous && typeof previous === 'object' ? previous : {};
  const next = observation && typeof observation === 'object' ? observation : {};
  const sessionId = next.nativeSessionId || next.sessionId;
  const sourceRevision = next.sourceRevision || next.sourceHash;
  return Object.freeze({
    ...prior,
    ...(sessionId ? { nativeSessionId: sessionId } : {}),
    ...(sourceRevision ? { sourceRevision } : {}),
    engineId: next.engineId || prior.engineId || null,
  });
}

function createRuntimeAdapter({ manifest, projectCwd, getClient }) {
  return {
    protocolVersion: EXTERNAL_ADAPTER_PROTOCOL_VERSION,
    descriptor: null,
    probe: context => getClient().then(client => client.probe(context)),
    buildInvocation: options => {
      const executable = resolveExternalAdapterExecutable(manifest);
      const cwd = resolveSelectedProjectCwd(
        options && options.cwd ? options.cwd : projectCwd,
        manifest.allowedProjects,
      );
      return Object.freeze({
        executable,
        args: [...manifest.executable.args],
        env: buildMinimalEnvironment(process.env, { allowlist: manifest.environmentAllowlist }),
        cwd,
        stdin: 'strict-lf-json',
        outputFraming: 'strict-lf-json',
        shell: false,
        killSignal: 'SIGTERM',
        timeouts: manifest.limits || {},
      });
    },
    parseEvent: nativeRecord => {
      if (!nativeRecord) return [];
      return [normalizeRunEvent(nativeRecord)];
    },
    classifyFailure: classifyExternalFailure,
    validateSession: (nativeSession, context) => getClient().then(client => client.validateSession(nativeSession, context)),
    updateSession: updateNativeSession,
    run: (request, options) => getClient().then(client => client.run(request, options)),
    runTurn: (request, options) => getClient().then(client => client.run(request, options)),
    cancel: (target, options) => getClient().then(client => client.cancel(target, options)),
    shutdown: options => getClient().then(client => client.shutdown(options)),
  };
}

function createSessionSource({ manifest, getClient }) {
  return createSessionSourceAdapter({
    engineId: manifest.engineId,
    protocolVersion: EXTERNAL_ADAPTER_PROTOCOL_VERSION,
    probe: context => getClient().then(client => client.probe(context)),
    discover: async function* discover(request) {
      for (const ref of await getClient().then(client => client.sessionDiscover(request))) yield ref;
    },
    inspect: (ref) => getClient().then(client => client.sessionInspect(ref)),
    read: async function* read(ref, request) {
      for (const event of await getClient().then(client => client.sessionRead(ref, request))) yield event;
    },
    validate: ref => getClient().then(client => client.validateSession(ref)),
  });
}

/**
 * Build an Engine Plugin backed by an explicitly installed external adapter.
 * The returned plugin is registered through the normal Engine Plugin seam;
 * core routing and ingestion do not receive an external-adapter branch.
 */
function createExternalAdapterPlugin(options = {}) {
  const manifest = normalizeExternalAdapterManifest(options.manifest || options);
  const projectCwd = String(options.projectCwd || options.cwd || '').trim();
  if (!projectCwd) throw pluginError('EXTERNAL_ADAPTER_PROJECT_CWD_REQUIRED');
  let client = options.client || null;
  let startPromise = null;
  const getClient = () => {
    if (!client) client = createExternalAdapterClient({
      manifest,
      projectCwd,
      ...(options.clientOptions || {}),
    });
    return client;
  };
  const readyClient = () => {
    const current = getClient();
    if (current.initialized) return Promise.resolve(current);
    if (!startPromise) {
      startPromise = current.start().then(() => current).finally(() => { startPromise = null; });
    }
    return startPromise;
  };
  const runtimeSupported = hasRuntimeCapability(manifest);
  const sourceSupported = hasSessionSourceCapability(manifest);
  const descriptor = {
    id: manifest.engineId,
    displayName: manifest.displayName || manifest.engineId,
    vendor: manifest.vendor || 'external',
    executableNames: [path.basename(manifest.executable.path)],
    contextProjection: 'external-adapter',
    nativeSessionKind: 'external-adapter-jsonl',
    configSchemaVersion: 1,
    capabilities: {
      runtime: capabilityState(runtimeSupported),
      sessionSource: capabilityState(sourceSupported),
      cognitiveHost: capabilityState(false),
    },
  };
  const runtime = runtimeSupported ? createRuntimeAdapter({ manifest, projectCwd, getClient: readyClient }) : null;
  const sessionSource = sourceSupported ? createSessionSource({ manifest, getClient: readyClient }) : null;
  return createEnginePlugin({
    protocolVersion: 1,
    descriptor,
    runtime,
    sessionSource,
    cognitiveHost: null,
  });
}

const createExternalAdapterEnginePlugin = createExternalAdapterPlugin;

module.exports = {
  createExternalAdapterEnginePlugin,
  createExternalAdapterPlugin,
  _internal: {
    classifyExternalFailure,
    createRuntimeAdapter,
    createSessionSource,
    hasRuntimeCapability,
    hasSessionSourceCapability,
    normalizeRunEvent,
    pluginError,
    updateNativeSession,
  },
};
