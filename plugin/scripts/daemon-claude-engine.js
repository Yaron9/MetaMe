'use strict';

const { classifyChatUsage } = require('./usage-classifier');
const { deriveProjectInfo } = require('./utils');
const {
  createEngineRuntimeFactory,
  normalizeEngineName,
  resolveEngineModel,
  ENGINE_MODEL_CONFIG,
  _private: { resolveCodexPermissionProfile },
} = require('./daemon-engine-runtime');
const { rawChatId } = require('./core/thread-chat-id');
const { buildAgentContextForEngine, buildMemorySnapshotContent, refreshMemorySnapshot } = require('./agent-layer');
const {
  adaptDaemonHintForEngine,
  buildAgentHint,
  buildDaemonHint,
  buildMacAutomationHint,
  buildLanguageGuard,
  buildIntentHint,
  composePrompt,
} = require('./daemon-prompt-context');
const { createPlatformSpawn, terminateChildProcess, stopStreamingLifecycle, abortStreamingChildLifecycle, setActiveChildProcess, clearActiveChildProcess, acquireStreamingChild, buildStreamingResult, resolveStreamingClosePayload, accumulateStreamingStderr, splitStreamingStdoutChunk, buildStreamFlushPayload, buildToolOverlayPayload, buildMilestoneOverlayPayload, finalizePersistentStreamingTurn, writeStreamingChildInput, parseStreamingEvents, applyStreamingMetadata, applyStreamingToolState, applyStreamingContentState, createStreamingWatchdog, runAsyncCommand } = require('./core/handoff');

/**
 * Antigravity Raw Session Logging — Lossless Diary (L0)
 * [PROTECTED] Append every user→AI turn to a daily markdown file.
 * Isolated as a standalone function to prevent accidental deletion during edits.
 */
function logRawSessionDiary(fs, path, HOME, { chatId, prompt, output, error, projectKey }) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const ym = today.slice(0, 7); // YYYY-MM
    const sessDir = path.join(HOME, '.metame', 'sessions', ym);
    if (!fs.existsSync(sessDir)) fs.mkdirSync(sessDir, { recursive: true });

    const diaryPath = path.join(sessDir, `${today}_${chatId}.md`);
    const MAX_OUTPUT_LOG = 8000;
    const outputLog = (output || error || 'No output.').slice(0, MAX_OUTPUT_LOG);
    const outputTruncated = (output || '').length > MAX_OUTPUT_LOG ? '\n\n[truncated]' : '';
    const entry = `\n---\ndate: ${new Date().toISOString()}\nproject: ${projectKey || 'global'}\n---\n\n## 🙋‍♂️ 用户指令\n\`\`\`text\n${prompt}\n\`\`\`\n\n## 🤖 执行实录\n${outputLog}${outputTruncated}\n`;
    fs.appendFileSync(diaryPath, entry, 'utf8');
  } catch (e) { console.warn(`[MetaMe] Raw session logging failed: ${e.message}`); }
}

function resolveStreamingTimeouts(engineTimeouts = {}) {
  return {
    idleMs: engineTimeouts.idleMs ?? (5 * 60 * 1000),
    toolMs: engineTimeouts.toolMs ?? (25 * 60 * 1000),
    ceilingMs: engineTimeouts.ceilingMs ?? (60 * 60 * 1000),
  };
}

function formatTimeoutWindowLabel(timeoutMs, kind = 'idle') {
  const mins = Math.round(Number(timeoutMs || 0) / 60000);
  if (mins <= 0) {
    return kind === 'tool' ? '立即' : '立即';
  }
  return `${Math.max(1, mins)} 分钟`;
}

