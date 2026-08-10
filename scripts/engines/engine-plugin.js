'use strict';

const Ajv2020 = require('ajv/dist/2020');

/**
 * The final Engine Plugin contract.
 *
 * A plugin is the only unit accepted by the registry.  Runtime, Session
 * Source, and Cognitive Host are deliberately independent capabilities: a
 * plugin may expose any subset of them, but it may not claim a capability
 * which it does not provide.
 */

const ENGINE_PLUGIN_PROTOCOL_VERSION = 1;
const CAPABILITY_NAMES = Object.freeze(['runtime', 'sessionSource', 'cognitiveHost']);
const CAPABILITY_STATES = Object.freeze([
  'unsupported',
  'detected',
  'configured',
  'reachable',
  'verified',
]);
const ENGINE_ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const DESCRIPTOR_KEYS = Object.freeze([
  'id', 'displayName', 'vendor', 'executableNames', 'contextProjection',
  'nativeSessionKind', 'capabilities', 'configSchemaVersion',
  // Kept as read-only aliases for existing persisted/configured callers.
  'name', 'provider', 'sessionStorage', 'hostHook',
]);
const PLUGIN_KEYS = Object.freeze([
  'protocolVersion', 'descriptor', 'runtime', 'sessionSource', 'cognitiveHost',
]);

// Function-valued adapter operations are validated by createEnginePlugin();
// Ajv validates this versioned public manifest shape before semantic checks.
const ENGINE_PLUGIN_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://metame.local/schema/engine-plugin-v1.json',
  title: 'MetaMe Engine Plugin',
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'descriptor', 'runtime', 'sessionSource', 'cognitiveHost'],
  properties: {
    protocolVersion: { const: ENGINE_PLUGIN_PROTOCOL_VERSION },
    descriptor: { $ref: '#/$defs/descriptor' },
    runtime: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    sessionSource: { anyOf: [{ type: 'object' }, { type: 'null' }] },
    cognitiveHost: { anyOf: [{ type: 'object' }, { type: 'null' }] },
  },
  $defs: {
    descriptor: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'displayName', 'vendor', 'executableNames', 'contextProjection',
        'nativeSessionKind', 'capabilities', 'configSchemaVersion',
      ],
      properties: {
        id: { type: 'string', pattern: ENGINE_ID_RE.source },
        displayName: { type: 'string', minLength: 1 },
        vendor: { type: 'string', minLength: 1 },
        executableNames: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        contextProjection: { type: 'string', minLength: 1 },
        nativeSessionKind: { type: 'string', minLength: 1 },
        capabilities: { $ref: '#/$defs/capabilities' },
        configSchemaVersion: { type: 'integer', minimum: 1 },
        name: { type: 'string', pattern: ENGINE_ID_RE.source },
        provider: { type: 'string', minLength: 1 },
        sessionStorage: { type: 'string', minLength: 1 },
        hostHook: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: [...CAPABILITY_NAMES],
      properties: Object.fromEntries(CAPABILITY_NAMES.map(name => [name, {
        oneOf: [
          { type: 'boolean' },
          {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            properties: {
              state: { enum: [...CAPABILITY_STATES] },
              supported: { type: 'boolean' },
            },
          },
        ],
      }])),
    },
  },
});

const CAPABILITY_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://metame.local/schema/engine-capabilities-v1.json',
  type: 'object',
  additionalProperties: false,
  required: [...CAPABILITY_NAMES],
  properties: Object.fromEntries(CAPABILITY_NAMES.map(name => [name, {
    oneOf: [
      { type: 'boolean' },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: { enum: [...CAPABILITY_STATES] },
          supported: { type: 'boolean' },
        },
        minProperties: 1,
      },
    ],
  }])),
});

const AJV = new Ajv2020({ strict: true, allErrors: true });
const validatePluginDocument = AJV.compile(ENGINE_PLUGIN_SCHEMA);
const validateCapabilityDocument = AJV.compile(CAPABILITY_SCHEMA);

