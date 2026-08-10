'use strict';

const fs = require('fs');
const path = require('path');
const { getEngineDescriptor } = require('../core/engine-descriptors');
const {
  defineNativeCliAdapter,
  acceptsEngineScopedSession,
  createNativeSessionValidator,
} = require('./native-cli-adapter');

const DEFAULT_MODEL = 'auto';
const DEFAULT_TIMEOUTS = Object.freeze({
  idleMs: 10 * 60 * 1000,
  toolMs: 25 * 60 * 1000,
  ceilingMs: null,
});
const TOOL_MAP = Object.freeze({
  command_execution: 'Bash',
  file_change: 'Write',
  file_read: 'Read',
  mcp_tool_call: 'MCP',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
});
const RESUME_RETRY_WINDOW_MS = 10 * 60 * 1000;
const PERMISSION_STABILIZE_MAX_RETRIES = 2;

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function classifyCodexError(text) {
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

function parseCodexStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object') return [];

  const out = [];
  if (raw.type === 'thread.started' && raw.thread_id) {
    out.push({ type: 'session', sessionId: String(raw.thread_id), raw });
  }

  if ((raw.type === 'item.started' || raw.type === 'item.completed') && raw.item && raw.item.type) {
    const itemType = String(raw.item.type);
    const mapped = TOOL_MAP[itemType] || itemType;
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
    const classified = classifyCodexError(raw.error || raw.message || '');
    if (classified) out.push({ type: 'error', ...classified, raw });
  }
  return out;
}

function looksLikeCodexModel(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (!raw) return false;
  return (
    raw === DEFAULT_MODEL
    || raw.startsWith('gpt-')
    || raw.startsWith('o1')
    || raw.startsWith('o3')
    || raw.startsWith('o4')
    || raw.includes('codex')
  );
}

