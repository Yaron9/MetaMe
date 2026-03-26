'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { EventEmitter } = require('events');
const handoff = require('./handoff');
const { createPlatformSpawn, terminateChildProcess, stopStreamingLifecycle, abortStreamingChildLifecycle, setActiveChildProcess, clearActiveChildProcess, acquireStreamingChild, buildStreamingResult, resolveStreamingClosePayload, accumulateStreamingStderr, splitStreamingStdoutChunk, buildStreamFlushPayload, buildToolOverlayPayload, buildMilestoneOverlayPayload, finalizePersistentStreamingTurn, writeStreamingChildInput, parseStreamingEvents, applyStreamingMetadata, applyStreamingToolState, applyStreamingContentState, createStreamingWatchdog, runAsyncCommand } = handoff;
const { resolveNodeEntry, escalateKill, resetReusableChildListeners, destroyChildStdin, recordToolUsage, reduceStreamingWaitState, applyStreamingTextResult } = handoff._internal;

describe('resolveNodeEntry', () => {
  it('extracts the node entry from a cmd wrapper', () => {
    const fakeFs = {
      readFileSync() { return '@echo off\n"%dp0%bin\\entry.js" %*\n'; },
      existsSync(file) { return file === 'C:\\tools\\bin\\entry.js'; },
    };
    assert.equal(
      resolveNodeEntry(fakeFs, path.win32, 'C:\\tools\\claude.cmd'),
      'C:\\tools\\bin\\entry.js'
    );
  });
});

describe('createPlatformSpawn', () => {
  it('uses node entry directly for cmd-like tools on windows', () => {
    const calls = [];
    const fakeSpawn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { cmd, args, options };
    };
    const handoff = createPlatformSpawn({
      fs: {
        readFileSync() { return '@echo off\n"%dp0%runner.js" %*\n'; },
        existsSync(file) { return file === 'C:\\tools\\runner.js' || file === 'C:\\tools\\codex.cmd'; },
      },
      path: path.win32,
      spawn: fakeSpawn,
      execSync() { return 'C:\\tools\\codex.cmd\n'; },
      processPlatform: 'win32',
      processExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      claudeBin: 'claude',
    });

    handoff.spawn('codex', ['exec'], { cwd: 'C:\\repo' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(calls[0].args, ['C:\\tools\\runner.js', 'exec']);
    assert.equal(calls[0].options.windowsHide, true);
  });

  it('passes through unchanged on non-windows', () => {
    const calls = [];
    const fakeSpawn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { cmd, args, options };
    };
    const handoff = createPlatformSpawn({
      fs: {
        readFileSync() { throw new Error('should not read files'); },
        existsSync() { return false; },
      },
      path,
      spawn: fakeSpawn,
      execSync() { throw new Error('should not run'); },
      processPlatform: 'darwin',
      processExecPath: process.execPath,
      claudeBin: 'claude',
    });

    handoff.spawn('claude', ['-p'], { cwd: '/tmp' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'claude');
    assert.deepEqual(calls[0].args, ['-p']);
    assert.deepEqual(calls[0].options, { cwd: '/tmp' });
  });
});

describe('terminateChildProcess', () => {
  it('falls back to child.kill when process group signal throws', () => {
    const calls = [];
    const originalKill = process.kill;
    process.kill = () => { throw new Error('no group'); };
    try {
      const child = {
        pid: 123,
        kill(signal) { calls.push(signal); },
      };
      assert.equal(terminateChildProcess(child, 'SIGTERM'), true);
      assert.deepEqual(calls, ['SIGTERM']);
    } finally {
      process.kill = originalKill;
    }
  });

  it('skips process-group kill when useProcessGroup is false', () => {
    const calls = [];
    const originalKill = process.kill;
    process.kill = () => { throw new Error('should not be called'); };
    try {
      const child = {
        pid: 123,
        kill(signal) { calls.push(signal); },
      };
      assert.equal(terminateChildProcess(child, 'SIGTERM', { useProcessGroup: false }), true);
      assert.deepEqual(calls, ['SIGTERM']);
    } finally {
      process.kill = originalKill;
    }
  });
});

describe('escalateKill', () => {
  it('schedules a SIGKILL escalation timer', async () => {
    const signals = [];
    const originalKill = process.kill;
    process.kill = (_pid, signal) => { signals.push(signal); };
    try {
      const child = { pid: 321, kill() {} };
      const { timer } = escalateKill(child, 'SIGTERM', 10);
      await new Promise((resolve) => setTimeout(resolve, 30));
      clearTimeout(timer);
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    } finally {
      process.kill = originalKill;
    }
  });

  it('uses child.kill directly when process groups are disabled', async () => {
    const calls = [];
    const originalKill = process.kill;
    process.kill = () => { throw new Error('should not be called'); };
    try {
      const child = {
        pid: 456,
        kill(signal) { calls.push(signal); },
      };
      const { timer } = escalateKill(child, 'SIGTERM', 10, { useProcessGroup: false });
      await new Promise((resolve) => setTimeout(resolve, 30));
      clearTimeout(timer);
      assert.deepEqual(calls, ['SIGTERM', 'SIGKILL']);
    } finally {
      process.kill = originalKill;
    }
  });
});

describe('resetReusableChildListeners', () => {
  it('clears reused child stream and lifecycle listeners', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('close', () => {});
    child.on('error', () => {});

    const result = resetReusableChildListeners(child);

    assert.equal(result, child);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });
});

