'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync: nodeExecFileSync } = require('child_process');
const { getEngineDescriptor } = require('../core/engine-descriptors');
const {
  defineNativeCliAdapter,
  acceptsEngineScopedSession,
} = require('./native-cli-adapter');

const DEFAULT_TIMEOUTS = Object.freeze({
  idleMs: 20 * 60 * 1000,
  toolMs: 25 * 60 * 1000,
  ceilingMs: null,
});
const DEFAULT_PROVIDER = 'google';
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_NATIVE_RECORD_BYTES = 1024 * 1024;
const PI_SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const READ_ONLY_TOOLS = 'read,grep,find,ls';

function parseJsonLine(line) {
  if (line && typeof line === 'object') return line;
  const text = String(line || '');
  if (Buffer.byteLength(text, 'utf8') > MAX_NATIVE_RECORD_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolvePiBinary(deps = {}) {
  const home = deps.home || deps.HOME || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const execFileSync = deps.execFileSync || nodeExecFileSync;
  const platform = deps.platform || process.platform;
  const lookup = platform === 'win32' ? 'where' : 'which';

  try {
    const output = execFileSync(lookup, ['pi'], {
      encoding: 'utf8',
      timeout: 3000,
      ...(platform === 'win32' ? { windowsHide: true } : {}),
    });
    const first = String(output || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (first) return first;
  } catch {
    // Fall through to the small, platform-specific candidate list.
  }

  const candidates = [
    pathMod.join(home, '.local', 'bin', 'pi'),
    pathMod.join(home, '.npm-global', 'bin', 'pi'),
    '/usr/local/bin/pi',
    '/opt/homebrew/bin/pi',
  ];
  for (const candidate of candidates) {
    try {
      if (fsMod.existsSync(candidate)) return candidate;
    } catch {
      // An inaccessible candidate is equivalent to a missing binary.
    }
  }
  return 'pi';
}

function firstConfiguredValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function piConfig(options = {}) {
  return options.daemonCfg && options.daemonCfg.pi && typeof options.daemonCfg.pi === 'object'
    ? options.daemonCfg.pi
    : {};
}

function assertPromptWithinLimit(input) {
  if (input === undefined || input === null) return;
  const text = String(input);
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error('pi_prompt_too_large');
  }
}

function buildPiArgs(options = {}) {
  assertPromptWithinLimit(options.input);
  const cfg = piConfig(options);
  const provider = firstConfiguredValue(options.provider, cfg.provider, options.defaultProvider);
  const model = firstConfiguredValue(options.model, cfg.model);
  const thinking = firstConfiguredValue(options.thinking, cfg.thinking);
  const sessionDir = firstConfiguredValue(options.sessionDir, cfg.session_dir, cfg.sessionDir);
  const session = options.session || options.nativeSession || {};

  if (!acceptsEngineScopedSession('pi', session)) {
    throw new Error('pi_native_session_mismatch');
  }
  if (session.id === '__continue__') {
    throw new Error('pi_continue_session_unsupported');
  }
  if (thinking && !THINKING_LEVELS.has(thinking)) {
    throw new Error('pi_thinking_level_invalid');
  }
  if (options.mcpConfig) {
    throw new Error('pi_capability_unsupported');
  }

  const args = ['--mode', 'json'];
  if (provider) args.push('--provider', provider);
  if (model) args.push('--model', model);
  if (thinking) args.push('--thinking', thinking);
  if (sessionDir) args.push('--session-dir', sessionDir);

  const allowedTools = Array.isArray(options.allowedTools) ? options.allowedTools.filter(Boolean) : [];
  if (options.readOnly) {
    args.push('--tools', READ_ONLY_TOOLS);
  } else if (allowedTools.length > 0) {
    args.push('--tools', allowedTools.map(String).join(','));
  }

  if (session.id) {
    const sessionId = String(session.id).trim();
    if (!PI_SESSION_ID_RE.test(sessionId)) throw new Error('pi_native_session_id_invalid');
    // Pi's documented continuation primitive is --session-id.  It resumes
    // an exact project session and creates the ID when it is missing.
    args.push('--session-id', sessionId);
  }
  return args;
}

function redactSensitiveText(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_ -]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .slice(0, 500);
}

function errorText(value) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    for (const key of ['message', 'errorMessage', 'error', 'detail']) {
      if (value[key] && value[key] !== value) return errorText(value[key]);
    }
    try { return JSON.stringify(value); } catch { return ''; }
  }
  return String(value || '');
}