function isCodexAutoModel(model) {
  return String(model || '').trim().toLowerCase() === DEFAULT_MODEL;
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
  const { readOnly = false, daemonCfg = {} } = options;
  const session = options.session || {};
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

function normalizeComparablePermissionProfile(profile) {
  if (!profile) return null;
  const sandboxMode = normalizeCodexSandboxMode(
    profile.sandboxMode || profile.permissionMode,
    null
  );
  const approvalPolicy = normalizeCodexApprovalPolicy(
    profile.approvalPolicy,
    null
  );
  if (!sandboxMode && !approvalPolicy) return null;
  return {
    sandboxMode,
    approvalPolicy,
    permissionMode: sandboxMode,
  };
}

function samePermissionProfile(left, right) {
  const normalizedLeft = normalizeComparablePermissionProfile(left);
  const normalizedRight = normalizeComparablePermissionProfile(right);
  if (!normalizedLeft || !normalizedRight) return false;
  const sameSandbox = normalizedLeft.sandboxMode === normalizedRight.sandboxMode;
  const leftApproval = String(normalizedLeft.approvalPolicy || '').trim();
  const rightApproval = String(normalizedRight.approvalPolicy || '').trim();
  if (!leftApproval || !rightApproval) return sameSandbox;
  return sameSandbox && leftApproval === rightApproval;
}

function sandboxPrivilegeRank(value) {
  const normalized = normalizeCodexSandboxMode(value, null);
  if (normalized === 'read-only') return 0;
  if (normalized === 'workspace-write') return 1;
  if (normalized === 'danger-full-access') return 2;
  return -1;
}

function approvalPrivilegeRank(value) {
  const normalized = normalizeCodexApprovalPolicy(value, null);
  if (normalized === 'untrusted') return 0;
  if (normalized === 'on-request') return 1;
  if (normalized === 'on-failure') return 2;
  if (normalized === 'never') return 3;
  return -1;
}

function needsFallbackForRequestedPermissions(actualProfile, requestedProfile) {
  const normalizedActual = normalizeComparablePermissionProfile(actualProfile);
  const normalizedRequested = normalizeComparablePermissionProfile(requestedProfile);
  if (!normalizedActual || !normalizedRequested) return false;
  return (
    sandboxPrivilegeRank(normalizedActual.sandboxMode) < sandboxPrivilegeRank(normalizedRequested.sandboxMode)
    || approvalPrivilegeRank(normalizedActual.approvalPolicy) < approvalPrivilegeRank(normalizedRequested.approvalPolicy)
  );
}

function buildFallbackBridgePrompt({
  fullPrompt,
  previousSessionId,
  previousProfile,
  requestedProfile,
  recentContext,
}) {
  const bridge = [];
  bridge.push('[Note: continuing the same MetaMe persona conversation on a fresh Codex execution thread because the previous thread could not satisfy the newly requested permission profile.]');
  if (previousSessionId) {
    bridge.push(`Previous Codex thread: ${String(previousSessionId).slice(0, 8)}`);
  }
  if (previousProfile || requestedProfile) {
    const previousSummary = previousProfile
      ? `${previousProfile.sandboxMode || previousProfile.permissionMode || 'unknown'}/${previousProfile.approvalPolicy || 'unknown'}`
      : 'unknown/unknown';
    const requestedSummary = requestedProfile
      ? `${requestedProfile.sandboxMode || requestedProfile.permissionMode || 'unknown'}/${requestedProfile.approvalPolicy || 'unknown'}`
      : 'unknown/unknown';
    bridge.push(`Permission migration: ${previousSummary} -> ${requestedSummary}`);
  }
  if (recentContext && (recentContext.lastUser || recentContext.lastAssistant)) {
    bridge.push('Recent conversation context:');
    if (recentContext.lastUser) bridge.push(`Last user message: ${String(recentContext.lastUser).trim()}`);
    if (recentContext.lastAssistant) bridge.push(`Last assistant reply: ${String(recentContext.lastAssistant).trim()}`);
  }
  bridge.push('Continue as the same conversation. Do not mention any internal thread migration unless the user explicitly asks.');
  return `${bridge.join('\n')}\n\n[Current user message follows:]\n\n${fullPrompt}`;
}

function classifyResumeFailure(error, errorCode) {
  const message = String(error || '').trim();
  const code = String(errorCode || '').trim();
  const lowered = message.toLowerCase();
  const nonRetryable = (
    code === 'AUTH_REQUIRED'
    || code === 'RATE_LIMIT'
    || lowered.includes('usage limit')
    || lowered.includes('purchase more credits')
    || lowered.includes('quota')
    || lowered.includes('rate limit')
    || lowered.includes('too many requests')
    || lowered.includes('429')
    || lowered.includes('unauthorized')
    || lowered.includes('authentication')
    || lowered.includes('api key')
    || lowered.includes('login')
    || lowered.includes('forbidden')
    || lowered.includes('401')
    || lowered.includes('403')
  );
  if (nonRetryable) {
    return { kind: 'fatal', userMessage: '', retryPromptPrefix: '' };
  }
  if (code === 'INTERRUPTED_USER') {
    return {
      kind: 'user-stop',
      userMessage: '⚠️ 当前执行已按你的停止动作中断，本轮不会自动续跑。',
      retryPromptPrefix: '',
    };
  }
  if (code === 'INTERRUPTED_MERGE_PAUSE' || lowered.includes('paused for merge')) {
    return { kind: 'merge-pause', userMessage: '', retryPromptPrefix: '' };
  }
  if (
    lowered.includes('stopped by user')
    || lowered.includes('interrupted')
    || lowered.includes('signal')
    || code === 'INTERRUPTED'
    || code === 'INTERRUPTED_RESTART'
  ) {
    return {
      kind: 'interrupted',
      userMessage: '⚠️ 后台刚刚重启或本轮执行被中断。系统正在自动恢复到同一条会话，请稍等。',
      retryPromptPrefix: '[Note: the previous Codex execution was interrupted by a daemon restart or user stop signal. Continue the same conversation if possible. User message follows:]',
    };
  }
  if (
    lowered.includes('stream disconnected')
    || lowered.includes('connection reset')
    || lowered.includes('connection aborted')
    || lowered.includes('broken pipe')
    || lowered.includes('timed out')
    || lowered.includes('timeout')
    || lowered.includes('temporarily unavailable')
    || lowered.includes('error sending request')
    || lowered.includes('http2')
  ) {
    return {
      kind: 'transport',
      userMessage: '⚠️ Codex 续接时网络/传输中断。系统正在优先重试同一条会话，不按 session 过期处理。',
      retryPromptPrefix: '[Note: the previous Codex resume attempt was interrupted by a transient transport error. Continue the same conversation if possible. User message follows:]',
    };
  }
  return {
    kind: 'expired',
    userMessage: '⚠️ Codex session 已过期，上下文可能丢失。正在以全新 session 重试，请在回复后补充必要背景。',
    retryPromptPrefix: '[Note: previous Codex session expired and could not be resumed. Treating this as a new session. User message follows:]',
  };
}

function createCodexSessionPolicy(deps = {}) {
  const retriedAt = new Map();
  const now = typeof deps.now === 'function' ? deps.now : (() => Date.now());

  function retryKey(chatId, kind = 'default') {
    const base = String(chatId || '').trim();
    const mode = String(kind || 'default').trim();
    return base && mode ? `${base}:${mode}` : '';
  }

  return Object.freeze({
    maxStabilizationRetries: PERMISSION_STABILIZE_MAX_RETRIES,
    retryWindowMs: RESUME_RETRY_WINDOW_MS,
    resolvePermissionProfile: resolveCodexPermissionProfile,
    normalizeComparablePermissionProfile,
    samePermissionProfile,
    sandboxPrivilegeRank,
    approvalPrivilegeRank,
    needsFallbackForRequestedPermissions,
    buildFallbackBridgePrompt,
    classifyResumeFailure,
    getActualPermissionProfile(session) {
      if (!session || !session.id) return null;
      if (typeof deps.getSessionSandboxProfile === 'function') {
        return deps.getSessionSandboxProfile(session.id, session.cwd || '');
      }
      if (typeof deps.getSessionPermissionMode === 'function') {
        const permissionMode = deps.getSessionPermissionMode(session.id, session.cwd || '');
        return permissionMode
          ? { sandboxMode: permissionMode, approvalPolicy: null, permissionMode }
          : null;
      }
      return null;
    },
    retryKey,
    canRetry(chatId, kind = 'default') {
      const key = retryKey(chatId, kind);
      if (!key) return false;
      const last = Number(retriedAt.get(key) || 0);
      return !last || (now() - last) > RESUME_RETRY_WINDOW_MS;
    },
    markRetried(chatId, kind = 'default') {
      const key = retryKey(chatId, kind);
      if (key) retriedAt.set(key, now());
    },
    clearRetries(chatId) {
      for (const kind of ['interrupted', 'transport', 'expired', 'default']) {
        retriedAt.delete(retryKey(chatId, kind));
      }
    },
    shouldRetryResumeFallback({
      wasResumeAttempt,
      output,
      error,
      errorCode,
      canRetry,
      failureKind = '',
    }) {
      return !!wasResumeAttempt
        && !!error
        && (!output || !!errorCode)
        && failureKind !== 'user-stop'
        && failureKind !== 'merge-pause'
        && failureKind !== 'fatal'
        && !!canRetry;
    },
  });
}

function buildCodexArgs(options = {}) {
  const {
    model = DEFAULT_MODEL,
    readOnly = false,
    daemonCfg = {},
    session = {},
    cwd,
    permissionProfile = null,
    outputSchemaPath = '',
  } = options;
  if (!acceptsEngineScopedSession('codex', session)) {
    throw new Error('codex_native_session_mismatch');
  }
  if (session && session.id === '__continue__') {
    throw new Error('codex_continue_session_unsupported');
  }
  const isResume = session && session.started && session.id && session.id !== '__continue__';
  const args = isResume ? ['exec', 'resume', session.id] : ['exec'];

  args.push('--json', '--skip-git-repo-check');
  if (outputSchemaPath) args.push('--output-schema', outputSchemaPath);
  if (model && !isCodexAutoModel(model)) args.push('-m', model);
  if (cwd && !isResume) args.push('-C', cwd);

  const effectivePermissionProfile = permissionProfile
    || resolveCodexPermissionProfile({ readOnly, daemonCfg, session });
  if (effectivePermissionProfile.sandboxMode === 'danger-full-access'
      && effectivePermissionProfile.approvalPolicy === 'never') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('-s', effectivePermissionProfile.sandboxMode);
  }
  args.push('-');
  return args;
}

