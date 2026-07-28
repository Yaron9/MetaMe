'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEngineDescriptor } = require('../core/engine-descriptors');
const { AGY_DEFAULT_MODEL } = require('../core/agy-model');
const {
  defineNativeCliAdapter,
  acceptsEngineScopedSession,
  createNativeSessionValidator,
} = require('./native-cli-adapter');

const DEFAULT_TIMEOUTS = Object.freeze({
  idleMs: 20 * 60 * 1000,
  toolMs: 25 * 60 * 1000,
  ceilingMs: null,
});

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
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
    return {
      code: 'AGY_CAPABILITY_UNSUPPORTED',
      message: 'agy 暂不支持任务级 allowedTools 或 mcp_config，已拒绝静默扩大权限。',
    };
  }
  if (/(auth|unauthorized|login|oauth|credential|401|403)/i.test(msg)) {
    return { code: 'AGY_AUTH_REQUIRED', message: 'agy 认证不可用，请先在终端完成 agy 登录。' };
  }
  if (/(rate.?limit|too many requests|quota|429)/i.test(msg)) {
    return { code: 'RATE_LIMIT', message: 'agy 请求频率或配额受限，请稍后重试。' };
  }
  return { code: 'AGY_EXEC_FAILURE', message: msg };
}

function buildAgyArgs(options = {}) {
  const {
    adapterPath,
    model = AGY_DEFAULT_MODEL,
    readOnly = false,
    cwd = os.homedir(),
    timeoutMs = DEFAULT_TIMEOUTS.idleMs,
    allowedTools = [],
    mcpConfig = '',
  } = options;
  const session = options.session || {};
  if (!acceptsEngineScopedSession('agy', session)) {
    throw new Error('agy_native_session_mismatch');
  }
  if (!adapterPath) throw new Error('agy_adapter_path_required');
  if ((Array.isArray(allowedTools) && allowedTools.length > 0) || mcpConfig) {
    throw new Error('agy_capability_unsupported');
  }
  const args = [
    adapterPath,
    '--cwd',
    cwd,
    '--model',
    model || 'auto',
    '--timeout-ms',
    String(timeoutMs),
  ];
  if (readOnly) args.push('--read-only');
  if (session && session.started && session.id && session.id !== '__continue__') {
    args.push('--session', session.id);
  }
  if (session && session.id === '__continue__') {
    throw new Error('agy_continue_session_unsupported');
  }
  return args;
}

function createAgyCliAdapter(deps = {}) {
  const home = deps.home || os.homedir();
  const nativeBinary = deps.nativeBinary || 'agy';
  const adapterPath = deps.adapterPath;
  const pluginConfig = deps.pluginConfig
    || path.join(home, '.gemini', 'config', 'plugins', 'metame-tools', 'mcp_config.json');

  return defineNativeCliAdapter({
    name: 'agy',
    descriptor: getEngineDescriptor('agy'),
    binary: deps.binary || process.execPath,
    nativeBinary,
    isReady: () => nativeBinary !== 'agy' && fs.existsSync(pluginConfig),
    defaultModel: deps.defaultModel || AGY_DEFAULT_MODEL,
    stdinBehavior: 'write-and-close',
    killSignal: 'SIGTERM',
    timeouts: deps.timeouts || DEFAULT_TIMEOUTS,
    capabilities: {
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
    },
    buildArgs: (options = {}) => buildAgyArgs({ ...options, adapterPath }),
    buildEnv: ({
      metameProject = '',
      metameSenderId = '',
      internalPrompt = false,
    } = {}) => ({
      ...process.env,
      AGY_BIN: nativeBinary,
      METAME_PROJECT: metameProject,
      METAME_SENDER_ID: String(metameSenderId || ''),
      ...(internalPrompt ? { METAME_INTERNAL_PROMPT: '1' } : {}),
    }),
    parseStreamEvent: parseAgyStreamEvent,
    classifyError: classifyAgyError,
    acceptsNativeSession: session => acceptsEngineScopedSession('agy', session),
    validateNativeSession: createNativeSessionValidator('agy', deps.validateNativeSession),
    updateNativeSession: (session, observation) => {
      if (!observation.sessionId) return session;
      return {
        ...(session || {}),
        engine: 'agy',
        id: observation.sessionId,
        started: true,
        cwd: observation.cwd || (session && session.cwd) || '',
      };
    },
    formatSpawnError(error) {
      if (!error) return 'Unknown spawn error';
      if (error.code === 'ENOENT') {
        return 'agy adapter 无法启动，请运行 `/doctor` 检查 agy CLI。';
      }
      return error.message || String(error);
    },
  });
}

module.exports = {
  createAgyCliAdapter,
  _private: {
    DEFAULT_TIMEOUTS,
    buildAgyArgs,
    classifyAgyError,
    parseAgyStreamEvent,
  },
};
