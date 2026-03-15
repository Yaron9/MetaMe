'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CODEX_TOOL_MAP = Object.freeze({
  command_execution: 'Bash',
  file_change: 'Write',
  file_read: 'Read',
  mcp_tool_call: 'MCP',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
});

function normalizeEngineName(name) {
  const text = String(name || '').trim().toLowerCase();
  return text === 'codex' ? 'codex' : 'claude';
}

function resolveBinary(engineName, deps = {}) {
  const engine = normalizeEngineName(engineName);
  const home = deps.HOME || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const execSyncFn = deps.execSync || execSync;

  const key = engine === 'codex' ? 'codex' : 'claude';
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
    main:     'gpt-5.4',           // recommended for most tasks (official default)
    distill:  'gpt-5.1-codex-mini', // cost-effective mini
    options:  [                     // quick-pick buttons (official model names)
      { value: 'gpt-5.4',            label: 'gpt-5.4 · 推荐' },
      { value: 'gpt-5.3-codex',      label: 'gpt-5.3-codex · 最新 Codex 专用' },
      { value: 'gpt-5.1-codex-max',  label: 'gpt-5.1-codex-max · 长任务' },
      { value: 'gpt-5.1-codex-mini', label: 'gpt-5.1-codex-mini · 轻量' },
    ],
    provider: 'openai',
    hint:     '或直接发送任意 OpenAI 模型名切换',
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
  if (explicitModel) return explicitModel;

  const perEngineModel = String(engineModels[engine] || '').trim();
  if (perEngineModel) return perEngineModel;

  const legacyModel = String((daemonCfg && daemonCfg.model) || '').trim();
  if (!legacyModel) return engineCfg.main;

  // Legacy daemon.model historically meant a Claude model.
  // Preserve backward compatibility for non-Claude custom model IDs,
  // but do not leak Claude aliases like "opus" into Codex sessions.
  if (engine === 'codex' && BUILTIN_CLAUDE_MODEL_VALUES.includes(legacyModel)) {
    return engineCfg.main;
  }
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
  if (/(rate.?limit|too many requests|quota|429)/i.test(msg)) {
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

function buildClaudeArgs(options = {}) {
  const { model = ENGINE_MODEL_CONFIG.claude.main, readOnly = false, session = {} } = options;
  const args = ['-p', '--model', model];
  if (readOnly) {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];
    for (const tool of readOnlyTools) args.push('--allowedTools', tool);
  } else {
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
  } = options;
  const isResume = (session && session.started && session.id && session.id !== '__continue__');
  const args = isResume
    ? ['exec', 'resume', session.id]
    : ['exec'];

  args.push('--json', '--skip-git-repo-check');
  if (model) args.push('-m', model);
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

function buildCodexEnv(baseEnv = {}, { metameProject = '', metameSenderId = '' } = {}) {
  const env = { ...baseEnv, METAME_PROJECT: metameProject, METAME_SENDER_ID: String(metameSenderId || '') };
  const strippedKeys = [
    'CODEX_THREAD_ID',
    'METAME_ACTIVE_SESSION',
    'CLAUDE_CODE_SSE_PORT',
  ];
  for (const key of strippedKeys) delete env[key];
  if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) delete env.CODEX_HOME;
  return env;
}

function createEngineRuntimeFactory(deps = {}) {
  const home = deps.HOME || os.homedir();
  const claudeBin = deps.CLAUDE_BIN || resolveBinary('claude', { ...deps, HOME: home });
  const codexBin = deps.CODEX_BIN || resolveBinary('codex', { ...deps, HOME: home });
  const getActiveProviderEnv = typeof deps.getActiveProviderEnv === 'function'
    ? deps.getActiveProviderEnv
    : (() => ({}));

  return function getEngineRuntime(engineName) {
    const engine = normalizeEngineName(engineName);
    if (engine === 'codex') {
      return {
        name: 'codex',
        binary: codexBin,
        defaultModel: ENGINE_MODEL_CONFIG.codex.main,
        stdinBehavior: 'write-and-close',
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 10 * 60 * 1000, toolMs: 25 * 60 * 1000, ceilingMs: 60 * 60 * 1000 },
        buildArgs: buildCodexArgs,
        buildEnv: ({ metameProject = '', metameSenderId = '' } = {}) => buildCodexEnv(process.env, { metameProject, metameSenderId }),
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
      timeouts: { idleMs: 5 * 60 * 1000, toolMs: 25 * 60 * 1000, ceilingMs: 60 * 60 * 1000 },
      buildArgs: buildClaudeArgs,
      buildEnv: ({ metameProject = '', metameSenderId = '' } = {}) => ({
        ...(() => {
          const env = { ...process.env, ...getActiveProviderEnv(), METAME_PROJECT: metameProject, METAME_SENDER_ID: String(metameSenderId || '') };
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
  ENGINE_MODEL_CONFIG,
  ENGINE_DISTILL_MAP,
  ENGINE_DEFAULT_MODEL,
  _private: {
    classifyEngineError,
    parseClaudeStreamEvent,
    parseCodexStreamEvent,
    buildClaudeArgs,
    buildCodexArgs,
    buildCodexEnv,
    normalizeCodexSandboxMode,
    normalizeCodexApprovalPolicy,
    resolveCodexPermissionProfile,
    BUILTIN_CLAUDE_MODEL_VALUES,
  },
};