describe('destroyChildStdin', () => {
  it('destroys stdin when available', () => {
    let destroyed = false;
    const child = {
      stdin: {
        destroy() { destroyed = true; },
      },
    };

    assert.equal(destroyChildStdin(child), true);
    assert.equal(destroyed, true);
  });

  it('returns false when stdin destroy is unavailable', () => {
    assert.equal(destroyChildStdin({ stdin: {} }), false);
    assert.equal(destroyChildStdin(null), false);
  });
});

describe('streaming lifecycle cleanup', () => {
  it('stops the watchdog and clears the milestone timer', async () => {
    let stopped = false;
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 20);

    stopStreamingLifecycle({ stop() { stopped = true; } }, timer);
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(stopped, true);
    assert.equal(timerFired, false);
  });

  it('aborts stdin-driven streaming cleanup without leaving the active child registered', () => {
    const active = new Map([['chat-1', { child: { pid: 1 } }]]);
    let saveCount = 0;
    let destroyed = false;
    let abortReason = null;
    const timer = setTimeout(() => {}, 1000);

    abortStreamingChildLifecycle({
      child: {
        stdin: {
          destroy() { destroyed = true; },
        },
      },
      watchdog: {
        abort(reason) { abortReason = reason; },
      },
      milestoneTimer: timer,
      activeProcesses: active,
      saveActivePids: () => { saveCount += 1; },
      chatId: 'chat-1',
      reason: 'stdin',
    });

    clearTimeout(timer);
    assert.equal(destroyed, true);
    assert.equal(abortReason, 'stdin');
    assert.equal(active.has('chat-1'), false);
    assert.equal(saveCount, 1);
  });
});

describe('active child tracking', () => {
  it('stores an active child entry and persists the pid snapshot', () => {
    const active = new Map();
    let saveCount = 0;
    const entry = { child: { pid: 1 }, engine: 'claude' };

    assert.equal(setActiveChildProcess(active, () => { saveCount += 1; }, 'chat-1', entry), true);
    assert.equal(active.get('chat-1'), entry);
    assert.equal(saveCount, 1);
  });

  it('clears an active child entry and persists the pid snapshot', () => {
    const active = new Map([['chat-1', { child: { pid: 1 } }]]);
    let saveCount = 0;

    assert.equal(clearActiveChildProcess(active, () => { saveCount += 1; }, 'chat-1'), true);
    assert.equal(active.has('chat-1'), false);
    assert.equal(saveCount, 1);
  });
});

