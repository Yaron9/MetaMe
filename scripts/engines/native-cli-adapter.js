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
};
