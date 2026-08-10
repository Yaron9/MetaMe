'use strict';

const { executeNativeCliTurn } = require('./native-cli-turn');

const REQUIRED_FUNCTIONS = Object.freeze([
  'buildArgs',
  'buildEnv',
  'parseStreamEvent',
  'classifyError',
  'acceptsNativeSession',
  'validateNativeSession',
  'updateNativeSession',
]);

/**
 * Convert the small legacy adapter event records into the versioned runtime
 * vocabulary.  Native parsers remain engine-owned; only this boundary knows
 * how their records map to events consumed by the Run Coordinator.
 */
function normalizeRuntimeEvents(events) {
  const normalized = [];
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue;
    const raw = event.raw;
    if (event.type === 'session') {
      const sessionEvent = { ...event };
      delete sessionEvent.sessionId;
      normalized.push({
        ...sessionEvent,
        type: 'session_observed',
        nativeSessionId: event.nativeSessionId || event.sessionId,
        raw,
      });
      continue;
    }
    if (event.type === 'text') {
      normalized.push({ ...event, type: 'message_delta', raw });
      continue;
    }
    if (event.type === 'thinking') {
      normalized.push({ ...event, type: 'thinking_delta', raw });
      continue;
    }
    if (event.type === 'tool_use') {
      normalized.push({ ...event, type: 'tool_started', raw });
      continue;
    }
    if (event.type === 'tool_result') {
      normalized.push({ ...event, type: 'tool_finished', raw });
      continue;
    }
    if (event.type === 'tool_update') {
      normalized.push({ ...event, type: 'tool_updated', raw });
      continue;
    }
    if (event.type === 'usage') {
      normalized.push({ ...event, type: 'usage_observed', raw });
      continue;
    }
    if (event.type === 'done') {
      if (event.usage) normalized.push({ type: 'usage_observed', usage: event.usage, raw });
      normalized.push({ ...event, type: 'run_completed', raw });
      continue;
    }
    if (event.type === 'error') {
      normalized.push({ ...event, type: 'run_failed', raw });
    }
  }
  return normalized;
}

function defineNativeCliAdapter(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('native_cli_adapter_spec_required');
  }

  const name = String(spec.name || '').trim().toLowerCase();
  if (!name) throw new TypeError('native_cli_adapter_name_required');
  if (!spec.descriptor || spec.descriptor.name !== name) {
    throw new TypeError(`native_cli_adapter_descriptor_mismatch:${name}`);
  }
  if (!spec.descriptor.contextProjection || !spec.descriptor.sessionStorage) {
    throw new TypeError(`native_cli_adapter_descriptor_incomplete:${name}`);
  }
  for (const key of REQUIRED_FUNCTIONS) {
    if (typeof spec[key] !== 'function') {
      throw new TypeError(`native_cli_adapter_function_required:${name}:${key}`);
    }
  }

  const adapter = {
    ...spec,
    name,
    capabilities: Object.freeze({ ...(spec.capabilities || {}) }),
    timeouts: Object.freeze({ ...(spec.timeouts || {}) }),
    nativeSession: Object.freeze({
      storage: spec.descriptor.sessionStorage,
      opaque: true,
    }),
  };

  // Final Engine Plugin runtime operations.  The legacy operation names above
  // remain adapter internals/compatibility reads, while all orchestration
  // crosses this boundary through these methods.
  adapter.probe = typeof spec.probe === 'function'
    ? spec.probe
    : (() => ({ engineId: name, state: 'detected' }));
  adapter.buildInvocation = (options = {}) => {
    const session = options.session || options.nativeSession || {};
    const cwd = options.cwd || session.cwd || '';
    const executable = adapter.binary;
    const args = adapter.buildArgs({ ...options, session });
    const env = adapter.buildEnv({ ...options, session });
    return Object.freeze({
      engine: name,
      executable,
      // `binary` is retained as a read-only result alias for existing process
      // helpers; callers should use `executable` at the final boundary.
      binary: executable,
      args,
      env,
      cwd,
      input: options.input === undefined ? '' : options.input,
      stdinStrategy: adapter.stdinBehavior || 'write-and-close',
      stdin: adapter.stdinBehavior || 'write-and-close',
      outputFraming: options.outputFormat || options.outputFraming || adapter.outputFraming || '',
      killSignal: adapter.killSignal || 'SIGTERM',
      timeouts: adapter.timeouts || {},
    });
  };
  adapter.parseEvent = (nativeRecord) => normalizeRuntimeEvents(
    adapter.parseStreamEvent(nativeRecord)
  );
  adapter.classifyFailure = value => adapter.classifyError(value);
  adapter.validateSession = session => {
    if (!adapter.acceptsNativeSession(session)) {
      throw new Error(`${name}_native_session_mismatch`);
    }
    return adapter.validateNativeSession(session);
  };
  adapter.updateSession = (session, observation) => adapter.updateNativeSession(session, observation);
  adapter.runTurn = request => executeNativeCliTurn(adapter, request);
  return Object.freeze(adapter);
}

function acceptsEngineScopedSession(engineName, session) {
  if (!session || typeof session !== 'object') return true;
  const sessionEngine = String(session.engine || '').trim().toLowerCase();
  if (!sessionEngine) return true;
  return sessionEngine === String(engineName || '').trim().toLowerCase();
}

function createNativeSessionValidator(engineName, validateNativeSession) {
  return session => {
    if (!acceptsEngineScopedSession(engineName, session)) return false;
    if (
      !session
      || !session.started
      || !session.id
      || session.id === '__continue__'
      || !session.cwd
    ) return true;
    if (typeof validateNativeSession !== 'function') return true;
    return validateNativeSession(engineName, session.id, session.cwd);
  };
}

module.exports = {
  defineNativeCliAdapter,
  acceptsEngineScopedSession,
  createNativeSessionValidator,
  normalizeRuntimeEvents,
};
