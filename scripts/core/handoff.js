'use strict';

function resolveNodeEntry(fs, path, cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    const match = content.match(/"([^"]+\.js)"\s*%\*\s*$/m);
    if (!match) return null;
    const entry = match[1].replace(/%dp0%/gi, path.dirname(cmdPath) + path.sep);
    return fs.existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

function createPlatformSpawn(deps) {
  const {
    fs,
    path,
    spawn,
    execSync,
    processPlatform = process.platform,
    processExecPath = process.execPath,
    claudeBin = '',
  } = deps;

  const nodeEntryCache = new Map();

  function resolveNodeEntryForCmd(cmd) {
    if (nodeEntryCache.has(cmd)) return nodeEntryCache.get(cmd);
    let cmdPath = cmd;
    const lowerCmd = String(cmd || '').toLowerCase();
    if (lowerCmd === 'claude' || lowerCmd === 'codex') {
      try {
        const lines = execSync(`where ${cmd}`, { encoding: 'utf8', timeout: 3000 })
          .split('\n').map((line) => line.trim()).filter(Boolean);
        cmdPath = lines.find((line) => line.toLowerCase().endsWith(`${lowerCmd}.cmd`)) || lines[0] || cmd;
      } catch { /* ignore */ }
    }
    const entry = resolveNodeEntry(fs, path, cmdPath);
    nodeEntryCache.set(cmd, entry);
    return entry;
  }

  function platformSpawn(cmd, args, options) {
    if (processPlatform !== 'win32') return spawn(cmd, args, options);

    const lowerCmd = String(cmd || '').toLowerCase();
    const isCmdLike = lowerCmd.endsWith('.cmd') || lowerCmd.endsWith('.bat')
      || cmd === claudeBin || lowerCmd === 'claude' || lowerCmd === 'codex';

    if (isCmdLike) {
      const entry = resolveNodeEntryForCmd(cmd);
      if (entry) {
        return spawn(processExecPath, [entry, ...args], { ...options, windowsHide: true });
      }
      return spawn(cmd, args, { ...options, shell: process.env.COMSPEC || true, windowsHide: true });
    }

    return spawn(cmd, args, { ...options, windowsHide: true });
  }

  return {
    spawn: platformSpawn,
    resolveNodeEntryForCmd,
  };
}

function terminateChildProcess(child, signal = 'SIGTERM', opts = {}) {
  if (!child) return false;
  const useProcessGroup = opts.useProcessGroup !== false;
  if (useProcessGroup) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch { /* fall through */ }
  }
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function escalateKill(child, signal = 'SIGTERM', forceDelayMs = 5000, opts = {}) {
  const signaled = terminateChildProcess(child, signal, opts);
  const timer = setTimeout(() => {
    terminateChildProcess(child, 'SIGKILL', opts);
  }, forceDelayMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { signaled, timer };
}

function resetReusableChildListeners(child) {
  if (!child) return child;
  if (child.stdout && typeof child.stdout.removeAllListeners === 'function') {
    child.stdout.removeAllListeners('data');
  }
  if (child.stderr && typeof child.stderr.removeAllListeners === 'function') {
    child.stderr.removeAllListeners('data');
  }
  if (child.stdin && typeof child.stdin.removeAllListeners === 'function') {
    child.stdin.removeAllListeners('error');
  }
  if (typeof child.removeAllListeners === 'function') {
    child.removeAllListeners('close');
    child.removeAllListeners('error');
  }
  return child;
}

function destroyChildStdin(child) {
  if (!child || !child.stdin || typeof child.stdin.destroy !== 'function') return false;
  try {
    child.stdin.destroy();
    return true;
  } catch {
    return false;
  }
}

function stopStreamingLifecycle(watchdog, milestoneTimer) {
  if (watchdog && typeof watchdog.stop === 'function') watchdog.stop();
  clearInterval(milestoneTimer);
}

function abortStreamingChildLifecycle(opts) {
  const {
    child,
    watchdog,
    milestoneTimer,
    activeProcesses,
    saveActivePids,
    chatId,
    reason = 'stdin',
  } = opts;

  clearInterval(milestoneTimer);
  destroyChildStdin(child);
  clearActiveChildProcess(activeProcesses, saveActivePids, chatId);
  if (watchdog && typeof watchdog.abort === 'function') watchdog.abort(reason);
}

function setActiveChildProcess(activeProcesses, saveActivePids, chatId, entry) {
  if (!chatId || !activeProcesses || typeof activeProcesses.set !== 'function') return false;
  activeProcesses.set(chatId, entry);
  if (typeof saveActivePids === 'function') saveActivePids();
  return true;
}

function clearActiveChildProcess(activeProcesses, saveActivePids, chatId) {
  if (!chatId || !activeProcesses || typeof activeProcesses.delete !== 'function') return false;
  activeProcesses.delete(chatId);
  if (typeof saveActivePids === 'function') saveActivePids();
  return true;
}

function acquireStreamingChild(opts) {
  const {
    warmChild = null,
    spawn,
    binary,
    args,
    cwd,
    env,
    useDetached = true,
  } = opts;

  if (warmChild) {
    return {
      child: resetReusableChildListeners(warmChild),
      reused: true,
    };
  }

  return {
    child: spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: useDetached,
      env,
    }),
    reused: false,
  };
}