describe('acquireStreamingChild', () => {
  it('reuses a warm child after resetting listeners', () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('close', () => {});
    child.on('error', () => {});

    const result = acquireStreamingChild({
      warmChild: child,
      spawn() { throw new Error('should not spawn'); },
    });

    assert.equal(result.child, child);
    assert.equal(result.reused, true);
    assert.equal(child.stdout.listenerCount('data'), 0);
    assert.equal(child.stderr.listenerCount('data'), 0);
    assert.equal(child.stdin.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(child.listenerCount('error'), 0);
  });

  it('spawns a fresh detached child when no warm child is available', () => {
    const calls = [];
    const child = { pid: 123 };
    const result = acquireStreamingChild({
      spawn(binary, args, options) {
        calls.push({ binary, args, options });
        return child;
      },
      binary: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      env: { A: '1' },
      useDetached: true,
    });

    assert.equal(result.child, child);
    assert.equal(result.reused, false);
    assert.deepEqual(calls, [{
      binary: 'claude',
      args: ['-p'],
      options: {
        cwd: '/tmp',
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        env: { A: '1' },
      },
    }]);
  });
});

describe('buildStreamingResult', () => {
  it('fills default streaming metadata fields', () => {
    assert.deepEqual(
      buildStreamingResult({ output: 'ok', error: null }),
      {
        output: 'ok',
        error: null,
        files: [],
        toolUsageLog: [],
        usage: null,
        sessionId: '',
      }
    );
  });

  it('allows overrides for additional result fields', () => {
    assert.deepEqual(
      buildStreamingResult(
        { output: null, error: 'boom', files: ['a'], toolUsageLog: [{ tool: 'Read' }], usage: { input: 1 }, sessionId: 'sid' },
        { timedOut: true, errorCode: 'INTERRUPTED' }
      ),
      {
        output: null,
        error: 'boom',
        files: ['a'],
        toolUsageLog: [{ tool: 'Read' }],
        usage: { input: 1 },
        sessionId: 'sid',
        timedOut: true,
        errorCode: 'INTERRUPTED',
      }
    );
  });
});

describe('resolveStreamingClosePayload', () => {
  const formatTimeoutWindowLabel = (timeoutMs, kind) => `${kind}:${timeoutMs}`;
  const emptyStream = { finalResult: '', finalUsage: null, observedSessionId: '', writtenFiles: [], toolUsageLog: [] };
  const defaultTimeout = { startTime: Date.now(), idleTimeoutMs: 1000, toolTimeoutMs: 1000, hardCeilingMs: 60000, formatTimeoutWindowLabel };

  it('maps interrupted merge-pause exits to the merge pause error code', () => {
    const result = resolveStreamingClosePayload({
      code: 1,
      streamState: { finalResult: 'partial', finalUsage: null, observedSessionId: 'sess', writtenFiles: ['/tmp/out.txt'], toolUsageLog: [{ tool: 'Write', context: 'out.txt' }] },
      wasAborted: true,
      abortReason: 'merge-pause',
      watchdog: { isKilled: () => false, getKilledReason: () => null },
      timeoutConfig: defaultTimeout,
      classifiedError: null,
      stderr: '',
    });

    assert.equal(result.error, 'Paused for merge');
    assert.equal(result.errorCode, 'INTERRUPTED_MERGE_PAUSE');
    assert.equal(result.output, 'partial');
  });

  it('keeps interrupted zero-exit payloads nullable when no output was produced', () => {
    const result = resolveStreamingClosePayload({
      code: 0,
      streamState: emptyStream,
      wasAborted: true,
      abortReason: 'user-stop',
      watchdog: { isKilled: () => false, getKilledReason: () => null },
      timeoutConfig: defaultTimeout,
      classifiedError: null,
      stderr: '',
    });

    assert.equal(result.output, null);
    assert.equal(result.errorCode, 'INTERRUPTED_USER');
  });

  it('marks watchdog timeouts as timedOut results', () => {
    const result = resolveStreamingClosePayload({
      code: 1,
      streamState: emptyStream,
      wasAborted: false,
      abortReason: '',
      stdinFailureError: null,
      watchdog: { isKilled: () => true, getKilledReason: () => 'tool' },
      timeoutConfig: { startTime: Date.now() - 2 * 60000, idleTimeoutMs: 1000, toolTimeoutMs: 2000, hardCeilingMs: 60000, formatTimeoutWindowLabel },
      classifiedError: null,
      stderr: '',
    });

    assert.equal(result.timedOut, true);
    assert.match(result.error, /工具执行tool:2000超时/);
  });

  it('prefers classified engine errors over raw stderr on non-zero exit', () => {
    const result = resolveStreamingClosePayload({
      code: 2,
      streamState: emptyStream,
      watchdog: { isKilled: () => false, getKilledReason: () => null },
      timeoutConfig: defaultTimeout,
      classifiedError: { message: 'friendly message', code: 'EXEC_FAILURE' },
      stderr: 'raw stderr',
    });

    assert.equal(result.error, 'friendly message');
    assert.equal(result.errorCode, 'EXEC_FAILURE');
  });
});

