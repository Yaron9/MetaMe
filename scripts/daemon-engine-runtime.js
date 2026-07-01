'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { normalizeEngineName } = require('./daemon-utils');

const CODEX_TOOL_MAP = Object.freeze({
  command_execution: 'Bash',
  file_change: 'Write',
  file_read: 'Read',
  mcp_tool_call: 'MCP',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
});

const CODEX_AUTO_MODEL = 'auto';

const ENGINE_TIMEOUT_DEFAULTS = Object.freeze({
  codex: Object.freeze({
    idleMs: 10 * 60 * 1000,
    toolMs: 25 * 60 * 1000,
    ceilingMs: null,
  }),
  claude: Object.freeze({
    idleMs: 20 * 60 * 1000,
    toolMs: 25 * 60 * 1000,
    ceilingMs: null,
  }),
  agy: Object.freeze({
    idleMs: 20 * 60 * 1000,
    toolMs: 25 * 60 * 1000,
    ceilingMs: null,
  }),
});

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
    main:     'auto',
    distill:  'auto',
    options:  [{ value: 'auto', label: 'auto · 跟随 agy 官方默认' }],
    provider: 'google',
    hint:     'agy 模型列表尚未纳入 MetaMe 快速切换；auto 跟随 CLI 默认',
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

function normalizeClaudeModel(model, fallback = ENGINE_MODEL_CONFIG.claude.main) {
  const raw = String(model || '').trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (BUILTIN_CLAUDE_MODEL_VALUES.includes(normalized)) return normalized;
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('haiku')) return 'haiku';
  return fallback;
}

function looksLikeCodexModel(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return false;
  return (
    raw === CODEX_AUTO_MODEL
    || raw.startsWith('gpt-')
    || raw.startsWith('o1')
    || raw.startsWith('o3')
    || raw.startsWith('o4')
    || raw.includes('codex')
  );
}

function isCodexAutoModel(model) {
  return String(model || '').trim().toLowerCase() === CODEX_AUTO_MODEL;
}

function resolveEngineModel(engineName, daemonCfg = {}, overrideModel = '') {
  const engine = normalizeEngineName(engineName);
  const engineCfg = ENGINE_MODEL_CONFIG[engine] || ENGINE_MODEL_CONFIG.claude;
  const engineModels = (daemonCfg && daemonCfg.models) || {};
  const explicitModel = String(overrideModel || '').trim();
  if (explicitModel) {
    return engine === 'claude'
      ? normalizeClaudeModel(explicitModel, engineCfg.main)
      : explicitModel;
  }

  const perEngineModel = String(engineModels[engine] || '').trim();
  if (perEngineModel) {
    return engine === 'claude'
      ? normalizeClaudeModel(perEngineModel, engineCfg.main)
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

function classifyEngineError(text) {
  const msg = String(text || '').trim();
  if (!msg) return null;
  if (/(auth|unauthorized|login|api key|authentication|permission denied|forbidden|401|403)/i.test(msg)) {
    return {
      code: 'AUTH_REQUIRED',
      message: '认证失败，请先执行 `codex login`（或配置 OPENAI_API_KEY）后重试。',
    };
  }
  if (/(rate.?limit|usage limit|too many requests|quota|purchase more credits|429)/i.test(msg)) {
    return {
      code: 'RATE_LIMIT',
      message: '请求频率或配额受限，请稍后重试。',
    };
  }
  return {
    code: 'EXEC_FAILURE',
    message: msg,
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseClaudeStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object') return [];

  const out = [];
  if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
    for (const block of raw.message.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text) {
        out.push({ type: 'text', text: String(block.text), raw });
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'tool_use',
          toolName: block.name || 'Tool',
          toolInput: block.input || {},
          raw,
        });
      }
    }
  }
  if (raw.type === 'system' && raw.subtype === 'init' && raw.session_id) {
    out.push({ type: 'session', sessionId: String(raw.session_id), raw });
  }
  if (raw.type === 'result') {
    if (raw.session_id) out.push({ type: 'session', sessionId: String(raw.session_id), raw });
    // Pass raw.result as fallback on done event — NOT as a text event.
    // The assistant streaming events already delivered this text; emitting it again as text
    // would cause finalResult to accumulate the same content twice → duplicate on card.
    out.push({ type: 'done', usage: raw.usage || null, result: raw.result || null, raw });
  }
  if (raw.type === 'content_block_start' || raw.type === 'content_block_delta') {
    out.push({ type: 'tool_result', raw });
  }
  if (raw.type === 'error') {
    const classified = classifyEngineError(raw.error || raw.message || '');
    if (classified) out.push({ type: 'error', ...classified, raw });
  }
  return out;
}

function parseCodexStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object') return [];

  const out = [];
  if (raw.type === 'thread.started' && raw.thread_id) {
    out.push({ type: 'session', sessionId: String(raw.thread_id), raw });
  }

  if ((raw.type === 'item.started' || raw.type === 'item.completed') && raw.item && raw.item.type) {
    const itemType = String(raw.item.type);
    const mapped = CODEX_TOOL_MAP[itemType] || itemType;
    if (mapped && mapped !== 'reasoning' && itemType !== 'agent_message') {
      if (raw.type === 'item.started') {
        out.push({
          type: 'tool_use',
          toolName: mapped,
          toolInput: {
            command: raw.item.command || '',
            file_path: raw.item.path || raw.item.file_path || '',
          },
          raw,
        });
      } else {
        out.push({ type: 'tool_result', toolName: mapped, raw });
      }
    }
    if (raw.type === 'item.completed' && itemType === 'agent_message' && raw.item.text) {
      out.push({ type: 'text', text: String(raw.item.text), raw });
    }
  }

  if (raw.type === 'turn.completed') {
    out.push({ type: 'done', usage: raw.usage || null, raw });
  }
  if (raw.type === 'error') {
    const classified = classifyEngineError(raw.error || raw.message || '');
    if (classified) out.push({ type: 'error', ...classified, raw });
  }
  return out;
}

function parseAgyStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object') return [];
  if (raw.type === 'heartbeat') return [];
  if (raw.type === 'session' && raw.session_id) {
    return [{ type: 'session', sessionId: String(raw.session_id), raw }];
  }
  if (raw.type === 'text' && raw.text) return [{ type: 'text', text: String(raw.text), raw }];
  if (raw.type === 'tool_use') {
    return [{ type: 'tool_use', toolName: raw.toolName || 'Tool', toolInput: raw.toolInput || {}, raw }];
  }
  if (raw.type === 'tool_result') {
    return [{ type: 'tool_result', toolName: raw.toolName || 'Tool', raw }];
  }
  if (raw.type === 'done') return [{ type: 'done', usage: null, raw }];
  if (raw.type === 'error') {
    return [{
      type: 'error',
      code: String(raw.code || 'AGY_EXEC_FAILURE'),
      message: String(raw.message || 'agy execution failed'),
      raw,
    }];
  }
  return [];
}

function classifyAgyError(value) {
  const msg = String(value && value.message ? value.message : value || '').trim();
  if (!msg) return null;
  if (/agy_capability_unsupported/i.test(msg)) {
    return { code: 'AGY_CAPABILITY_UNSUPPORTED', message: 'agy 暂不支持任务级 allowedTools 或 mcp_config，已拒绝静默扩大权限。' };
  }
  if (/(auth|unauthorized|login|oauth|credential|401|403)/i.test(msg)) {
    return { code: 'AGY_AUTH_REQUIRED', message: 'agy 认证不可用，请先在终端完成 agy 登录。' };
  }
  if (/(rate.?limit|too many requests|quota|429)/i.test(msg)) {
    return { code: 'RATE_LIMIT', message: 'agy 请求频率或配额受限，请稍后重试。' };
  }
  return { code: 'AGY_EXEC_FAILURE', message: msg };
}

function resolveEngineTimeouts(engineName) {
  const engine = normalizeEngineName(engineName);
  const base = ENGINE_TIMEOUT_DEFAULTS[engine] || ENGINE_TIMEOUT_DEFAULTS.claude;
  return { ...base };
}

function buildClaudeArgs(options = {}) {
  const {
    model = ENGINE_MODEL_CONFIG.claude.main,
    readOnly = false,
    session = {},
    addDirs,
    outputSchema = null,
    allowedTools = [],
    mcpConfig = '',
  } = options;
  const args = ['-p', '--model', model];
  if (outputSchema) args.push('--json-schema', JSON.stringify(outputSchema));
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
  // --add-dir: grant file access to additional directories (e.g. worktrees)
  // without changing session storage location (which follows cwd).
  if (Array.isArray(addDirs)) {
    for (const dir of addDirs) {
      if (dir) args.push('--add-dir', dir);
    }
  }
  if (readOnly) {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];
    for (const tool of readOnlyTools) args.push('--allowedTools', tool);
  } else {
    for (const tool of allowedTools) args.push('--allowedTools', tool);
    // Always bypass permission prompts — desktop users run in trusted local context,
    // mobile users cannot click dialogs. Security relies on allowed_chat_ids whitelist.
    args.push('--dangerously-skip-permissions');
  }

  if (session.id === '__continue__') {
    args.push('--continue');
  } else if (session.started && session.id) {
    args.push('--resume', session.id);
  } else if (session.id) {
    args.push('--session-id', session.id);
  }
  return args;
}