function buildStreamingResult(base, overrides = {}) {
  return {
    output: base.output,
    error: base.error,
    files: Array.isArray(base.files) ? base.files : [],
    toolUsageLog: Array.isArray(base.toolUsageLog) ? base.toolUsageLog : [],
    usage: base.usage || null,
    sessionId: base.sessionId || '',
    ...overrides,
  };
}

function resolveStreamingClosePayload(opts) {
  const {
    code,
    streamState: { finalResult, finalUsage, observedSessionId, writtenFiles, toolUsageLog } = {},
    wasAborted = false,
    abortReason = '',
    stdinFailureError = null,
    watchdog,
    timeoutConfig: { startTime, idleTimeoutMs, toolTimeoutMs, hardCeilingMs, formatTimeoutWindowLabel } = {},
    classifiedError,
    stderr = '',
  } = opts;

  const base = {
    output: finalResult || null,
    error: null,
    files: writtenFiles,
    toolUsageLog,
    usage: finalUsage,
    sessionId: observedSessionId || '',
  };

  if (wasAborted) {
    const errorCode = (abortReason === 'daemon-restart' || abortReason === 'shutdown')
      ? 'INTERRUPTED_RESTART'
      : abortReason === 'merge-pause'
        ? 'INTERRUPTED_MERGE_PAUSE'
        : 'INTERRUPTED_USER';
    return buildStreamingResult({
      ...base,
      error: abortReason === 'merge-pause' ? 'Paused for merge' : 'Stopped by user',
    }, { errorCode });
  }

  if (stdinFailureError) {
    return buildStreamingResult({
      ...base,
      error: stdinFailureError,
    });
  }

  if (watchdog && typeof watchdog.isKilled === 'function' && watchdog.isKilled()) {
    const elapsed = Math.round((Date.now() - startTime) / 60000);
    const toolWindow = formatTimeoutWindowLabel(toolTimeoutMs, 'tool');
    const idleWindow = formatTimeoutWindowLabel(idleTimeoutMs, 'idle');
    const killedReason = typeof watchdog.getKilledReason === 'function' ? watchdog.getKilledReason() : 'idle';
    const reason = killedReason === 'ceiling'
      ? `⏱ 已运行 ${elapsed} 分钟，达到上限（${Math.round(hardCeilingMs / 60000)} 分钟）`
      : killedReason === 'tool'
        ? `⏱ 工具执行${toolWindow}超时，判定卡死（共运行 ${elapsed} 分钟）`
        : `⏱ 已${idleWindow}无输出，判定卡死（共运行 ${elapsed} 分钟）`;
    return buildStreamingResult({
      ...base,
      error: reason,
    }, { timedOut: true });
  }

  if (code !== 0) {
    return buildStreamingResult({
      ...base,
      error: classifiedError && classifiedError.message
        ? classifiedError.message
        : (stderr || `Exit code ${code}`),
    }, { errorCode: classifiedError ? classifiedError.code : undefined });
  }

  return buildStreamingResult({
    ...base,
    output: finalResult || '',
  });
}

function accumulateStreamingStderr(state, chunk, opts = {}) {
  const {
    classifyError = null,
  } = opts;

  const nextState = {
    stderr: `${state && state.stderr ? state.stderr : ''}${chunk}`,
    classifiedError: state ? state.classifiedError || null : null,
  };

  nextState.isApiError = /\b(400|is not supported|model.*not found|invalid.*model)\b/i.test(chunk);
  if (!nextState.classifiedError && typeof classifyError === 'function') {
    nextState.classifiedError = classifyError(chunk);
  }

  return nextState;
}

function splitStreamingStdoutChunk(buffer, chunk) {
  const nextBuffer = `${buffer || ''}${chunk}`;
  const lines = nextBuffer.split('\n');
  return {
    lines: lines.slice(0, -1),
    buffer: lines[lines.length - 1] || '',
  };
}