describe('accumulateStreamingStderr', () => {
  it('appends stderr chunks and captures the first classified error', () => {
    const first = accumulateStreamingStderr(
      { stderr: '', classifiedError: null },
      'model not found',
      {
        classifyError: (chunk) => ({ message: `classified:${chunk}`, code: 'EXEC_FAILURE' }),
      }
    );
    const second = accumulateStreamingStderr(
      first,
      ' raw stderr',
      {
        classifyError: () => ({ message: 'should not replace', code: 'OTHER' }),
      }
    );

    assert.equal(second.stderr, 'model not found raw stderr');
    assert.deepEqual(second.classifiedError, { message: 'classified:model not found', code: 'EXEC_FAILURE' });
  });

  it('flags API-looking stderr chunks via isApiError', () => {
    const result = accumulateStreamingStderr(
      { stderr: '', classifiedError: null },
      '400 invalid model request',
      {}
    );

    assert.equal(result.stderr, '400 invalid model request');
    assert.equal(result.isApiError, true);
  });

  it('does not flag non-API stderr as isApiError', () => {
    const result = accumulateStreamingStderr(
      { stderr: '', classifiedError: null },
      'normal debug output',
      {}
    );
    assert.equal(result.isApiError, false);
  });
});

describe('splitStreamingStdoutChunk', () => {
  it('returns complete lines and preserves the trailing partial buffer', () => {
    assert.deepEqual(
      splitStreamingStdoutChunk('partial', ' line 1\nline 2\ntrail'),
      {
        lines: ['partial line 1', 'line 2'],
        buffer: 'trail',
      }
    );
  });

  it('keeps the full chunk buffered when no newline is present', () => {
    assert.deepEqual(
      splitStreamingStdoutChunk('', 'no newline yet'),
      {
        lines: [],
        buffer: 'no newline yet',
      }
    );
  });
});

describe('buildStreamFlushPayload', () => {
  it('skips flushes for empty stream text', () => {
    assert.deepEqual(
      buildStreamFlushPayload({ streamText: '   ', lastFlushAt: 10 }, { now: 20, throttleMs: 5 }),
      { shouldFlush: false, lastFlushAt: 10 }
    );
  });

  it('throttles non-forced flushes within the throttle window', () => {
    assert.deepEqual(
      buildStreamFlushPayload({ streamText: 'hello', lastFlushAt: 100 }, { now: 200, throttleMs: 150 }),
      { shouldFlush: false, lastFlushAt: 100 }
    );
  });

  it('builds a stream payload when flush is allowed', () => {
    assert.deepEqual(
      buildStreamFlushPayload({ streamText: 'hello', lastFlushAt: 100 }, { now: 300, throttleMs: 150 }),
      { shouldFlush: true, lastFlushAt: 300, payload: '__STREAM_TEXT__hello' }
    );
  });
});

describe('buildToolOverlayPayload', () => {
  const toolEmoji = { default: '•', Write: '✍️', Skill: '🧠' };

  it('suppresses tool overlays inside the throttle window', () => {
    assert.deepEqual(
      buildToolOverlayPayload({
        toolName: 'Write',
        toolInput: { file_path: '/tmp/out.txt' },
        lastStatusTime: 100,
        now: 150,
        throttleMs: 100,
        toolEmoji,
        pathModule: require('path'),
      }),
      { shouldEmit: false, lastStatusTime: 100 }
    );
  });

  it('builds overlay payloads with streamed text context', () => {
    const result = buildToolOverlayPayload({
      toolName: 'Write',
      toolInput: { file_path: '/tmp/out.txt' },
      streamText: 'partial output',
      lastStatusTime: 100,
      now: 500,
      throttleMs: 100,
      toolEmoji,
      pathModule: require('path'),
    });

    assert.equal(result.shouldEmit, true);
    assert.equal(result.lastStatusTime, 500);
    assert.match(result.payload, /^__TOOL_OVERLAY__partial output\n\n> ✍️ Write: 「out/);
  });

  it('formats playwright MCP tools as browser actions', () => {
    const result = buildToolOverlayPayload({
      toolName: 'mcp__playwright__open_page',
      toolInput: {},
      lastStatusTime: 0,
      now: 500,
      throttleMs: 100,
      toolEmoji,
      pathModule: require('path'),
    });

    assert.equal(result.payload, '🌐 Browser: 「open page」');
  });
});