function normalizeCodexSandboxMode(value, fallback = 'danger-full-access') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'read-only' || text === 'readonly') return 'read-only';
  if (text === 'workspace-write' || text === 'workspace') return 'workspace-write';
  if (
    text === 'danger-full-access'
    || text === 'dangerous'
    || text === 'full-access'
    || text === 'full'
    || text === 'bypass'
    || text === 'writable'
  ) return 'danger-full-access';
  return fallback;
}

function normalizeCodexApprovalPolicy(value, fallback = 'never') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return fallback;
  if (text === 'never' || text === 'no' || text === 'none') return 'never';
  if (text === 'on-failure' || text === 'on_failure' || text === 'failure') return 'on-failure';
  if (text === 'on-request' || text === 'on_request' || text === 'request') return 'on-request';
  if (text === 'untrusted') return 'untrusted';
  return fallback;
}

function resolveCodexPermissionProfile(options = {}) {
  const { readOnly = false, daemonCfg = {}, session = {} } = options;
  if (readOnly) {
    return {
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      permissionMode: 'read-only',
    };
  }

  const codexCfg = (daemonCfg && daemonCfg.codex && typeof daemonCfg.codex === 'object') ? daemonCfg.codex : {};
  const sandboxMode = normalizeCodexSandboxMode(
    codexCfg.sandbox_mode
      || codexCfg.sandboxMode
      || codexCfg.sandbox
      || codexCfg.permission_mode
      || codexCfg.permissionMode
      || session.sandboxMode
      || session.permissionMode,
    'danger-full-access'
  );
  const approvalPolicy = normalizeCodexApprovalPolicy(
    codexCfg.approval_policy
      || codexCfg.approvalPolicy
      || session.approvalPolicy,
    sandboxMode === 'danger-full-access' ? 'never' : 'on-failure'
  );

  return {
    sandboxMode,
    approvalPolicy,
    permissionMode: sandboxMode,
  };
}

function buildCodexArgs(options = {}) {
  const {
    model = ENGINE_MODEL_CONFIG.codex.main,
    readOnly = false,
    daemonCfg = {},
    session = {},
    cwd,
    permissionProfile = null,
    outputSchemaPath = '',
  } = options;
  if (session && session.id === '__continue__') {
    throw new Error('codex_continue_session_unsupported');
  }
  const isResume = (session && session.started && session.id && session.id !== '__continue__');
  const args = isResume
    ? ['exec', 'resume', session.id]
    : ['exec'];

  args.push('--json', '--skip-git-repo-check');
  if (outputSchemaPath) args.push('--output-schema', outputSchemaPath);
  if (model && !isCodexAutoModel(model)) args.push('-m', model);
  // -C (cwd) is only supported on fresh exec, not resume
  if (cwd && !isResume) args.push('-C', cwd);

  const effectivePermissionProfile = permissionProfile || resolveCodexPermissionProfile({ readOnly, daemonCfg, session });
  if (effectivePermissionProfile.sandboxMode === 'danger-full-access' && effectivePermissionProfile.approvalPolicy === 'never') {
    // Keep the legacy shortcut for the fully-trusted mobile/default path.
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    // codex 0.114.0 removed --ask-for-approval; only -s <sandboxMode> is needed
    args.push('-s', effectivePermissionProfile.sandboxMode);
  }

  // "-" means prompt is read from stdin.
  args.push('-');
  return args;
}

function buildAgyArgs(options = {}) {
  const {
    adapterPath,
    model = ENGINE_MODEL_CONFIG.agy.main,
    readOnly = false,
    session = {},
    cwd = os.homedir(),
    timeoutMs = ENGINE_TIMEOUT_DEFAULTS.agy.idleMs,
    allowedTools = [],
    mcpConfig = '',
  } = options;
  if (!adapterPath) throw new Error('agy_adapter_path_required');
  if ((Array.isArray(allowedTools) && allowedTools.length > 0) || mcpConfig) {
    throw new Error('agy_capability_unsupported');
  }
  const args = [adapterPath, '--cwd', cwd, '--model', model || 'auto', '--timeout-ms', String(timeoutMs)];
  if (readOnly) args.push('--read-only');
  if (session && session.started && session.id && session.id !== '__continue__') {
    args.push('--session', session.id);
  }
  if (session && session.id === '__continue__') throw new Error('agy_continue_session_unsupported');
  return args;
}

