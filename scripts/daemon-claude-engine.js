'use strict';

const { classifyChatUsage } = require('./usage-classifier');
const { deriveProjectInfo } = require('./utils');
const { createEngineRuntimeFactory, normalizeEngineName, resolveEngineModel, ENGINE_MODEL_CONFIG } = require('./daemon-engine-runtime');
const { buildAgentContextForEngine, buildMemorySnapshotContent, refreshMemorySnapshot } = require('./agent-layer');

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
    messageQueue,
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
    listRecentSessions,
    getSession,
    getSessionForEngine,
    createSession,
    getSessionName,
    writeSessionName,
    markSessionStarted,
    isEngineSessionValid,
    gitCheckpoint,
    gitCheckpointAsync,
    recordTokens,
    skillEvolution,
    touchInteraction,
    statusThrottleMs = 3000,
    fallbackThrottleMs = 8000,
    getEngineRuntime: injectedGetEngineRuntime,
    getDefaultEngine: _getDefaultEngine,
  } = deps;
  function getDefaultEngine() {
    return (typeof _getDefaultEngine === 'function') ? _getDefaultEngine() : 'claude';
  }
  let mentorEngine = null;
  try { mentorEngine = require('./mentor-engine'); } catch { /* optional */ }
  let sessionAnalytics = null;
  try { sessionAnalytics = require('./session-analytics'); } catch { /* optional */ }

  const getEngineRuntime = typeof injectedGetEngineRuntime === 'function'
    ? injectedGetEngineRuntime
    : createEngineRuntimeFactory({ fs, path, HOME, CLAUDE_BIN, getActiveProviderEnv });

  // On Windows, spawning .cmd files via shell:true causes cmd.exe to flash briefly.
  // Instead, read the .cmd wrapper, extract the real Node.js entry point, and spawn
  // `node <entry.js> <args>` directly — completely bypasses cmd.exe, zero flash.
  function resolveNodeEntry(cmdPath) {
    try {
      const content = fs.readFileSync(cmdPath, 'utf8');
      // Match the quoted .js path just before %* at end of last exec line
      const m = content.match(/"([^"]+\.js)"\s*%\*\s*$/m);
      if (m) {
        // Substitute %dp0% (batch var for the cmd file's own directory)
        const entry = m[1].replace(/%dp0%/gi, path.dirname(cmdPath) + path.sep);
        if (fs.existsSync(entry)) return entry;
      }
    } catch { /* ignore */ }
    return null;
  }

  // Cache resolved entries so we only read .cmd files once
  const _nodeEntryCache = new Map();
  function resolveNodeEntryForCmd(cmd) {
    if (_nodeEntryCache.has(cmd)) return _nodeEntryCache.get(cmd);
    let cmdPath = cmd;
    const lowerCmd = String(cmd || '').toLowerCase();
    // If bare name (not a file path), find the .cmd via where
    if (lowerCmd === 'claude' || lowerCmd === 'codex') {
      try {
        const { execSync: _es } = require('child_process');
        const lines = _es(`where ${cmd}`, { encoding: 'utf8', timeout: 3000 })
          .split('\n').map(l => l.trim()).filter(Boolean);
        cmdPath = lines.find(l => l.toLowerCase().endsWith(`${lowerCmd}.cmd`)) || lines[0] || cmd;
      } catch { /* ignore */ }
    }
    const entry = resolveNodeEntry(cmdPath);
    _nodeEntryCache.set(cmd, entry);
    return entry;
  }

  function spawn(cmd, args, options) {
    if (process.platform !== 'win32') return _spawn(cmd, args, options);

    const lowerCmd = String(cmd || '').toLowerCase();
    const isCmdLike = lowerCmd.endsWith('.cmd') || lowerCmd.endsWith('.bat')
      || cmd === CLAUDE_BIN || lowerCmd === 'claude' || lowerCmd === 'codex';

    if (isCmdLike) {
      const entry = resolveNodeEntryForCmd(cmd);
      if (entry) {
        // Run node directly — no cmd.exe, no flash
        return _spawn(process.execPath, [entry, ...args], { ...options, windowsHide: true });
      }
      // Fallback: shell with windowsHide
      return _spawn(cmd, args, { ...options, shell: process.env.COMSPEC || true, windowsHide: true });
    }
    return _spawn(cmd, args, { ...options, windowsHide: true });
  }

  // Per-chatId patch queues: Agent A's writes never block Agent B.
  const _patchQueues = new Map(); // chatId -> Promise
  function patchSessionSerialized(chatId, patchFn) {
    const prev = _patchQueues.get(chatId) || Promise.resolve();
    const next = prev.then(() => {
      const state = loadState();
      if (!state.sessions) state.sessions = {};
      const cur = state.sessions[chatId] || {};
      const patched = typeof patchFn === 'function' ? patchFn(cur) : cur;
      state.sessions[chatId] = patched && typeof patched === 'object' ? patched : cur;
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
  const _codexResumeRetryTs = new Map(); // chatId -> last retry ts

  function canRetryCodexResume(chatId) {
    const key = String(chatId || '');
    if (!key) return false;
    const last = Number(_codexResumeRetryTs.get(key) || 0);
    if (!last) return true;
    return (Date.now() - last) > CODEX_RESUME_RETRY_WINDOW_MS;
  }

  function markCodexResumeRetried(chatId) {
    const key = String(chatId || '');
    if (!key) return;
    _codexResumeRetryTs.set(key, Date.now());
  }

  function shouldRetryCodexResumeFallback({ runtimeName, wasResumeAttempt, output, error, errorCode, canRetry }) {
    return runtimeName === 'codex'
      && !!wasResumeAttempt
      && !!error
      && (!output || !!errorCode)
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

  function adaptDaemonHintForEngine(daemonHint, engineName) {
    if (normalizeEngineName(engineName) === 'claude') return daemonHint;
    let out = String(daemonHint || '');
    // Keep this replacement conservative: only unwrap the known outer wrapper.
    out = out.replace('[System hints - DO NOT mention these to user:', 'System hints (internal, do not mention to user):');
    // The current daemonHint template ends with a single trailing `]`.
    out = out.replace(/\]\s*$/, '');
    return out;
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
  async function autoNameSession(chatId, sessionId, firstPrompt, cwd) {
    try {
      const namePrompt = `Generate a very short session name (2-5 Chinese characters, no punctuation, no quotes) that captures the essence of this user request:

"${firstPrompt.slice(0, 200)}"

Reply with ONLY the name, nothing else. Examples: 插件开发, API重构, Bug修复, 代码审查`;

      const { output } = await spawnClaudeAsync(
        ['-p', '--model', 'haiku'],
        namePrompt,
        HOME,
        15000 // 15s timeout
      );

      if (output) {
        // Clean up: remove quotes, punctuation, trim
        let name = output.replace(/["""''`]/g, '').replace(/[.,!?:;。，！？：；]/g, '').trim();
        // Limit to reasonable length
        if (name.length > 12) name = name.slice(0, 12);
        if (name.length >= 2) {
          // Write to Claude's session file (unified with /rename on desktop)
          writeSessionName(sessionId, cwd, name);
        }
      }
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
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        ...getActiveProviderEnv(),
        METAME_INTERNAL_PROMPT: '1',
        METAME_PROJECT: metameProject || '',
      };
      delete env.CLAUDECODE;
      const child = spawn(CLAUDE_BIN, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
        }, 5000);
      }, timeoutMs);

      child.stdout.on('data', (data) => { stdout += data.toString(); });
      child.stderr.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({ output: null, error: 'Timeout: Claude took too long' });
        } else if (code !== 0) {
          resolve({ output: null, error: stderr || `Exit code ${code}` });
        } else {
          resolve({ output: stdout.trim(), error: null });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ output: null, error: formatEngineSpawnError(err, { name: getDefaultEngine() }) });
      });

      // Write input and close stdin
      child.stdin.write(input);
      child.stdin.end();
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
    runtime = null,
    onSession = null,
  ) {
    return new Promise((resolve) => {
      let settled = false;
      const finalize = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      const rt = runtime || getEngineRuntime(getDefaultEngine());
      const streamArgs = rt.name === 'claude'
        ? [...args, '--output-format', 'stream-json', '--verbose']
        : args;
      const _spawnAt = Date.now();
      const child = spawn(rt.binary, streamArgs, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env: rt.buildEnv({ metameProject }),
      });
      log('INFO', `[TIMING:${chatId}] spawned ${rt.name} pid=${child.pid}`);

      if (chatId) {
        activeProcesses.set(chatId, {
          child,
          aborted: false,
          startedAt: _spawnAt,
          engine: rt.name,
          killSignal: rt.killSignal || 'SIGTERM',
        });
        saveActivePids();
      }

      let buffer = '';
      let stderr = '';
      let killed = false;
      let killedReason = 'idle';
      let finalResult = '';
      let finalUsage = null;
      let observedSessionId = '';
      let _firstOutputLogged = false;
      let classifiedError = null;
      let lastStatusTime = 0;
      const STATUS_THROTTLE = statusThrottleMs;
      // Streaming card: accumulate text and push to card in real-time (throttled)
      let _streamText = '';
      let _lastStreamFlush = 0;
      const STREAM_THROTTLE = 1500; // ms between card edits (safe within Feishu 5 req/s limit)
      function flushStream(force) {
        if (!onStatus || !_streamText.trim()) return;
        const now = Date.now();
        if (!force && now - _lastStreamFlush < STREAM_THROTTLE) return;
        _lastStreamFlush = now;
        onStatus('__STREAM_TEXT__' + _streamText).catch(() => {});
      }
      const writtenFiles = [];
      const toolUsageLog = [];

      const engineTimeouts = rt.timeouts || {};
      const IDLE_TIMEOUT_MS = engineTimeouts.idleMs || (5 * 60 * 1000);
      const TOOL_EXEC_TIMEOUT_MS = engineTimeouts.toolMs || (25 * 60 * 1000);
      const HARD_CEILING_MS = engineTimeouts.ceilingMs || (60 * 60 * 1000);
      const startTime = Date.now();
      let waitingForTool = false;

      let sigkillTimer = null;
      function killChild(reason) {
        if (killed) return;
        killed = true;
        killedReason = reason;
        log('WARN', `[${rt.name}] ${reason} timeout for chatId ${chatId} — killing process group`);
        const sig = rt.killSignal || 'SIGTERM';
        try { process.kill(-child.pid, sig); } catch { child.kill(sig); }
        sigkillTimer = setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
        }, 5000);
      }

      let idleTimer = setTimeout(() => killChild('idle'), IDLE_TIMEOUT_MS);
      const ceilingTimer = setTimeout(() => killChild('ceiling'), HARD_CEILING_MS);

      function resetIdleTimer() {
        clearTimeout(idleTimer);
        const timeout = waitingForTool ? TOOL_EXEC_TIMEOUT_MS : IDLE_TIMEOUT_MS;
        idleTimer = setTimeout(() => killChild('idle'), timeout);
      }

      let toolCallCount = 0;
      let lastMilestoneMin = 0;
      const milestoneTimer = setInterval(() => {
        if (killed) return;
        const elapsedMin = Math.floor((Date.now() - startTime) / 60000);
        const nextMin = lastMilestoneMin === 0 ? 2 : lastMilestoneMin + 5;
        if (elapsedMin >= nextMin) {
          lastMilestoneMin = elapsedMin;
          const parts = [`⏳ 已运行 ${elapsedMin} 分钟`];
          if (toolCallCount > 0) parts.push(`调用 ${toolCallCount} 次工具`);
          if (writtenFiles.length > 0) parts.push(`修改 ${writtenFiles.length} 个文件`);
          const recentTool = toolUsageLog.length > 0 ? toolUsageLog[toolUsageLog.length - 1] : null;
          if (recentTool) {
            const ctx = recentTool.context || recentTool.skill || '';
            parts.push(`最近: ${recentTool.tool}${ctx ? ' ' + ctx : ''}`);
          }
          if (onStatus) {
            const milestoneMsg = parts.join(' | ');
            const msg = _streamText ? `__TOOL_OVERLAY__${_streamText}\n\n> ${milestoneMsg}` : milestoneMsg;
            onStatus(msg).catch(() => {});
          }
        }
      }, 30000);

      function parseEventsFromLine(line) {
        try {
          return rt.parseStreamEvent(line) || [];
        } catch {
          return [];
        }
      }

      child.stdout.on('data', (data) => {
        resetIdleTimer();
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          if (!_firstOutputLogged) {
            _firstOutputLogged = true;
            log('INFO', `[TIMING:${chatId}] first-line +${Date.now() - _spawnAt}ms`);
          }
          const events = parseEventsFromLine(line);
          for (const event of events) {
            if (!event || !event.type) continue;
            if (event.type === 'session' && event.sessionId) {
              observedSessionId = String(event.sessionId);
              if (typeof onSession === 'function') {
                Promise.resolve(onSession(observedSessionId)).catch(() => { });
              }
              continue;
            }
            if (event.type === 'error') {
              classifiedError = event;
              continue;
            }
            if (event.type === 'text' && event.text) {
              finalResult += (finalResult ? '\n\n' : '') + String(event.text);
              _streamText = finalResult;
              if (waitingForTool) {
                waitingForTool = false;
                resetIdleTimer();
              }
              flushStream(); // throttled stream to card
              continue;
            }
            if (event.type === 'done') {
              finalUsage = event.usage || null;
              if (waitingForTool) {
                waitingForTool = false;
                resetIdleTimer();
              }
              // Fallback: if no text streamed yet (tool-only response), use result text from done.
              // Do NOT use when finalResult already has content — result duplicates streamed text.
              if (!finalResult && event.result) {
                finalResult = String(event.result);
                _streamText = finalResult;
              }
              flushStream(true); // force final text flush before process ends
              continue;
            }
            if (event.type === 'tool_result') {
              if (waitingForTool) {
                waitingForTool = false;
                resetIdleTimer();
              }
              continue;
            }
            if (event.type !== 'tool_use') continue;

            toolCallCount++;
            waitingForTool = true;
            resetIdleTimer();
            const toolName = event.toolName || 'Tool';
            const toolInput = event.toolInput || {};

            const toolEntry = { tool: toolName };
            if (toolName === 'Skill' && toolInput.skill) toolEntry.skill = toolInput.skill;
            else if (toolInput.command) toolEntry.context = String(toolInput.command).slice(0, 50);
            else if (toolInput.file_path) toolEntry.context = path.basename(String(toolInput.file_path));
            if (toolUsageLog.length < 50) toolUsageLog.push(toolEntry);

            if (toolName === 'Write' && toolInput.file_path) {
              const filePath = String(toolInput.file_path);
              if (!writtenFiles.includes(filePath)) writtenFiles.push(filePath);
            }

            const now = Date.now();
            if (now - lastStatusTime < STATUS_THROTTLE) continue;
            lastStatusTime = now;

            const emoji = TOOL_EMOJI[toolName] || TOOL_EMOJI.default;
            let displayName = toolName;
            let displayEmoji = emoji;
            let context = '';

            if (toolName === 'Skill' && toolInput.skill) {
              context = toolInput.skill;
            } else if ((toolName === 'Task' || toolName === 'Agent') && toolInput.description) {
              const agentType = toolInput.subagent_type ? `[${toolInput.subagent_type}] ` : '';
              context = (agentType + String(toolInput.description)).slice(0, 40);
            } else if (toolName.startsWith('mcp__')) {
              const parts = toolName.split('__');
              const server = parts[1] || 'unknown';
              const action = parts.slice(2).join('_') || '';
              if (server === 'playwright') {
                displayEmoji = '🌐';
                displayName = 'Browser';
                context = action.replace(/_/g, ' ');
              } else {
                displayEmoji = '🔗';
                displayName = `MCP:${server}`;
                context = action.replace(/_/g, ' ').slice(0, 25);
              }
            } else if (toolInput.file_path) {
              const basename = path.basename(String(toolInput.file_path));
              const dotIdx = basename.lastIndexOf('.');
              context = dotIdx > 0 ? basename.slice(0, dotIdx) + '\u200B' + basename.slice(dotIdx) : basename;
            } else if (toolInput.command) {
              context = String(toolInput.command).slice(0, 30);
              if (String(toolInput.command).length > 30) context += '...';
            } else if (toolInput.pattern) {
              context = String(toolInput.pattern).slice(0, 20);
            } else if (toolInput.query) {
              context = String(toolInput.query).slice(0, 25);
            } else if (toolInput.url) {
              try { context = new URL(toolInput.url).hostname; } catch { context = 'web'; }
            }

            const status = context
              ? `${displayEmoji} ${displayName}: 「${context}」`
              : `${displayEmoji} ${displayName}...`;
            if (onStatus) {
              // Overlay tool status on top of streamed text (if any); else show plain status
              const msg = _streamText ? `__TOOL_OVERLAY__${_streamText}\n\n> ${status}` : status;
              onStatus(msg).catch(() => {});
            }
          }
        }
      });

      child.stderr.on('data', (data) => {
        resetIdleTimer();
        const chunk = data.toString();
        stderr += chunk;
        if (!classifiedError && typeof rt.classifyError === 'function') {
          classifiedError = rt.classifyError(chunk);
        }
      });

      child.on('close', (code) => {
        log('INFO', `[TIMING:${chatId}] process-close code=${code} total=${Date.now() - _spawnAt}ms`);
        clearTimeout(idleTimer);
        clearTimeout(ceilingTimer);
        clearTimeout(sigkillTimer);
        clearInterval(milestoneTimer);

        if (buffer.trim()) {
          const events = parseEventsFromLine(buffer.trim());
          for (const event of events) {
            if (event.type === 'text' && event.text) finalResult = String(event.text);
            if (event.type === 'done') finalUsage = event.usage || null;
            if (event.type === 'session' && event.sessionId) observedSessionId = String(event.sessionId);
            if (event.type === 'error') classifiedError = event;
          }
        }

        const proc = chatId ? activeProcesses.get(chatId) : null;
        const wasAborted = proc && proc.aborted;
        if (chatId) { activeProcesses.delete(chatId); saveActivePids(); }

        if (wasAborted) {
          finalize({ output: finalResult || null, error: 'Stopped by user', files: writtenFiles, toolUsageLog, usage: finalUsage, sessionId: observedSessionId || '' });
          return;
        }
        if (killed) {
          const elapsed = Math.round((Date.now() - startTime) / 60000);
          const idleMin = Math.max(1, Math.round(IDLE_TIMEOUT_MS / 60000));
          const reason = killedReason === 'ceiling'
            ? `⏱ 已运行 ${elapsed} 分钟，达到上限（${Math.round(HARD_CEILING_MS / 60000)} 分钟）`
            : `⏱ 已 ${idleMin} 分钟无输出，判定卡死（共运行 ${elapsed} 分钟）`;
          finalize({ output: finalResult || null, error: reason, timedOut: true, files: writtenFiles, toolUsageLog, usage: finalUsage, sessionId: observedSessionId || '' });
          return;
        }
        if (code !== 0) {
          const engineErr = classifiedError && classifiedError.message
            ? classifiedError.message
            : (stderr || `Exit code ${code}`);
          finalize({ output: finalResult || null, error: engineErr, errorCode: classifiedError ? classifiedError.code : undefined, files: writtenFiles, toolUsageLog, usage: finalUsage, sessionId: observedSessionId || '' });
          return;
        }
        finalize({ output: finalResult || '', error: null, files: writtenFiles, toolUsageLog, usage: finalUsage, sessionId: observedSessionId || '' });
      });

      child.on('error', (err) => {
        clearTimeout(idleTimer);
        clearTimeout(ceilingTimer);
        clearTimeout(sigkillTimer);
        clearInterval(milestoneTimer);
        if (chatId) { activeProcesses.delete(chatId); saveActivePids(); }
        finalize({ output: null, error: formatEngineSpawnError(err, rt), files: [], toolUsageLog: [], usage: null, sessionId: '' });
      });

      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (e) {
        clearTimeout(idleTimer);
        clearTimeout(ceilingTimer);
        clearTimeout(sigkillTimer);
        clearInterval(milestoneTimer);
        if (chatId) { activeProcesses.delete(chatId); saveActivePids(); }
        try { child.stdin.destroy(); } catch { /* ignore */ }
        try {
          const sig = rt.killSignal || 'SIGTERM';
          process.kill(-child.pid, sig);
        } catch {
          try { child.kill(rt.killSignal || 'SIGTERM'); } catch { /* ignore */ }
        }
        finalize({ output: null, error: e.message, files: [], toolUsageLog: [], usage: null, sessionId: '' });
      }
    });
  }

  // Track outbound message_id → session for reply-based session restoration.
  // Keeps last 200 entries to avoid unbounded growth.
  function trackMsgSession(messageId, session, agentKey) {
    if (!messageId || !session || !session.id) return;
    const st = loadState();
    if (!st.msg_sessions) st.msg_sessions = {};
    st.msg_sessions[messageId] = { id: session.id, cwd: session.cwd, engine: session.engine || getDefaultEngine(), agentKey: agentKey || null };
    const keys = Object.keys(st.msg_sessions);
    if (keys.length > 200) {
      for (const k of keys.slice(0, keys.length - 200)) delete st.msg_sessions[k];
    }
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

  async function askClaude(bot, chatId, prompt, config, readOnly = false) {
    const _t0 = Date.now();
    log('INFO', `askClaude for ${chatId}: ${prompt.slice(0, 50)}`);
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
    const _ackAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map || {} : {}), ...(config.feishu ? config.feishu.chat_agent_map || {} : {}) };
    const _ackBoundKey = _ackAgentMap[_ackChatIdStr] || projectKeyFromVirtualChatId(_ackChatIdStr);
    const _ackBoundProj = _ackBoundKey && config.projects ? config.projects[_ackBoundKey] : null;
    // _ackCardHeader: non-null for agents with icon/name (team members, dispatch); passed to editMessage to preserve header on streaming edits
    const _ackCardHeader = (_ackBoundProj && _ackBoundProj.icon && _ackBoundProj.name)
      ? { title: `${_ackBoundProj.icon} ${_ackBoundProj.name}`, color: _ackBoundProj.color || 'blue' }
      : null;
    // Fire-and-forget: don't await Telegram RTT before spawning the engine process.
    // statusMsgId will be populated well before the first model output (~5s for codex).
    // For branded agents: send a card with header so streaming edits preserve the agent identity.
    const _ackFn = (_ackCardHeader && bot.sendCard)
      ? () => bot.sendCard(chatId, { title: _ackCardHeader.title, body: '🤔', color: _ackCardHeader.color })
      : () => (bot.sendMarkdown ? bot.sendMarkdown(chatId, '🤔') : bot.sendMessage(chatId, '🤔'));
    _ackFn()
      .then(msg => { if (msg && msg.message_id) statusMsgId = msg.message_id; })
      .catch(e => log('ERROR', `Failed to send ack to ${chatId}: ${e.message}`));
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
    const _strictAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const _isStrictChatSession = !!(_strictAgentMap[String(chatId)] || projectKeyFromVirtualChatId(String(chatId)));
    const agentMatch = _isStrictChatSession ? null : routeAgent(prompt, config);
    if (agentMatch) {
      const { key, proj, rest } = agentMatch;
      const projCwd = normalizeCwd(proj.cwd);
      attachOrCreateSession(chatId, projCwd, proj.name || key, proj.engine ? normalizeEngineName(proj.engine) : getDefaultEngine());
      log('INFO', `Agent switch via nickname: ${key} (${projCwd})`);
      if (!rest) {
        // Pure nickname call — confirm switch and stop
        clearInterval(typingTimer);
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
    const chatAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const boundProjectKey = chatAgentMap[chatIdStr] || projectKeyFromVirtualChatId(chatIdStr);
    const boundProject = boundProjectKey && config.projects ? config.projects[boundProjectKey] : null;
    // Each virtual chatId (including clones) keeps its own isolated session.
    // Parallel tasks must not share JSONL files — concurrent writes cause corruption.
    const sessionChatId = boundProjectKey ? `_agent_${boundProjectKey}` : chatId;
    const sessionRaw = getSession(sessionChatId);
    const boundCwd = (boundProject && boundProject.cwd) ? normalizeCwd(boundProject.cwd) : null;
    const boundEngineName = (boundProject && boundProject.engine) ? normalizeEngineName(boundProject.engine) : getDefaultEngine();

    // Engine is determined from config only — bound agent config wins, then global default.
    const engineName = normalizeEngineName(
      (boundProject && boundProject.engine) || getDefaultEngine()
    );
    const runtime = getEngineRuntime(engineName);

    // hasActiveSession: does the current engine have an ongoing conversation?
    const hasActiveSession = sessionRaw && (
      sessionRaw.engines ? !!(sessionRaw.engines[engineName]?.started) : !!sessionRaw.started
    );
    const skill = (agentMatch || hasActiveSession) ? null : routeSkill(prompt);

    if (!sessionRaw) {
      // No saved state for this chatId: start a fresh session.
      // Note: daemon_state.json persists across restarts, so this only happens on truly first use
      // or after an explicit /new command.
      createSession(sessionChatId, boundCwd || undefined, boundProject && boundProject.name ? boundProject.name : '', boundEngineName);
    }

    // Resolve flat view for current engine (id + started are engine-specific; cwd is shared)
    let session = getSessionForEngine(sessionChatId, engineName) || { cwd: boundCwd || HOME, engine: engineName, id: null, started: false };
    session.engine = engineName; // keep local copy for Codex resume detection below

    // Pre-spawn session validation: unified for all engines.
    // Claude checks JSONL file existence; Codex checks SQLite. Same interface, different backend.
    // Skip warning for virtual agents (team members) - they may use worktrees with fresh sessions
    const isVirtualAgent = String(sessionChatId).startsWith('_agent_');
    if (session.started && session.id && session.id !== '__continue__' && session.cwd) {
      const valid = isEngineSessionValid(engineName, session.id, session.cwd);
      if (!valid) {
        log('WARN', `${engineName} session ${session.id.slice(0, 8)} invalid for ${sessionChatId}; starting fresh ${engineName} session`);
        if (!isVirtualAgent) {
          await bot.sendMessage(chatId, '⚠️ 上次 session 已失效，已自动开启新 session。').catch(() => {});
        }
        session = createSession(sessionChatId, session.cwd, boundProject && boundProject.name ? boundProject.name : '', engineName);
      }
    }

    const daemonCfg = (config && config.daemon) || {};
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
    const model = resolveEngineModel(runtime.name, daemonCfg, boundProject && boundProject.model);
    const args = runtime.buildArgs({
      model,
      readOnly,
      daemonCfg,
      session,
      cwd: session.cwd,
    });

    // Codex: write/refresh AGENTS.md = CLAUDE.md + SOUL.md on every new session.
    // Written as a real file (not a symlink) for Windows compatibility.
    // Refreshed each session so edits to CLAUDE.md or SOUL.md are always picked up.
    // Codex auto-loads AGENTS.md from cwd and all parent dirs up to ~.
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

    let agentHint = '';
    if (!session.started && (boundProject || (session && session.cwd))) {
      try {
        // Engine-aware: Codex gets memory only (soul is already in AGENTS.md);
        // Claude gets soul + memory (SOUL.md is not auto-loaded by Claude).
        agentHint = buildAgentContextForEngine(
          boundProject || { cwd: session.cwd },
          engineName,
          HOME,
        ).hint || '';
      } catch (e) {
        log('WARN', `Agent context injection failed: ${e.message}`);
      }
    }

    // Memory & Knowledge Injection (RAG)
    let memoryHint = '';
    // projectKey must be declared outside the try block so the daemonHint template below can reference it.
    const _cid0 = String(chatId);
    const _agentMap0 = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const projectKey = _agentMap0[_cid0] || projectKeyFromVirtualChatId(_cid0);
    try {
      const memory = require('./memory');

      // L1: NOW.md per-agent whiteboard injection（按 projectKey 隔离，防并发冲突）
      if (!session.started) {
        try {
          const nowDir = path.join(HOME, '.metame', 'memory', 'now');
          const nowKey = projectKey || 'default';
          const nowPath = path.join(nowDir, `${nowKey}.md`);
          if (fs.existsSync(nowPath)) {
            const nowContent = fs.readFileSync(nowPath, 'utf8').trim();
            if (nowContent) {
              memoryHint += `\n\n[Current task context:\n${nowContent}]`;
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
          const factItems = facts.map(f => `- [${f.relation}] ${f.value}`).join('\n');
          memoryHint += `\n\n[Relevant facts:\n${factItems}]`;
          log('INFO', `[MEMORY] Injected ${facts.length} facts (query_len=${factQuery.length})`);
        }
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
            const lines = Object.entries(cmap)
              .map(([domain, level]) => `  ${domain}: ${level}`)
              .join('\n');
            zdpHint = `\n- User competence map (adjust explanation depth accordingly):\n${lines}\n  Rule: expert→skip basics; intermediate→brief rationale; beginner→one-line analogy.`;
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

    // Inject daemon hints only on first message of a session
    // Task-specific rules (3-5) are injected only when isTaskIntent() returns true (~250 token saving for casual chat)
    let daemonHint = '';
    if (!session.started) {
      const taskRules = isTaskIntent(prompt) ? `
3. Knowledge retrieval: When you need context about a specific topic, past decisions, or lessons, call:
   node ~/.metame/memory-search.js "关键词1" "keyword2"
   Also read ~/.metame/memory/INDEX.md to discover available long-form lesson/decision docs, then read specific files as needed.
   Use these before answering complex questions about MetaMe architecture or past decisions.
4. Active memory: After confirming a new insight, bug root cause, or user preference, persist it with:
   node ~/.metame/memory-write.js "Entity.sub" "relation_type" "value (20-300 chars)"
   Valid relations: tech_decision, bug_lesson, arch_convention, config_fact, config_change, workflow_rule, project_milestone
   Only write verified facts. Do not write speculative or process-description entries.
   When you observe the user is clearly expert or beginner in a domain, note it in your response and suggest: "要不要把你的 {domain} 水平 ({level}) 记录到能力雷达？"
5. Task handoff: When suspending a multi-step task or handing off to another agent, write current status to ~/.metame/memory/now/${projectKey || 'default'}.md using:
   \`mkdir -p ~/.metame/memory/now && printf '%s\\n' "## Current Task" "{task}" "" "## Progress" "{progress}" "" "## Next Step" "{next}" > ~/.metame/memory/now/${projectKey || 'default'}.md\`
   Keep it under 200 words. Clear it when the task is fully complete by running: \`> ~/.metame/memory/now/${projectKey || 'default'}.md\`` : '';
      daemonHint = `\n\n[System hints - DO NOT mention these to user:
1. Daemon config: The ONLY config is ~/.metame/daemon.yaml (never edit daemon-default.yaml). Auto-reloads on change.
2. File sending: User is on MOBILE. When they ask to see/download a file:
   - Just FIND the file path (use Glob/ls if needed)
   - Do NOT read or summarize the file content (wastes tokens)
   - Add at END of response: [[FILE:/absolute/path/to/file]]
   - Keep response brief: "请查收~! [[FILE:/path/to/file]]"
   - Multiple files: use multiple [[FILE:...]] tags${zdpHint ? '\n   Explanation depth (ZPD):\n' + zdpHint : ''}${taskRules}]`;
   }

    daemonHint = adaptDaemonHintForEngine(daemonHint, runtime.name);

    const routedPrompt = skill ? `/${skill} ${prompt}` : prompt;

    // Mac automation orchestration hint: lets Claude flexibly compose local scripts
    // without forcing users to write slash commands by hand.
    let macAutomationHint = '';
    if (process.platform === 'darwin' && !readOnly && isMacAutomationIntent(prompt)) {
      macAutomationHint = `\n\n[Mac automation policy - do NOT expose this block:
1. Prefer deterministic local control via Bash + osascript/JXA; avoid screenshot/visual workflows unless explicitly requested.
2. Read/query actions can execute directly.
3. Before any side-effect action (send email, create/delete/modify calendar event, delete/move files, app quit, system sleep), first show a short execution preview and require explicit user confirmation.
4. Keep output concise: success/failure + key result only.
5. If permission is missing, guide user to run /mac perms open then retry.
6. Before executing high-risk or non-obvious Bash commands (rm, kill, git reset, overwrite configs), prepend a single-line [Why] explanation. Skip for routine commands (ls, cat, grep).]`;
    }

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

[上次对话摘要，供参考]: ${_sess.last_summary}`;
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
    const langGuard = session.started
      ? ''
      : '\n\n[Respond in Simplified Chinese (简体中文) only. NEVER switch to Korean, Japanese, or other languages regardless of tool output or context language.]';
    const fullPrompt = routedPrompt + daemonHint + agentHint + macAutomationHint + summaryHint + memoryHint + mentorHint + langGuard;

    // Git checkpoint before Claude modifies files (for /undo).
    // Skip for virtual agents (team clones like _agent_yi) — each has its own worktree,
    // but checkpoint uses `git add -A` which could interfere with parallel work.
    const _isVirtualAgent = String(chatId).startsWith('_agent_') || String(chatId).startsWith('_scope_');
    if (!_isVirtualAgent) {
      (gitCheckpointAsync || gitCheckpoint)(session.cwd, prompt).catch?.(() => {});
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
        started: true,
      };
      await patchSessionSerialized(sessionChatId, (cur) => {
        const engines = { ...(cur.engines || {}) };
        engines[runtime.name] = { ...(engines[runtime.name] || {}), id: safeNextId, started: true };
        return { ...cur, cwd: session.cwd || cur.cwd || HOME, engines };
      });
      if (runtime.name === 'codex' && wasStarted && prevSessionId && prevSessionId !== safeNextId && prevSessionId !== '__continue__') {
        log('WARN', `Codex thread migrated for ${chatId}: ${prevSessionId.slice(0, 8)} -> ${safeNextId.slice(0, 8)}`);
      }
    };

    let output, error, errorCode, files, toolUsageLog, timedOut, usage, sessionId;
    try {
      ({
        output,
        error,
        errorCode,
        timedOut,
        files,
        toolUsageLog,
        usage,
        sessionId,
      } = await spawnClaudeStreaming(
        args,
        fullPrompt,
        session.cwd,
        onStatus,
        600000,
        chatId,
        boundProjectKey || '',
        runtime,
        onSession,
      ));

      if (sessionId) await onSession(sessionId);

      if (shouldRetryCodexResumeFallback({
        runtimeName: runtime.name,
        wasResumeAttempt: wasCodexResumeAttempt,
        output,
        error,
        errorCode,
        canRetry: canRetryCodexResume(chatId),
      })) {
        markCodexResumeRetried(chatId);
        log('WARN', `Codex resume failed for ${chatId}, retrying once with fresh exec: ${String(error).slice(0, 120)}`);
        // Notify user explicitly — silent context loss is worse than a visible warning.
        await bot.sendMessage(chatId, '⚠️ Codex session 已过期，上下文丢失。正在以全新 session 重试，请在回复后补充必要背景。').catch(() => {});
        session = createSession(
          sessionChatId,
          session.cwd,
          boundProject && boundProject.name ? boundProject.name : '',
          'codex'
        );
        const retryArgs = runtime.buildArgs({
          model,
          readOnly,
          daemonCfg,
          session,
          cwd: session.cwd,
        });
        // Prepend a context-loss marker so Codex knows this is a fresh session mid-conversation.
        const retryPrompt = `[Note: previous Codex session expired and could not be resumed. Treating this as a new session. User message follows:]\n\n${fullPrompt}`;
        ({
          output,
          error,
          errorCode,
          timedOut,
          files,
          toolUsageLog,
          usage,
          sessionId,
        } = await spawnClaudeStreaming(
          retryArgs,
          retryPrompt,
          session.cwd,
          onStatus,
          600000,
          chatId,
          boundProjectKey || '',
          runtime,
          onSession,
        ));
        if (sessionId) await onSession(sessionId);
      }
    } catch (spawnErr) {
      clearInterval(typingTimer);
      if (statusMsgId && bot.deleteMessage) bot.deleteMessage(chatId, statusMsgId).catch(() => { });
      log('ERROR', `spawnClaudeStreaming crashed for ${chatId}: ${spawnErr.message}`);
      await bot.sendMessage(chatId, `❌ 内部错误: ${spawnErr.message}`).catch(() => { });
      return { ok: false, error: spawnErr.message };
    }
    clearInterval(typingTimer);

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

    if (output) {
      if (runtime.name === 'codex') _codexResumeRetryTs.delete(String(chatId));
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
      if (wasNew) markSessionStarted(sessionChatId, engineName);

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
        log('DEBUG', `[REPLY:${chatId}] statusMsgId=${statusMsgId} editFailed=${editFailed} activeProject=${activeProject && activeProject.name} lastCard=${_lastStatusCardContent ? _lastStatusCardContent.slice(0,40) : 'null'}`);

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
            replyMsg = await bot.sendCard(chatId, {
              title: `${activeProject.icon || '🤖'} ${activeProject.name || ''}`,
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
      if (replyMsg && replyMsg.message_id && session) trackMsgSession(replyMsg.message_id, session, String(chatId).startsWith('_agent_') ? String(chatId).slice(7) : null);

      await sendFileButtons(bot, chatId, mergeFileCollections(markedFiles, files));

      // Timeout: also send the reason after the partial result
      if (timedOut && error) {
        try { await bot.sendMessage(chatId, error); } catch { /* */ }
      }

      // Auto-name: if this was the first message and session has no name, generate one
      if (runtime.name === 'claude' && wasNew && !getSessionName(session.id)) {
        autoNameSession(chatId, session.id, prompt, session.cwd).catch(() => { });
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

      // If session not found (expired/deleted), create new and retry once (Claude path)
      if (runtime.name === 'claude' && (errMsg.includes('not found') || errMsg.includes('No session') || errMsg.includes('already in use'))) {
        log('WARN', `Session ${session.id} unusable (${errMsg.includes('already in use') ? 'locked' : 'not found'}), creating new`);
        session = createSession(sessionChatId, session.cwd, '', runtime.name);

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
          runtime,
          onSession,
        );
        if (retry.sessionId) await onSession(retry.sessionId);
        if (retry.output) {
          markSessionStarted(sessionChatId, runtime.name);
          const { markedFiles: retryMarked, cleanOutput: retryClean } = parseFileMarkers(retry.output);
          await bot.sendMarkdown(chatId, retryClean);
          await sendFileButtons(bot, chatId, mergeFileCollections(retryMarked, retry.files));
          return { ok: true };
        } else {
          log('ERROR', `askClaude retry failed: ${(retry.error || '').slice(0, 200)}`);
          try { await bot.sendMessage(chatId, userErrMsg); } catch { /* */ }
          return { ok: false, error: retry.error || errMsg };
        }
      } else {
        // Auto-fallback: if custom provider/model fails, revert to anthropic + opus (Claude path only)
        if (runtime.name === 'claude') {
          const activeProv = providerMod ? providerMod.getActiveName() : 'anthropic';
          const builtinModels = ENGINE_MODEL_CONFIG.claude.options;
          if (activeProv !== 'anthropic' || !builtinModels.includes(model)) {
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
      formatEngineSpawnError,
      adaptDaemonHintForEngine,
      canRetryCodexResume,
      markCodexResumeRetried,
      CODEX_RESUME_RETRY_WINDOW_MS,
    },
  };
}

module.exports = { createClaudeEngine };
