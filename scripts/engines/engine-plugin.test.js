'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CAPABILITY_NAMES,
  createEnginePlugin,
  negotiateCapabilities,
  runEnginePluginConformance,
  validateEnginePlugin,
} = require('./engine-plugin');
const { createEngineRegistry } = require('./engine-registry');

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

test('the deterministic public conformance seam validates a plugin without launching a Host', () => {
  const report = runEnginePluginConformance(pluginFixture());
  assert.equal(report.ok, true);
  assert.equal(report.engineId, 'fixture-agent');
  assert.deepEqual(Object.keys(report.checks), ['immutable', 'protocolVersion', 'capabilityNegotiation']);
  assert.deepEqual(CAPABILITY_NAMES, ['runtime', 'sessionSource', 'cognitiveHost']);
  assert.equal(validateEnginePlugin(pluginFixture()).valid, true);
  assert.equal(validateEnginePlugin({}).valid, false);
});