function buildStreamFlushPayload(state, opts = {}) {
  const {
    force = false,
    now = Date.now(),
    throttleMs = 1500,
  } = opts;
  const text = state && state.streamText ? String(state.streamText) : '';
  const lastFlushAt = state && state.lastFlushAt ? state.lastFlushAt : 0;

  if (!text.trim()) return { shouldFlush: false, lastFlushAt };
  if (!force && now - lastFlushAt < throttleMs) {
    return { shouldFlush: false, lastFlushAt };
  }
  return {
    shouldFlush: true,
    lastFlushAt: now,
    payload: `__STREAM_TEXT__${text}`,
  };
}

function buildToolOverlayPayload(opts = {}) {
  const {
    toolName = 'Tool',
    toolInput = {},
    streamText = '',
    lastStatusTime = 0,
    now = Date.now(),
    throttleMs = 3000,
    toolEmoji = {},
    pathModule = null,
  } = opts;

  if (now - lastStatusTime < throttleMs) {
    return { shouldEmit: false, lastStatusTime };
  }

  const emoji = toolEmoji[toolName] || toolEmoji.default || '';
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
  } else if (toolInput.file_path && pathModule) {
    const basename = pathModule.basename(String(toolInput.file_path));
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

  return {
    shouldEmit: true,
    lastStatusTime: now,
    payload: streamText ? `__TOOL_OVERLAY__${streamText}\n\n> ${status}` : status,
  };
}

function recordToolUsage(state, opts = {}) {
  const {
    toolName = 'Tool',
    toolInput = {},
    pathModule = null,
    maxEntries = 50,
  } = opts;

  const toolUsageLog = Array.isArray(state && state.toolUsageLog) ? [...state.toolUsageLog] : [];
  const writtenFiles = Array.isArray(state && state.writtenFiles) ? [...state.writtenFiles] : [];

  const toolEntry = { tool: toolName };
  if (toolName === 'Skill' && toolInput.skill) toolEntry.skill = toolInput.skill;
  else if (toolInput.command) toolEntry.context = String(toolInput.command).slice(0, 50);
  else if (toolInput.file_path && pathModule) toolEntry.context = pathModule.basename(String(toolInput.file_path));

  if (toolUsageLog.length < maxEntries) toolUsageLog.push(toolEntry);

  if (toolName === 'Write' && toolInput.file_path) {
    const filePath = String(toolInput.file_path);
    if (!writtenFiles.includes(filePath)) writtenFiles.push(filePath);
  }

  return { toolUsageLog, writtenFiles };
}

function buildMilestoneOverlayPayload(opts = {}) {
  const {
    elapsedMin,
    toolCallCount = 0,
    writtenFiles = [],
    toolUsageLog = [],
    streamText = '',
  } = opts;

  const parts = [`⏳ 已运行 ${elapsedMin} 分钟`];
  if (toolCallCount > 0) parts.push(`调用 ${toolCallCount} 次工具`);
  if (writtenFiles.length > 0) parts.push(`修改 ${writtenFiles.length} 个文件`);

  const recentTool = toolUsageLog.length > 0 ? toolUsageLog[toolUsageLog.length - 1] : null;
  if (recentTool) {
    const ctx = recentTool.context || recentTool.skill || '';
    parts.push(`最近: ${recentTool.tool}${ctx ? ' ' + ctx : ''}`);
  }

  const milestoneMsg = parts.join(' | ');
  return streamText ? `__TOOL_OVERLAY__${streamText}\n\n> ${milestoneMsg}` : milestoneMsg;
}

function finalizePersistentStreamingTurn(opts = {}) {
  const {
    watchdog,
    milestoneTimer,
    activeProcesses,
    saveActivePids,
    chatId,
    warmPool = null,
    warmSessionKey = '',
    child = null,
    observedSessionId = '',
    cwd = '',
    output = '',
    files = [],
    toolUsageLog = [],
    usage = null,
  } = opts;

  if (watchdog && typeof watchdog.stop === 'function') watchdog.stop();
  clearInterval(milestoneTimer);
  clearActiveChildProcess(activeProcesses, saveActivePids, chatId);
  if (warmPool && warmSessionKey && child && !child.killed && child.exitCode === null) {
    warmPool.storeWarm(warmSessionKey, child, { sessionId: observedSessionId, cwd });
  }

  return buildStreamingResult({
    output,
    error: null,
    files,
    toolUsageLog,
    usage,
    sessionId: observedSessionId || '',
  });
}

