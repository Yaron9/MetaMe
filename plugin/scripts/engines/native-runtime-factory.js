'use strict';

/**
 * Built-in Runtime Plugin assembly.
 *
 * This is the only module that knows which native adapter implements a
 * built-in Engine.  The shared runtime facade consumes the catalog below as
 * data and policies; it must not import adapter internals or branch on an
 * Engine id.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync: nodeExecFileSync } = require('child_process');
const { AGY_DEFAULT_MODEL, normalizeAgyModel } = require('../core/agy-model');
const { createEnginePlugin } = require('./engine-plugin');
const { createEngineRegistry } = require('./engine-registry');
const { createClaudeCliAdapter, _private: claudeOps } = require('./claude-cli-adapter');
const { createCodexCliAdapter, _private: codexOps } = require('./codex-cli-adapter');
const { createAgyCliAdapter, _private: agyOps } = require('./agy-cli-adapter');
const { createPiCliAdapter, _private: piOps } = require('./pi-cli-adapter');
const { createClaudeSessionSourceAdapter } = require('./claude-session-source-adapter');
const { createCodexSessionSourceAdapter } = require('./codex-session-source-adapter');
const { createAgySessionSourceAdapter } = require('./agy-session-source-adapter');
const { createPiSessionSourceAdapter } = require('./pi-session-source-adapter');

function identityModel(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function commandCandidates(home, pathMod, command) {
  const common = [
    pathMod.join(home, '.local', 'bin', command),
    '/usr/local/bin/' + command,
    '/opt/homebrew/bin/' + command,
  ];
  if (command === 'claude' || command === 'pi') {
    common.splice(1, 0, pathMod.join(home, '.npm-global', 'bin', command));
  }
  return common;
}

function resolveCommandBinary({ command, deps = {}, candidates = commandCandidates } = {}) {
  const home = deps.HOME || deps.home || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const execFileSync = deps.execFileSync || (deps.execSync
    ? (lookup, args, options) => deps.execSync(`${lookup} ${args.join(' ')}`, options)
    : nodeExecFileSync);
  const platform = deps.platform || process.platform;
  const lookup = platform === 'win32' ? 'where' : 'which';

  try {
    const output = execFileSync(lookup, [command], {
      encoding: 'utf8',
      timeout: 3000,
      ...(platform === 'win32' ? { windowsHide: true } : {}),
    });
    const lines = String(output || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const preferred = platform === 'win32'
      ? (lines.find(value => value.toLowerCase().endsWith(`${command}.cmd`)) || lines[0])
      : lines[0];
    if (preferred) return preferred;
  } catch {
    // Fall through to the bounded candidate list.
  }

  for (const candidate of candidates(home, pathMod, command)) {
    try {
      if (fsMod.existsSync(candidate)) return candidate;
    } catch {
      // An inaccessible candidate is equivalent to a missing binary.
    }
  }
  return command;
}

function binaryProbe(definition, binary) {
  return Object.freeze({
    available: String(binary || '') !== definition.id,
    engineId: definition.id,
    executable: binary,
  });
}

const claudeModel = Object.freeze({
  main: 'sonnet',
  distill: 'haiku',
  options: Object.freeze([
    Object.freeze({ value: 'opus', label: 'opus · 最强' }),
    Object.freeze({ value: 'sonnet', label: 'sonnet · 均衡' }),
    Object.freeze({ value: 'haiku', label: 'haiku · 轻量' }),
  ]),
  provider: 'anthropic',
  hint: null,
  normalizeConfiguredModel: (value, fallback = 'sonnet') => claudeOps.normalizeClaudeModel(value, fallback),
  resolveLegacyModel: (value, fallback = 'sonnet') => claudeOps.normalizeClaudeModel(value, fallback),
});

const codexModel = Object.freeze({
  main: 'auto',
  distill: 'auto',
  options: Object.freeze([
    Object.freeze({ value: 'auto', label: 'auto · 跟随 Codex 官方默认' }),
    Object.freeze({ value: 'gpt-5-codex', label: 'gpt-5-codex · 官方滚动别名' }),
    Object.freeze({ value: 'gpt-5.5', label: 'gpt-5.5 · 固定版本' }),
    Object.freeze({ value: 'gpt-5.4', label: 'gpt-5.4 · 固定版本' }),
    Object.freeze({ value: 'gpt-5.3-codex', label: 'gpt-5.3-codex · 固定 Codex' }),
    Object.freeze({ value: 'gpt-5.1-codex-max', label: 'gpt-5.1-codex-max · 长任务' }),
    Object.freeze({ value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini · 轻量' }),
  ]),
  provider: 'openai',
  hint: '推荐 `auto` 或 `gpt-5-codex`，也可直接发送任意 OpenAI 模型名切换',
  normalizeConfiguredModel: identityModel,
  resolveLegacyModel: (value, fallback = 'auto') => (
    codexOps.looksLikeCodexModel(value) ? identityModel(value, fallback) : fallback
  ),
});

const agyModel = Object.freeze({
  main: AGY_DEFAULT_MODEL,
  distill: AGY_DEFAULT_MODEL,
  options: Object.freeze([
    Object.freeze({ value: AGY_DEFAULT_MODEL, label: 'Gemini 3.5 Flash · agy 默认' }),
  ]),
  provider: 'google',
  hint: 'agy 1.1.0 需要显式模型；当前默认使用 Gemini 3.5 Flash (Medium)',
  normalizeConfiguredModel: normalizeAgyModel,
  resolveLegacyModel: (value, fallback = AGY_DEFAULT_MODEL) => fallback,
});

const piModel = Object.freeze({
  main: '',
  distill: '',
  options: Object.freeze([]),
  provider: 'google',
  hint: 'Pi 为实验性引擎；provider/model/thinking 由 Pi 配置或 daemon.pi 显式传入',
  normalizeConfiguredModel: identityModel,
  resolveLegacyModel: (value, fallback = '') => fallback,
});

function createCommonSessionSourceDeps({ deps, home, namespace = {} }) {
  const engineOptions = namespace && typeof namespace === 'object' ? namespace : {};
  return {
    ...deps,
    ...engineOptions,
    home: engineOptions.home || home,
    HOME: engineOptions.HOME || engineOptions.home || home,
    fs: engineOptions.fs || deps.fs,
    path: engineOptions.path || deps.path,
  };
}

function createCatalogSessionSourceDeps(context, namespace) {
  return createCommonSessionSourceDeps({ ...context, namespace });
}

// `createDefaultEngineRegistry` historically accepted one nested dependency
// object per built-in adapter.  Normalize that input at this edge so the
// catalog remains the sole assembly surface while old callers and fixtures can
// migrate without reintroducing a shared Engine branch.
function normalizeFactoryDeps(input = {}) {
  const deps = { ...input };
  const claude = input.claude || {};
  const codex = input.codex || {};
  const agy = input.agy || {};
  const pi = input.pi || {};
  const first = (...values) => values.find(value => value !== undefined && value !== null && String(value).trim() !== '');
  return {
    ...deps,
    HOME: first(input.HOME, input.home, claude.home, codex.home, agy.home, pi.home),
    CLAUDE_BIN: first(input.CLAUDE_BIN, claude.binary),
    CODEX_BIN: first(input.CODEX_BIN, codex.binary),
    AGY_BIN: first(input.AGY_BIN, agy.nativeBinary, agy.binary),
    AGY_RUNTIME_BIN: first(input.AGY_RUNTIME_BIN, agy.binary),
    AGY_ADAPTER: first(input.AGY_ADAPTER, agy.adapterPath),
    AGY_PLUGIN_CONFIG: first(input.AGY_PLUGIN_CONFIG, agy.pluginConfig),
    PI_BIN: first(input.PI_BIN, pi.binary),
    PI_SESSION_DIR: first(input.PI_SESSION_DIR, pi.sessionDir),
    getActiveProviderEnv: input.getActiveProviderEnv || claude.getActiveProviderEnv,
    claudeSessionPolicy: input.claudeSessionPolicy || claude.sessionPolicy,
    codexSessionPolicy: input.codexSessionPolicy || codex.sessionPolicy,
    validateNativeSession: input.validateNativeSession
      || claude.validateNativeSession
      || codex.validateNativeSession
      || agy.validateNativeSession
      || pi.validateNativeSession,
    fs: input.fs || claude.fs || codex.fs || agy.fs || pi.fs,
    path: input.path || claude.path || codex.path || agy.path || pi.path,
    execFileSync: input.execFileSync || pi.execFileSync,
    log: input.log || codex.log,
  };
}

const BUILTIN_RUNTIME_CATALOG = Object.freeze([
  Object.freeze({
    id: 'claude',
    defaultEngine: true,
    autodetectPriority: 10,
    model: claudeModel,
    timeouts: claudeOps.DEFAULT_TIMEOUTS,
    structuredOutput: Object.freeze({ schema: 'inline', format: 'json', buffer: 'tail', unstructuredBuffer: 'prefix' }),
    configuredBinary: deps => deps.CLAUDE_BIN,
    resolveBinary: deps => resolveCommandBinary({ command: 'claude', deps }),
    probeBinary: binary => binaryProbe({ id: 'claude' }, binary),
    createRuntimeDeps: ({ deps, home, nativeBinary, timeouts, defaultModel }) => ({
      home,
      binary: nativeBinary,
      defaultModel,
      timeouts,
      getActiveProviderEnv: deps.getActiveProviderEnv,
      sessionPolicy: deps.claudeSessionPolicy,
      validateNativeSession: deps.validateNativeSession,
    }),
    createRuntime: createClaudeCliAdapter,
    createSessionSourceDeps: context => createCatalogSessionSourceDeps(context, context.deps.claude),
    createSessionSource: createClaudeSessionSourceAdapter,
  }),
  Object.freeze({
    id: 'codex',
    autodetectPriority: 20,
    model: codexModel,
    timeouts: codexOps.DEFAULT_TIMEOUTS,
    structuredOutput: Object.freeze({ schema: 'path', format: 'jsonl', buffer: 'tail', unstructuredBuffer: 'tail' }),
    configuredBinary: deps => deps.CODEX_BIN,
    resolveBinary: deps => resolveCommandBinary({ command: 'codex', deps }),
    probeBinary: binary => binaryProbe({ id: 'codex' }, binary),
    createRuntimeDeps: ({ deps, nativeBinary, timeouts, defaultModel }) => ({
      binary: nativeBinary,
      defaultModel,
      timeouts,
      sessionPolicy: deps.codexSessionPolicy,
      validateNativeSession: deps.validateNativeSession,
      fs: deps.fs,
      path: deps.path,
      log: deps.log,
    }),
    createRuntime: createCodexCliAdapter,
    createSessionSourceDeps: context => createCatalogSessionSourceDeps(context, context.deps.codex),
    createSessionSource: createCodexSessionSourceAdapter,
  }),
  Object.freeze({
    id: 'agy',
    autodetectPriority: null,
    model: agyModel,
    timeouts: agyOps.DEFAULT_TIMEOUTS,
    structuredOutput: Object.freeze({ schema: 'none', format: '', buffer: 'prefix', unstructuredBuffer: 'prefix' }),
    configuredBinary: deps => deps.AGY_BIN,
    resolveBinary: deps => resolveCommandBinary({ command: 'agy', deps }),
    probeBinary: binary => binaryProbe({ id: 'agy' }, binary),
    createRuntimeDeps: ({ deps, home, nativeBinary, timeouts, defaultModel }) => ({
      home,
      binary: deps.AGY_RUNTIME_BIN || process.execPath,
      nativeBinary,
      adapterPath: deps.AGY_ADAPTER || path.join(__dirname, '..', 'bin', 'agy-adapter.js'),
      pluginConfig: deps.AGY_PLUGIN_CONFIG,
      defaultModel,
      timeouts,
      validateNativeSession: deps.validateNativeSession,
    }),
    createRuntime: createAgyCliAdapter,
    createSessionSourceDeps: context => createCatalogSessionSourceDeps(context, context.deps.agy),
    createSessionSource: createAgySessionSourceAdapter,
  }),
  Object.freeze({
    id: 'pi',
    autodetectPriority: null,
    model: piModel,
    timeouts: piOps.DEFAULT_TIMEOUTS,
    structuredOutput: Object.freeze({ schema: 'none', format: '', buffer: 'prefix', unstructuredBuffer: 'prefix' }),
    configuredBinary: deps => deps.PI_BIN,
    resolveBinary: deps => resolveCommandBinary({ command: 'pi', deps }),
    probeBinary: binary => binaryProbe({ id: 'pi' }, binary),
    createRuntimeDeps: ({ deps, home, nativeBinary, timeouts, defaultModel }) => ({
      home,
      binary: nativeBinary,
      defaultProvider: piModel.provider,
      defaultModel,
      sessionDir: deps.PI_SESSION_DIR,
      timeouts,
      fs: deps.fs,
      path: deps.path,
      execFileSync: deps.execFileSync,
    }),
    createRuntime: createPiCliAdapter,
    createSessionSourceDeps: context => createCatalogSessionSourceDeps(context, context.deps.pi),
    createSessionSource: createPiSessionSourceAdapter,
  }),
]);

function createBuiltinEnginePlugins(deps = {}) {
  const normalizedDeps = normalizeFactoryDeps(deps);
  const home = normalizedDeps.HOME || os.homedir();
  return BUILTIN_RUNTIME_CATALOG.map(definition => {
    const configuredBinary = typeof definition.configuredBinary === 'function'
      ? definition.configuredBinary(normalizedDeps)
      : '';
    const nativeBinary = String(configuredBinary || '').trim()
      || definition.resolveBinary({ ...normalizedDeps, HOME: home, home });
    const context = {
      deps: normalizedDeps,
      home,
      nativeBinary,
      timeouts: definition.timeouts,
      defaultModel: definition.model.main,
    };
    const runtime = definition.createRuntime(definition.createRuntimeDeps(context));
    const sourceDeps = definition.createSessionSourceDeps(context);
    const sessionSource = definition.createSessionSource(sourceDeps);
    const descriptor = sessionSource
      ? {
        ...runtime.descriptor,
        capabilities: {
          ...runtime.descriptor.capabilities,
          sessionSource: { state: 'verified' },
        },
      }
      : runtime.descriptor;
    return createEnginePlugin({
      protocolVersion: 1,
      descriptor,
      runtime,
      sessionSource,
      cognitiveHost: null,
    });
  });
}

function createBuiltinEngineRegistry(deps = {}) {
  const defaultDefinition = BUILTIN_RUNTIME_CATALOG.find(definition => definition.defaultEngine)
    || BUILTIN_RUNTIME_CATALOG[0];
  const normalizedDeps = normalizeFactoryDeps(deps);
  return createEngineRegistry(createBuiltinEnginePlugins(normalizedDeps), {
    normalizeEngineName: normalizedDeps.normalizeEngineName,
    defaultEngineId: defaultDefinition.id,
    legacyFallback: true,
  });
}

module.exports = {
  BUILTIN_RUNTIME_CATALOG,
  createBuiltinEnginePlugins,
  createBuiltinEngineRegistry,
};
