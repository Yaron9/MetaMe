'use strict';

const { getEngineDescriptor } = require('../core/engine-descriptors');
const {
  defineNativeCliAdapter,
  acceptsEngineScopedSession,
  createNativeSessionValidator,
} = require('./native-cli-adapter');

const DEFAULT_MODEL = 'sonnet';
const BUILTIN_MODEL_VALUES = Object.freeze(['opus', 'sonnet', 'haiku']);
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

function classifyClaudeError(text) {
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
  return { code: 'EXEC_FAILURE', message: msg };
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
    out.push({ type: 'done', usage: raw.usage || null, result: raw.result || null, raw });
  }
  if (raw.type === 'content_block_start' || raw.type === 'content_block_delta') {
    out.push({ type: 'tool_result', raw });
  }
  if (raw.type === 'error') {
    const classified = classifyClaudeError(raw.error || raw.message || '');
    if (classified) out.push({ type: 'error', ...classified, raw });
  }
  return out;
}

function normalizeClaudeModel(model, fallback = DEFAULT_MODEL) {
  const raw = String(model || '').trim();
  if (!raw) return fallback;
  const normalized = raw.toLowerCase();
  if (BUILTIN_MODEL_VALUES.includes(normalized)) return normalized;
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('sonnet')) return 'sonnet';
  if (normalized.includes('haiku')) return 'haiku';
  return fallback;
}

function modelFamilyAlias(fullModelId) {
  const model = String(fullModelId || '').toLowerCase();
  if (model.includes('opus')) return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('haiku')) return 'haiku';
  return null;
}

function createClaudeSessionPolicy(deps = {}) {
  const fsMod = deps.fs;
  const findSessionFile = deps.findSessionFile;
  const listRecentSessions = deps.listRecentSessions;
  const stripThinkingSignatures = deps.stripThinkingSignatures;
  const autoSyncMinGapMs = Number.isFinite(deps.autoSyncMinGapMs)
    ? deps.autoSyncMinGapMs
    : 60_000;

  return Object.freeze({
    findNewerSession(session) {
      if (
        !session
        || !session.started
        || !session.id
        || session.id === '__continue__'
        || !session.cwd
        || !fsMod
        || typeof fsMod.statSync !== 'function'
        || typeof findSessionFile !== 'function'
        || typeof listRecentSessions !== 'function'
      ) return null;
      try {
        const currentFile = findSessionFile(session.id);
        const currentMtime = currentFile ? fsMod.statSync(currentFile).mtimeMs : 0;
        const candidates = listRecentSessions(2, session.cwd, 'claude') || [];
        const newer = candidates.find(candidate => (
          candidate.sessionId !== session.id
          && (candidate.fileMtime || 0) - currentMtime > autoSyncMinGapMs
        ));
        if (!newer) return null;
        return {
          sessionId: newer.sessionId,
          gapMs: (newer.fileMtime || 0) - currentMtime,
        };
      } catch {
        return null;
      }
    },
    inspectResumeSession(session, configuredModel) {
      const result = {
        shouldResume: true,
        modelPin: null,
        reason: '',
      };
      if (!session || !session.started || !session.id) return result;
      if (!fsMod || typeof fsMod.readFileSync !== 'function' || typeof findSessionFile !== 'function') {
        return result;
      }
      try {
        const sessionFile = findSessionFile(session.id);
        if (!sessionFile) return result;
        const lines = fsMod.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
        for (const line of lines.slice(0, 30)) {
          const entry = JSON.parse(line);
          const sessionModel = entry && entry.message && entry.message.model;
          if (!sessionModel || sessionModel === '<synthetic>') continue;
          const sessionFamily = modelFamilyAlias(sessionModel);
          const configFamily = modelFamilyAlias(configuredModel);
          if (sessionFamily && configFamily && sessionFamily === configFamily) return result;
          if (sessionFamily) {
            return {
              shouldResume: true,
              modelPin: sessionFamily,
              reason: '',
            };
          }
          return result;
        }
      } catch {
        return result;
      }
      return result;
    },
    isThinkingSignatureError(errorMessage) {
      const message = String(errorMessage || '');
      return message.includes('Invalid signature') && message.includes('thinking block');
    },
    classifyResumeFailure(errorMessage) {
      const message = String(errorMessage || '');
      const thinkingSignature = message.includes('Invalid signature')
        && message.includes('thinking block');
      if (thinkingSignature) {
        return { isResumeFailure: true, reason: 'thinking-signature-invalid', repairable: true };
      }
      if (message.includes('already in use')) {
        return { isResumeFailure: true, reason: 'locked', repairable: false };
      }
      if (message.includes('not found') || message.includes('No session')) {
        return { isResumeFailure: true, reason: 'not found', repairable: false };
      }
      return { isResumeFailure: false, reason: '', repairable: false };
    },
    repairResumeSession(session, failure) {
      if (
        !failure
        || !failure.repairable
        || !session
        || !session.id
        || typeof stripThinkingSignatures !== 'function'
      ) return false;
      return stripThinkingSignatures(session.id) > 0;
    },
    formatResumeFallbackUserMessage(retryError) {
      return retryError
        ? '⚠️ 旧 session 无法继续，已自动切换到新 session，但本次请求仍失败。'
        : '';
    },
  });
}