function writeStreamingChildInput(opts = {}) {
  const {
    child,
    input = '',
    isPersistent = false,
    warmPool = null,
    observedSessionId = '',
  } = opts;

  if (isPersistent && warmPool) {
    child.stdin.write(warmPool.buildStreamMessage(input, observedSessionId || ''));
    return { mode: 'persistent' };
  }

  child.stdin.write(input);
  child.stdin.end();
  return { mode: 'oneshot' };
}

function parseStreamingEvents(parseStreamEvent, line) {
  try {
    return parseStreamEvent(line) || [];
  } catch {
    return [];
  }
}

function reduceStreamingWaitState(waitingForTool, eventType) {
  if (eventType === 'tool_use') {
    return { waitingForTool: true, shouldUpdateWatchdog: !waitingForTool, watchdogWaiting: true };
  }
  if ((eventType === 'text' || eventType === 'done' || eventType === 'tool_result') && waitingForTool) {
    return { waitingForTool: false, shouldUpdateWatchdog: true, watchdogWaiting: false };
  }
  return { waitingForTool, shouldUpdateWatchdog: false, watchdogWaiting: waitingForTool };
}

function applyStreamingTextResult(state, opts = {}) {
  const {
    eventType,
    text = '',
    doneResult = '',
  } = opts;
  let finalResult = state && typeof state.finalResult === 'string' ? state.finalResult : '';
  let streamText = state && typeof state.streamText === 'string' ? state.streamText : finalResult;

  if (eventType === 'text' && text) {
    finalResult += (finalResult ? '\n\n' : '') + String(text);
    streamText = finalResult;
  }
  if (eventType === 'done' && !finalResult && doneResult) {
    finalResult = String(doneResult);
    streamText = finalResult;
  }

  return { finalResult, streamText };
}

function applyStreamingMetadata(state, event) {
  return {
    observedSessionId: event && event.type === 'session' && event.sessionId
      ? String(event.sessionId)
      : (state && state.observedSessionId ? state.observedSessionId : ''),
    classifiedError: event && event.type === 'error'
      ? event
      : (state ? state.classifiedError || null : null),
  };
}

function applyStreamingToolState(state, event, opts = {}) {
  const {
    pathModule,
    maxEntries = 50,
  } = opts;
  const eventType = event && event.type ? event.type : '';
  const waitState = reduceStreamingWaitState(state && state.waitingForTool, eventType);
  const nextState = {
    toolCallCount: state && Number.isFinite(state.toolCallCount) ? state.toolCallCount : 0,
    waitingForTool: waitState.waitingForTool,
    shouldUpdateWatchdog: waitState.shouldUpdateWatchdog,
    watchdogWaiting: waitState.watchdogWaiting,
    toolUsageLog: Array.isArray(state && state.toolUsageLog) ? state.toolUsageLog.slice() : [],
    writtenFiles: Array.isArray(state && state.writtenFiles) ? state.writtenFiles.slice() : [],
    toolName: event && event.toolName ? event.toolName : 'Tool',
    toolInput: event && event.toolInput ? event.toolInput : {},
  };

  if (eventType !== 'tool_use') return nextState;

  nextState.toolCallCount += 1;
  const toolState = recordToolUsage(
    { toolUsageLog: nextState.toolUsageLog, writtenFiles: nextState.writtenFiles },
    {
      toolName: nextState.toolName,
      toolInput: nextState.toolInput,
      pathModule,
      maxEntries,
    }
  );
  nextState.toolUsageLog = toolState.toolUsageLog;
  nextState.writtenFiles = toolState.writtenFiles;
  return nextState;
}

function applyStreamingContentState(state, event) {
  const eventType = event && event.type ? event.type : '';
  const waitState = reduceStreamingWaitState(state && state.waitingForTool, eventType);
  const textState = applyStreamingTextResult(
    {
      finalResult: state && state.finalResult,
      streamText: state && state.streamText,
    },
    {
      eventType,
      text: event && event.text,
      doneResult: event && event.result,
    }
  );
  return {
    finalResult: textState.finalResult,
    streamText: textState.streamText,
    waitingForTool: waitState.waitingForTool,
    shouldUpdateWatchdog: waitState.shouldUpdateWatchdog,
    watchdogWaiting: waitState.watchdogWaiting,
    finalUsage: eventType === 'done' ? (event.usage || null) : (state ? state.finalUsage || null : null),
    shouldFlush: eventType === 'text' || eventType === 'done',
    flushForce: eventType === 'done',
  };
}

