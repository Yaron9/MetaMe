'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPABILITY_NAMES,
  createEnginePlugin,
  negotiateCapabilities,
  runEnginePluginConformance,
  validateCapabilitySchema,
  validateEnginePluginSchema,
  validateEnginePlugin,
} = require('./engine-plugin');
const { createEngineRegistry } = require('./engine-registry');
const { normalizeEngineName } = require('../daemon-utils');

function runtimeFixture() {
  return {
    runTurn: async request => ({ final: request && request.input || '' }),
    buildInvocation: () => ({ executable: '/fixture/agent', args: [], env: {} }),
    parseEvent: () => [],
    classifyFailure: () => null,
    validateSession: () => true,
    updateSession: session => session,
    probe: () => ({ state: 'verified' }),
  };
}

function pluginFixture(overrides = {}) {
  return createEnginePlugin({
    protocolVersion: 1,
    descriptor: {
      id: 'fixture-agent',
      displayName: 'Fixture Agent',
      vendor: 'metame-test',
      executableNames: ['fixture-agent'],
      contextProjection: 'none',
      nativeSessionKind: 'fixture-session',
      configSchemaVersion: 1,
      capabilities: {
        runtime: { state: 'verified' },
        sessionSource: { state: 'unsupported' },
        cognitiveHost: { state: 'unsupported' },
      },
    },
    runtime: runtimeFixture(),
    sessionSource: null,
    cognitiveHost: null,
    ...overrides,
  });
}

test('Engine Plugin is immutable and independently declares capabilities', () => {
  const plugin = pluginFixture();
  assert.ok(Object.isFrozen(plugin));
  assert.ok(Object.isFrozen(plugin.descriptor));
  assert.ok(Object.isFrozen(plugin.descriptor.capabilities));
  assert.ok(Object.isFrozen(plugin.runtime));
  assert.equal(plugin.descriptor.id, 'fixture-agent');
  assert.equal(plugin.name, 'fixture-agent', 'legacy runtime access remains available');
  assert.deepEqual(negotiateCapabilities(plugin).capabilities, {
    runtime: { state: 'verified', supported: true, available: true },
    sessionSource: { state: 'unsupported', supported: false, available: false },
    cognitiveHost: { state: 'unsupported', supported: false, available: false },
  });

  assert.throws(() => {
    plugin.descriptor.id = 'changed';
  }, TypeError);
  assert.equal(plugin.descriptor.id, 'fixture-agent');
});

test('capability absence is valid, while a declared-but-missing capability is rejected', () => {
  const sourceOnly = pluginFixture({
    descriptor: {
      id: 'source-only',
      displayName: 'Source Only',
      vendor: 'metame-test',
      executableNames: ['source-only'],
      contextProjection: 'none',
      nativeSessionKind: 'fixture-session',
      configSchemaVersion: 1,
      capabilities: {
        runtime: false,
        sessionSource: { state: 'verified' },
        cognitiveHost: false,
      },
    },
    runtime: null,
    sessionSource: {
      probe: () => ({ state: 'verified' }),
      discover: () => [],
      inspect: () => null,
      read: () => [],
      validate: () => true,
    },
  });
  assert.equal(sourceOnly.runtime, null);
  assert.equal(sourceOnly.sessionSource !== null, true);
  assert.deepEqual(negotiateCapabilities(sourceOnly, ['runtime', 'sessionSource']).unsupported, ['runtime']);

  assert.throws(() => pluginFixture({
    descriptor: {
      ...pluginFixture().descriptor,
      id: 'missing-runtime',
      name: 'missing-runtime',
      capabilities: { runtime: { state: 'verified' }, sessionSource: false, cognitiveHost: false },
    },
    runtime: null,
  }), /capability_adapter_mismatch/);

  for (const malformedCapabilities of [null, false]) {
    assert.throws(() => pluginFixture({
      descriptor: {
        ...pluginFixture().descriptor,
        id: `malformed-capabilities-${String(malformedCapabilities)}`,
        name: `malformed-capabilities-${String(malformedCapabilities)}`,
        capabilities: malformedCapabilities,
      },
      runtime: null,
    }), /capabilities_required/);
  }
});