function classifyPiError(value) {
  const msg = redactSensitiveText(errorText(value).trim());
  if (!msg) return null;
  if (/(auth|unauthorized|login|api key|authentication|credential|permission denied|forbidden|401|403)/i.test(msg)) {
    return {
      code: 'AUTH_REQUIRED',
      message: 'Pi 认证不可用，请先完成 Pi 登录或配置 provider 凭证后重试。',
    };
  }
  if (/(rate.?limit|usage limit|too many requests|quota|purchase more credits|429)/i.test(msg)) {
    return {
      code: 'RATE_LIMIT',
      message: 'Pi 请求频率或配额受限，请稍后重试。',
    };
  }
  if (/pi_capability_unsupported/i.test(msg)) {
    return {
      code: 'PI_CAPABILITY_UNSUPPORTED',
      message: 'Pi 当前适配器不支持该任务级能力配置。',
    };
  }
  return { code: 'PI_EXEC_FAILURE', message: msg };
}

function assistantUsage(message) {
  return message && message.role === 'assistant' && message.usage
    ? message.usage
    : null;
}

function parsePiStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const out = [];
  if (raw.type === 'session' && raw.id) {
    out.push({
      type: 'session',
      sessionId: String(raw.id),
      cwd: raw.cwd ? String(raw.cwd) : '',
      raw,
    });
  }

  if (raw.type === 'message_update' && raw.assistantMessageEvent) {
    const update = raw.assistantMessageEvent;
    if (update.type === 'text_delta' && update.delta) {
      out.push({ type: 'text', text: String(update.delta), raw });
    } else if (update.type === 'thinking_delta' && update.delta) {
      out.push({ type: 'thinking', text: String(update.delta), raw });
    } else if (update.type === 'toolcall_delta' && update.delta) {
      out.push({ type: 'tool_update', toolInput: String(update.delta), raw });
    } else if (update.type === 'toolcall_end' && update.toolCall) {
      // The later tool_execution_start event is the single lifecycle start
      // used for overlays.  Keep this provider-side completion as an update
      // so tool calls are not counted twice by the generic coordinator.
      const toolCall = update.toolCall;
      out.push({
        type: 'tool_update',
        toolName: toolCall.name || 'Tool',
        toolInput: toolCall.arguments || {},
        toolCallId: toolCall.id || '',
        raw,
      });
    } else if (update.type === 'done') {
      const usage = assistantUsage(update.message) || assistantUsage(raw.message);
      if (usage) out.push({ type: 'usage', usage, raw });
    } else if (update.type === 'error') {
      const classified = classifyPiError(update.error || update.message || raw.message);
      if (classified) out.push({ type: 'error', ...classified, raw });
    }
  }

  if (raw.type === 'message_end' && raw.message && raw.message.role === 'assistant') {
    const usage = assistantUsage(raw.message);
    if (usage) out.push({ type: 'usage', usage, raw });
    if (raw.message.stopReason === 'error' || raw.message.stopReason === 'aborted') {
      const classified = classifyPiError(raw.message.errorMessage || raw.message.stopReason);
      if (classified) out.push({ type: 'error', ...classified, raw });
    }
  }

  if (raw.type === 'tool_execution_start') {
    out.push({
      type: 'tool_use',
      toolName: raw.toolName || 'Tool',
      toolInput: raw.args || {},
      toolCallId: raw.toolCallId || '',
      raw,
    });
  }
  if (raw.type === 'tool_execution_update') {
    out.push({
      type: 'tool_update',
      toolName: raw.toolName || 'Tool',
      toolInput: raw.args || {},
      toolCallId: raw.toolCallId || '',
      toolResult: raw.partialResult,
      raw,
    });
  }
  if (raw.type === 'tool_execution_end') {
    out.push({
      type: 'tool_result',
      toolName: raw.toolName || 'Tool',
      toolCallId: raw.toolCallId || '',
      toolResult: raw.result,
      isError: !!raw.isError,
      raw,
    });
  }

  if (raw.type === 'agent_end' && Array.isArray(raw.messages)) {
    const assistant = [...raw.messages].reverse().find(message => (
      message && message.role === 'assistant'
    ));
    if (assistant && (assistant.stopReason === 'error' || assistant.stopReason === 'aborted')) {
      const classified = classifyPiError(assistant.errorMessage || assistant.stopReason);
      if (classified) out.push({ type: 'error', ...classified, raw });
    }
  }
  if (raw.type === 'agent_settled') {
    out.push({ type: 'done', usage: null, raw });
  }
  return out;
}