function createStreamingWatchdog(opts) {
  const {
    child,
    killSignal = 'SIGTERM',
    useProcessGroup = true,
    idleTimeoutMs,
    toolTimeoutMs,
    ceilingTimeoutMs = null,
    forceKillDelayMs = 5000,
    onKill = null,
  } = opts;

  let waitingForTool = false;
  let killed = false;
  let killedReason = null;
  let sigkillTimer = null;

  function kill(reason) {
    if (killed) return;
    killed = true;
    killedReason = reason;
    if (typeof onKill === 'function') onKill(reason);
    ({ timer: sigkillTimer } = escalateKill(child, killSignal, forceKillDelayMs, { useProcessGroup }));
  }

  let idleTimer = setTimeout(() => kill('idle'), idleTimeoutMs);
  const ceilingTimer = ceilingTimeoutMs
    ? setTimeout(() => kill('ceiling'), ceilingTimeoutMs)
    : null;

  function resetIdle() {
    clearTimeout(idleTimer);
    const timeout = waitingForTool ? toolTimeoutMs : idleTimeoutMs;
    idleTimer = setTimeout(() => kill(waitingForTool ? 'tool' : 'idle'), timeout);
  }

  function setWaitingForTool(next) {
    waitingForTool = !!next;
    resetIdle();
  }

  function abort(reason = 'stdin') {
    clearTimeout(idleTimer);
    clearTimeout(ceilingTimer);
    kill(reason);
  }

  function stop() {
    clearTimeout(idleTimer);
    clearTimeout(ceilingTimer);
    clearTimeout(sigkillTimer);
  }

  return {
    resetIdle,
    setWaitingForTool,
    abort,
    stop,
    isKilled() { return killed; },
    getKilledReason() { return killedReason; },
  };
}

function runAsyncCommand(opts) {
  const {
    spawn,
    cmd,
    args,
    cwd,
    env,
    input = '',
    timeoutMs = 300000,
    killSignal = 'SIGTERM',
    useProcessGroup = false,
    forceKillDelayMs = 5000,
    formatSpawnError = (err) => err && err.message ? err.message : String(err || 'Unknown spawn error'),
  } = opts;

  return new Promise((resolve) => {
    let settled = false;
    function finalize(payload) {
      if (settled) return;
      settled = true;
      resolve(payload);
    }

    const child = spawn(cmd, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let sigkillTimer = null;
    let stdinFailureError = null;

    function abortForStdinFailure(err) {
      if (stdinFailureError) return;
      stdinFailureError = formatSpawnError(err);
      clearTimeout(timer);
      destroyChildStdin(child);
      if (!sigkillTimer) {
        ({ timer: sigkillTimer } = escalateKill(child, killSignal, forceKillDelayMs, { useProcessGroup }));
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      ({ timer: sigkillTimer } = escalateKill(child, killSignal, forceKillDelayMs, { useProcessGroup }));
    }, timeoutMs);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    if (child.stdin && typeof child.stdin.on === 'function') {
      child.stdin.on('error', (err) => { abortForStdinFailure(err); });
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(sigkillTimer);
      if (stdinFailureError) {
        finalize({ output: null, error: stdinFailureError });
      } else if (timedOut) {
        finalize({ output: null, error: 'Timeout: Claude took too long' });
      } else if (code !== 0) {
        finalize({ output: null, error: stderr || `Exit code ${code}` });
      } else {
        finalize({ output: stdout.trim(), error: null });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearTimeout(sigkillTimer);
      finalize({ output: null, error: formatSpawnError(err) });
    });

    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch (err) {
      abortForStdinFailure(err);
    }
  });
}

// Public API — consumed by daemon-claude-engine.js
module.exports = {
  createPlatformSpawn,
  terminateChildProcess,
  stopStreamingLifecycle,
  abortStreamingChildLifecycle,
  setActiveChildProcess,
  clearActiveChildProcess,
  acquireStreamingChild,
  buildStreamingResult,
  resolveStreamingClosePayload,
  accumulateStreamingStderr,
  splitStreamingStdoutChunk,
  buildStreamFlushPayload,
  buildToolOverlayPayload,
  buildMilestoneOverlayPayload,
  finalizePersistentStreamingTurn,
  writeStreamingChildInput,
  parseStreamingEvents,
  applyStreamingMetadata,
  applyStreamingToolState,
  applyStreamingContentState,
  createStreamingWatchdog,
  runAsyncCommand,

  // Internal helpers — exported for unit test coverage only
  _internal: {
    resolveNodeEntry,
    escalateKill,
    resetReusableChildListeners,
    destroyChildStdin,
    recordToolUsage,
    reduceStreamingWaitState,
    applyStreamingTextResult,
  },
};