test('registry rejects malformed and duplicate plugins and distinguishes unknown from explicit fallback', () => {
  const fixture = pluginFixture();
  const registry = createEngineRegistry([fixture], { defaultEngineId: 'fixture-agent' });
  assert.equal(registry.lookup('missing'), null);
  assert.equal(registry.get('missing'), null, 'generic registries never hide an unknown Engine');
  assert.deepEqual(registry.resolve('missing'), {
    requestedId: 'missing', engineId: null, plugin: null, fallback: false, reason: 'unknown_engine',
  });
  const fallback = registry.resolve('missing', { fallbackEngine: 'fixture-agent' });
  assert.equal(fallback.engineId, 'fixture-agent');
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.reason, 'unknown_engine');
  assert.throws(() => createEngineRegistry([fixture, fixture]), /duplicate_engine_plugin/);
  assert.throws(() => createEngineRegistry([{
    protocolVersion: 1,
    descriptor: { id: 'bad id' },
    runtime: null,
    sessionSource: null,
    cognitiveHost: null,
  }]), /engine_id_invalid/);

  assert.equal(registry.remove('fixture-agent'), true);
  assert.equal(registry.lookup('fixture-agent'), null);
  assert.throws(() => registry.register(fixture), /engine_id_reused/);
});

test('strict lookup preserves unknown IDs when a legacy normalizer defaults to Claude', () => {
  const claude = pluginFixture({ descriptor: {
    id: 'claude', displayName: 'Claude', vendor: 'test', executableNames: ['claude'],
    contextProjection: 'none', nativeSessionKind: 'fixture', configSchemaVersion: 1,
    capabilities: { runtime: { state: 'verified' }, sessionSource: false, cognitiveHost: false },
  } });
  const codex = pluginFixture({ descriptor: {
    id: 'codex', displayName: 'Codex', vendor: 'test', executableNames: ['codex'],
    contextProjection: 'none', nativeSessionKind: 'fixture', configSchemaVersion: 1,
    capabilities: { runtime: { state: 'verified' }, sessionSource: false, cognitiveHost: false },
  } });
  const registry = createEngineRegistry([claude, codex], {
    normalizeEngineName,
    defaultEngineId: 'claude',
    legacyFallback: true,
  });
  assert.equal(registry.lookup('missing'), null);
  assert.deepEqual(registry.resolve('missing'), {
    requestedId: 'missing', engineId: null, plugin: null, fallback: false, reason: 'unknown_engine',
  });
  const fallback = registry.resolve('missing', { fallbackEngine: 'codex' });
  assert.equal(fallback.requestedId, 'missing');
  assert.equal(fallback.engineId, 'codex');
  assert.equal(fallback.fallback, true);
});

test('shallow-frozen descriptors are copied into a deeply immutable contract graph', () => {
  const descriptor = {
    id: 'shallow-agent',
    displayName: 'Shallow Agent',
    vendor: 'metame-test',
    executableNames: ['shallow-agent'],
    contextProjection: 'none',
    nativeSessionKind: 'fixture-session',
    configSchemaVersion: 1,
    capabilities: {
      runtime: { state: 'verified' },
      sessionSource: { state: 'unsupported' },
      cognitiveHost: { state: 'unsupported' },
    },
  };
  Object.freeze(descriptor);
  const plugin = createEnginePlugin({
    protocolVersion: 1,
    descriptor,
    runtime: runtimeFixture(),
    sessionSource: null,
    cognitiveHost: null,
  });
  assert.notEqual(plugin.descriptor, descriptor);
  assert.ok(Object.isFrozen(plugin.descriptor.executableNames));
  assert.ok(Object.isFrozen(plugin.descriptor.capabilities.runtime));
  descriptor.executableNames.push('mutated');
  descriptor.capabilities.runtime.state = 'unsupported';
  assert.deepEqual(plugin.descriptor.executableNames, ['shallow-agent']);
  assert.equal(plugin.descriptor.capabilities.runtime.state, 'verified');
});