function buildCodexEnv(baseEnv = {}, {
  metameProject = '',
  metameSenderId = '',
  cwd = '',
  internalPrompt = false,
} = {}) {
  const env = {
    ...baseEnv,
    METAME_PROJECT: metameProject,
    METAME_SENDER_ID: String(metameSenderId || ''),
  };
  if (internalPrompt) env.METAME_INTERNAL_PROMPT = '1';
  for (const key of ['CODEX_THREAD_ID', 'METAME_ACTIVE_SESSION', 'CLAUDE_CODE_SSE_PORT']) {
    delete env[key];
  }
  void cwd;
  if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) delete env.CODEX_HOME;
  return env;
}

function projectCodexContext(options = {}) {
  const cwd = String(options.cwd || '').trim();
  if (!cwd || options.fresh === false) return { status: 'skipped', sections: 0 };
  const fsMod = options.fs || fs;
  const pathMod = options.path || path;
  const log = typeof options.log === 'function' ? options.log : (() => {});
  const agentsMd = pathMod.join(cwd, 'AGENTS.md');

  try {
    let canRefresh = false;
    try {
      canRefresh = !fsMod.lstatSync(agentsMd).isSymbolicLink();
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        canRefresh = true;
      } else {
        log('WARN', `AGENTS.md lstat failed in ${cwd}; skip refresh: ${error.message}`);
        return { status: 'lstat-failed', sections: 0, error };
      }
    }
    if (!canRefresh) {
      log('INFO', `AGENTS.md is not a regular file in ${cwd}; relying on link target (skip refresh)`);
      return { status: 'symlink-skipped', sections: 0 };
    }

    const parts = [];
    const claudeMd = pathMod.join(cwd, 'CLAUDE.md');
    const soulMd = pathMod.join(cwd, 'SOUL.md');
    if (fsMod.existsSync(claudeMd)) parts.push(fsMod.readFileSync(claudeMd, 'utf8').trim());
    if (fsMod.existsSync(soulMd)) {
      const soulContent = fsMod.readFileSync(soulMd, 'utf8').trim();
      if (soulContent) parts.push(soulContent);
    }
    if (parts.length === 0) return { status: 'empty', sections: 0 };

    fsMod.writeFileSync(agentsMd, parts.join('\n\n'), 'utf8');
    log('INFO', `Refreshed AGENTS.md (${parts.length} section(s)) in ${cwd}`);
    return { status: 'refreshed', sections: parts.length };
  } catch (error) {
    log('WARN', `AGENTS.md refresh failed: ${error.message}`);
    return { status: 'failed', sections: 0, error };
  }
}

