'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEngineRuntimeFactory,
  resolveEnginePlugin,
  normalizeEngineName,
  resolveEngineModel,
  normalizeEngineModel,
  resolveEngineTimeouts,
  ENGINE_MODEL_CONFIG,
} = require('./daemon-engine-runtime');
const { BUILTIN_RUNTIME_CATALOG } = require('./engines/native-runtime-factory');

test('runtime facade derives model metadata from the built-in catalog', () => {
  assert.deepEqual(
    Object.keys(ENGINE_MODEL_CONFIG),
    BUILTIN_RUNTIME_CATALOG.map(definition => definition.id)
  );
  for (const definition of BUILTIN_RUNTIME_CATALOG) {
    const config = ENGINE_MODEL_CONFIG[definition.id];
    assert.equal(config.main, definition.model.main);
    assert.equal(config.distill, definition.model.distill);
    assert.equal(config.provider, definition.model.provider);
  }
  assert.equal(ENGINE_MODEL_CONFIG.codex.distill, 'auto');
});

test('runtime facade normalizes known engines through the shared identity policy', () => {
  assert.equal(normalizeEngineName('codex'), 'codex');
  assert.equal(normalizeEngineName('agy'), 'agy');
  assert.equal(normalizeEngineName('Claude'), 'claude');
  assert.equal(normalizeEngineName(''), 'claude');
  assert.equal(normalizeEngineName('unknown'), 'claude');
});

test('model resolution uses definition policy and preserves legacy migration semantics', () => {
  assert.equal(resolveEngineModel('codex', {}), 'auto');
  assert.equal(resolveEngineModel('codex', {
    model: 'opus',
    models: { codex: 'gpt-5.4' },
  }), 'gpt-5.4');
  assert.equal(resolveEngineModel('codex', { model: 'opus' }), 'auto');
  assert.equal(resolveEngineModel('codex', { model: 'gpt-5-mini' }), 'gpt-5-mini');
  assert.equal(resolveEngineModel('codex', { model: 'MiniMax-M2.1' }), 'auto');
  assert.equal(resolveEngineModel('agy', { model: 'opus' }), 'Gemini 3.5 Flash (Medium)');
  assert.equal(resolveEngineModel('agy', { models: { agy: 'gemini-custom' } }), 'gemini-custom');
  assert.equal(
    resolveEngineModel('agy', {}, 'claude-sonnet-4-6'),
    'Claude Sonnet 4.6 (Thinking)'
  );
  assert.equal(resolveEngineModel('agy', {}, 'gpt-5.4'), 'Gemini 3.5 Flash (Medium)');
  assert.equal(
    resolveEngineModel('agy', {}, 'Gemini 3.5 Flash (High)'),
    'Gemini 3.5 Flash (High)'
  );
  assert.equal(resolveEngineModel('claude', { model: 'MiniMax-M2.1' }), 'sonnet');
  assert.equal(resolveEngineModel('claude', { model: 'claude-opus-4-6' }), 'opus');
  assert.equal(
    resolveEngineModel('claude', { models: { claude: 'claude-haiku-4-5-20251001' } }),
    'haiku'
  );
  assert.equal(normalizeEngineModel('codex', 'auto'), 'auto');
});

test('default-engine detection iterates catalog policies in declared priority order', () => {
  const calls = [];
  const engine = require('./daemon-engine-runtime').detectDefaultEngine({
    HOME: '/tmp/metame-runtime-test',
    CLAUDE_BIN: '/opt/test/claude',
    CODEX_BIN: '/opt/test/codex',
    execFileSync: () => {
      calls.push('lookup');
      throw new Error('fixture PATH lookup disabled');
    },
    fs: { existsSync: () => false },
  });
  assert.equal(engine, 'claude');
  assert.equal(calls.length, 0);
});

test('runtime factory returns immutable Engine Plugins from the catalog registry', () => {
  const getEnginePlugin = createEngineRuntimeFactory({
    HOME: '/tmp/metame-runtime-test',
    CLAUDE_BIN: '/opt/test/claude',
    CODEX_BIN: '/opt/test/codex',
    AGY_BIN: '/opt/test/agy',
    AGY_ADAPTER: '/opt/test/agy-adapter.js',
    getActiveProviderEnv: () => ({}),
  });
  for (const definition of BUILTIN_RUNTIME_CATALOG) {
    const plugin = getEnginePlugin(definition.id);
    assert.equal(plugin.descriptor.id, definition.id);
    assert.equal(plugin.descriptor.capabilities.runtime.state, 'verified');
    assert.equal(Object.isFrozen(plugin), true);
    assert.equal(typeof plugin.runtime.buildInvocation, 'function');
    assert.equal(typeof plugin.runtime.parseEvent, 'function');
    assert.equal(typeof plugin.runtime.classifyFailure, 'function');
    assert.equal(typeof plugin.runtime.validateSession, 'function');
    assert.equal(typeof plugin.runtime.updateSession, 'function');
    assert.equal(plugin.runtime.structuredOutput.schema, definition.structuredOutput.schema);
    const invocation = plugin.runtime.buildInvocation({ input: 'hello', cwd: '/tmp/project', session: {} });
    assert.equal(invocation.executable, plugin.runtime.binary);
    assert.ok(Array.isArray(invocation.args));
    assert.equal(invocation.shell, undefined);
  }
  assert.equal(getEnginePlugin('unknown').descriptor.id, 'claude');
});

test('runtime factory keeps descriptors attached to each runtime boundary', () => {
  const getRuntime = createEngineRuntimeFactory({
    CLAUDE_BIN: 'claude',
    CODEX_BIN: 'codex',
    AGY_BIN: '/tmp/agy',
    AGY_ADAPTER: '/tmp/agy-adapter.js',
    PI_BIN: 'pi',
  });
  for (const definition of BUILTIN_RUNTIME_CATALOG) {
    const plugin = getRuntime(definition.id);
    assert.equal(plugin.runtime.descriptor, plugin.descriptor, `${definition.id} descriptor`);
  }
});

test('runtime factory preserves adapter-specific runtime defaults at the edge', () => {
  const getRuntime = createEngineRuntimeFactory({
    CLAUDE_BIN: 'claude',
    CODEX_BIN: 'codex',
    AGY_BIN: '/tmp/agy',
    AGY_ADAPTER: '/tmp/agy-adapter.js',
    getActiveProviderEnv: () => ({ ANTHROPIC_API_KEY: 'fixture-only' }),
  });
  const codex = getRuntime('codex').runtime;
  assert.equal(codex.name, 'codex');
  assert.equal(codex.binary, 'codex');
  assert.equal(codex.stdinBehavior, 'write-and-close');
  assert.equal(codex.defaultModel, 'auto');
  const agy = getRuntime('agy').runtime;
  assert.equal(agy.name, 'agy');
  assert.equal(agy.binary, process.execPath);
  assert.equal(agy.nativeBinary, '/tmp/agy');
  assert.equal(agy.capabilities.outputSchema, false);
  assert.equal(agy.buildEnv({}).AGY_BIN, '/tmp/agy');
});

test('runtime facade requires a versioned Engine Plugin at orchestration boundaries', () => {
  assert.throws(
    () => resolveEnginePlugin({ name: 'fixture', buildArgs: () => [] }, 'fixture'),
    /engine_plugin_required:fixture/
  );
});

test('timeouts are read from catalog definitions without facade host policy', () => {
  for (const definition of BUILTIN_RUNTIME_CATALOG) {
    assert.deepEqual(resolveEngineTimeouts(definition.id), definition.timeouts);
  }
});