function buildClaudeArgs(options = {}) {
  const {
    model = DEFAULT_MODEL,
    readOnly = false,
    addDirs,
    outputSchema = null,
    outputFormat = '',
    inputFormat = '',
    streaming = false,
    persistent = false,
    allowedTools = [],
    mcpConfig = '',
  } = options;
  const session = options.session || {};
  if (!acceptsEngineScopedSession('claude', session)) {
    throw new Error('claude_native_session_mismatch');
  }
  const args = ['-p', '--model', model];
  if (outputSchema) args.push('--json-schema', JSON.stringify(outputSchema));
  const effectiveOutputFormat = outputFormat || (streaming ? 'stream-json' : '');
  const effectiveInputFormat = inputFormat || (streaming && persistent ? 'stream-json' : '');
  if (effectiveOutputFormat) args.push('--output-format', effectiveOutputFormat);
  if (effectiveInputFormat) args.push('--input-format', effectiveInputFormat);
  if (streaming) args.push('--verbose');
  if (mcpConfig) args.push('--mcp-config', mcpConfig);
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

function createClaudeCliAdapter(deps = {}) {
  const descriptor = getEngineDescriptor('claude');
  const sessionPolicy = createClaudeSessionPolicy(deps.sessionPolicy);
  const getActiveProviderEnv = typeof deps.getActiveProviderEnv === 'function'
    ? deps.getActiveProviderEnv
    : (() => ({}));

  return defineNativeCliAdapter({
    name: 'claude',
    descriptor,
    binary: deps.binary || 'claude',
    defaultModel: deps.defaultModel || DEFAULT_MODEL,
    stdinBehavior: 'write-and-close',
    killSignal: 'SIGTERM',
    timeouts: deps.timeouts || DEFAULT_TIMEOUTS,
    capabilities: {
      interactiveTurns: true,
      backgroundTurns: true,
      durableSessions: true,
      structuredEvents: 'native',
      nativeUsage: true,
      compact: true,
      warmPool: true,
      outputSchema: true,
      projectMcp: true,
      projectSkills: true,
    },
    structuredOutput: Object.freeze({ schema: 'inline', format: 'json', buffer: 'tail', unstructuredBuffer: 'prefix' }),
    buildArgs: buildClaudeArgs,
    buildEnv: ({
      metameProject = '',
      metameSenderId = '',
      providerEnv = {},
      internalPrompt = false,
    } = {}) => {
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
    },
    parseStreamEvent: parseClaudeStreamEvent,
    classifyError: classifyClaudeError,
    acceptsNativeSession: session => acceptsEngineScopedSession('claude', session),
    validateNativeSession: createNativeSessionValidator('claude', deps.validateNativeSession),
    updateNativeSession: (session, observation) => {
      if (!observation.sessionId) return session;
      return {
        ...(session || {}),
        engine: 'claude',
        id: observation.sessionId,
        started: true,
        cwd: observation.cwd || (session && session.cwd) || '',
      };
    },
    recoverFinalOutput(output, nativeResult = {}) {
      if (String(nativeResult.finalValue || '').trim()) return nativeResult;
      const plainFinal = String(output || '').trim();
      if (!plainFinal) return nativeResult;
      return { ...nativeResult, finalValue: plainFinal };
    },
    sessionPolicy,
    formatSpawnError(error) {
      if (!error) return 'Unknown spawn error';
      if (error.code === 'ENOENT') {
        return 'Claude CLI 未安装或不在 PATH。请先确认 `claude` 可执行。';
      }
      return error.message || String(error);
    },
  });
}

module.exports = {
  createClaudeCliAdapter,
  _private: {
    BUILTIN_MODEL_VALUES,
    DEFAULT_TIMEOUTS,
    buildClaudeArgs,
    classifyClaudeError,
    createClaudeSessionPolicy,
    modelFamilyAlias,
    normalizeClaudeModel,
    parseClaudeStreamEvent,
  },
};
