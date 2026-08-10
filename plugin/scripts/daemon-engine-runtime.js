'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeEngineName } = require('./daemon-utils');
const { AGY_DEFAULT_MODEL, normalizeAgyModel } = require('./core/agy-model');
const { createDefaultEngineRegistry } = require('./engines/engine-registry');
const { createEnginePlugin, isEnginePlugin } = require('./engines/engine-plugin');
const { getEngineDescriptor } = require('./core/engine-descriptors');
const { _private: claudeAdapter } = require('./engines/claude-cli-adapter');
const { _private: codexAdapter } = require('./engines/codex-cli-adapter');
const { _private: agyAdapter } = require('./engines/agy-cli-adapter');

const CODEX_AUTO_MODEL = 'auto';
const AGY_AUTO_MODEL = AGY_DEFAULT_MODEL;

const ENGINE_TIMEOUT_DEFAULTS = Object.freeze({
  codex: codexAdapter.DEFAULT_TIMEOUTS,
  claude: claudeAdapter.DEFAULT_TIMEOUTS,
  agy: agyAdapter.DEFAULT_TIMEOUTS,
});

const {
  buildClaudeArgs: adapterBuildClaudeArgs,
  classifyClaudeError: classifyEngineError,
  normalizeClaudeModel,
  parseClaudeStreamEvent,
} = claudeAdapter;
const {
  buildCodexArgs: adapterBuildCodexArgs,
  buildCodexEnv: adapterBuildCodexEnv,
  looksLikeCodexModel,
  normalizeCodexApprovalPolicy: adapterNormalizeCodexApprovalPolicy,
  normalizeCodexSandboxMode: adapterNormalizeCodexSandboxMode,
  parseCodexStreamEvent,
  resolveCodexPermissionProfile: adapterResolveCodexPermissionProfile,
} = codexAdapter;
const {
  buildAgyArgs: adapterBuildAgyArgs,
  classifyAgyError,
  parseAgyStreamEvent,
} = agyAdapter;