function buildCodexEnv(baseEnv = {}, {
  metameProject = '', metameSenderId = '', cwd = '', internalPrompt = false,
} = {}) {
  const env = { ...baseEnv, METAME_PROJECT: metameProject, METAME_SENDER_ID: String(metameSenderId || '') };
  if (internalPrompt) env.METAME_INTERNAL_PROMPT = '1';
  const strippedKeys = [
    'CODEX_THREAD_ID',
    'METAME_ACTIVE_SESSION',
    'CLAUDE_CODE_SSE_PORT',
  ];
  for (const key of strippedKeys) delete env[key];
  void cwd;
  if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) delete env.CODEX_HOME;
  return env;
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

  return function getEngineRuntime(engineName) {
    const engine = normalizeEngineName(engineName);
    if (engine === 'agy') {
      const agyPluginConfig = path.join(home, '.gemini', 'config', 'plugins', 'metame-tools', 'mcp_config.json');
      return {
        name: 'agy',
        binary: process.execPath,
        nativeBinary: agyBin,
        isReady: () => agyBin !== 'agy' && fs.existsSync(agyPluginConfig),
        defaultModel: ENGINE_MODEL_CONFIG.agy.main,
        capabilities: Object.freeze({
          interactiveTurns: true,
          backgroundTurns: true,
          durableSessions: true,
          structuredEvents: 'adapter',
          nativeUsage: false,
          compact: false,
          warmPool: false,
          outputSchema: false,
          projectMcp: 'probe-required',
          projectSkills: 'probe-required',
        }),
        stdinBehavior: 'write-and-close',
        killSignal: 'SIGTERM',
        timeouts: resolveEngineTimeouts('agy'),
        buildArgs: (options = {}) => buildAgyArgs({ ...options, adapterPath: agyAdapterPath }),
        buildEnv: ({ metameProject = '', metameSenderId = '', internalPrompt = false } = {}) => ({
          ...process.env,
          AGY_BIN: agyBin,
          METAME_PROJECT: metameProject,
          METAME_SENDER_ID: String(metameSenderId || ''),
          ...(internalPrompt ? { METAME_INTERNAL_PROMPT: '1' } : {}),
        }),
        parseStreamEvent: parseAgyStreamEvent,
        classifyError: classifyAgyError,
      };
    }
    if (engine === 'codex') {
      return {
        name: 'codex',
        binary: codexBin,
        defaultModel: ENGINE_MODEL_CONFIG.codex.main,
        stdinBehavior: 'write-and-close',
        killSignal: 'SIGTERM',
        timeouts: resolveEngineTimeouts('codex'),
        buildArgs: buildCodexArgs,
        buildEnv: ({ metameProject = '', metameSenderId = '', cwd = '', internalPrompt = false } = {}) => buildCodexEnv(
          process.env,
          { metameProject, metameSenderId, cwd, internalPrompt }
        ),
        parseStreamEvent: parseCodexStreamEvent,
        classifyError: classifyEngineError,
      };
    }
    return {
      name: 'claude',
      binary: claudeBin,
      defaultModel: ENGINE_MODEL_CONFIG.claude.main,
      stdinBehavior: 'write-and-close',
      killSignal: 'SIGTERM',
      timeouts: resolveEngineTimeouts('claude'),
      buildArgs: buildClaudeArgs,
      buildEnv: ({ metameProject = '', metameSenderId = '', providerEnv = {}, internalPrompt = false } = {}) => ({
        ...(() => {
          const env = {
            ...process.env,
            ...getActiveProviderEnv(),
            ...providerEnv,
            METAME_PROJECT: metameProject,
            METAME_SENDER_ID: String(metameSenderId || ''),
          };
          if (internalPrompt) env.METAME_INTERNAL_PROMPT = '1';
          delete env.CLAUDECODE;
          return env;
        })(),
      }),
      parseStreamEvent: parseClaudeStreamEvent,
      classifyError: classifyEngineError,
    };
  };
}

module.exports = {
  createEngineRuntimeFactory,
  normalizeEngineName,
  resolveBinary,
  detectDefaultEngine,
  resolveEngineModel,
  buildCodexArgs,
  normalizeClaudeModel,
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
    looksLikeCodexModel,
    resolveEngineTimeouts,
    classifyAgyError,
  },
};
