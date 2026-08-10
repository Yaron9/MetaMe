'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeEngineName } = require('./daemon-utils');
const { isExperimentalEngineName } = require('./core/engine-descriptors');
const { AGY_DEFAULT_MODEL, normalizeAgyModel } = require('./core/agy-model');
const { createDefaultEngineRegistry } = require('./engines/engine-registry');
const { isEnginePlugin } = require('./engines/engine-plugin');
const { _private: claudeAdapter } = require('./engines/claude-cli-adapter');
const { _private: codexAdapter } = require('./engines/codex-cli-adapter');
const { _private: agyAdapter } = require('./engines/agy-cli-adapter');
const { _private: piAdapter } = require('./engines/pi-cli-adapter');

const CODEX_AUTO_MODEL = 'auto';
const AGY_AUTO_MODEL = AGY_DEFAULT_MODEL;

const ENGINE_TIMEOUT_DEFAULTS = Object.freeze({
  codex: codexAdapter.DEFAULT_TIMEOUTS,
  claude: claudeAdapter.DEFAULT_TIMEOUTS,
  agy: agyAdapter.DEFAULT_TIMEOUTS,
  pi: piAdapter.DEFAULT_TIMEOUTS,
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
  pi: {
    // Empty means “use Pi's configured/default model”; an explicit value in
    // daemon.models.pi is passed through unchanged by the adapter.
    main:     '',
    distill:  '',
    options:  [],
    provider: 'google',
    hint:     'Pi 为实验性引擎；provider/model/thinking 由 Pi 配置或 daemon.pi 显式传入',
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
  if (isExperimentalEngineName(engine)) return engineCfg.main;
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

function resolveEnginePlugin(value, engineName = '') {
  const requestedId = String(engineName || '').trim().toLowerCase();
  if (isEnginePlugin(value)) return value;
  throw new TypeError(requestedId
    ? `engine_plugin_required:${requestedId}`
    : 'engine_plugin_required');
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
    pi: {
      home,
      binary: deps.PI_BIN,
      sessionDir: deps.PI_SESSION_DIR,
      defaultProvider: ENGINE_MODEL_CONFIG.pi.provider,
      defaultModel: ENGINE_MODEL_CONFIG.pi.main,
      timeouts: resolveEngineTimeouts('pi'),
      fs: deps.fs,
      path: deps.path,
      execFileSync: deps.execFileSync,
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
    parsePiStreamEvent: piAdapter.parsePiStreamEvent,
    classifyPiError: piAdapter.classifyPiError,
    buildPiArgs: piAdapter.buildPiArgs,
    resolvePiBinary: piAdapter.resolvePiBinary,
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