function contractError(code, detail = '') {
  const error = new TypeError(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function formatSchemaErrors(errors) {
  return (errors || []).map(error => ({
    code: `schema_${error.keyword}`,
    path: error.instancePath || '/',
    message: error.message || 'schema validation failed',
  }));
}

function validateSchemaDocument(validator, value) {
  const valid = !!validator(value);
  return {
    valid,
    errors: valid ? [] : formatSchemaErrors(validator.errors),
  };
}

function validateEnginePluginSchema(value) {
  return validateSchemaDocument(validatePluginDocument, value);
}

function validateCapabilitySchema(value) {
  return validateSchemaDocument(validateCapabilityDocument, value);
}

function assertPluginSchema(value) {
  const result = validateEnginePluginSchema(value);
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.path} ${error.message}`).join('; ');
    throw contractError('engine_plugin_schema_invalid', detail);
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item, seen);
  } else if (isPlainObject(value)) {
    for (const child of Object.values(value)) deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function normalizeEngineId(value) {
  const id = String(value || '').trim();
  if (!id || !ENGINE_ID_RE.test(id)) {
    throw contractError('engine_id_invalid', id || 'missing');
  }
  if (id !== id.toLowerCase()) throw contractError('engine_id_not_lowercase', id);
  return id;
}

function assertKnownKeys(value, allowed, code) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw contractError(code, key);
  }
}

function normalizeCapability(value, capabilityName) {
  if (typeof value === 'boolean') {
    return { state: value ? 'detected' : 'unsupported', supported: value };
  }
  if (!isPlainObject(value)) throw contractError('capability_invalid', capabilityName);
  assertKnownKeys(value, ['state', 'supported'], 'capability_property_unknown');
  const state = value.state === undefined ? null : String(value.state);
  if (state && !CAPABILITY_STATES.includes(state)) {
    throw contractError('capability_state_invalid', `${capabilityName}:${state}`);
  }
  if (value.supported !== undefined && typeof value.supported !== 'boolean') {
    throw contractError('capability_supported_invalid', capabilityName);
  }
  if (!state && value.supported === undefined) {
    throw contractError('capability_declaration_empty', capabilityName);
  }
  const supported = value.supported === undefined ? state !== 'unsupported' : value.supported;
  if (state === 'unsupported' && supported) {
    throw contractError('capability_state_mismatch', capabilityName);
  }
  if (state && state !== 'unsupported' && value.supported === false) {
    throw contractError('capability_state_mismatch', capabilityName);
  }
  return {
    ...(state ? { state } : {}),
    ...(value.supported === undefined ? {} : { supported }),
  };
}

function normalizeCapabilities(value) {
  if (!isPlainObject(value)) throw contractError('capabilities_required');
  assertKnownKeys(value, CAPABILITY_NAMES, 'capability_name_unknown');
  const missing = CAPABILITY_NAMES.filter(name => !Object.prototype.hasOwnProperty.call(value, name));
  if (missing.length) throw contractError('capability_declaration_required', missing.join(','));
  return Object.fromEntries(CAPABILITY_NAMES.map(name => [name, normalizeCapability(value[name], name)]));
}

function isDeeplyFrozen(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.keys(value).every(key => isDeeplyFrozen(value[key], seen));
}

function equivalentValue(left, right, seen = new Map()) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (seen.get(left) === right) return true;
  seen.set(left, right);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every(key => equivalentValue(left[key], right[key], seen));
}

function canReuseDescriptor(input, normalized) {
  if (!isDeeplyFrozen(input)) return false;
  // Compare every supplied field against the normalized contract.  This
  // permits omitted legacy aliases while preventing booleans, duplicate
  // executable names, or mutable nested capability values from bypassing
  // normalization.
  return Object.keys(input).every(key => equivalentValue(input[key], normalized[key]));
}

function normalizeDescriptor(input, { adapterPresence = {} } = {}) {
  if (!isPlainObject(input)) throw contractError('engine_descriptor_required');
  assertKnownKeys(input, DESCRIPTOR_KEYS, 'engine_descriptor_property_unknown');

  const id = normalizeEngineId(input.id || input.name);
  const displayName = String(input.displayName || input.name || id).trim();
  const vendor = String(input.vendor || input.provider || '').trim();
  const executableNames = input.executableNames === undefined ? [id] : input.executableNames;
  const contextProjection = String(input.contextProjection || '').trim();
  const nativeSessionKind = String(input.nativeSessionKind || input.sessionStorage || '').trim();
  const configSchemaVersion = input.configSchemaVersion === undefined ? 1 : input.configSchemaVersion;
  if (input.id !== undefined && input.name !== undefined && String(input.name).trim() !== id) {
    throw contractError('engine_descriptor_id_mismatch', id);
  }
  if (input.vendor !== undefined && input.provider !== undefined && String(input.provider).trim() !== vendor) {
    throw contractError('engine_descriptor_vendor_mismatch', id);
  }
  if (input.nativeSessionKind !== undefined && input.sessionStorage !== undefined
    && String(input.sessionStorage).trim() !== nativeSessionKind) {
    throw contractError('engine_descriptor_session_kind_mismatch', id);
  }
  if (!displayName) throw contractError('engine_descriptor_display_name_required', id);
  if (!vendor) throw contractError('engine_descriptor_vendor_required', id);
  if (!Array.isArray(executableNames) || executableNames.length === 0) {
    throw contractError('engine_descriptor_executables_required', id);
  }
  if (executableNames.some(name => typeof name !== 'string' || !name.trim())) {
    throw contractError('engine_descriptor_executable_invalid', id);
  }
  if (!contextProjection) throw contractError('engine_descriptor_context_projection_required', id);
  if (!nativeSessionKind) throw contractError('engine_descriptor_session_kind_required', id);
  if (!Number.isInteger(configSchemaVersion) || configSchemaVersion < 1) {
    throw contractError('engine_descriptor_config_schema_invalid', id);
  }
  const capabilities = normalizeCapabilities(input.capabilities || {
    runtime: adapterPresence.runtime === true,
    sessionSource: adapterPresence.sessionSource === true,
    cognitiveHost: adapterPresence.cognitiveHost === true,
  });
  const descriptor = {
    id,
    displayName,
    vendor,
    executableNames: [...new Set(executableNames.map(name => name.trim()))],
    contextProjection,
    nativeSessionKind,
    capabilities,
    configSchemaVersion,
    name: id,
    provider: vendor,
    sessionStorage: nativeSessionKind,
    hostHook: Object.prototype.hasOwnProperty.call(input, 'hostHook') ? input.hostHook : null,
  };
  if (descriptor.hostHook !== null && typeof descriptor.hostHook !== 'string') {
    throw contractError('engine_descriptor_host_hook_invalid', id);
  }
  // Built-in descriptors are already immutable and are shared by legacy
  // runtime callers.  Reuse those exact objects so the migration does not
  // change descriptor identity for existing consumers.
  if (canReuseDescriptor(input, descriptor)) return input;
  return deepFreeze(descriptor);
}

function capabilityIsSupported(capability) {
  return !!(capability && capability.supported !== false && capability.state !== 'unsupported');
}

function hasAdapterOperations(adapter, capabilityName) {
  if (adapter === null) return false;
  if (!isPlainObject(adapter) && typeof adapter !== 'object') {
    throw contractError('engine_adapter_invalid', capabilityName);
  }
  const operations = {
    runtime: ['probe', 'buildInvocation', 'parseEvent', 'classifyFailure', 'validateSession', 'updateSession'],
    sessionSource: ['discover', 'inspect', 'read', 'validate'],
    cognitiveHost: ['detect', 'inspectCapabilities', 'planInstall', 'verify'],
  }[capabilityName];
  if (capabilityName === 'runtime' && typeof adapter.runTurn === 'function') return true;
  // The capability boundaries are intentionally complete when present.  A
  // plugin may omit a whole capability, but a partial adapter cannot be
  // registered and later misreported as available.
  return operations.every(key => typeof adapter[key] === 'function');
}

function validateCapabilityAdapters(descriptor, adapters) {
  for (const name of CAPABILITY_NAMES) {
    const declared = capabilityIsSupported(descriptor.capabilities[name]);
    const present = adapters[name] !== null;
    if (declared !== present) {
      throw contractError('capability_adapter_mismatch', `${descriptor.id}:${name}`);
    }
    if (present && !hasAdapterOperations(adapters[name], name)) {
      throw contractError('capability_adapter_operations_required', `${descriptor.id}:${name}`);
    }
  }
}

function normalizeRuntimeAdapter(runtime, descriptor) {
  if (runtime === null) return null;
  if (!isPlainObject(runtime) && typeof runtime !== 'object') {
    throw contractError('runtime_adapter_invalid', descriptor.id);
  }
  // Existing native adapters already provide the legacy names.  The facade
  // adds final-contract names without changing their behavior or identity.
  const facade = { ...runtime, descriptor };
  if (typeof facade.buildInvocation !== 'function' && typeof runtime.buildArgs === 'function') {
    facade.buildInvocation = options => ({
      executable: runtime.binary,
      args: runtime.buildArgs(options),
      env: typeof runtime.buildEnv === 'function' ? runtime.buildEnv(options) : {},
      cwd: options && options.cwd ? options.cwd : '',
      stdin: runtime.stdinBehavior || 'write-and-close',
      killSignal: runtime.killSignal || 'SIGTERM',
      timeouts: runtime.timeouts || {},
    });
  }
  if (typeof facade.parseEvent !== 'function' && typeof runtime.parseStreamEvent === 'function') {
    facade.parseEvent = runtime.parseStreamEvent;
  }
  if (typeof facade.classifyFailure !== 'function' && typeof runtime.classifyError === 'function') {
    facade.classifyFailure = runtime.classifyError;
  }
  if (typeof facade.validateSession !== 'function' && typeof runtime.validateNativeSession === 'function') {
    facade.validateSession = runtime.validateNativeSession;
  }
  if (typeof facade.updateSession !== 'function' && typeof runtime.updateNativeSession === 'function') {
    facade.updateSession = runtime.updateNativeSession;
  }
  if (typeof facade.probe !== 'function') {
    facade.probe = () => ({ engineId: descriptor.id, state: 'detected' });
  }
  return deepFreeze(facade);
}

function normalizeAdapter(adapter, capabilityName, descriptor) {
  if (adapter === undefined) return null;
  if (adapter === null) return null;
  if (!isPlainObject(adapter) && typeof adapter !== 'object') {
    throw contractError('engine_adapter_invalid', `${descriptor.id}:${capabilityName}`);
  }
  return capabilityName === 'runtime'
    ? normalizeRuntimeAdapter(adapter, descriptor)
    : deepFreeze({ ...adapter });
}

function addRuntimeCompatibilityAliases(plugin) {
  const runtime = plugin.runtime;
  if (!runtime) return plugin;
  const aliases = new Set([
    'name', 'binary', 'nativeBinary', 'adapterPath', 'pluginConfig', 'defaultModel',
    'stdinBehavior', 'killSignal', 'timeouts', 'capabilities', 'nativeSession',
    'sessionPolicy', 'buildArgs', 'buildEnv', 'parseStreamEvent', 'classifyError',
    'acceptsNativeSession', 'validateNativeSession', 'updateNativeSession',
    'runTurn', 'projectContext', 'resolvePermissionProfile', 'formatSpawnError',
    'recoverFinalOutput', 'isReady',
  ]);
  for (const key of aliases) {
    if (key in runtime && !(key in plugin)) {
      Object.defineProperty(plugin, key, {
        value: runtime[key],
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
  }
  if (!Object.prototype.hasOwnProperty.call(plugin, 'name')) {
    Object.defineProperty(plugin, 'name', {
      value: plugin.descriptor.id,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  return plugin;
}

function createEnginePlugin(spec) {
  if (!isPlainObject(spec)) throw contractError('engine_plugin_required');
  assertKnownKeys(spec, PLUGIN_KEYS, 'engine_plugin_property_unknown');
  if (spec.protocolVersion !== ENGINE_PLUGIN_PROTOCOL_VERSION) {
    throw contractError('engine_plugin_protocol_unsupported', String(spec.protocolVersion));
  }
  const adapterPresence = Object.fromEntries(CAPABILITY_NAMES.map(name => [
    name,
    spec[name] !== undefined && spec[name] !== null,
  ]));
  const descriptor = normalizeDescriptor(spec.descriptor, { adapterPresence });
  const adapters = {
    runtime: normalizeAdapter(spec.runtime, 'runtime', descriptor),
    sessionSource: normalizeAdapter(spec.sessionSource, 'sessionSource', descriptor),
    cognitiveHost: normalizeAdapter(spec.cognitiveHost, 'cognitiveHost', descriptor),
  };
  const canonicalSpec = {
    protocolVersion: ENGINE_PLUGIN_PROTOCOL_VERSION,
    descriptor,
    runtime: adapters.runtime,
    sessionSource: adapters.sessionSource,
    cognitiveHost: adapters.cognitiveHost,
  };
  assertPluginSchema(canonicalSpec);
  validateCapabilityAdapters(descriptor, adapters);
  const plugin = canonicalSpec;
  addRuntimeCompatibilityAliases(plugin);
  return Object.freeze(plugin);
}

function isEnginePlugin(value) {
  try {
    if (!value || typeof value !== 'object' || !Object.isFrozen(value)) return false;
    createEnginePlugin({
      protocolVersion: value.protocolVersion,
      descriptor: value.descriptor,
      runtime: value.runtime,
      sessionSource: value.sessionSource,
      cognitiveHost: value.cognitiveHost,
    });
    return true;
  } catch {
    return false;
  }
}

function validateEnginePlugin(value) {
  try {
    const plugin = createEnginePlugin(value);
    const schemaResult = validateEnginePluginSchema(plugin);
    return schemaResult.valid
      ? { valid: true, errors: [], plugin }
      : schemaResult;
  } catch (error) {
    return {
      valid: false,
      errors: [{ code: error.code || 'engine_plugin_invalid', message: error.message }],
    };
  }
}

function negotiateCapabilities(plugin, requested = CAPABILITY_NAMES) {
  const names = Array.isArray(requested)
    ? requested
    : Object.keys(requested || {});
  const unknown = names.filter(name => !CAPABILITY_NAMES.includes(name));
  if (unknown.length) throw contractError('capability_name_unknown', unknown.join(','));
  const capabilities = Object.fromEntries(names.map(name => {
    const declaration = plugin.descriptor.capabilities[name];
    return [name, {
      state: declaration.state || (declaration.supported ? 'detected' : 'unsupported'),
      supported: capabilityIsSupported(declaration),
      available: plugin[name] !== null,
    }];
  }));
  const unsupported = Object.entries(capabilities)
    .filter(([, value]) => !value.supported)
    .map(([name]) => name);
  return Object.freeze({
    engineId: plugin.descriptor.id,
    capabilities: deepFreeze(capabilities),
    ok: unsupported.length === 0,
    unsupported: Object.freeze(unsupported),
  });
}

/**
 * Deterministic high-level seam used by future plugins before registration.
 * It exercises the public contract and capability negotiation without
 * launching a Host or touching native session state.
 */
function runEnginePluginConformance(plugin, options = {}) {
  const checked = createEnginePlugin(plugin);
  const schema = validateEnginePluginSchema(checked);
  const requiredCapabilities = options.requiredCapabilities || CAPABILITY_NAMES.filter(name => (
    capabilityIsSupported(checked.descriptor.capabilities[name])
  ));
  const negotiation = negotiateCapabilities(checked, requiredCapabilities);
  const checks = {
    immutable: Object.isFrozen(checked)
      && Object.isFrozen(checked.descriptor)
      && Object.isFrozen(checked.descriptor.capabilities),
    protocolVersion: checked.protocolVersion === ENGINE_PLUGIN_PROTOCOL_VERSION,
    schema: schema.valid,
    capabilityNegotiation: negotiation.ok,
  };
  return Object.freeze({
    ok: Object.values(checks).every(Boolean),
    engineId: checked.descriptor.id,
    protocolVersion: checked.protocolVersion,
    checks: Object.freeze(checks),
    negotiation,
    plugin: checked,
  });
}

module.exports = {
  CAPABILITY_NAMES,
  CAPABILITY_STATES,
  ENGINE_ID_RE,
  ENGINE_PLUGIN_PROTOCOL_VERSION,
  ENGINE_PLUGIN_SCHEMA,
  CAPABILITY_SCHEMA,
  createEnginePlugin,
  defineEnginePlugin: createEnginePlugin,
  isEnginePlugin,
  negotiateCapabilities,
  runEnginePluginConformance,
  validateCapabilitySchema,
  validateEnginePluginSchema,
  validateEnginePlugin,
  _internal: {
    deepFreeze,
    isDeeplyFrozen,
    canReuseDescriptor,
    equivalentValue,
    normalizeCapability,
    normalizeCapabilities,
    normalizeDescriptor,
    normalizeEngineId,
  },
};