function createClaudeEngine(deps) {
  const {
    fs,
    path,
    spawn: _spawn,
    CLAUDE_BIN,
    HOME,
    CONFIG_FILE,
    getActiveProviderEnv,
    activeProcesses,
    saveActivePids,
    log,
    yaml,
    providerMod,
    writeConfigSafe,
    loadConfig,
    loadState,
    saveState,
    routeAgent,
    routeSkill,
    attachOrCreateSession,
    normalizeCwd,
    isContentFile,
    sendFileButtons,
    findSessionFile,
    getSession,
    getSessionForEngine,
    createSession,
    getSessionName,
    writeSessionName,
    markSessionStarted,
    stripThinkingSignatures,
    isEngineSessionValid,
    getCodexSessionSandboxProfile,
    getCodexSessionPermissionMode,
    getSessionRecentContext,
    gitCheckpoint,
    gitCheckpointAsync,
    recordTokens,
    skillEvolution,
    touchInteraction,
    statusThrottleMs = 3000,
    fallbackThrottleMs = 8000,
    getEngineRuntime: injectedGetEngineRuntime,
    getDefaultEngine: _getDefaultEngine,
    warmPool,
  } = deps;
  function getDefaultEngine() {
    return (typeof _getDefaultEngine === 'function') ? _getDefaultEngine() : 'claude';
  }
  function resolveSessionForEngine(chatId, engineName) {
    if (typeof getSessionForEngine === 'function') {
      return getSessionForEngine(chatId, engineName);
    }
    const legacy = typeof getSession === 'function' ? getSession(chatId) : null;
    if (!legacy) return null;
    if (!legacy.engines) return legacy;
    const slot = legacy.engines[engineName] || null;
    if (!slot) return null;
    return {
      ...legacy,
      ...slot,
      cwd: legacy.cwd || HOME,
      engine: engineName,
    };
  }
  function validateEngineSession(engineName, sessionId, cwd) {
    if (typeof isEngineSessionValid === 'function') {
      return isEngineSessionValid(engineName, sessionId, cwd);
    }
    return true;
  }
  // Card reuse for merge-pause: when a task is paused for message merging,
  // save the statusMsgId so the next askClaude reuses the same card.
  // Entries auto-expire via periodic sweep (60s) to prevent unbounded growth.
  const _pausedCards = new Map(); // chatId -> { statusMsgId, cardHeader, savedAt }
  const _PAUSED_CARD_TTL = 60000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of _pausedCards) {
      if (now - (v.savedAt || 0) > _PAUSED_CARD_TTL) _pausedCards.delete(k);
    }
  }, _PAUSED_CARD_TTL).unref();

  let mentorEngine = null;
  try { mentorEngine = require('./mentor-engine'); } catch { /* optional */ }
  let sessionAnalytics = null;
  try { sessionAnalytics = require('./session-analytics'); } catch { /* optional */ }

  function shouldAutoRouteSkill({ agentMatch, hasActiveSession, boundProjectKey, skillName }) {
    if (agentMatch || hasActiveSession) return false;
    // Dedicated agent chats (Munger, Jia, etc.) must never be hijacked by skill routing.
    // agentMatch is null for strict-bound chats (by design), so we guard on boundProjectKey.
    if (boundProjectKey && String(boundProjectKey).trim() !== 'personal') return false;
    if (
      String(boundProjectKey || '').trim() === 'personal'
      && String(skillName || '').trim() === 'macos-local-orchestrator'
    ) return false;
    return true;
  }

  const getEngineRuntime = typeof injectedGetEngineRuntime === 'function'
    ? injectedGetEngineRuntime
    : createEngineRuntimeFactory({ fs, path, HOME, CLAUDE_BIN, getActiveProviderEnv });
  const { spawn } = createPlatformSpawn({
    fs,
    path,
    spawn: _spawn,
    execSync: require('child_process').execSync,
    processPlatform: process.platform,
    processExecPath: process.execPath,
    claudeBin: CLAUDE_BIN,
  });

  // Per-chatId patch queues: Agent A's writes never block Agent B.
  const _patchQueues = new Map(); // chatId -> Promise
  function patchSessionSerialized(chatId, patchFn) {
    const prev = _patchQueues.get(chatId) || Promise.resolve();
    const next = prev.then(() => {
      const state = loadState();
      if (!state.sessions) state.sessions = {};
      const cur = state.sessions[chatId] || {};
      const patched = typeof patchFn === 'function' ? patchFn(cur) : cur;
      if (patched && typeof patched === 'object') {
        state.sessions[chatId] = { ...patched, last_active: Date.now() };
      } else {
        state.sessions[chatId] = cur;
      }
      saveState(state);
    }).catch((e) => {
      log('WARN', `patchSessionSerialized failed for ${chatId}: ${e.message}`);
    });
    _patchQueues.set(chatId, next);
    // GC: remove resolved entries to prevent unbounded Map growth
    next.then(() => { if (_patchQueues.get(chatId) === next) _patchQueues.delete(chatId); });
    return next;
  }

  const CODEX_RESUME_RETRY_WINDOW_MS = 10 * 60 * 1000;
  const CODEX_PERMISSION_STABILIZE_MAX_RETRIES = 2;
  const _codexResumeRetryTs = new Map(); // `${chatId}:${kind}` -> last retry ts

  function getCodexResumeRetryKey(chatId, kind = 'default') {
    const base = String(chatId || '').trim();
    const mode = String(kind || 'default').trim();
    return base && mode ? `${base}:${mode}` : '';
  }

  function canRetryCodexResume(chatId, kind = 'default') {
    const key = getCodexResumeRetryKey(chatId, kind);
    if (!key) return false;
    const last = Number(_codexResumeRetryTs.get(key) || 0);
    if (!last) return true;
    return (Date.now() - last) > CODEX_RESUME_RETRY_WINDOW_MS;
  }

  function markCodexResumeRetried(chatId, kind = 'default') {
    const key = getCodexResumeRetryKey(chatId, kind);
    if (!key) return;
    _codexResumeRetryTs.set(key, Date.now());
  }

  function shouldRetryCodexResumeFallback({ runtimeName, wasResumeAttempt, output, error, errorCode, canRetry, failureKind = '' }) {
    return runtimeName === 'codex'
      && !!wasResumeAttempt
      && !!error
      && (!output || !!errorCode)
      && failureKind !== 'user-stop'
      && failureKind !== 'merge-pause'
      && !!canRetry;
  }

  function formatEngineSpawnError(err, runtime) {
    if (!err) return 'Unknown spawn error';
    const rt = runtime || { name: getDefaultEngine() };
    if (err.code === 'ENOENT') {
      if (rt.name === 'codex') {
        return 'Codex CLI 未安装。请先运行: npm install -g @openai/codex';
      }
      return 'Claude CLI 未安装或不在 PATH。请先确认 `claude` 可执行。';
    }
    return err.message || String(err);
  }

  function getCodexPermissionProfile(readOnly, daemonCfg = {}, session = {}) {
    return resolveCodexPermissionProfile({ readOnly, daemonCfg, session });
  }

  function getSessionChatId(chatId, boundProjectKey) {
    const chatIdStr = String(chatId || '');
    if (chatIdStr.startsWith('_agent_') || chatIdStr.startsWith('_scope_')) return chatIdStr;
    // Topic threads get their own session even within a bound project —
    // "thread:oc_xxx:om_yyy" must NOT collapse to "_bound_jarvis"
    const { isThreadChatId } = require('./core/thread-chat-id');
    if (isThreadChatId(chatIdStr)) return chatIdStr;
    if (boundProjectKey) return `_bound_${boundProjectKey}`;
    return chatIdStr || chatId;
  }

  function normalizeCodexSandboxMode(value, fallback = null) {
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

  function normalizeCodexApprovalPolicy(value, fallback = null) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return fallback;
    if (text === 'never' || text === 'no' || text === 'none') return 'never';
    if (text === 'on-failure' || text === 'on_failure' || text === 'failure') return 'on-failure';
    if (text === 'on-request' || text === 'on_request' || text === 'request') return 'on-request';
    if (text === 'untrusted') return 'untrusted';
    return fallback;
  }

  function normalizeComparableCodexPermissionProfile(profile) {
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

  function normalizeSenderId(senderId) {
    const text = String(senderId || '').trim();
    return text || '';
  }

  function sameCodexPermissionProfile(left, right) {
    const normalizedLeft = normalizeComparableCodexPermissionProfile(left);
    const normalizedRight = normalizeComparableCodexPermissionProfile(right);
    if (!normalizedLeft || !normalizedRight) return false;
    const sameSandbox = normalizedLeft.sandboxMode === normalizedRight.sandboxMode;
    const leftApproval = String(normalizedLeft.approvalPolicy || '').trim();
    const rightApproval = String(normalizedRight.approvalPolicy || '').trim();
    if (!leftApproval || !rightApproval) return sameSandbox;
    return sameSandbox && leftApproval === rightApproval;
  }

  function codexSandboxPrivilegeRank(value) {
    const normalized = normalizeCodexSandboxMode(value, null);
    if (normalized === 'read-only') return 0;
    if (normalized === 'workspace-write') return 1;
    if (normalized === 'danger-full-access') return 2;
    return -1;
  }

  function codexApprovalPrivilegeRank(value) {
    const normalized = normalizeCodexApprovalPolicy(value, null);
    if (normalized === 'untrusted') return 0;
    if (normalized === 'on-request') return 1;
    if (normalized === 'on-failure') return 2;
    if (normalized === 'never') return 3;
    return -1;
  }

  function codexNeedsFallbackForRequestedPermissions(actualProfile, requestedProfile) {
    const normalizedActual = normalizeComparableCodexPermissionProfile(actualProfile);
    const normalizedRequested = normalizeComparableCodexPermissionProfile(requestedProfile);
    if (!normalizedActual || !normalizedRequested) return false;
    return (
      codexSandboxPrivilegeRank(normalizedActual.sandboxMode) < codexSandboxPrivilegeRank(normalizedRequested.sandboxMode)
      || codexApprovalPrivilegeRank(normalizedActual.approvalPolicy) < codexApprovalPrivilegeRank(normalizedRequested.approvalPolicy)
    );
  }

  function buildCodexFallbackBridgePrompt({ fullPrompt, previousSessionId, previousProfile, requestedProfile, recentContext }) {
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

  function getActualCodexPermissionProfile(session) {
    if (!session || !session.id) return null;
    if (typeof getCodexSessionSandboxProfile === 'function') {
      return getCodexSessionSandboxProfile(session.id, session.cwd || '');
    }
    if (typeof getCodexSessionPermissionMode === 'function') {
      const permissionMode = getCodexSessionPermissionMode(session.id, session.cwd || '');
      return permissionMode ? { sandboxMode: permissionMode, approvalPolicy: null, permissionMode } : null;
    }
    return null;
  }

  // Map full API model IDs back to their CLI alias family.
  // When the configured model is an alias (e.g. "sonnet") and the JSONL records the full ID
  // (e.g. "claude-sonnet-4-6"), they are the same family — no pin needed.
  // This prevents pinning to a deprecated/retired full model name.
  function _modelFamilyAlias(fullModelId) {
    const m = String(fullModelId || '').toLowerCase();
    if (m.includes('opus')) return 'opus';
    if (m.includes('sonnet')) return 'sonnet';
    if (m.includes('haiku')) return 'haiku';
    return null;
  }

  function inspectClaudeResumeSession(session, configuredModel) {
    const result = {
      shouldResume: true,
      modelPin: null,
      reason: '',
    };
    if (!session || !session.started || !session.id) return result;
    try {
      const sessionFile = findSessionFile && findSessionFile(session.id);
      if (!sessionFile) return result;
      const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(0, 30)) {
        const entry = JSON.parse(line);
        const sessionModel = entry && entry.message && entry.message.model;
        if (!sessionModel || sessionModel === '<synthetic>') continue;
        // If the configured model is a short alias (sonnet/opus/haiku) and the JSONL model
        // belongs to the same family, do NOT pin — let the alias resolve to the latest version.
        // Only pin when the families genuinely differ (e.g. session was opus, config says sonnet).
        const sessionFamily = _modelFamilyAlias(sessionModel);
        const configFamily = _modelFamilyAlias(configuredModel);
        if (sessionFamily && configFamily && sessionFamily === configFamily) {
          return result; // same family, no pin needed
        }
        // Pin to the family alias (e.g., "opus") instead of the full JSONL model name
        // (e.g., "claude-opus-4-6"). The Claude CLI rejects full model IDs via the API.
        if (sessionFamily) {
          return {
            shouldResume: true,
            modelPin: sessionFamily,
            reason: '',
          };
        }
        // Cannot determine session model family — don't pin, use configured model
        return result;
      }
    } catch {
      return result;
    }
    return result;
  }

  function isClaudeThinkingSignatureError(errMsg) {
    const msg = String(errMsg || '');
    return msg.includes('Invalid signature') && msg.includes('thinking block');
  }

  function formatClaudeResumeFallbackUserMessage(retryError) {
    if (retryError) {
      return '⚠️ 旧 session 无法继续，已自动切换到新 session，但本次请求仍失败。';
    }
    return '';
  }

  function classifyCodexResumeFailure(error, errorCode) {
    const message = String(error || '').trim();
    const code = String(errorCode || '').trim();
    const lowered = message.toLowerCase();
    if (code === 'INTERRUPTED_USER') {
      return {
        kind: 'user-stop',
        userMessage: '⚠️ 当前执行已按你的停止动作中断，本轮不会自动续跑。',
        retryPromptPrefix: '',
      };
    }
    if (code === 'INTERRUPTED_MERGE_PAUSE' || lowered.includes('paused for merge')) {
      return {
        kind: 'merge-pause',
        userMessage: '',
        retryPromptPrefix: '',
      };
    }
    const interrupted = (
      lowered.includes('stopped by user')
      || lowered.includes('interrupted')
      || lowered.includes('signal')
      || code === 'INTERRUPTED'
      || code === 'INTERRUPTED_RESTART'
    );
    if (interrupted) {
      return {
        kind: 'interrupted',
        userMessage: '⚠️ 后台刚刚重启或本轮执行被中断。系统正在自动恢复到同一条会话，请稍等。',
        retryPromptPrefix: '[Note: the previous Codex execution was interrupted by a daemon restart or user stop signal. Continue the same conversation if possible. User message follows:]',
      };
    }
    const transportInterrupted = (
      lowered.includes('stream disconnected')
      || lowered.includes('connection reset')
      || lowered.includes('connection aborted')
      || lowered.includes('broken pipe')
      || lowered.includes('timed out')
      || lowered.includes('timeout')
      || lowered.includes('temporarily unavailable')
      || lowered.includes('error sending request')
      || lowered.includes('http2')
    );
    if (transportInterrupted) {
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


  /**
   * Parse [[FILE:...]] markers from Claude output.
   * Returns { markedFiles, cleanOutput }
   */
  function parseFileMarkers(output) {
    const markers = output.match(/\[\[FILE:([^\]]+)\]\]/g) || [];
    const markedFiles = markers.map(m => m.match(/\[\[FILE:([^\]]+)\]\]/)[1].trim());
    const cleanOutput = output.replace(/\s*\[\[FILE:[^\]]+\]\]/g, '').trim();
    return { markedFiles, cleanOutput };
  }

  /**
   * Merge explicit [[FILE:...]] paths with auto-detected content files.
   * Returns a Set of unique file paths.
   */
  function mergeFileCollections(markedFiles, sourceFiles) {
    const result = new Set(markedFiles);
    if (sourceFiles && sourceFiles.length > 0) {
      for (const f of sourceFiles) { if (isContentFile(f)) result.add(f); }
    }
    return result;
  }

  /**
   * Build a richer fact-retrieval query from the user prompt.
   * Adds lightweight code anchors (filenames/commands/identifiers) for better recall.
   */
  function buildFactSearchQuery(prompt, projectKey) {
    const text = String(prompt || '').replace(/\s+/g, ' ').trim();
    if (!text) return projectKey || '';

    const anchors = [];
    const seen = new Set();
    const add = (v) => {
      const t = String(v || '').trim();
      if (!t || seen.has(t)) return;
      seen.add(t);
      anchors.push(t);
    };

    // File/path-like anchors: daemon.js, scripts/memory-extract.js, foo.ts
    const fileLike = text.match(/\b(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z0-9]{1,8}\b/g) || [];
    for (const f of fileLike.slice(0, 6)) {
      add(path.basename(f));
    }

    // Command-like anchors: git commit, npm run build, node index.js ...
    const cmdLike = text.match(/\b(?:git|npm|pnpm|yarn|npx|node|python|pytest|make)\b[^,.;\n]{0,48}/gi) || [];
    for (const c of cmdLike.slice(0, 4)) {
      add(c.toLowerCase());
    }

    // Symbol-like anchors: snake_case / camelCase identifiers often present in bug reports
    const idLike = text.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
    for (const id of idLike) {
      if (anchors.length >= 12) break;
      if (id.includes('_') || /[a-z][A-Z]/.test(id)) add(id);
    }

    const parts = [text.slice(0, 260)];
    if (projectKey) parts.push(projectKey);
    if (anchors.length > 0) parts.push(anchors.slice(0, 10).join(' '));
    return parts.join(' ').slice(0, 520);
  }

  function projectKeyFromVirtualChatId(chatId) {
    const v = String(chatId || '');
    if (v.startsWith('_agent_')) return v.slice(7) || null;
    if (v.startsWith('_scope_')) {
      const idx = v.lastIndexOf('__');
      if (idx > 7 && idx + 2 < v.length) return v.slice(idx + 2);
    }
    return null;
  }

  function resolveMentorMode(cfg = {}) {
    const mode = String(cfg.mode || '').trim().toLowerCase();
    if (mode === 'gentle' || mode === 'active' || mode === 'intense') return mode;
    const level = Number(cfg.friction_level);
    if (Number.isFinite(level)) {
      if (level >= 8) return 'intense';
      if (level >= 4) return 'active';
    }
    return 'gentle';
  }

  function extractUserText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    for (const item of content) {
      if (item && item.type === 'text' && item.text) return item.text;
    }
    return '';
  }

  function collectRecentSessionSignals(sessionId, limit = 6) {
    const out = { recentMessages: [], sessionStartTime: null };
    if (!sessionId || typeof findSessionFile !== 'function') return out;
    const file = findSessionFile(sessionId);
    if (!file || !fs.existsSync(file)) return out;

    try {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-800);
      let current = null;
      for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!out.sessionStartTime && entry.timestamp) out.sessionStartTime = entry.timestamp;

        if (entry.type === 'user' && entry.message) {
          if (current) out.recentMessages.push(current);
          current = {
            text: extractUserText(entry.message.content),
            tool_calls: 0,
          };
        } else if (entry.type === 'assistant' && current && entry.message && Array.isArray(entry.message.content)) {
          for (const item of entry.message.content) {
            if (item && item.type === 'tool_use') current.tool_calls++;
          }
        }
      }
      if (current) out.recentMessages.push(current);
      if (out.recentMessages.length > limit) {
        out.recentMessages = out.recentMessages.slice(-limit);
      }
    } catch {
      return out;
    }
    return out;
  }

  function countCodeLines(output) {
    const text = String(output || '');
    if (!text.trim()) return 0;
    const lines = text.split('\n');
    let inFence = false;
    let count = 0;
    let sawFence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        sawFence = true;
        inFence = !inFence;
        continue;
      }
      if (inFence && line.trim()) count++;
    }
    if (!sawFence) return 0;
    return count;
  }

  function isMacAutomationIntent(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return false;
    return /(邮件|邮箱|收件箱|mail|email|calendar|日历|日程|会议|提醒|remind|草稿|发送邮件|打开|关闭|启动|切到|前台|音量|静音|睡眠|锁屏|Finder|Safari|微信|WeChat|Terminal|iTerm|System Events)/i.test(text);
  }

  // Returns true when the message is a task/technical request that warrants full memory hints (rules 3-5).
  // Errs on the side of over-inclusion: false negatives (missing hints) are worse than false positives.
  function isTaskIntent(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return false;
    // Errs on the side of over-inclusion: false negatives (missing hints) are worse than false positives.
    if (/^\/\w+/.test(text)) return true;  // slash command / dispatch prefix
    return text.length > 30 || /(node|git|npm|daemon|script|debug|fix|bug|error|api|sql|review|实现|修改|排查|架构|配置|代码|函数|部署|测试|调试|重构|优化|回滚|日志|迁移|升级|接口|监控|错误|修复|异常|警告|单测|崩|死锁|内存)/i.test(text);
  }

  /**
   * Auto-generate a session name using Haiku (async, non-blocking).
   * Writes to Claude's session file (unified with /rename).
   */
  function autoNameSession(_chatId, sessionId, firstPrompt, cwd, labelPrefix = '') {
    try {
      // Use first user message as session name (same as desktop Claude Code behavior).
      // No AI generation — instant, zero-cost, and more recognizable.
      let name = String(firstPrompt || '').trim().split('\n')[0];
      // Strip command prefixes
      name = name.replace(/^\/\S+\s*/, '').trim();
      // Truncate to reasonable display length
      if (name.length > 60) name = name.slice(0, 57) + '...';
      if (!name) return;
      name = labelPrefix + name;
      writeSessionName(sessionId, cwd, name);
    } catch (e) {
      log('DEBUG', `Auto-name failed for ${sessionId.slice(0, 8)}: ${e.message}`);
    }
  }

  /**
   * Spawn Claude as async child process (non-blocking).
   * Intentionally Claude-only: used by naming/fallback helper paths that
   * should not depend on project runtime adapter selection.
   * Returns { output, error } after process exits.
   */
  function spawnClaudeAsync(args, input, cwd, timeoutMs = 300000, metameProject = '') {
    const env = {
      ...process.env,
      ...getActiveProviderEnv(),
      METAME_INTERNAL_PROMPT: '1',
      METAME_PROJECT: metameProject || '',
    };
    delete env.CLAUDECODE;
    return runAsyncCommand({
      spawn,
      cmd: CLAUDE_BIN,
      args,
      cwd,
      env,
      input,
      timeoutMs,
      killSignal: 'SIGTERM',
      useProcessGroup: false,
      forceKillDelayMs: 5000,
      formatSpawnError: (err) => formatEngineSpawnError(err, { name: 'claude' }),
    });
  }

  /**
   * Tool name to emoji mapping for status display
   */
  const TOOL_EMOJI = {
    Read: '📖',
    Edit: '✏️',
    Write: '📝',
    Bash: '💻',
    Glob: '🔍',
    Grep: '🔎',
    WebFetch: '🌐',
    WebSearch: '🔍',
    Task: '🤖',
    Agent: '🤖',
    Skill: '🔧',
    TodoWrite: '📋',
    NotebookEdit: '📓',
    default: '🔧',
  };

  /**
   * Spawn engine with streaming output. Parser comes from runtime adapter.
   * Returns { output, error, files, toolUsageLog, usage, sessionId }.
   */
  function spawnClaudeStreaming(
    args,
    input,
    cwd,
    onStatus,
    timeoutMs = 600000,
    chatId = null,
    metameProject = '',
    metameSenderId = '',
    runtime = null,
    onSession = null,
    options = {},
  ) {
    return new Promise((resolve) => {
      let settled = false;
      const finalize = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      const rt = runtime || getEngineRuntime(getDefaultEngine());
      const { warmChild, persistent, warmPool: _warmPool, warmSessionKey } = options;
      const isPersistent = persistent && rt.name === 'claude'; // Only Claude supports stream-json
      const streamArgs = rt.name === 'claude'
        ? [...args, '--output-format', 'stream-json', '--verbose', ...(isPersistent ? ['--input-format', 'stream-json'] : [])]
        : args;
      const _spawnAt = Date.now();

      const { child, reused } = acquireStreamingChild({
        warmChild,
        spawn,
        binary: rt.binary,
        args: streamArgs,
        cwd,
        env: rt.buildEnv({ metameProject, metameSenderId, cwd }),
        useDetached: process.platform !== 'win32',
      });
      if (reused) log('INFO', `[TIMING:${chatId}] reusing warm pid=${child.pid} (+0ms)`);
      else log('INFO', `[TIMING:${chatId}] spawned ${rt.name} pid=${child.pid}`);

      if (chatId) {
        setActiveChildProcess(activeProcesses, saveActivePids, chatId, {
          child,
          aborted: false,
          abortReason: null,
          startedAt: _spawnAt,
          engine: rt.name,
          killSignal: rt.killSignal || 'SIGTERM',
        });
      }

      let buffer = '';
      let stderr = '';
      let finalResult = '';
      let finalUsage = null;
      let observedSessionId = '';
      let _firstOutputLogged = false;
      let classifiedError = null;
      let stdinFailureError = null;
      let lastStatusTime = 0;
      const STATUS_THROTTLE = statusThrottleMs;
      // Streaming card: accumulate text and push to card in real-time (throttled)
      let _streamText = '';
      let _lastStreamFlush = 0;
      const STREAM_THROTTLE = 1500; // ms between card edits (safe within Feishu 5 req/s limit)
      function flushStream(force) {
        if (!onStatus) return;
        const flush = buildStreamFlushPayload(
          { streamText: _streamText, lastFlushAt: _lastStreamFlush },
          { force, now: Date.now(), throttleMs: STREAM_THROTTLE }
        );
        if (!flush.shouldFlush) return;
        _lastStreamFlush = flush.lastFlushAt;
        onStatus(flush.payload).catch(() => { });
      }
      const writtenFiles = [];
      const toolUsageLog = [];

      void timeoutMs; // positional placeholder — actual timeouts come from engine config
      const engineTimeouts = resolveStreamingTimeouts(rt.timeouts || {});
      const IDLE_TIMEOUT_MS = engineTimeouts.idleMs;
      const TOOL_EXEC_TIMEOUT_MS = engineTimeouts.toolMs;
      const HARD_CEILING_MS = engineTimeouts.ceilingMs;
      const startTime = Date.now();
      let waitingForTool = false;

      const watchdog = createStreamingWatchdog({
        child,
        killSignal: rt.killSignal || 'SIGTERM',
        useProcessGroup: process.platform !== 'win32',
        idleTimeoutMs: IDLE_TIMEOUT_MS,
        toolTimeoutMs: TOOL_EXEC_TIMEOUT_MS,
        ceilingTimeoutMs: HARD_CEILING_MS,
        forceKillDelayMs: 5000,
        onKill(reason) {
          log('WARN', `[${rt.name}] ${reason} timeout for chatId ${chatId} — killing process group`);
        },
      });

      function abortForStdinFailure(err) {
        if (stdinFailureError) return;
        stdinFailureError = err && err.message ? err.message : String(err || 'stdin error');
        abortStreamingChildLifecycle({
          child,
          watchdog,
          milestoneTimer,
          activeProcesses,
          saveActivePids,
          chatId,
          reason: 'stdin',
        });
        absorbBufferedEvents();
        finalize(buildStreamingResult({
          output: finalResult || null,
          error: stdinFailureError,
          files: writtenFiles,
          toolUsageLog,
          usage: finalUsage,
          sessionId: observedSessionId || '',
        }));
      }

      let toolCallCount = 0;
      let lastMilestoneMin = 0;
      const milestoneTimer = setInterval(() => {
        if (watchdog.isKilled()) return;
        const elapsedMin = Math.floor((Date.now() - startTime) / 60000);
        const nextMin = lastMilestoneMin === 0 ? 2 : lastMilestoneMin + 5;
        if (elapsedMin >= nextMin) {
          lastMilestoneMin = elapsedMin;
          if (onStatus) {
            onStatus(buildMilestoneOverlayPayload({
              elapsedMin,
              toolCallCount,
              writtenFiles,
              toolUsageLog,
              streamText: _streamText,
            })).catch(() => { });
          }
        }
      }, 30000);

      function parseEventsFromLine(line) {
        return parseStreamingEvents(rt.parseStreamEvent, line);
      }

      function applyContentState(event, buffered) {
        const contentState = applyStreamingContentState(
          { finalResult, streamText: _streamText, waitingForTool, finalUsage },
          event
        );
        finalResult = contentState.finalResult;
        _streamText = contentState.streamText;
        waitingForTool = contentState.waitingForTool;
        finalUsage = contentState.finalUsage;
        if (!buffered && contentState.shouldUpdateWatchdog) watchdog.setWaitingForTool(contentState.watchdogWaiting);
        if (!buffered && contentState.shouldFlush) flushStream(contentState.flushForce);
      }

      function applyStreamEvent(event, options = {}) {
        if (!event || !event.type) return;

        const buffered = options.buffered === true;
        if (event.type === 'session' && event.sessionId) {
          observedSessionId = applyStreamingMetadata(
            { observedSessionId, classifiedError },
            event
          ).observedSessionId;
          if (!buffered && typeof onSession === 'function') {
            Promise.resolve(onSession(observedSessionId)).catch(() => { });
          }
          return;
        }
        if (event.type === 'error') {
          classifiedError = applyStreamingMetadata(
            { observedSessionId, classifiedError },
            event
          ).classifiedError;
          return;
        }
        if (event.type === 'text' && event.text) {
          applyContentState(event, buffered);
          return;
        }
        if (event.type === 'done') {
          applyContentState(event, buffered);

          if (!buffered && isPersistent) {
            finalize(finalizePersistentStreamingTurn({
              watchdog,
              milestoneTimer,
              activeProcesses,
              saveActivePids,
              chatId,
              warmPool: _warmPool,
              warmSessionKey,
              child,
              observedSessionId,
              cwd,
              output: finalResult || '',
              files: writtenFiles,
              toolUsageLog,
              usage: finalUsage,
            }));
          }
          return;
        }
        if (event.type !== 'tool_result' && event.type !== 'tool_use') return;

        const toolState = applyStreamingToolState(
          { waitingForTool, toolCallCount, toolUsageLog, writtenFiles },
          event,
          { pathModule: path, maxEntries: 50 }
        );
        toolCallCount = toolState.toolCallCount;
        waitingForTool = toolState.waitingForTool;
        toolUsageLog.length = 0;
        toolUsageLog.push(...toolState.toolUsageLog);
        writtenFiles.length = 0;
        writtenFiles.push(...toolState.writtenFiles);
        if (!buffered && toolState.shouldUpdateWatchdog) watchdog.setWaitingForTool(toolState.watchdogWaiting);

        if (event.type !== 'tool_use' || buffered) return;

        const overlay = buildToolOverlayPayload({
          toolName: toolState.toolName,
          toolInput: toolState.toolInput,
          streamText: _streamText,
          lastStatusTime,
          now: Date.now(),
          throttleMs: STATUS_THROTTLE,
          toolEmoji: TOOL_EMOJI,
          pathModule: path,
        });
        if (!overlay.shouldEmit) return;
        lastStatusTime = overlay.lastStatusTime;
        if (onStatus) {
          onStatus(overlay.payload).catch(() => { });
        }
      }

      function absorbBufferedEvents() {
        if (!buffer.trim()) return;
        const events = parseEventsFromLine(buffer.trim());
        buffer = '';
        for (const event of events) {
          applyStreamEvent(event, { buffered: true });
        }
      }

      child.stdout.on('data', (data) => {
        watchdog.resetIdle();
        const stdoutState = splitStreamingStdoutChunk(buffer, data.toString());
        const lines = stdoutState.lines;
        buffer = stdoutState.buffer;

        for (const line of lines) {
          if (!line.trim()) continue;
          if (!_firstOutputLogged) {
            _firstOutputLogged = true;
            log('INFO', `[TIMING:${chatId}] first-line +${Date.now() - _spawnAt}ms`);
          }
          const events = parseEventsFromLine(line);
          for (const event of events) {
            applyStreamEvent(event);
          }
        }
      });

      child.stderr.on('data', (data) => {
        watchdog.resetIdle();
        const chunk = data.toString();
        const stderrState = accumulateStreamingStderr(
          { stderr, classifiedError },
          chunk,
          { classifyError: rt.classifyError }
        );
        stderr = stderrState.stderr;
        classifiedError = stderrState.classifiedError;
        if (stderrState.isApiError) {
          log('ERROR', `[API-ERROR] ${rt.name} stderr for ${chatId}: ${chunk.slice(0, 300)}`);
        }
      });

      if (child.stdin && typeof child.stdin.on === 'function') {
        child.stdin.on('error', (err) => {
          abortForStdinFailure(err);
        });
      }

      child.on('close', (code) => {
        log('INFO', `[TIMING:${chatId}] process-close code=${code} total=${Date.now() - _spawnAt}ms`);
        stopStreamingLifecycle(watchdog, milestoneTimer);

        // Persistent mode: if already finalized on result event, just clean up
        if (isPersistent && settled) {
          clearActiveChildProcess(activeProcesses, saveActivePids, chatId);
          // Process died after we returned result — remove from warm pool
          if (_warmPool && warmSessionKey) _warmPool.releaseWarm(warmSessionKey);
          return;
        }

        absorbBufferedEvents();

        const proc = chatId ? activeProcesses.get(chatId) : null;
        const wasAborted = proc && proc.aborted;
        const abortReason = proc && proc.abortReason ? String(proc.abortReason) : '';
        clearActiveChildProcess(activeProcesses, saveActivePids, chatId);
        finalize(resolveStreamingClosePayload({
          code,
          streamState: { finalResult, finalUsage, observedSessionId, writtenFiles, toolUsageLog },
          wasAborted,
          abortReason,
          stdinFailureError,
          watchdog,
          timeoutConfig: {
            startTime,
            idleTimeoutMs: IDLE_TIMEOUT_MS,
            toolTimeoutMs: TOOL_EXEC_TIMEOUT_MS,
            hardCeilingMs: HARD_CEILING_MS,
            formatTimeoutWindowLabel,
          },
          classifiedError,
          stderr,
        }));
      });

      child.on('error', (err) => {
        stopStreamingLifecycle(watchdog, milestoneTimer);
        clearActiveChildProcess(activeProcesses, saveActivePids, chatId);
        finalize({ output: null, error: formatEngineSpawnError(err, rt), files: [], toolUsageLog: [], usage: null, sessionId: '' });
      });

      try {
        writeStreamingChildInput({
          child,
          input,
          isPersistent,
          warmPool: _warmPool,
          observedSessionId,
        });
      } catch (e) {
        abortForStdinFailure(e);
      }
    });
  }

  const MSG_SESSION_MAX_ENTRIES = 5000;
  const MSG_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

  function pruneMsgSessionMappings(msgSessions) {
    const now = Date.now();
    const entries = Object.entries(msgSessions || {});
    if (entries.length === 0) return {};

    const freshEntries = entries.filter(([, value]) => {
      const touchedAt = Number(value && value.touchedAt || 0);
      return !touchedAt || (now - touchedAt) <= MSG_SESSION_MAX_AGE_MS;
    });

    const boundedEntries = freshEntries.length > MSG_SESSION_MAX_ENTRIES
      ? freshEntries
        .sort((a, b) => Number((a[1] && a[1].touchedAt) || 0) - Number((b[1] && b[1].touchedAt) || 0))
        .slice(freshEntries.length - MSG_SESSION_MAX_ENTRIES)
      : freshEntries;
    return Object.fromEntries(boundedEntries);
  }

  // Track outbound message_id → session for reply-based session restoration.
  // Keep a larger, time-bounded mapping pool so active chats do not lose
  // reply continuity after a few hundred messages across all groups.
  function trackMsgSession(messageId, session, agentKey, options = {}) {
    if (!messageId || !session) return;
    const forceRouteOnly = !!(options && options.routeOnly);
    if (!forceRouteOnly && !session.id) return;
    const st = loadState();
    if (!st.msg_sessions) st.msg_sessions = {};
    st.msg_sessions[messageId] = {
      ...(session.id && !forceRouteOnly ? { id: session.id } : {}),
      ...(session.cwd ? { cwd: session.cwd } : {}),
      engine: session.engine || getDefaultEngine(),
      logicalChatId: session.logicalChatId || null,
      agentKey: agentKey || null,
      ...(session.sandboxMode ? { sandboxMode: session.sandboxMode } : {}),
      ...(session.approvalPolicy ? { approvalPolicy: session.approvalPolicy } : {}),
      ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
      touchedAt: Date.now(),
    };
    st.msg_sessions = pruneMsgSessionMappings(st.msg_sessions);
    saveState(st);
  }

  /**
   * Shared ask logic — full Claude Code session (stateful, with tools)
   * Now uses spawn (async) instead of execSync to allow parallel requests.
   */

  /**
   * Reset active provider back to anthropic/opus and reload config.
   * Returns the freshly loaded config so callers can reassign their local variable.
   */
  function fallbackToDefaultProvider(reason) {
    log('WARN', `Falling back to anthropic/opus — reason: ${reason}`);
    if (providerMod && providerMod.getActiveName() !== 'anthropic') {
      providerMod.setActive('anthropic');
    }
    const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
    if (!cfg.daemon) cfg.daemon = {};
    cfg.daemon.model = 'opus';
    writeConfigSafe(cfg);
    return loadConfig();
  }

  async function askClaude(bot, chatId, prompt, config, readOnly = false, senderId = null) {
    const _t0 = Date.now();
    log('INFO', `askClaude for ${chatId}: ${prompt.slice(0, 50)}`);

    // Serialization is now guaranteed by daemon-message-pipeline (per-chatId Promise chain).
    // No race guard needed here — pipeline ensures only one askClaude runs per chatId.
    // Defense-in-depth: if a stale entry exists with a live child, kill it first.
    const _existing = activeProcesses.get(chatId);
    if (_existing && _existing.child && !_existing.aborted) {
      log('WARN', `askClaude: overwriting active process for ${chatId} — aborting previous`);
      terminateChildProcess(_existing.child, 'SIGTERM', { useProcessGroup: process.platform !== 'win32' });
    }
    activeProcesses.set(chatId, {
      child: null,       // sentinel: no process yet
      aborted: false,
      abortReason: null,
      startedAt: _t0,
      engine: 'pending',
      killSignal: 'SIGTERM',
    });

    // Track interaction time for idle/sleep detection
    if (touchInteraction) touchInteraction();
    // Track per-session last_active for summary generation (P2-B)
    try {
      const _st = loadState();
      if (_st.sessions && _st.sessions[chatId]) {
        _st.sessions[chatId].last_active = Date.now();
        saveState(_st);
      }
    } catch { /* non-critical */ }
    // Send 🤔 ack and start typing — fire-and-forget so we don't block spawn on Telegram RTT.
    // statusMsgId is resolved via a promise; it will be ready well before the first model output.
    let statusMsgId = null;
    let _lastStatusCardContent = null; // tracks last clean text written to card (for final-reply dedup)
    // Early detect bound project for branded ack card (team members / dispatch agents)
    const _ackChatIdStr = String(chatId);
    const _ackAgentMap = {
      ...(config.telegram ? config.telegram.chat_agent_map || {} : {}),
      ...(config.feishu ? config.feishu.chat_agent_map || {} : {}),
      ...(config.imessage ? config.imessage.chat_agent_map || {} : {}),
    };
    const _ackBoundKey = _ackAgentMap[_ackChatIdStr] || _ackAgentMap[rawChatId(_ackChatIdStr)] || projectKeyFromVirtualChatId(_ackChatIdStr);
    const _ackBoundProj = _ackBoundKey && config.projects ? config.projects[_ackBoundKey] : null;
    // _ackCardHeader: non-null for bound projects with a name; passed to editMessage to preserve header on streaming edits
    let _ackCardHeader = (_ackBoundProj && _ackBoundProj.name)
      ? { title: `${_ackBoundProj.icon || '🤖'} ${_ackBoundProj.name}`, color: _ackBoundProj.color || 'blue' }
      : null;
    // Reuse card from a paused merge (same card, no new push)
    const _pausedCard = _pausedCards.get(chatId);
    if (_pausedCard) {
      _pausedCards.delete(chatId);
      // Discard stale paused cards (>30s old) — they may come from cancelled flushes
      const cardAge = _pausedCard.savedAt ? Date.now() - _pausedCard.savedAt : 0;
      if (cardAge > 30000) {
        log('INFO', `[askClaude] Discarding stale paused card for ${chatId} (${Math.round(cardAge / 1000)}s old)`);
      } else {
        statusMsgId = _pausedCard.statusMsgId;
        if (_pausedCard.cardHeader) _ackCardHeader = _pausedCard.cardHeader;
        log('INFO', `[askClaude] Reusing paused card ${statusMsgId} for ${chatId}`);
      }
    }
    if (_pausedCard && statusMsgId) {
      // Update card to show "merging" state
      if (statusMsgId && bot.editMessage) {
        bot.editMessage(chatId, statusMsgId, '🔄 合并处理中…', _ackCardHeader).catch(() => {});
      }
    } else if (!bot.suppressAck) {
      // Fire-and-forget: don't await Telegram RTT before spawning the engine process.
      // statusMsgId will be populated well before the first model output (~5s for codex).
      // For branded agents: send a card with header so streaming edits preserve the agent identity.
      const _ackFn = (_ackCardHeader && bot.sendCard)
        ? () => bot.sendCard(chatId, { title: _ackCardHeader.title, body: '🤔', color: _ackCardHeader.color })
        : () => (bot.sendMarkdown ? bot.sendMarkdown(chatId, '🤔') : bot.sendMessage(chatId, '🤔'));
      _ackFn()
        .then(msg => { if (msg && msg.message_id) statusMsgId = msg.message_id; })
        .catch(e => log('ERROR', `Failed to send ack to ${chatId}: ${e.message}`));
    }
    bot.sendTyping(chatId).catch(() => { });
    const typingTimer = setInterval(() => {
      bot.sendTyping(chatId).catch(() => { });
    }, 4000);

    // Top-level safety net: any uncaught error inside askClaude MUST clean up timers and notify user.
    // Without this, a ReferenceError / TypeError in the routing or injection code would silently
    // kill the handler, leaving the typing indicator spinning forever.
    try { // ── safety-net-start ──

      // Agent nickname routing: "贾维斯" / "小美，帮我..." → switch project session
      // Strict chats (chat_agent_map bound groups) must NOT switch agents via nickname
      const _strictAgentMap = {
        ...(config.telegram ? config.telegram.chat_agent_map : {}),
        ...(config.feishu ? config.feishu.chat_agent_map : {}),
        ...(config.imessage ? config.imessage.chat_agent_map : {}),
      };
      const _isStrictChatSession = !!(_strictAgentMap[String(chatId)] || _strictAgentMap[rawChatId(String(chatId))] || projectKeyFromVirtualChatId(String(chatId)));
      const agentMatch = _isStrictChatSession ? null : routeAgent(prompt, config);
      if (agentMatch) {
        const { key, proj, rest } = agentMatch;
        const projCwd = normalizeCwd(proj.cwd);
        attachOrCreateSession(chatId, projCwd, proj.name || key, proj.engine ? normalizeEngineName(proj.engine) : getDefaultEngine());
        log('INFO', `Agent switch via nickname: ${key} (${projCwd})`);
        if (!rest) {
          // Pure nickname call — confirm switch and stop
          clearInterval(typingTimer);
          // Clean up pending sentinel (no spawn will follow)
          const _ps = activeProcesses.get(chatId);
          if (_ps && _ps.child === null) { activeProcesses.delete(chatId); saveActivePids(); }
          await bot.sendMessage(chatId, `${proj.icon || '🤖'} ${proj.name || key} 在线`);
          return { ok: true };
        }
        // Nickname + content — strip nickname, continue with rest as prompt
        prompt = rest;
      }

      // Skill routing: detect skill first, then decide session
      // BUT: skip skill routing if agent addressed by nickname OR chat already has an active session
      // (active conversation should never be hijacked by keyword-based skill matching)
      const chatIdStr = String(chatId);
      const chatAgentMap = {
        ...(config.telegram ? config.telegram.chat_agent_map : {}),
        ...(config.feishu ? config.feishu.chat_agent_map : {}),
        ...(config.imessage ? config.imessage.chat_agent_map : {}),
      };
      const boundProjectKey = chatAgentMap[chatIdStr] || chatAgentMap[rawChatId(chatIdStr)] || projectKeyFromVirtualChatId(chatIdStr);
      const boundProject = boundProjectKey && config.projects ? config.projects[boundProjectKey] : null;
      const daemonCfg = (config && config.daemon) || {};
      // Keep real group chats on their own session key.
      // Only true virtual agents (_agent_*) should use the virtual namespace.
      const sessionChatId = getSessionChatId(chatId, boundProjectKey);
      const sessionRaw = getSession(sessionChatId);
      const boundCwd = (boundProject && boundProject.cwd) ? normalizeCwd(boundProject.cwd) : null;
      const boundEngineName = (boundProject && boundProject.engine) ? normalizeEngineName(boundProject.engine) : getDefaultEngine();
      // effectiveCwd: single source of truth for this request's working directory.
      // For bound projects, config always wins over stored session cwd.
      // Resolved once here; all downstream createSession/spawn calls use this.
      let effectiveCwd = boundCwd || null;

      // Engine is determined from config only — bound agent config wins, then global default.
      const engineName = normalizeEngineName(
        (boundProject && boundProject.engine) || getDefaultEngine()
      );
      const runtime = getEngineRuntime(engineName);
      const requestedCodexPermissionProfile = engineName === 'codex'
        ? getCodexPermissionProfile(readOnly, daemonCfg)
        : null;

      // hasActiveSession: does the current engine have an ongoing conversation?
      const hasActiveSession = sessionRaw && (
        sessionRaw.engines ? !!(sessionRaw.engines[engineName]?.started) : !!sessionRaw.started
      );
      const detectedSkill = routeSkill(prompt);
      const skill = shouldAutoRouteSkill({
        agentMatch,
        hasActiveSession,
        boundProjectKey,
        skillName: detectedSkill,
      })
        ? detectedSkill
        : null;

      if (!sessionRaw) {
        // No saved state for this chatId: start a fresh session.
        // Note: daemon_state.json persists across restarts, so this only happens on truly first use
        // or after an explicit /new command.
        createSession(
          sessionChatId,
          boundCwd || undefined,
          boundProject && boundProject.name ? boundProject.name : '',
          boundEngineName,
          boundEngineName === 'codex' ? requestedCodexPermissionProfile : undefined
        );
      }

      // Resolve flat view for current engine (id + started are engine-specific; cwd is shared)
      let session = resolveSessionForEngine(sessionChatId, engineName) || { cwd: boundCwd || HOME, engine: engineName, id: null, started: false };
      session.engine = engineName; // keep local copy for Codex resume detection below
      session.logicalChatId = sessionChatId;
      // Finalize effectiveCwd: bound config > stored session > HOME
      if (!effectiveCwd) effectiveCwd = (session && session.cwd) || HOME;
      // Correct stored cwd if it drifted from config (e.g., stale state from prior bug)
      if (session.cwd !== effectiveCwd) {
        log('WARN', `[SessionCwd] correcting session cwd for ${sessionChatId}: ${session.cwd || 'unknown'} -> ${effectiveCwd}`);
        session = { ...session, cwd: effectiveCwd };
        await patchSessionSerialized(sessionChatId, (cur) => ({ ...cur, cwd: effectiveCwd }));
      }

      // Warm pool: check if a persistent process is available for this session (Claude only).
      // Declared early so downstream logic can skip expensive operations when reusing warm process.
      const _warmSessionKey = sessionChatId;
      const _warmEntry = (warmPool && runtime.name === 'claude') ? warmPool.acquireWarm(_warmSessionKey) : null;

      // Pre-spawn session validation: unified for all engines.
      // Claude checks JSONL file existence; Codex checks SQLite. Same interface, different backend.
      // Skip warning for virtual agents (team members) - they may use worktrees with fresh sessions
      const isVirtualAgent = String(sessionChatId).startsWith('_agent_');
      if (session.started && session.id && session.id !== '__continue__' && session.cwd) {
        const valid = validateEngineSession(engineName, session.id, session.cwd);
        if (!valid) {
          log('WARN', `${engineName} session ${session.id.slice(0, 8)} invalid for ${sessionChatId}; starting fresh ${engineName} session`);
          if (!isVirtualAgent) {
            await bot.sendMessage(chatId, '⚠️ 上次 session 已失效，已自动开启新 session。').catch(() => { });
          }
          session = createSession(
            sessionChatId,
            effectiveCwd,
            boundProject && boundProject.name ? boundProject.name : '',
            engineName,
            engineName === 'codex' ? requestedCodexPermissionProfile : undefined
          );
        }
      }

      if (runtime.name === 'codex' && session.started && session.id) {
        const actualPermissionProfile = getActualCodexPermissionProfile(session);
        if (actualPermissionProfile) {
          const storedPermissionProfile = normalizeComparableCodexPermissionProfile(session);
          if (!sameCodexPermissionProfile(storedPermissionProfile, actualPermissionProfile)) {
            session = { ...session, ...actualPermissionProfile };
            await patchSessionSerialized(sessionChatId, (cur) => {
              const engines = { ...(cur.engines || {}) };
              engines.codex = {
                ...(engines.codex || {}),
                ...(actualPermissionProfile || {}),
              };
              return { ...cur, engines };
            });
          }
          if (!sameCodexPermissionProfile(actualPermissionProfile, requestedCodexPermissionProfile)) {
            const actualSummary = `${actualPermissionProfile.sandboxMode || actualPermissionProfile.permissionMode || 'unknown'}/${actualPermissionProfile.approvalPolicy || 'unknown'}`;
            const requestedSummary = `${requestedCodexPermissionProfile.sandboxMode}/${requestedCodexPermissionProfile.approvalPolicy}`;
            log('INFO', `Codex session ${session.id.slice(0, 8)} permission differs for ${sessionChatId}: ${actualSummary} vs requested ${requestedSummary}; preserving existing session continuity`);
          }
        }
      }
      const mentorCfg = (daemonCfg.mentor && typeof daemonCfg.mentor === 'object') ? daemonCfg.mentor : {};
      const mentorEnabled = !!(mentorEngine && mentorCfg.enabled);
      const excludeAgents = new Set(
        (Array.isArray(mentorCfg.exclude_agents) ? mentorCfg.exclude_agents : [])
          .map(x => String(x || '').trim())
          .filter(Boolean)
      );
      const chatAgentKey = boundProjectKey || 'personal';
      const mentorExcluded = excludeAgents.has(chatAgentKey);
      let mentorSuppressed = false;

      // Mentor pre-flight breaker: first hit sends a short reassurance; cooldown does not block normal answers.
      if (mentorEnabled && !mentorExcluded) {
        try {
          const breaker = mentorEngine.checkEmotionBreaker(prompt, mentorCfg);
          if (breaker && breaker.tripped) {
            mentorSuppressed = true;
            if (breaker.reason !== 'cooldown_active' && breaker.response) {
              await bot.sendMessage(chatId, breaker.response).catch(() => { });
            }
          }
        } catch (e) {
          log('WARN', `Mentor breaker failed: ${e.message}`);
        }
      }

      // Build engine command — prefer per-engine model, fall back to legacy daemon.model
      let model = resolveEngineModel(runtime.name, daemonCfg, boundProject && boundProject.model);

      // When resuming a Claude session, inspect the original model first.
      // Thinking block signatures are model-specific; non-Claude JSONL sessions
      // must not be resumed as Claude.
      // Skip for warm process reuse — model is already loaded in the persistent process.
      if (runtime.name === 'claude' && session.started && session.id && !_warmEntry) {
        const resumeInspection = inspectClaudeResumeSession(session, model);
        if (resumeInspection.shouldResume === false) {
          log('INFO', `[ModelPin] session ${session.id.slice(0, 8)} flagged as ${resumeInspection.reason}; starting fresh Claude session`);
          session = createSession(sessionChatId, effectiveCwd, boundProject && boundProject.name ? boundProject.name : '', runtime.name);
        } else if (resumeInspection.modelPin) {
          if (resumeInspection.modelPin !== model) {
            log('INFO', `[ModelPin] resuming ${session.id.slice(0, 8)} with original model ${resumeInspection.modelPin} (configured: ${model})`);
          }
          model = resumeInspection.modelPin;
        }
      }

      const agentHint = buildAgentHint({
        sessionStarted: session.started,
        boundProject,
        sessionCwd: session && session.cwd,
        engineName,
        HOME,
        buildAgentContextForEngine,
        log,
      });

      // Memory & Knowledge Injection (RAG)
      let memoryHint = '';

      // Compact context injection: injected once on first message after /compact, then cleared
      if (!session.started && session.compactContext) {
        const _compactCtx = String(session.compactContext).trim();
        if (_compactCtx) {
          memoryHint += `\n\n[Context from previous session (compacted):\n${_compactCtx}]`;
          try {
            const _stC = loadState();
            const _engSlot = _stC.sessions && _stC.sessions[sessionChatId] && _stC.sessions[sessionChatId].engines
              ? _stC.sessions[sessionChatId].engines[engineName]
              : null;
            if (_engSlot) { delete _engSlot.compactContext; saveState(_stC); }
          } catch { /* non-critical */ }
        }
      }

      // projectKey must be declared outside the try block so the daemonHint template below can reference it.
      const _cid0 = String(chatId);
      const _agentMap0 = {
        ...(config.telegram ? config.telegram.chat_agent_map : {}),
        ...(config.feishu ? config.feishu.chat_agent_map : {}),
        ...(config.imessage ? config.imessage.chat_agent_map : {}),
      };
      const projectKey = _agentMap0[_cid0] || _agentMap0[rawChatId(_cid0)] || projectKeyFromVirtualChatId(_cid0);
      try {
        const memory = require('./memory');

        // L1: NOW.md per-agent whiteboard injection（按 projectKey 隔离，防并发冲突）
        // One-shot: inject once then clear, same pattern as compactContext.
        // Prevents re-injection on daemon restart or new session for the same chat.
        if (!session.started) {
          try {
            const nowDir = path.join(HOME, '.metame', 'memory', 'now');
            const nowKey = projectKey || 'default';
            const nowPath = path.join(nowDir, `${nowKey}.md`);
            if (fs.existsSync(nowPath)) {
              const nowContent = fs.readFileSync(nowPath, 'utf8').trim();
              if (nowContent) {
                memoryHint += `\n\n[Current task context:\n${nowContent}]`;
                // Clear after injection to prevent re-triggering on next session start
                try { fs.writeFileSync(nowPath, '', 'utf8'); } catch { /* non-critical */ }
              }
            }
          } catch { /* non-critical */ }
        }

        // 1. Inject recent session memories ONLY on first message of a session
        if (!session.started) {
          const recent = memory.recentSessions({ limit: 1, project: projectKey || undefined });
          if (recent.length > 0) {
            const items = recent.map(r => `- [${r.created_at}] ${r.summary}${r.keywords ? ' (keywords: ' + r.keywords + ')' : ''}`).join('\n');
            memoryHint += `\n\n[Past session memory:\n${items}]`;
          }
        }

        // 2. Dynamic Fact Injection (RAG) — first message only
        // Facts stay in Claude's context for the rest of the session; no need to repeat.
        // Uses QMD hybrid search if available, falls back to FTS5.
        if (!session.started) {
          const searchFn = memory.searchFactsAsync || memory.searchFacts;
          const factQuery = buildFactSearchQuery(prompt, projectKey);
          const facts = await Promise.resolve(searchFn(factQuery, { limit: 3, project: projectKey || undefined }));
          if (facts.length > 0) {
            // Separate capsule facts from regular facts
            const capsuleFacts = facts.filter(f => f.relation === 'knowledge_capsule');
            const regularFacts = facts.filter(f => f.relation !== 'knowledge_capsule');

            // Inject regular facts as before
            if (regularFacts.length > 0) {
              const factItems = regularFacts.map(f => `- [${f.relation}] ${f.value}`).join('\n');
              memoryHint += `\n\n[Relevant facts:\n${factItems}]`;
            }

            // Capsule facts: derive file path from entity and inject as direct "must read" hint
            // Entity pattern: capsule.metame_daemon_dispatch → capsules/metame-daemon-dispatch-playbook.md
            if (capsuleFacts.length > 0) {
              const capsulePaths = capsuleFacts.map(f => {
                const slug = f.entity.replace(/^capsule\./, '').replace(/_/g, '-');
                return path.join(HOME, '.metame', 'memory', 'capsules', `${slug}-playbook.md`);
              }).filter(p => fs.existsSync(p));
              if (capsulePaths.length > 0) {
                // Inject file paths only (no shell commands) — works cross-platform and with all engines.
                // Claude Code reads via Read tool; Codex/Gemini parse the path directly.
                memoryHint += `\n\n[Relevant playbook detected — read before answering:\n${capsulePaths.map(p => `  ${p}`).join('\n')}]`;
              }
            }

            log('INFO', `[MEMORY] Injected ${regularFacts.length} facts, ${capsuleFacts.length} capsule(s) (query_len=${factQuery.length})`);
          }
        }

        // Inject latest nightly insight (decisions/lessons) — one-liner per file, ~100 tokens
        if (!session.started) {
          try {
            const reflectDirs = [
              path.join(HOME, '.metame', 'memory', 'decisions'),
              path.join(HOME, '.metame', 'memory', 'lessons'),
            ];
            const reflectItems = [];
            for (const dir of reflectDirs) {
              if (!fs.existsSync(dir)) continue;
              const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
              const latest = files[files.length - 1];
              if (!latest) continue;
              const content = fs.readFileSync(path.join(dir, latest), 'utf8');
              // Extract ## headings as one-line summaries (skip frontmatter)
              const headings = content.match(/^## .+$/gm);
              if (headings && headings.length > 0) {
                const type = dir.endsWith('decisions') ? 'decision' : 'lesson';
                reflectItems.push(...headings.slice(0, 2).map(h => `- [${type}] ${h.replace(/^## /, '')}`));
              }
            }
            if (reflectItems.length > 0) {
              memoryHint += `\n\n[Recent insights:\n${reflectItems.join('\n')}]`;
            }
          } catch { /* non-critical */ }
        }

        memory.close();
      } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') log('WARN', `Memory injection failed: ${e.message}`);
      }

      // ZPD: build competence hint from brain profile
      let zdpHint = '';
      let brainDoc = null;
      if (!session.started) {
        try {
          const brainPath = path.join(HOME, '.claude_profile.yaml');
          if (fs.existsSync(brainPath)) {
            const brain = yaml.load(fs.readFileSync(brainPath, 'utf8'));
            brainDoc = brain;
            const cmap = brain && brain.user_competence_map;
            if (cmap && typeof cmap === 'object' && Object.keys(cmap).length > 0) {
              const entries = Object.entries(cmap);
              const allExpert = entries.every(([, level]) => String(level).toLowerCase() === 'expert');
              if (allExpert) {
                zdpHint = `\n- User is expert-level across all domains. Skip basics, no analogies needed.`;
              } else {
                const lines = entries
                  .map(([domain, level]) => `  ${domain}: ${level}`)
                  .join('\n');
                zdpHint = `\n- User competence map (adjust explanation depth accordingly):\n${lines}\n  Rule: expert→skip basics; intermediate→brief rationale; beginner→one-line analogy.`;
              }
            }
          }
        } catch { /* non-critical */ }
      }
      if (!brainDoc) {
        try {
          const brainPath = path.join(HOME, '.claude_profile.yaml');
          if (fs.existsSync(brainPath)) brainDoc = yaml.load(fs.readFileSync(brainPath, 'utf8')) || {};
        } catch { /* ignore */ }
      }

      // Self-reflection patterns: behavioral guardrails distilled from past mistakes
      let reflectHint = '';
      if (!session.started && brainDoc) {
        try {
          const patterns = (brainDoc.growth && Array.isArray(brainDoc.growth.self_reflection_patterns))
            ? brainDoc.growth.self_reflection_patterns.filter(p => p && p.summary).slice(0, 3)
            : [];
          if (patterns.length > 0) {
            reflectHint = `\n- Self-correction patterns (avoid repeating these mistakes):\n${patterns.map(p => `  - ${String(p.summary).slice(0, 150)}`).join('\n')}`;
          }
        } catch { /* non-critical */ }
      }

      // Inject daemon hints only on first message of a session
      // Task-specific rules (3-4) are injected only when isTaskIntent() returns true (~250 token saving for casual chat)
      const mentorRadarHint = (config && config.daemon && config.daemon.mentor && config.daemon.mentor.enabled)
        ? '\n   When you observe the user is clearly expert or beginner in a domain, note it in your response and suggest: "要不要把你的 {domain} 水平 ({level}) 记录到能力雷达？"'
        : '';
      const daemonHint = buildDaemonHint({
        sessionStarted: session.started,
        prompt,
        mentorRadarHint,
        zdpHint,
        reflectHint,
        projectKey,
        isTaskIntent,
        runtimeName: runtime.name,
      });

      const routedPrompt = skill ? `/${skill} ${prompt}` : prompt;

      const macAutomationHint = buildMacAutomationHint({
        processPlatform: process.platform,
        readOnly,
        prompt,
        isMacAutomationIntent,
      });

      // P2-B: inject session summary when resuming after a 2h+ gap
      let summaryHint = '';
      if (session.started) {
        try {
          const _stSum = loadState();
          const _sess = _stSum.sessions && _stSum.sessions[chatId];
          if (_sess && _sess.last_summary && _sess.last_summary_at) {
            const _idleMs = Date.now() - (_sess.last_active || 0);
            const _summaryAgeH = (Date.now() - _sess.last_summary_at) / 3600000;
            if (_idleMs > 2 * 60 * 60 * 1000 && _summaryAgeH < 168) {
              summaryHint = `

[上次对话摘要（历史已完成，仅供上下文，请勿重复执行）]: ${_sess.last_summary}`;
              log('INFO', `[DAEMON] Injected session summary for ${chatId} (idle ${Math.round(_idleMs / 3600000)}h)`);
            }
          }
        } catch { /* non-critical */ }
      }

      // Mentor context hook: inject after memoryHint, before langGuard.
      let mentorHint = '';
      if (mentorEnabled && !mentorExcluded && !mentorSuppressed) {
        try {
          const signals = collectRecentSessionSignals(session.id, 6);
          let skeleton = null;
          if (sessionAnalytics && typeof sessionAnalytics.extractSkeleton === 'function') {
            const file = findSessionFile(session.id);
            if (file && fs.existsSync(file)) {
              const st = fs.statSync(file);
              if (st.size <= 2 * 1024 * 1024) {
                skeleton = sessionAnalytics.extractSkeleton(file);
              }
            }
          }
          const zone = skeleton && mentorEngine.computeZone
            ? mentorEngine.computeZone(skeleton).zone
            : 'stretch';
          const sessionState = {
            zone,
            recentMessages: signals.recentMessages,
            cwd: session.cwd,
            skeleton,
            sessionStartTime: signals.sessionStartTime || new Date().toISOString(),
            topic: String(prompt || '').slice(0, 120),
            currentTopic: String(prompt || '').slice(0, 120),
            lastUserMessage: String(prompt || '').slice(0, 200),
          };
          const built = mentorEngine.buildMentorPrompt(sessionState, brainDoc || {}, mentorCfg);
          if (built && String(built).trim()) mentorHint = `\n\n${String(built).trim()}`;

          // Collect reflection debt: if user returns to same project+topic, inject recall prompt.
          // Suppressed by quiet_until (user explicitly asked for silence), but NOT by expert skip
          // (even experts may not have reviewed AI-generated code).
          const quietUntil = brainDoc && brainDoc.growth ? brainDoc.growth.quiet_until : null;
          const quietMs = quietUntil ? new Date(quietUntil).getTime() : 0;
          const isQuiet = quietMs && quietMs > Date.now();
          if (!isQuiet && mentorEngine.collectDebt) {
            const info = deriveProjectInfo(session && session.cwd ? session.cwd : '');
            const projectId = info && info.project_id ? info.project_id : '';
            if (projectId) {
              const debt = mentorEngine.collectDebt(projectId, String(prompt || '').slice(0, 120));
              if (debt && debt.prompt) {
                mentorHint += `\n\n[Reflection debt] ${debt.prompt}`;
              }
            }
          }
        } catch (e) {
          log('WARN', `Mentor prompt build failed: ${e.message}`);
        }
      }

      // Language guard: only inject on first message of a new session to avoid
      // linearly growing token cost on every turn in long conversations.
      // Claude Code preserves session context, so the guard persists after initial injection.
      const langGuard = buildLanguageGuard(session.started);
      const intentHint = buildIntentHint({
        prompt,
        config,
        boundProjectKey,
        projectKey,
        log,
      });
      // For warm process reuse: static context (daemonHint, memoryHint, etc.) is already
      // in the persistent process — skip those to save tokens. intentHint is dynamic
      // (varies per prompt), so include it even on warm reuse.
      const fullPrompt = composePrompt({
        routedPrompt,
        warmEntry: _warmEntry,
        intentHint,
        daemonHint,
        agentHint,
        macAutomationHint,
        summaryHint,
        memoryHint,
        mentorHint,
        langGuard,
      });
      if (runtime.name === 'codex' && session.started && session.id && requestedCodexPermissionProfile) {
        const actualPermissionProfile = getActualCodexPermissionProfile(session);
        if (codexNeedsFallbackForRequestedPermissions(actualPermissionProfile, requestedCodexPermissionProfile)) {
          const actualSummary = actualPermissionProfile
            ? `${actualPermissionProfile.sandboxMode || actualPermissionProfile.permissionMode || 'unknown'}/${actualPermissionProfile.approvalPolicy || 'unknown'}`
            : 'unknown/unknown';
          const requestedSummary = `${requestedCodexPermissionProfile.sandboxMode}/${requestedCodexPermissionProfile.approvalPolicy}`;
          log('INFO', `Codex session ${session.id.slice(0, 8)} is below requested permissions for ${sessionChatId}: ${actualSummary} vs ${requestedSummary}; trying native resume first`);
        }
      }

      const args = runtime.buildArgs({
        model,
        readOnly,
        daemonCfg,
        session,
        cwd: session.cwd,
        addDirs: boundProject && boundProject.addDirs,
        permissionProfile: runtime.name === 'codex' ? requestedCodexPermissionProfile : null,
      });

      // Codex: write/refresh AGENTS.md = CLAUDE.md + SOUL.md on every fresh execution thread.
      // This must happen after any permission-triggered fallback decision so the spawned process uses
      // the final session object and fresh exec args rather than stale resume args.
      if (engineName === 'codex' && session.cwd && !session.started) {
        try {
          const parts = [];
          const claudeMd = path.join(session.cwd, 'CLAUDE.md');
          const soulMd = path.join(session.cwd, 'SOUL.md');
          if (fs.existsSync(claudeMd)) parts.push(fs.readFileSync(claudeMd, 'utf8').trim());
          if (fs.existsSync(soulMd)) {
            const soulContent = fs.readFileSync(soulMd, 'utf8').trim();
            if (soulContent) parts.push(soulContent);
          }
          if (parts.length > 0) {
            fs.writeFileSync(path.join(session.cwd, 'AGENTS.md'), parts.join('\n\n'), 'utf8');
            log('INFO', `Refreshed AGENTS.md (${parts.length} section(s)) in ${session.cwd}`);
          }
        } catch (e) {
          log('WARN', `AGENTS.md refresh failed: ${e.message}`);
        }
      }

      // Git checkpoint before Claude modifies files (for /undo).
      // Skip for virtual agents (team clones like _agent_yi) — each has its own worktree,
      // but checkpoint uses `git add -A` which could interfere with parallel work.
      const _isVirtualAgent = String(chatId).startsWith('_agent_') || String(chatId).startsWith('_scope_');
      if (!_isVirtualAgent && !_warmEntry) {
        try {
          // Do NOT pass prompt — conversation content must never enter git history
          const checkpointResult = (gitCheckpointAsync || gitCheckpoint)(session.cwd);
          if (checkpointResult && typeof checkpointResult.catch === 'function') {
            checkpointResult.catch(() => { });
          }
        } catch { /* non-critical */ }
      }
      log('INFO', `[TIMING:${chatId}] pre-spawn +${Date.now() - _t0}ms (engine:${runtime.name} started:${session.started})`);

      // Use streaming mode to show progress
      // Telegram: edit status msg in-place; Feishu: edit or fallback to new messages
      let editFailed = false;
      let lastFallbackStatus = 0;
      const FALLBACK_THROTTLE = fallbackThrottleMs;
      const onStatus = async (status) => {
        try {
          if (typeof status !== 'string') return;

          // __STREAM_TEXT__: streamed model text — edit card and track for final dedup
          if (status.startsWith('__STREAM_TEXT__')) {
            const content = status.slice('__STREAM_TEXT__'.length);
            // Set synchronously BEFORE await — this is the critical race fix.
            // flushStream(true) is called from the 'done' event (before process close),
            // so by setting here synchronously, _lastStatusCardContent is guaranteed to be
            // set before the child 'close' event fires and finalize() resolves.
            _lastStatusCardContent = content;
            if (statusMsgId && bot.editMessage && !editFailed) {
              const ok = await bot.editMessage(chatId, statusMsgId, content, _ackCardHeader);
              if (ok === false) editFailed = true;
            }
            return; // skip fallback — final reply logic will use existing card
          }

          // __TOOL_OVERLAY__: text + tool status line — edit card but don't update _lastStatusCardContent
          if (status.startsWith('__TOOL_OVERLAY__')) {
            const content = status.slice('__TOOL_OVERLAY__'.length);
            if (statusMsgId && bot.editMessage && !editFailed) {
              await bot.editMessage(chatId, statusMsgId, content, _ackCardHeader);
              // intentionally NOT updating _lastStatusCardContent — overlay is transient
            }
            return;
          }

          // Plain status (tool names before any text, milestone timers, etc.)
          if (statusMsgId && bot.editMessage && !editFailed) {
            const ok = await bot.editMessage(chatId, statusMsgId, status, _ackCardHeader);
            if (ok !== false) {
              _lastStatusCardContent = status;
              return;
            }
            editFailed = true;
          }
          // Fallback: send as new message with throttle to avoid spam
          const now = Date.now();
          if (now - lastFallbackStatus < FALLBACK_THROTTLE) return;
          lastFallbackStatus = now;
          await bot.sendMessage(chatId, status);
        } catch { /* ignore status update failures */ }
      };

      const wasCodexResumeAttempt = runtime.name === 'codex'
        && !!(session && session.started && session.id && session.id !== '__continue__');
      const onSession = async (nextSessionId) => {
        const safeNextId = String(nextSessionId || '').trim();
        if (!safeNextId) return;
        const prevSessionId = session && session.id ? String(session.id) : '';
        const wasStarted = !!(session && session.started);
        session = {
          ...session,
          id: safeNextId,
          engine: runtime.name,
          logicalChatId: sessionChatId,
          started: true,
        };
        await patchSessionSerialized(sessionChatId, (cur) => {
          const engines = { ...(cur.engines || {}) };
          const actualPermissionProfile = runtime.name === 'codex'
            ? (getActualCodexPermissionProfile({ id: safeNextId }) || requestedCodexPermissionProfile)
            : null;
          engines[runtime.name] = {
            ...(engines[runtime.name] || {}),
            id: safeNextId,
            started: true,
            ...(runtime.name === 'codex' ? { runtimeSessionObserved: true } : {}),
            ...(runtime.name === 'codex' ? actualPermissionProfile : {}),
          };
          return { ...cur, cwd: effectiveCwd || cur.cwd || HOME, engines };
        });
        if (runtime.name === 'codex' && wasStarted && prevSessionId && prevSessionId !== safeNextId && prevSessionId !== '__continue__') {
          log('WARN', `Codex thread migrated for ${chatId}: ${prevSessionId.slice(0, 8)} -> ${safeNextId.slice(0, 8)}`);
        }
        // Keep card header in sync with the real session ID reported by the engine
        if (_ackCardHeader && _ackCardHeader._baseTitle) {
          _ackCardHeader = { ..._ackCardHeader, title: `${_ackCardHeader._baseTitle}（${safeNextId.slice(0, 8)}）` };
        }
      };

      // Check if user cancelled during pre-spawn phase (sentinel was marked aborted)
      // Stamp session ID on card header so user can track session continuity
      if (_ackCardHeader) {
        _ackCardHeader._baseTitle = _ackCardHeader.title; // preserve original title for onSession updates
      }
      if (session && session.id && _ackCardHeader) {
        _ackCardHeader = { ..._ackCardHeader, title: `${_ackCardHeader._baseTitle}（${session.id.slice(0, 8)}）` };
      }

      const _preSentinel = activeProcesses.get(chatId);
      if (_preSentinel && _preSentinel.child === null && _preSentinel.aborted) {
        clearInterval(typingTimer);
        const _preReason = _preSentinel.abortReason || '';
        activeProcesses.delete(chatId); saveActivePids();
        if (_preReason === 'merge-pause' && statusMsgId) {
          // Save card for reuse by the merged flush
          _pausedCards.set(chatId, { statusMsgId, cardHeader: _ackCardHeader, savedAt: Date.now() });
          if (bot.editMessage) bot.editMessage(chatId, statusMsgId, '⏸ 合并中…', _ackCardHeader).catch(() => {});
        } else if (statusMsgId && bot.deleteMessage) {
          bot.deleteMessage(chatId, statusMsgId).catch(() => {});
        }
        log('INFO', `[askClaude] Pre-spawn abort for ${chatId}: ${_preReason || 'user cancelled'}`);
        return { ok: false, error: _preReason === 'merge-pause' ? 'Paused for merge' : 'Stopped by user' };
      }

      let output, error, errorCode, files, toolUsageLog, timedOut, sessionId;
      try {
        ({
          output,
          error,
          errorCode,
          timedOut,
          files,
          toolUsageLog,
          sessionId,
        } = await spawnClaudeStreaming(
          args,
          fullPrompt,
          session.cwd,
          onStatus,
          600000,
          chatId,
          boundProjectKey || '',
          normalizeSenderId(senderId),
          runtime,
          onSession,
          {
            warmChild: _warmEntry ? _warmEntry.child : null,
            persistent: runtime.name === 'claude' && !!warmPool,
            warmPool,
            warmSessionKey: _warmSessionKey,
          },
        ));

        if (sessionId) await onSession(sessionId);

        if (runtime.name === 'codex' && requestedCodexPermissionProfile) {
          let observedRuntimeProfile = getActualCodexPermissionProfile(sessionId ? { id: sessionId } : session);
          let stabilizationRetryCount = 0;
          while (codexNeedsFallbackForRequestedPermissions(observedRuntimeProfile, requestedCodexPermissionProfile)
            && stabilizationRetryCount < CODEX_PERMISSION_STABILIZE_MAX_RETRIES) {
            stabilizationRetryCount += 1;
            const previousSessionId = String(sessionId || session.id || '').trim();
            const observedSummary = observedRuntimeProfile
              ? `${observedRuntimeProfile.sandboxMode || observedRuntimeProfile.permissionMode || 'unknown'}/${observedRuntimeProfile.approvalPolicy || 'unknown'}`
              : 'unknown/unknown';
            const requestedSummary = `${requestedCodexPermissionProfile.sandboxMode}/${requestedCodexPermissionProfile.approvalPolicy}`;
            log(
              'WARN',
              `Codex thread ${String(sessionId || session.id || '').slice(0, 8)} ended below requested permissions for ${sessionChatId}: ${observedSummary} vs ${requestedSummary}; retrying with a new execution thread (${stabilizationRetryCount}/${CODEX_PERMISSION_STABILIZE_MAX_RETRIES})`
            );
            session = createSession(
              sessionChatId,
              effectiveCwd,
              boundProject && boundProject.name ? boundProject.name : '',
              'codex',
              requestedCodexPermissionProfile
            );
            const retryRecentContext = previousSessionId && typeof getSessionRecentContext === 'function'
              ? getSessionRecentContext(previousSessionId)
              : null;
            const freshRetryPrompt = buildCodexFallbackBridgePrompt({
              fullPrompt,
              previousSessionId,
              previousProfile: normalizeComparableCodexPermissionProfile(observedRuntimeProfile),
              requestedProfile: requestedCodexPermissionProfile,
              recentContext: retryRecentContext,
            });
            const freshRetryArgs = runtime.buildArgs({
              model,
              readOnly,
              daemonCfg,
              session,
              cwd: session.cwd,
              permissionProfile: requestedCodexPermissionProfile,
            });
            ({
              output,
              error,
              errorCode,
              timedOut,
              files,
              toolUsageLog,
              sessionId,
            } = await spawnClaudeStreaming(
              freshRetryArgs,
              freshRetryPrompt,
              session.cwd,
              onStatus,
              600000,
              chatId,
              boundProjectKey || '',
              normalizeSenderId(senderId),
              runtime,
              onSession,
            ));
            if (sessionId) await onSession(sessionId);
            observedRuntimeProfile = getActualCodexPermissionProfile(sessionId ? { id: sessionId } : session);
          }
          if (codexNeedsFallbackForRequestedPermissions(observedRuntimeProfile, requestedCodexPermissionProfile)) {
            const observedSummary = observedRuntimeProfile
              ? `${observedRuntimeProfile.sandboxMode || observedRuntimeProfile.permissionMode || 'unknown'}/${observedRuntimeProfile.approvalPolicy || 'unknown'}`
              : 'unknown/unknown';
            const requestedSummary = `${requestedCodexPermissionProfile.sandboxMode}/${requestedCodexPermissionProfile.approvalPolicy}`;
            log(
              'WARN',
              `Codex thread ${String(sessionId || session.id || '').slice(0, 8)} still below requested permissions for ${sessionChatId} after ${CODEX_PERMISSION_STABILIZE_MAX_RETRIES} stabilization retries: ${observedSummary} vs ${requestedSummary}`
            );
          }
        }

        const resumeFailure = classifyCodexResumeFailure(error, errorCode);
        if (shouldRetryCodexResumeFallback({
          runtimeName: runtime.name,
          wasResumeAttempt: wasCodexResumeAttempt,
          output,
          error,
          errorCode,
          failureKind: resumeFailure.kind,
          canRetry: canRetryCodexResume(chatId, resumeFailure.kind),
        })) {
          markCodexResumeRetried(chatId, resumeFailure.kind);
          log(
            'WARN',
            `Codex resume failed for ${chatId}, retrying once with ${(resumeFailure.kind === 'interrupted' || resumeFailure.kind === 'transport') ? 'native resume recovery' : 'fresh exec'}: ${String(error).slice(0, 120)}`
          );
          await bot.sendMessage(chatId, resumeFailure.userMessage).catch(() => { });
          if (resumeFailure.kind !== 'interrupted' && resumeFailure.kind !== 'transport') {
            session = createSession(
              sessionChatId,
              effectiveCwd,
              boundProject && boundProject.name ? boundProject.name : '',
              'codex',
              requestedCodexPermissionProfile
            );
          }
          const retryArgs = runtime.buildArgs({
            model,
            readOnly,
            daemonCfg,
            session,
            cwd: session.cwd,
            permissionProfile: requestedCodexPermissionProfile,
          });
          const retryPrompt = `${resumeFailure.retryPromptPrefix}\n\n${fullPrompt}`;
          ({
            output,
            error,
            errorCode,
            timedOut,
            files,
            toolUsageLog,
            sessionId,
          } = await spawnClaudeStreaming(
            retryArgs,
            retryPrompt,
            session.cwd,
            onStatus,
            600000,
            chatId,
            boundProjectKey || '',
            normalizeSenderId(senderId),
            runtime,
            onSession,
          ));
          if (sessionId) await onSession(sessionId);
        }
      } catch (spawnErr) {
        clearInterval(typingTimer);
        // Clean up pending sentinel if spawn never completed
        const _ps2 = activeProcesses.get(chatId);
        if (_ps2 && _ps2.child === null) { activeProcesses.delete(chatId); saveActivePids(); }
        if (statusMsgId && bot.deleteMessage) bot.deleteMessage(chatId, statusMsgId).catch(() => { });
        log('ERROR', `spawnClaudeStreaming crashed for ${chatId}: ${spawnErr.message}`);
        await bot.sendMessage(chatId, `❌ 内部错误: ${spawnErr.message}`).catch(() => { });
        return { ok: false, error: spawnErr.message };
      }
      clearInterval(typingTimer);

      // [PROTECTED] L0 lossless diary — see logRawSessionDiary() at file top
      logRawSessionDiary(fs, path, HOME, { chatId, prompt, output, error, projectKey: boundProjectKey });

      // Skill evolution: capture signal + hot path heuristic check
      if (skillEvolution) {
        try {
          const signal = skillEvolution.extractSkillSignal(fullPrompt, output, error, files, session.cwd, toolUsageLog);
          if (signal) {
            skillEvolution.appendSkillSignal(signal);
            skillEvolution.checkHotEvolution(signal);
          }
        } catch (e) { log('WARN', `Skill evolution signal capture failed: ${e.message}`); }
      }

      // statusMsgId is always available for final reply handling (edit or delete).
      const _statusMsgIdForReply = statusMsgId || null;

      // Mentor post-flight debt registration (intense mode only).
      if (mentorEnabled && !mentorExcluded && !mentorSuppressed && mentorEngine && typeof mentorEngine.registerDebt === 'function' && output) {
        try {
          const mode = resolveMentorMode(mentorCfg);
          if (mode === 'intense') {
            const codeLines = countCodeLines(output);
            if (codeLines > 30) {
              const info = deriveProjectInfo(session && session.cwd ? session.cwd : '');
              const projectId = info && info.project_id ? info.project_id : 'proj_default';
              mentorEngine.registerDebt(projectId, String(prompt || '').slice(0, 120), codeLines);
              log('INFO', `[MENTOR] Registered reflection debt (${projectId}, lines=${codeLines})`);
            }
          }
        } catch (e) {
          log('WARN', `Mentor post-flight failed: ${e.message}`);
        }
      }

      // When Claude completes with no text output (pure tool work), send a done notice
      if (output === '' && !error) {
        // Special case: if dispatch_to was called, send a "forwarded" confirmation
        const dispatchedTargets = (toolUsageLog || [])
          .filter(t => t.tool === 'Bash' && typeof t.context === 'string' && t.context.includes('dispatch_to'))
          .map(t => { const m = t.context.match(/dispatch_to\s+(\S+)/); return m ? m[1] : null; })
          .filter(Boolean);
        if (dispatchedTargets.length > 0) {
          const allProjects = (config && config.projects) || {};
          const names = dispatchedTargets.map(k => (allProjects[k] && allProjects[k].name) || k).join('、');
          const doneMsg = await bot.sendMessage(chatId, `✉️ 已转达给 ${names}，处理中…`);
          if (doneMsg && doneMsg.message_id && session) trackMsgSession(doneMsg.message_id, session, String(chatId).startsWith('_agent_') ? String(chatId).slice(7) : null);
          const wasNew = !session.started;
          if (wasNew) markSessionStarted(sessionChatId, engineName);
          return { ok: true };
        }
        const filesDesc = files && files.length > 0 ? `\n修改了 ${files.length} 个文件` : '';
        const doneMsg = await bot.sendMessage(chatId, `✅ 完成${filesDesc}`);
        if (doneMsg && doneMsg.message_id && session) trackMsgSession(doneMsg.message_id, session, String(chatId).startsWith('_agent_') ? String(chatId).slice(7) : null);
        const wasNew = !session.started;
        if (wasNew) markSessionStarted(sessionChatId, engineName);
        return { ok: true };
      }

      // Merge-pause with partial output: save card for reuse, discard partial output
      if (output && errorCode === 'INTERRUPTED_MERGE_PAUSE') {
        if (statusMsgId) {
          _pausedCards.set(chatId, { statusMsgId, cardHeader: _ackCardHeader, savedAt: Date.now() });
          if (bot.editMessage) bot.editMessage(chatId, statusMsgId, '⏸ 合并中…', _ackCardHeader).catch(() => {});
          log('INFO', `[askClaude] Merge-pause with partial output, saved card ${statusMsgId} for ${chatId}`);
        }
        return { ok: false, error: 'Paused for merge', errorCode };
      }

      if (output) {
        if (runtime.name === 'codex') {
          _codexResumeRetryTs.delete(getCodexResumeRetryKey(chatId, 'interrupted'));
          _codexResumeRetryTs.delete(getCodexResumeRetryKey(chatId, 'expired'));
          _codexResumeRetryTs.delete(getCodexResumeRetryKey(chatId, 'default'));
        }
        // Detect provider/model errors disguised as output (e.g., "model not found", API errors)
        if (runtime.name === 'claude') {
          const activeProvCheck = providerMod ? providerMod.getActiveName() : 'anthropic';
          const builtinModelsCheck = ['sonnet', 'opus', 'haiku'];
          const looksLikeError = output.length < 300 && /\b(not found|invalid model|unauthorized|401|403|404|error|failed)\b/i.test(output);
          if (looksLikeError && (activeProvCheck !== 'anthropic' || !builtinModelsCheck.includes(model))) {
            try {
              config = fallbackToDefaultProvider(`output looks like error for ${activeProvCheck}/${model}`);
              await bot.sendMessage(chatId, `⚠️ ${activeProvCheck}/${model} 疑似失败，已回退到 anthropic/opus\n输出: ${output.slice(0, 150)}`);
            } catch (fbErr) {
              log('ERROR', `Fallback failed: ${fbErr.message}`);
              await bot.sendMarkdown(chatId, output);
            }
            return { ok: false, error: output };
          }
        }

        // Mark session as started after first successful call
        const wasNew = !session.started;
        if (wasNew) {
          markSessionStarted(sessionChatId, engineName);
          if (runtime.name === 'codex' && session.runtimeSessionObserved === false) {
            log('WARN', `Codex completed without emitting thread id for ${chatId}; keeping session non-resumable until a real thread id is observed`);
          }
        }

        const estimated = Math.ceil((prompt.length + output.length) / 4);
        const chatCategory = classifyChatUsage(chatId, {
          projectKey: boundProjectKey || '',
          cwd: session && session.cwd,
          homeDir: HOME,
        });
        recordTokens(loadState(), estimated, { category: chatCategory });

        // Parse [[FILE:...]] markers from output (Claude's explicit file sends)
        let { markedFiles, cleanOutput } = parseFileMarkers(output);

        // Timeout with partial results: prepend warning
        if (timedOut) {
          cleanOutput = `⚠️ **任务超时，以下是已完成的部分结果：**\n\n${cleanOutput}`;
        }

        if (typeof bot.notifyFinalOutput === 'function') {
          try { await bot.notifyFinalOutput(cleanOutput); } catch { /* non-critical */ }
        }

        // Match current session to a project for colored card display.
        // Prefer the bound project (known by virtual chatId or chat_agent_map) — avoids ambiguity
        // when multiple projects share the same cwd (e.g. team members with parent project cwd).
        let activeProject = boundProject || null;
        if (!activeProject && session && session.cwd && config && config.projects) {
          const sessionCwd = path.resolve(normalizeCwd(session.cwd));
          for (const [, proj] of Object.entries(config.projects)) {
            if (!proj.cwd) continue;
            const projCwd = path.resolve(normalizeCwd(proj.cwd));
            if (sessionCwd === projCwd) { activeProject = proj; break; }
          }
        }

        let replyMsg;
        try {
          log('DEBUG', `[REPLY:${chatId}] statusMsgId=${statusMsgId} editFailed=${editFailed} activeProject=${activeProject && activeProject.name} lastCard=${_lastStatusCardContent ? _lastStatusCardContent.slice(0, 40) : 'null'}`);

          // siri_ask: write full response to temp file for any dispatch-triggered reply
          if (chatId && chatId.startsWith('_agent_') && cleanOutput) {
            try { require('fs').writeFileSync('/tmp/siri_response.txt', cleanOutput); } catch {}
          }

          // Strategy: always try to update the status card first (avoids sending a new card
          // while the old 🤔 card lingers, which would produce two messages).
          // If edit fails: try to delete the status card (awaited, not fire-and-forget).
          // If delete also fails: fall through to sending a new card.
          if (_statusMsgIdForReply && bot.editMessage) {
            // Skip redundant edit: streaming already wrote the final content to the card.
            // _lastStatusCardContent tracks the last __STREAM_TEXT__ write, so if it matches
            // cleanOutput the card is already showing the right content — no update needed.
            if (_lastStatusCardContent !== null && _lastStatusCardContent === cleanOutput) {
              log('DEBUG', `[REPLY:${chatId}] skipping editMessage — card already shows final content`);
              replyMsg = { message_id: _statusMsgIdForReply };
            } else {
              const editOk = await bot.editMessage(chatId, _statusMsgIdForReply, cleanOutput, _ackCardHeader);
              log('DEBUG', `[REPLY:${chatId}] editMessage result=${editOk}`);
              if (editOk !== false) {
                replyMsg = { message_id: _statusMsgIdForReply };
              } else if (bot.deleteMessage) {
                const deleted = await bot.deleteMessage(chatId, _statusMsgIdForReply).then(() => true).catch(() => false);
                log('DEBUG', `[REPLY:${chatId}] deleteMessage result=${deleted}`);
                if (!deleted) {
                  // Both edit and delete failed — try one more edit attempt to avoid leaving 🤔
                  log('WARN', `[REPLY:${chatId}] deleteMessage failed — status card may linger alongside new reply`);
                }
              }
            }
          } else if (_statusMsgIdForReply && bot.deleteMessage) {
            // No editMessage — delete the status card
            await bot.deleteMessage(chatId, _statusMsgIdForReply).catch(() => { });
          }

          if (!replyMsg) {
            if (activeProject && bot.sendCard) {
              log('DEBUG', `[REPLY:${chatId}] sending sendCard`);
              const _sessionTag = session && session.id ? `（${session.id.slice(0, 8)}）` : '';
              replyMsg = await bot.sendCard(chatId, {
                title: `${activeProject.icon || '🤖'} ${activeProject.name || ''}${_sessionTag}`,
                body: cleanOutput,
                color: activeProject.color || 'blue',
              });
              log('DEBUG', `[REPLY:${chatId}] sendCard done msgId=${replyMsg && replyMsg.message_id}`);
            } else {
              log('DEBUG', `[REPLY:${chatId}] sending sendMarkdown`);
              replyMsg = await bot.sendMarkdown(chatId, cleanOutput);
              log('DEBUG', `[REPLY:${chatId}] sendMarkdown done msgId=${replyMsg && replyMsg.message_id}`);
            }
          }
        } catch (sendErr) {
          log('WARN', `sendCard/sendMarkdown failed (${sendErr.message}), falling back to sendMessage`);
          try { replyMsg = await bot.sendMessage(chatId, cleanOutput); } catch (e2) {
            log('ERROR', `sendMessage fallback also failed: ${e2.message}`);
          }
        }
        const trackedAgentKey = String(chatId).startsWith('_agent_') ? String(chatId).slice(7) : null;
        if (replyMsg && replyMsg.message_id && session) {
          if (runtime.name === 'codex' && session.runtimeSessionObserved === false) {
            trackMsgSession(replyMsg.message_id, session, trackedAgentKey, { routeOnly: true });
          } else {
            trackMsgSession(replyMsg.message_id, session, trackedAgentKey);
          }
        }

        const fileMsgs = await sendFileButtons(bot, chatId, mergeFileCollections(markedFiles, files));
        if (session && Array.isArray(fileMsgs)) {
          for (const msg of fileMsgs) {
            if (!msg || !msg.message_id) continue;
            if (runtime.name === 'codex' && session.runtimeSessionObserved === false) {
              trackMsgSession(msg.message_id, session, trackedAgentKey, { routeOnly: true });
            } else {
              trackMsgSession(msg.message_id, session, trackedAgentKey);
            }
          }
        }

        // Timeout: also send the reason after the partial result
        if (timedOut && error) {
          try { await bot.sendMessage(chatId, error); } catch { /* */ }
        }

        // Auto-name: if this was the first message and session has no name, generate one.
        // Add agent label prefix so desktop users can identify which agent owns the session.
        if (runtime.name === 'claude' && wasNew && !getSessionName(session.id)) {
          const _agentLabel = (boundProject && boundProject.name)
            ? `[${boundProject.name}] `
            : (projectKey ? `[${projectKey}] ` : '');
          autoNameSession(chatId, session.id, prompt, session.cwd, _agentLabel).catch(() => { });
        }

        // Auto-refresh memory-snapshot.md for this agent on first session message (fire-and-forget)
        if (wasNew && boundProject && boundProject.agent_id) {
          setImmediate(async () => {
            try {
              const memory = require('./memory');
              const pKey = boundProjectKey || '';
              const sessions = memory.recentSessions({ limit: 5, project: pKey });
              const factsRaw = memory.searchFacts('', { limit: 10, project: pKey });
              const facts = Array.isArray(factsRaw) ? factsRaw : [];
              memory.close();
              const snapshotContent = buildMemorySnapshotContent(sessions, facts);
              const agentId = boundProject.agent_id;
              if (refreshMemorySnapshot(agentId, snapshotContent, HOME)) {
                log('DEBUG', `[AGENT] Memory snapshot refreshed for ${agentId}`);
              }
            } catch { /* non-critical — memory module may not be available */ }
          });
        }
        return { ok: !timedOut };
      } else {
        const errMsg = error || 'Unknown error';
        const userErrMsg = (errorCode === 'AUTH_REQUIRED' || errorCode === 'RATE_LIMIT')
          ? errMsg
          : `Error: ${errMsg.slice(0, 200)}`;
        log('ERROR', `ask${runtime.name === 'codex' ? 'Codex' : 'Claude'} failed for ${chatId}: ${errMsg.slice(0, 300)} (${errorCode || 'NO_CODE'})`);

        // Merge-pause: save card for reuse, don't show error to user
        if (errorCode === 'INTERRUPTED_MERGE_PAUSE') {
          if (statusMsgId) {
            _pausedCards.set(chatId, { statusMsgId, cardHeader: _ackCardHeader, savedAt: Date.now() });
            // Update card to show paused state
            if (bot.editMessage) bot.editMessage(chatId, statusMsgId, '⏸ 合并中…', _ackCardHeader).catch(() => {});
            log('INFO', `[askClaude] Saved paused card ${statusMsgId} for ${chatId}`);
          }
          return { ok: false, error: errMsg, errorCode };
        }

        // If session not found / locked / thinking signature invalid — try repair or create new and retry once (Claude path)
        const _isThinkingSignatureError = isClaudeThinkingSignatureError(errMsg);
        const _isSessionResumeFail = errMsg.includes('not found') || errMsg.includes('No session') || errMsg.includes('already in use') || _isThinkingSignatureError;
        if (runtime.name === 'claude' && _isSessionResumeFail) {
          const _reason = errMsg.includes('already in use') ? 'locked' : _isThinkingSignatureError ? 'thinking-signature-invalid' : 'not found';

          // For thinking signature errors, try to repair the session in-place first (preserve context)
          let _repaired = false;
          if (_isThinkingSignatureError && session.id) {
            const stripped = stripThinkingSignatures(session.id);
            if (stripped > 0) {
              log('INFO', `Session ${session.id} repaired: stripped ${stripped} thinking signatures, retrying same session`);
              _repaired = true;
            }
          }

          if (!_repaired) {
            log('WARN', `Session ${session.id} unusable (${_reason}), creating new`);
            session = createSession(sessionChatId, effectiveCwd, '', runtime.name);
          }

          const retryArgs = runtime.buildArgs({
            model,
            readOnly,
            daemonCfg,
            session,
            cwd: session.cwd,
          });

          const retry = await spawnClaudeStreaming(
            retryArgs,
            fullPrompt,
            session.cwd,
            onStatus,
            600000,
            chatId,
            boundProjectKey || '',
            normalizeSenderId(senderId),
            runtime,
            onSession,
          );
          if (retry.sessionId) await onSession(retry.sessionId);
          if (retry.output) {
            markSessionStarted(sessionChatId, runtime.name);
            const { markedFiles: retryMarked, cleanOutput: retryClean } = parseFileMarkers(retry.output);
            if (typeof bot.notifyFinalOutput === 'function') {
              try { await bot.notifyFinalOutput(retryClean); } catch { /* non-critical */ }
            }
            await bot.sendMarkdown(chatId, retryClean);
            await sendFileButtons(bot, chatId, mergeFileCollections(retryMarked, retry.files));
            return { ok: true };
          } else {
            log('ERROR', `askClaude retry failed: ${(retry.error || '').slice(0, 200)}`);
            const retryUserMsg = _isThinkingSignatureError
              ? formatClaudeResumeFallbackUserMessage(retry.error || errMsg)
              : userErrMsg;
            try { await bot.sendMessage(chatId, retryUserMsg); } catch { /* */ }
            return { ok: false, error: retry.error || errMsg };
          }
        } else {
          // Auto-fallback: if custom provider/model fails, revert to anthropic + opus (Claude path only)
          if (runtime.name === 'claude') {
            const activeProv = providerMod ? providerMod.getActiveName() : 'anthropic';
            const builtinModelValues = (ENGINE_MODEL_CONFIG.claude.options || []).map(o => typeof o === 'string' ? o : o.value);
            if ((activeProv !== 'anthropic' || !builtinModelValues.includes(model)) && !errMsg.includes('Stopped by user')) {
              try {
                config = fallbackToDefaultProvider(`${activeProv}/${model} error: ${errMsg.slice(0, 100)}`);
                await bot.sendMessage(chatId, `⚠️ ${activeProv}/${model} 失败，已回退到 anthropic/opus\n原因: ${errMsg.slice(0, 100)}`);
              } catch (fallbackErr) {
                log('ERROR', `Fallback failed: ${fallbackErr.message}`);
                try { await bot.sendMessage(chatId, userErrMsg); } catch { /* */ }
              }
            } else {
              try { await bot.sendMessage(chatId, userErrMsg); } catch { /* */ }
            }
          } else {
            try { await bot.sendMessage(chatId, userErrMsg); } catch { /* */ }
          }
          return { ok: false, error: errMsg, errorCode };
        }
      }

    } catch (fatalErr) { // ── safety-net-catch ──
      clearInterval(typingTimer);
      // Clean up pending sentinel if spawn never completed
      const _ps3 = activeProcesses.get(chatId);
      if (_ps3 && _ps3.child === null) { activeProcesses.delete(chatId); saveActivePids(); }
      if (statusMsgId && bot.deleteMessage) await bot.deleteMessage(chatId, statusMsgId).catch(() => { });
      log('FATAL', `[askClaude] Uncaught error for ${chatId}: ${fatalErr.message}\n${fatalErr.stack}`);
      try { await bot.sendMessage(chatId, `❌ 内部错误: ${fatalErr.message}`); } catch { /* */ }
      return { ok: false, error: fatalErr.message };
    }
  }

  return {
    parseFileMarkers,
    mergeFileCollections,
    spawnClaudeAsync,
    spawnClaudeStreaming,
    trackMsgSession,
    askClaude,
    _private: {
      patchSessionSerialized,
      shouldRetryCodexResumeFallback,
      resolveStreamingTimeouts,
      formatTimeoutWindowLabel,
      formatEngineSpawnError,
      adaptDaemonHintForEngine,
      getSessionChatId,
      getCodexPermissionProfile,
      getActualCodexPermissionProfile,
      sameCodexPermissionProfile,
      inspectClaudeResumeSession,
      isClaudeThinkingSignatureError,
      formatClaudeResumeFallbackUserMessage,
      classifyCodexResumeFailure,
      canRetryCodexResume,
      markCodexResumeRetried,
      getCodexResumeRetryKey,
      CODEX_RESUME_RETRY_WINDOW_MS,
      shouldAutoRouteSkill,
      codexSandboxPrivilegeRank,
      codexApprovalPrivilegeRank,
      codexNeedsFallbackForRequestedPermissions,
      buildCodexFallbackBridgePrompt,
    },
  };
}

module.exports = { createClaudeEngine };