describe('recordToolUsage', () => {
  it('records tool context and tracks written files once', () => {
    const result = recordToolUsage(
      { toolUsageLog: [], writtenFiles: ['/tmp/existing.txt'] },
      {
        toolName: 'Write',
        toolInput: { file_path: '/tmp/out.txt' },
        pathModule: require('path'),
      }
    );

    assert.deepEqual(result.toolUsageLog, [{ tool: 'Write', context: 'out.txt' }]);
    assert.deepEqual(result.writtenFiles, ['/tmp/existing.txt', '/tmp/out.txt']);
  });

  it('caps tool usage entries but still tracks file writes', () => {
    const result = recordToolUsage(
      { toolUsageLog: new Array(50).fill({ tool: 'Read' }), writtenFiles: [] },
      {
        toolName: 'Write',
        toolInput: { file_path: '/tmp/out.txt' },
        pathModule: require('path'),
        maxEntries: 50,
      }
    );

    assert.equal(result.toolUsageLog.length, 50);
    assert.deepEqual(result.writtenFiles, ['/tmp/out.txt']);
  });
});

describe('buildMilestoneOverlayPayload', () => {
  it('builds a plain milestone message without stream text', () => {
    assert.equal(
      buildMilestoneOverlayPayload({
        elapsedMin: 7,
        toolCallCount: 2,
        writtenFiles: ['/tmp/a.txt'],
        toolUsageLog: [{ tool: 'Write', context: 'a.txt' }],
      }),
      '⏳ 已运行 7 分钟 | 调用 2 次工具 | 修改 1 个文件 | 最近: Write a.txt'
    );
  });

  it('wraps milestone text as an overlay when stream text exists', () => {
    assert.equal(
      buildMilestoneOverlayPayload({
        elapsedMin: 2,
        toolCallCount: 0,
        writtenFiles: [],
        toolUsageLog: [],
        streamText: 'partial output',
      }),
      '__TOOL_OVERLAY__partial output\n\n> ⏳ 已运行 2 分钟'
    );
  });
});