test('constructor canonicalizes legacy descriptor aliases and omitted unsupported adapters', () => {
  const legacyInput = {
    protocolVersion: 1,
    descriptor: {
      name: 'legacy-agent',
      provider: 'metame-test',
      contextProjection: 'none',
      sessionStorage: 'legacy-session',
      hostHook: null,
    },
    runtime: runtimeFixture(),
  };
  assert.equal(validateEnginePluginSchema(legacyInput).valid, false, 'raw legacy form is not the manifest schema');
  const plugin = createEnginePlugin(legacyInput);
  assert.equal(plugin.descriptor.id, 'legacy-agent');
  assert.equal(plugin.descriptor.displayName, 'legacy-agent');
  assert.deepEqual(plugin.descriptor.executableNames, ['legacy-agent']);
  assert.equal(plugin.descriptor.configSchemaVersion, 1);
  assert.equal(plugin.sessionSource, null);
  assert.equal(plugin.cognitiveHost, null);
  assert.equal(validateEnginePlugin(legacyInput).valid, true, 'constructor validator accepts canonicalizable compatibility input');
  assert.equal(runEnginePluginConformance(legacyInput).ok, true);

  const omittedAdapters = createEnginePlugin({
    protocolVersion: 1,
    descriptor: {
      id: 'runtime-only',
      displayName: 'Runtime Only',
      vendor: 'metame-test',
      executableNames: ['runtime-only'],
      contextProjection: 'none',
      nativeSessionKind: 'runtime-session',
      configSchemaVersion: 1,
      capabilities: { runtime: { state: 'verified' }, sessionSource: false, cognitiveHost: false },
    },
    runtime: runtimeFixture(),
  });
  assert.equal(omittedAdapters.sessionSource, null);
  assert.equal(omittedAdapters.cognitiveHost, null);
  assert.equal(validateEnginePluginSchema(omittedAdapters).valid, true);
});

test('frozen legacy alias-only descriptors are normalized instead of reused', () => {
  const descriptor = {
    name: 'frozen-legacy-agent',
    provider: 'metame-test',
    contextProjection: 'none',
    sessionStorage: 'legacy-session',
    hostHook: null,
  };
  Object.freeze(descriptor);
  const plugin = createEnginePlugin({
    protocolVersion: 1,
    descriptor,
    runtime: runtimeFixture(),
  });
  assert.notEqual(plugin.descriptor, descriptor);
  assert.equal(plugin.descriptor.id, 'frozen-legacy-agent');
  assert.equal(plugin.descriptor.configSchemaVersion, 1);
  assert.ok(Object.prototype.hasOwnProperty.call(plugin.descriptor, 'capabilities'));
  assert.ok(Object.isFrozen(plugin.descriptor.capabilities));
});

test('Ajv strict schemas reject unknown public fields and malformed capability declarations', () => {
  const plugin = pluginFixture();
  const malformedPlugin = { ...plugin, unexpected: true };
  const pluginResult = validateEnginePluginSchema(malformedPlugin);
  assert.equal(pluginResult.valid, false);
  assert.ok(pluginResult.errors.some(error => error.code === 'schema_additionalProperties'));
  assert.equal(validateEnginePlugin(malformedPlugin).valid, false);

  const capabilityResult = validateCapabilitySchema({
    runtime: true,
    sessionSource: false,
    cognitiveHost: false,
    unexpected: true,
  });
  assert.equal(capabilityResult.valid, false);
  assert.ok(capabilityResult.errors.some(error => error.code === 'schema_additionalProperties'));
});

test('the deterministic public conformance seam validates a plugin without launching a Host', () => {
  const report = runEnginePluginConformance(pluginFixture());
  assert.equal(report.ok, true);
  assert.equal(report.engineId, 'fixture-agent');
  assert.deepEqual(Object.keys(report.checks), ['immutable', 'protocolVersion', 'schema', 'capabilityNegotiation']);
  assert.deepEqual(CAPABILITY_NAMES, ['runtime', 'sessionSource', 'cognitiveHost']);
  assert.equal(validateEnginePlugin(pluginFixture()).valid, true);
  assert.equal(validateEnginePlugin({}).valid, false);
});