function createPiSessionValidator() {
  return session => {
    if (!acceptsEngineScopedSession('pi', session)) return false;
    if (!session || !session.started || !session.id || !session.cwd) return true;
    if (session.id === '__continue__') return false;
    return PI_SESSION_ID_RE.test(String(session.id).trim());
  };
}

function createPiCliAdapter(deps = {}) {
  const binary = deps.binary || resolvePiBinary(deps);
  const defaultProvider = deps.defaultProvider || DEFAULT_PROVIDER;
  const defaultSessionDir = deps.sessionDir || '';
  const descriptor = getEngineDescriptor('pi');
  const execFileSync = deps.execFileSync || nodeExecFileSync;
  const isReady = () => binary !== 'pi';

  return defineNativeCliAdapter({
    name: 'pi',
    descriptor,
    binary,
    defaultModel: deps.defaultModel === undefined ? '' : deps.defaultModel,
    defaultProvider,
    stdinBehavior: 'write-and-close',
    outputFraming: 'jsonl',
    killSignal: 'SIGTERM',
    timeouts: deps.timeouts || DEFAULT_TIMEOUTS,
    capabilities: {
      interactiveTurns: true,
      backgroundTurns: true,
      durableSessions: true,
      structuredEvents: 'native',
      nativeUsage: true,
      compact: false,
      warmPool: false,
      outputSchema: false,
      projectMcp: true,
      projectSkills: true,
    },
    isReady,
    probe() {
      if (!isReady()) {
        return { engineId: 'pi', state: 'unsupported', code: 'PI_NOT_INSTALLED', executable: binary };
      }
      try {
        const output = execFileSync(binary, ['--version'], {
          encoding: 'utf8',
          timeout: 3000,
          env: { ...process.env, PI_OFFLINE: '1' },
        });
        const version = String(output || '').trim().split(/\r?\n/)[0].slice(0, 80);
        return { engineId: 'pi', state: 'detected', executable: binary, version };
      } catch {
        return { engineId: 'pi', state: 'unsupported', code: 'PI_NOT_INSTALLED', executable: binary };
      }
    },
    buildArgs: (options = {}) => buildPiArgs({
      ...options,
      defaultProvider,
      sessionDir: options.sessionDir || defaultSessionDir,
    }),
    buildEnv: ({
      metameProject = '',
      metameSenderId = '',
      providerEnv = {},
      baseEnv = {},
      offline = false,
    } = {}) => ({
      ...process.env,
      ...baseEnv,
      ...providerEnv,
      METAME_PROJECT: metameProject,
      METAME_SENDER_ID: String(metameSenderId || ''),
      ...(offline ? { PI_OFFLINE: '1' } : {}),
    }),
    parseStreamEvent: parsePiStreamEvent,
    classifyError: classifyPiError,
    acceptsNativeSession: session => acceptsEngineScopedSession('pi', session),
    validateNativeSession: createPiSessionValidator(),
    updateNativeSession: (session, observation) => {
      if (!observation.sessionId) return session;
      return {
        ...(session || {}),
        engine: 'pi',
        id: observation.sessionId,
        started: true,
        cwd: observation.cwd || (session && session.cwd) || '',
      };
    },
    formatSpawnError(error) {
      if (!error) return 'Unknown spawn error';
      if (error.code === 'ENOENT') return 'Pi CLI 未安装或不在 PATH。请先确认 `pi` 可执行。';
      return error.message || String(error);
    },
  });
}

module.exports = {
  createPiCliAdapter,
  _private: {
    DEFAULT_PROVIDER,
    DEFAULT_TIMEOUTS,
    MAX_NATIVE_RECORD_BYTES,
    MAX_PROMPT_BYTES,
    PI_SESSION_ID_RE,
    buildPiArgs,
    classifyPiError,
    parsePiStreamEvent,
    resolvePiBinary,
  },
};