function createCodexCliAdapter(deps = {}) {
  const sessionPolicy = createCodexSessionPolicy(deps.sessionPolicy);
  return defineNativeCliAdapter({
    name: 'codex',
    descriptor: getEngineDescriptor('codex'),
    binary: deps.binary || 'codex',
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
      compact: false,
      warmPool: false,
      outputSchema: true,
      projectMcp: true,
      projectSkills: true,
    },
    structuredOutput: Object.freeze({ schema: 'path', format: 'jsonl', buffer: 'tail' }),
    buildArgs: buildCodexArgs,
    buildEnv: options => buildCodexEnv(process.env, options),
    parseStreamEvent: parseCodexStreamEvent,
    classifyError: classifyCodexError,
    acceptsNativeSession: session => acceptsEngineScopedSession('codex', session),
    validateNativeSession: createNativeSessionValidator('codex', deps.validateNativeSession),
    updateNativeSession: (session, observation) => {
      if (!observation.sessionId) return session;
      return {
        ...(session || {}),
        engine: 'codex',
        id: observation.sessionId,
        started: true,
        cwd: observation.cwd || (session && session.cwd) || '',
      };
    },
    projectContext: options => projectCodexContext({
      ...options,
      fs: deps.fs,
      path: deps.path,
      log: deps.log,
    }),
    resolvePermissionProfile: resolveCodexPermissionProfile,
    sessionPolicy,
    formatSpawnError(error) {
      if (!error) return 'Unknown spawn error';
      if (error.code === 'ENOENT') {
        return 'Codex CLI 未安装。请先运行: npm install -g @openai/codex';
      }
      return error.message || String(error);
    },
  });
}

module.exports = {
  createCodexCliAdapter,
  _private: {
    DEFAULT_TIMEOUTS,
    PERMISSION_STABILIZE_MAX_RETRIES,
    RESUME_RETRY_WINDOW_MS,
    TOOL_MAP,
    buildFallbackBridgePrompt,
    buildCodexArgs,
    buildCodexEnv,
    classifyResumeFailure,
    classifyCodexError,
    createCodexSessionPolicy,
    isCodexAutoModel,
    looksLikeCodexModel,
    needsFallbackForRequestedPermissions,
    normalizeComparablePermissionProfile,
    normalizeCodexApprovalPolicy,
    normalizeCodexSandboxMode,
    parseCodexStreamEvent,
    projectCodexContext,
    resolveCodexPermissionProfile,
    samePermissionProfile,
  },
};