describe('finalizePersistentStreamingTurn', () => {
  it('stops lifecycle, clears active state, stores the warm child, and returns the final result', () => {
    let stopped = false;
    const active = new Map([['chat-1', { child: { pid: 1 } }]]);
    let saveCount = 0;
    const stored = [];
    const timer = setTimeout(() => {}, 1000);
    const child = { killed: false, exitCode: null };

    const result = finalizePersistentStreamingTurn({
      watchdog: { stop() { stopped = true; } },
      milestoneTimer: timer,
      activeProcesses: active,
      saveActivePids: () => { saveCount += 1; },
      chatId: 'chat-1',
      warmPool: {
        storeWarm(key, proc, meta) { stored.push({ key, proc, meta }); },
      },
      warmSessionKey: 'warm-1',
      child,
      observedSessionId: 'sess-1',
      cwd: '/tmp/project',
      output: 'ok',
      files: ['/tmp/out.txt'],
      toolUsageLog: [{ tool: 'Write', context: 'out.txt' }],
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    clearTimeout(timer);
    assert.equal(stopped, true);
    assert.equal(active.has('chat-1'), false);
    assert.equal(saveCount, 1);
    assert.deepEqual(stored, [{
      key: 'warm-1',
      proc: child,
      meta: { sessionId: 'sess-1', cwd: '/tmp/project' },
    }]);
    assert.deepEqual(result, {
      output: 'ok',
      error: null,
      files: ['/tmp/out.txt'],
      toolUsageLog: [{ tool: 'Write', context: 'out.txt' }],
      usage: { input_tokens: 1, output_tokens: 2 },
      sessionId: 'sess-1',
    });
  });
});

describe('writeStreamingChildInput', () => {
  it('writes stream-json input through the warm pool in persistent mode', () => {
    const writes = [];
    const child = {
      stdin: {
        write(chunk) { writes.push(chunk); },
        end() { writes.push('END'); },
      },
    };
    const result = writeStreamingChildInput({
      child,
      input: 'hello',
      isPersistent: true,
      warmPool: { buildStreamMessage: (input, sessionId) => `MSG:${sessionId}:${input}` },
      observedSessionId: 'sess-1',
    });

    assert.deepEqual(writes, ['MSG:sess-1:hello']);
    assert.deepEqual(result, { mode: 'persistent' });
  });

  it('writes plain stdin and ends in one-shot mode', () => {
    const writes = [];
    const child = {
      stdin: {
        write(chunk) { writes.push(chunk); },
        end() { writes.push('END'); },
      },
    };
    const result = writeStreamingChildInput({
      child,
      input: 'hello',
      isPersistent: false,
      warmPool: null,
    });

    assert.deepEqual(writes, ['hello', 'END']);
    assert.deepEqual(result, { mode: 'oneshot' });
  });
});

describe('parseStreamingEvents', () => {
  it('returns parser output when parsing succeeds', () => {
    assert.deepEqual(
      parseStreamingEvents((line) => [JSON.parse(line)], '{"type":"text","text":"ok"}'),
      [{ type: 'text', text: 'ok' }]
    );
  });

  it('returns an empty list when the parser throws', () => {
    assert.deepEqual(
      parseStreamingEvents(() => { throw new Error('bad line'); }, 'bad'),
      []
    );
  });
});

describe('reduceStreamingWaitState', () => {
  it('enters tool-waiting mode on tool_use', () => {
    assert.deepEqual(
      reduceStreamingWaitState(false, 'tool_use'),
      { waitingForTool: true, shouldUpdateWatchdog: true, watchdogWaiting: true }
    );
  });

  it('clears tool-waiting mode on text output', () => {
    assert.deepEqual(
      reduceStreamingWaitState(true, 'text'),
      { waitingForTool: false, shouldUpdateWatchdog: true, watchdogWaiting: false }
    );
  });

  it('keeps state unchanged when no wait transition applies', () => {
    assert.deepEqual(
      reduceStreamingWaitState(false, 'session'),
      { waitingForTool: false, shouldUpdateWatchdog: false, watchdogWaiting: false }
    );
  });
});

describe('applyStreamingTextResult', () => {
  it('appends streamed text chunks with paragraph separators', () => {
    assert.deepEqual(
      applyStreamingTextResult(
        { finalResult: 'first', streamText: 'first' },
        { eventType: 'text', text: 'second' }
      ),
      { finalResult: 'first\n\nsecond', streamText: 'first\n\nsecond' }
    );
  });

  it('uses done.result as a fallback when no text has streamed', () => {
    assert.deepEqual(
      applyStreamingTextResult(
        { finalResult: '', streamText: '' },
        { eventType: 'done', doneResult: 'tool-only result' }
      ),
      { finalResult: 'tool-only result', streamText: 'tool-only result' }
    );
  });
});

describe('applyStreamingMetadata', () => {
  it('updates the observed session id on session events', () => {
    assert.deepEqual(
      applyStreamingMetadata(
        { observedSessionId: '', classifiedError: null },
        { type: 'session', sessionId: 'sess-1' }
      ),
      { observedSessionId: 'sess-1', classifiedError: null }
    );
  });

  it('captures classified error events without disturbing the session id', () => {
    const errorEvent = { type: 'error', message: 'boom', code: 'EXEC_FAILURE' };
    assert.deepEqual(
      applyStreamingMetadata(
        { observedSessionId: 'sess-1', classifiedError: null },
        errorEvent
      ),
      { observedSessionId: 'sess-1', classifiedError: errorEvent }
    );
  });
});

describe('applyStreamingToolState', () => {
  it('updates tool state on tool_use events', () => {
    assert.deepEqual(
      applyStreamingToolState(
        { waitingForTool: false, toolCallCount: 0, toolUsageLog: [], writtenFiles: [] },
        { type: 'tool_use', toolName: 'Write', toolInput: { file_path: '/tmp/out.txt' } },
        { pathModule: path, maxEntries: 50 }
      ),
      {
        toolCallCount: 1,
        waitingForTool: true,
        shouldUpdateWatchdog: true,
        watchdogWaiting: true,
        toolUsageLog: [{ tool: 'Write', context: 'out.txt' }],
        writtenFiles: ['/tmp/out.txt'],
        toolName: 'Write',
        toolInput: { file_path: '/tmp/out.txt' },
      }
    );
  });

  it('only clears wait state on tool_result events', () => {
    assert.deepEqual(
      applyStreamingToolState(
        {
          waitingForTool: true,
          toolCallCount: 2,
          toolUsageLog: [{ tool: 'Write', context: 'out.txt' }],
          writtenFiles: ['/tmp/out.txt'],
        },
        { type: 'tool_result' },
        { pathModule: path, maxEntries: 50 }
      ),
      {
        toolCallCount: 2,
        waitingForTool: false,
        shouldUpdateWatchdog: true,
        watchdogWaiting: false,
        toolUsageLog: [{ tool: 'Write', context: 'out.txt' }],
        writtenFiles: ['/tmp/out.txt'],
        toolName: 'Tool',
        toolInput: {},
      }
    );
  });
});

describe('applyStreamingContentState', () => {
  it('updates text content state and clears tool wait on text events', () => {
    assert.deepEqual(
      applyStreamingContentState(
        { finalResult: 'first', streamText: 'first', waitingForTool: true, finalUsage: null },
        { type: 'text', text: 'second' }
      ),
      {
        finalResult: 'first\n\nsecond',
        streamText: 'first\n\nsecond',
        waitingForTool: false,
        shouldUpdateWatchdog: true,
        watchdogWaiting: false,
        finalUsage: null,
        shouldFlush: true,
        flushForce: false,
      }
    );
  });

  it('captures final usage and forces a flush on done events', () => {
    assert.deepEqual(
      applyStreamingContentState(
        { finalResult: '', streamText: '', waitingForTool: true, finalUsage: null },
        { type: 'done', result: 'tool-only result', usage: { input_tokens: 1, output_tokens: 2 } }
      ),
      {
        finalResult: 'tool-only result',
        streamText: 'tool-only result',
        waitingForTool: false,
        shouldUpdateWatchdog: true,
        watchdogWaiting: false,
        finalUsage: { input_tokens: 1, output_tokens: 2 },
        shouldFlush: true,
        flushForce: true,
      }
    );
  });
});

describe('createStreamingWatchdog', () => {
  it('kills for idle timeout and records the reason', async () => {
    const killSignals = [];
    const child = { pid: 123, kill(signal) { killSignals.push(signal); } };
    const watchdog = createStreamingWatchdog({
      child,
      idleTimeoutMs: 10,
      toolTimeoutMs: 30,
      useProcessGroup: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    watchdog.stop();

    assert.equal(watchdog.isKilled(), true);
    assert.equal(watchdog.getKilledReason(), 'idle');
    assert.deepEqual(killSignals, ['SIGTERM']);
  });

  it('switches to tool timeout window when waiting for a tool', async () => {
    const killSignals = [];
    const child = { pid: 456, kill(signal) { killSignals.push(signal); } };
    const watchdog = createStreamingWatchdog({
      child,
      idleTimeoutMs: 10,
      toolTimeoutMs: 40,
      useProcessGroup: false,
    });

    watchdog.setWaitingForTool(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(watchdog.isKilled(), false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    watchdog.stop();

    assert.equal(watchdog.isKilled(), true);
    assert.equal(watchdog.getKilledReason(), 'tool');
    assert.deepEqual(killSignals, ['SIGTERM']);
  });

  it('aborts immediately with a custom reason', () => {
    const killSignals = [];
    const reasons = [];
    const child = { pid: 789, kill(signal) { killSignals.push(signal); } };
    const watchdog = createStreamingWatchdog({
      child,
      idleTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      useProcessGroup: false,
      onKill(reason) { reasons.push(reason); },
    });

    watchdog.abort('stdin');
    watchdog.stop();

    assert.equal(watchdog.isKilled(), true);
    assert.equal(watchdog.getKilledReason(), 'stdin');
    assert.deepEqual(reasons, ['stdin']);
    assert.deepEqual(killSignals, ['SIGTERM']);
  });

  it('kills for ceiling timeout and records the reason', async () => {
    const killSignals = [];
    const child = { pid: 654, kill(signal) { killSignals.push(signal); } };
    const watchdog = createStreamingWatchdog({
      child,
      idleTimeoutMs: 1000,
      toolTimeoutMs: 1000,
      ceilingTimeoutMs: 10,
      useProcessGroup: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    watchdog.stop();

    assert.equal(watchdog.isKilled(), true);
    assert.equal(watchdog.getKilledReason(), 'ceiling');
    assert.deepEqual(killSignals, ['SIGTERM']);
  });
});

describe('runAsyncCommand', () => {
  it('collects stdout and resolves successful output', async () => {
    let closeHandler = null;
    const fakeChild = {
      stdout: { on(_event, handler) { handler(Buffer.from('hello\n')); } },
      stderr: { on() {} },
      stdin: { write() {}, end() {} },
      on(event, handler) {
        if (event === 'close') closeHandler = handler;
      },
    };
    const promise = runAsyncCommand({
      spawn() { return fakeChild; },
      cmd: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      env: {},
    });
    closeHandler(0);
    const result = await promise;
    assert.deepEqual(result, { output: 'hello', error: null });
  });

  it('uses the provided spawn error formatter', async () => {
    let errorHandler = null;
    const fakeChild = {
      stdout: { on() {} },
      stderr: { on() {} },
      stdin: { write() {}, end() {} },
      on(event, handler) {
        if (event === 'error') errorHandler = handler;
      },
    };
    const promise = runAsyncCommand({
      spawn() { return fakeChild; },
      cmd: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      env: {},
      formatSpawnError() { return 'formatted'; },
    });
    errorHandler(new Error('boom'));
    const result = await promise;
    assert.deepEqual(result, { output: null, error: 'formatted' });
  });

  it('handles stdin write exceptions without hanging', async () => {
    let closeHandler = null;
    const killCalls = [];
    const fakeChild = {
      pid: 777,
      stdout: { on() {} },
      stderr: { on() {} },
      stdin: {
        on() {},
        write() { throw new Error('EPIPE'); },
        end() {},
      },
      kill(signal) { killCalls.push(signal); },
      on(event, handler) {
        if (event === 'close') closeHandler = handler;
      },
    };
    const promise = runAsyncCommand({
      spawn() { return fakeChild; },
      cmd: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      env: {},
      formatSpawnError(err) { return err.message; },
    });
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    closeHandler(1);
    const result = await promise;
    assert.deepEqual(result, { output: null, error: 'EPIPE' });
    assert.deepEqual(killCalls, ['SIGTERM']);
    assert.equal(typeof closeHandler, 'function');
  });

  it('handles stdin error events without hanging', async () => {
    let stdinErrorHandler = null;
    let closeHandler = null;
    const killCalls = [];
    const fakeChild = {
      pid: 888,
      stdout: { on() {} },
      stderr: { on() {} },
      stdin: {
        on(event, handler) {
          if (event === 'error') stdinErrorHandler = handler;
        },
        write() {},
        end() {},
      },
      kill(signal) { killCalls.push(signal); },
      on(event, handler) {
        if (event === 'close') closeHandler = handler;
      },
    };
    const promise = runAsyncCommand({
      spawn() { return fakeChild; },
      cmd: 'claude',
      args: ['-p'],
      cwd: '/tmp',
      env: {},
      formatSpawnError(err) { return err.message; },
    });
    stdinErrorHandler(new Error('ERR_STREAM_DESTROYED'));
    let settled = false;
    promise.then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    closeHandler(1);
    const result = await promise;
    assert.deepEqual(result, { output: null, error: 'ERR_STREAM_DESTROYED' });
    assert.deepEqual(killCalls, ['SIGTERM']);
  });
});