function resolveBinary(engineName, deps = {}) {
  const engine = normalizeEngineName(engineName);
  const home = deps.HOME || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const execSyncFn = deps.execSync || execSync;

  const key = engine === 'codex' ? 'codex' : engine === 'agy' ? 'agy' : 'claude';
  const cmd = process.platform === 'win32' ? `where ${key}` : `which ${key} 2>/dev/null`;
  try {
    const lines = execSyncFn(cmd, { encoding: 'utf8', timeout: 3000, ...(process.platform === 'win32' ? { windowsHide: true } : {}) })
      .split('\n').map(l => l.trim()).filter(Boolean);
    // On Windows prefer .cmd wrapper (reliably executable by spawn)
    const preferred = process.platform === 'win32'
      ? (lines.find(l => l.toLowerCase().endsWith(`${key}.cmd`)) || lines[0])
      : lines[0];
    if (preferred) return preferred;
  } catch { /* fallback */ }

  const candidates = engine === 'codex'
    ? [
      pathMod.join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ]
    : engine === 'agy'
      ? [
        pathMod.join(home, '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        '/opt/homebrew/bin/agy',
      ]
      : [
      pathMod.join(home, '.local', 'bin', 'claude'),
      pathMod.join(home, '.npm-global', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
  for (const p of candidates) {
    if (fsMod.existsSync(p)) return p;
  }
  return key;
}

// Single source of truth for all per-engine model config.
// All other code should read from here — no scattered hardcodes.
const ENGINE_MODEL_CONFIG = Object.freeze({
  claude: {
    main:     'sonnet',                       // default session model
    distill:  'haiku',                        // background/cheap tasks
    options:  [                               // /model button list
      { value: 'opus',   label: 'opus · 最强' },
      { value: 'sonnet', label: 'sonnet · 均衡' },
      { value: 'haiku',  label: 'haiku · 轻量' },
    ],
    provider: 'anthropic',
    hint:     null,
  },
  codex: {
    main:     CODEX_AUTO_MODEL,     // follow official Codex CLI default model
    distill:  CODEX_AUTO_MODEL,     // account/model availability changes; follow the CLI default
    options:  [                     // quick-pick buttons (official model names)
      { value: CODEX_AUTO_MODEL,     label: 'auto · 跟随 Codex 官方默认' },
      { value: 'gpt-5-codex',        label: 'gpt-5-codex · 官方滚动别名' },
      { value: 'gpt-5.5',            label: 'gpt-5.5 · 固定版本' },
      { value: 'gpt-5.4',            label: 'gpt-5.4 · 固定版本' },
      { value: 'gpt-5.3-codex',      label: 'gpt-5.3-codex · 固定 Codex' },
      { value: 'gpt-5.1-codex-max',  label: 'gpt-5.1-codex-max · 长任务' },
      { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini · 轻量' },
    ],
    provider: 'openai',
    hint:     '推荐 `auto` 或 `gpt-5-codex`，也可直接发送任意 OpenAI 模型名切换',
  },
  agy: {
    main:     AGY_AUTO_MODEL,
    distill:  AGY_AUTO_MODEL,
    options:  [{ value: AGY_AUTO_MODEL, label: 'Gemini 3.5 Flash · agy 默认' }],
    provider: 'google',
    hint:     'agy 1.1.0 需要显式模型；当前默认使用 Gemini 3.5 Flash (Medium)',
  },
});

// Backward-compat aliases (derived, do not edit directly)
const ENGINE_DISTILL_MAP = Object.freeze(
  Object.fromEntries(Object.entries(ENGINE_MODEL_CONFIG).map(([k, v]) => [k, v.distill]))
);
const ENGINE_DEFAULT_MODEL = Object.freeze(
  Object.fromEntries(Object.entries(ENGINE_MODEL_CONFIG).map(([k, v]) => [k, v.main]))
);
const BUILTIN_CLAUDE_MODEL_VALUES = Object.freeze(
  (ENGINE_MODEL_CONFIG.claude.options || []).map(option =>
    typeof option === 'string' ? option : option.value
  ).filter(Boolean)
);

function resolveEngineModel(engineName, daemonCfg = {}, overrideModel = '') {
  const engine = normalizeEngineName(engineName);
  const engineCfg = ENGINE_MODEL_CONFIG[engine] || ENGINE_MODEL_CONFIG.claude;
  const engineModels = (daemonCfg && daemonCfg.models) || {};
  const explicitModel = String(overrideModel || '').trim();
  if (explicitModel) {
    return engine === 'claude'
      ? normalizeClaudeModel(explicitModel, engineCfg.main)
      : engine === 'agy'
        ? normalizeAgyModel(explicitModel, engineCfg.main)
        : explicitModel;
  }

  const perEngineModel = String(engineModels[engine] || '').trim();
  if (perEngineModel) {
    return engine === 'claude'
      ? normalizeClaudeModel(perEngineModel, engineCfg.main)
      : engine === 'agy'
        ? normalizeAgyModel(perEngineModel, engineCfg.main)
        : perEngineModel;
  }

  const legacyModel = String((daemonCfg && daemonCfg.model) || '').trim();
  if (!legacyModel) return engineCfg.main;

  // Legacy daemon.model historically meant a Claude model.
  if (engine === 'claude') {
    return normalizeClaudeModel(legacyModel, engineCfg.main);
  }

  // Legacy daemon.model primarily belonged to Claude; only reuse it for Codex
  // when it already looks like a real Codex/OpenAI model id.
  if (engine === 'codex' && !looksLikeCodexModel(legacyModel)) {
    return engineCfg.main;
  }
  if (engine === 'agy') return engineCfg.main;
  return legacyModel;
}

function detectDefaultEngine(deps = {}) {
  for (const engine of ['claude', 'codex']) {
    const bin = resolveBinary(engine, deps);
    if (bin !== engine) return engine; // resolveBinary found a real path
  }
  return 'claude'; // ultimate fallback
}

function resolveEngineTimeouts(engineName) {
  const engine = normalizeEngineName(engineName);
  const base = ENGINE_TIMEOUT_DEFAULTS[engine] || ENGINE_TIMEOUT_DEFAULTS.claude;
  return { ...base };
}

/**
 * Resolve the only supported execution registration unit: an Engine Plugin.
 *
 * The daemon historically accepted a bare native runtime from dependency
 * injection.  That shape is normalized once at this external boundary so
 * tests and older embedders can continue to construct the daemon.  Production
 * callers receive the immutable plugin returned by the registry and never
 * enter this compatibility path.
 */
function compatibilityDescriptor(runtime, engineName) {
  const requestedId = String(engineName || runtime.name || '').trim().toLowerCase();
  return runtime.descriptor
    || getEngineDescriptor(requestedId)
    || {
      id: requestedId || 'unknown',
      displayName: requestedId || 'unknown',
      vendor: 'unknown',
      executableNames: [requestedId || 'unknown'],
      contextProjection: 'prompt-bootstrap',
      nativeSessionKind: 'opaque',
      capabilities: {
        runtime: { state: 'verified' },
        sessionSource: { state: 'unsupported' },
        cognitiveHost: { state: 'unsupported' },
      },
      configSchemaVersion: 1,
    };
}

function adaptCompatibilityRuntime(legacyRuntime, descriptor) {
  const runtime = { ...legacyRuntime };
  if (typeof runtime.probe !== 'function') {
    runtime.probe = () => ({ engineId: descriptor.id, state: 'detected' });
  }
  if (typeof runtime.buildInvocation !== 'function' && typeof runtime.buildArgs === 'function') {
    runtime.buildInvocation = (options = {}) => {
      const session = options.session || options.nativeSession || {};
      const executable = runtime.binary || runtime.executable || descriptor.executableNames[0];
      return {
        engine: descriptor.id,
        executable,
        binary: executable,
        args: runtime.buildArgs({ ...options, session }),
        env: typeof runtime.buildEnv === 'function' ? runtime.buildEnv({ ...options, session }) : {},
        cwd: options.cwd || session.cwd || '',
        input: options.input === undefined ? '' : options.input,
        killSignal: runtime.killSignal || 'SIGTERM',
        timeouts: runtime.timeouts || {},
      };
    };
  }
  if (typeof runtime.parseEvent !== 'function' && typeof runtime.parseStreamEvent === 'function') {
    runtime.parseEvent = runtime.parseStreamEvent;
  }
  if (typeof runtime.classifyFailure !== 'function' && typeof runtime.classifyError === 'function') {
    runtime.classifyFailure = runtime.classifyError;
  }
  if (typeof runtime.validateSession !== 'function') {
    runtime.validateSession = session => {
      if (typeof runtime.acceptsNativeSession === 'function' && !runtime.acceptsNativeSession(session)) {
        throw new Error(`${descriptor.id}_native_session_mismatch`);
      }
      if (typeof runtime.validateNativeSession === 'function') return runtime.validateNativeSession(session);
      return true;
    };
  }
  if (typeof runtime.updateSession !== 'function') {
    runtime.updateSession = (session, observation = {}) => {
      if (typeof runtime.updateNativeSession === 'function') {
        return runtime.updateNativeSession(session, observation);
      }
      if (!observation.sessionId) return session;
      return {
        ...(session || {}),
        engine: descriptor.id,
        id: observation.sessionId,
        started: true,
        cwd: observation.cwd || (session && session.cwd) || '',
      };
    };
  }
  return runtime;
}

function resolveEnginePlugin(value, engineName = '') {
  if (isEnginePlugin(value)) return value;
  const legacyRuntime = value && value.runtime && value.descriptor
    ? value.runtime
    : value;
  if (!legacyRuntime || typeof legacyRuntime !== 'object') return null;
  const descriptor = compatibilityDescriptor(legacyRuntime, engineName);
  const runtime = adaptCompatibilityRuntime(legacyRuntime, descriptor);
  return createEnginePlugin({
    protocolVersion: 1,
    descriptor,
    runtime,
    sessionSource: null,
    cognitiveHost: null,
  });
}

function buildClaudeArgs(options = {}) {
  return adapterBuildClaudeArgs(options);
}

function normalizeCodexSandboxMode(value, fallback = 'danger-full-access') {
  return adapterNormalizeCodexSandboxMode(value, fallback);
}

function normalizeCodexApprovalPolicy(value, fallback = 'never') {
  return adapterNormalizeCodexApprovalPolicy(value, fallback);
}

function resolveCodexPermissionProfile(options = {}) {
  return adapterResolveCodexPermissionProfile(options);
}

function buildCodexArgs(options = {}) {
  return adapterBuildCodexArgs(options);
}

function buildAgyArgs(options = {}) {
  return adapterBuildAgyArgs(options);
}

function buildCodexEnv(baseEnv = {}, {
  metameProject = '', metameSenderId = '', cwd = '', internalPrompt = false,
} = {}) {
  return adapterBuildCodexEnv(baseEnv, {
    metameProject,
    metameSenderId,
    cwd,
    internalPrompt,
  });
}

function createEngineRuntimeFactory(deps = {}) {
  const home = deps.HOME || os.homedir();
  const claudeBin = deps.CLAUDE_BIN || resolveBinary('claude', { ...deps, HOME: home });
  const codexBin = deps.CODEX_BIN || resolveBinary('codex', { ...deps, HOME: home });
  const agyBin = deps.AGY_BIN || resolveBinary('agy', { ...deps, HOME: home });
  const agyAdapterPath = deps.AGY_ADAPTER || path.join(__dirname, 'bin', 'agy-adapter.js');
  const getActiveProviderEnv = typeof deps.getActiveProviderEnv === 'function'
    ? deps.getActiveProviderEnv
    : (() => ({}));
  const registry = createDefaultEngineRegistry({
    normalizeEngineName,
    claude: {
      binary: claudeBin,
      defaultModel: ENGINE_MODEL_CONFIG.claude.main,
      timeouts: resolveEngineTimeouts('claude'),
      getActiveProviderEnv,
      sessionPolicy: deps.claudeSessionPolicy,
      validateNativeSession: deps.validateNativeSession,
    },
    codex: {
      binary: codexBin,
      defaultModel: ENGINE_MODEL_CONFIG.codex.main,
      timeouts: resolveEngineTimeouts('codex'),
      sessionPolicy: deps.codexSessionPolicy,
      validateNativeSession: deps.validateNativeSession,
      fs: deps.fs,
      path: deps.path,
      log: deps.log,
    },
    agy: {
      home,
      binary: process.execPath,
      nativeBinary: agyBin,
      adapterPath: agyAdapterPath,
      defaultModel: ENGINE_MODEL_CONFIG.agy.main,
      timeouts: resolveEngineTimeouts('agy'),
      validateNativeSession: deps.validateNativeSession,
    },
  });

  return engineName => registry.get(engineName);
}

module.exports = {
  createEngineRuntimeFactory,
  resolveEnginePlugin,
  normalizeEngineName,
  resolveBinary,
  detectDefaultEngine,
  resolveEngineModel,
  buildCodexArgs,
  normalizeClaudeModel,
  normalizeAgyModel,
  ENGINE_MODEL_CONFIG,
  ENGINE_DISTILL_MAP,
  ENGINE_DEFAULT_MODEL,
  _private: {
    ENGINE_TIMEOUT_DEFAULTS,
    classifyEngineError,
    parseClaudeStreamEvent,
    parseCodexStreamEvent,
    parseAgyStreamEvent,
    buildClaudeArgs,
    buildCodexArgs,
    buildAgyArgs,
    buildCodexEnv,
    normalizeCodexSandboxMode,
    normalizeCodexApprovalPolicy,
    resolveCodexPermissionProfile,
    BUILTIN_CLAUDE_MODEL_VALUES,
    normalizeClaudeModel,
    normalizeAgyModel,
    looksLikeCodexModel,
    resolveEngineTimeouts,
    classifyAgyError,
  },
};
