'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');
const adapter = require('./agy-adapter');

describe('agy-adapter invocation', () => {
  it('passes prompt and metadata as separate argv values', () => {
    const args = adapter.buildAgyArgs({
      cwd: '/tmp/project',
      model: 'gemini-test',
      sessionId: 'conversation-id',
      timeoutMs: 65_000,
      readOnly: false,
    }, 'prompt with spaces; $(not-shell)', '/tmp/agy');
    assert.deepEqual(args.slice(0, 3), ['-q', '/dev/null', '/tmp/agy']);
    assert.equal(args[args.indexOf('--conversation') + 1], 'conversation-id');
    assert.equal(args[args.indexOf('--model') + 1], 'gemini-test');
    assert.equal(args.at(-2), '-p');
    assert.equal(args.at(-1), 'prompt with spaces; $(not-shell)');
  });

  it('omits permission and model flags in read-only auto mode', () => {
    const args = adapter.buildAgyArgs({ model: 'auto', sessionId: '', timeoutMs: 1000, readOnly: true }, 'hello', 'agy');
    assert.equal(args.includes('--dangerously-skip-permissions'), false);
    assert.equal(args.includes('--model'), false);
    assert.deepEqual(args.slice(-2), ['-p', 'hello']);
  });

  it('classifies authentication and PTY failures without Codex instructions', () => {
    assert.equal(adapter.classifyFailure({ output: 'please login with OAuth' }).code, 'AGY_AUTH_REQUIRED');
    const pty = adapter.classifyFailure({ spawnError: { code: 'ENOENT', message: 'missing' } });
    assert.equal(pty.code, 'AGY_PTY_FAILED');
    assert.doesNotMatch(pty.message, /codex/i);
  });

  it('escalates an ignored timeout to SIGKILL and settles without close', async () => {
    const child = new EventEmitter();
    child.pid = 123456;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const signals = [];
    const result = await adapter.spawnAgy({
      cwd: '/tmp', model: 'auto', sessionId: '', timeoutMs: 1, readOnly: false,
    }, 'hello', {
      allowAnyPlatform: true,
      spawn: () => child,
      terminateTree: (_child, signal) => signals.push(signal),
      timeoutPaddingMs: 0,
      killAfterMs: 2,
      forceFinishAfterMs: 4,
    });
    assert.equal(result.error.code, 'AGY_TIMEOUT');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });

  it('returns the transcript final text before lingering background work closes', async () => {
    const child = new EventEmitter();
    child.pid = 234567;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const cwd = path.join(os.tmpdir(), `metame-agy-early-final-${Date.now()}-${Math.random()}`);
    const sessionId = 'sess-early-final';
    const records = [
      { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: '查一下工业富联' },
      {
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        content: '结论：已有最终回答应该立刻返回，不继续等待后台 search-web 进程退出。',
      },
      { type: 'RUN_COMMAND', source: 'MODEL', status: 'RUNNING', content: 'search-web trailing work' },
    ];
    const signals = [];

    const result = await adapter.spawnAgy({
      cwd, model: 'auto', sessionId, timeoutMs: 10_000, readOnly: false,
    }, '查一下工业富联', {
      allowAnyPlatform: true,
      spawn: () => child,
      readCache: () => ({ [cwd]: sessionId }),
      readTranscript: () => records.slice(),
      beforeCache: { [cwd]: sessionId },
      minRecordCount: 0,
      finalPollIntervalMs: 1,
      terminateTree: (_child, signal) => signals.push(signal),
      killAfterMs: 10_000,
    });

    assert.equal(result.error, undefined);
    assert.match(result.earlyFinal.text, /已有最终回答应该立刻返回/);
    assert.deepEqual(signals, ['SIGTERM']);
  });

  it('blocks interactive OAuth browser login in unattended agy runs', async () => {
    const child = new EventEmitter();
    child.pid = 345678;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const signals = [];
    let spawnedEnv = null;

    const resultPromise = adapter.spawnAgy({
      cwd: '/tmp', model: 'auto', sessionId: '', timeoutMs: 10_000, readOnly: false,
    }, 'hello', {
      allowAnyPlatform: true,
      spawn: (_bin, _args, opts) => {
        spawnedEnv = opts.env;
        setImmediate(() => {
          child.stderr.emit('data', 'Authentication required. Please open https://accounts.google.com/o/oauth2/auth');
        });
        return child;
      },
      terminateTree: (_child, signal) => signals.push(signal),
      killAfterMs: 10_000,
    });

    const result = await resultPromise;
    assert.equal(result.error.code, 'AGY_AUTH_REQUIRED');
    assert.match(result.error.message, /已阻止后台弹窗/);
    assert.equal(spawnedEnv.METAME_AGY_UNATTENDED, '1');
    assert.equal(spawnedEnv.BROWSER, '/usr/bin/false');
    assert.deepEqual(signals, ['SIGTERM']);
  });

  it('asks agy to summarize existing tool evidence when the first turn has no final text', async () => {
    const cwd = path.join(os.tmpdir(), `metame-agy-finalize-${Date.now()}-${Math.random()}`);
    const sessionId = 'sess-finalize';
    const records = [];
    const prompts = [];

    const result = await adapter.run({
      cwd,
      model: 'auto',
      sessionId,
      timeoutMs: 1000,
      readOnly: false,
    }, '管网阀门相关被错误定价的股有哪些', {
      readCache: () => ({ [cwd]: sessionId }),
      readTranscript: () => records.slice(),
      sleep: async () => {},
      spawnAgy: async (_options, prompt) => {
        prompts.push(prompt);
        if (prompts.length === 1) {
          records.push(
            { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: prompt },
            { type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', tool_calls: [{ name: 'search_web' }] },
            { type: 'SEARCH_WEB', source: 'MODEL', status: 'DONE', content: '搜索结果：A公司管网阀门业务占比高，估值低；B公司传感器订单增长。' },
          );
        } else {
          records.push(
            { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: prompt },
            { type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '结论：优先看A公司，B公司作为备选。依据是已有搜索结果显示A估值低且管网阀门业务占比高。' },
          );
        }
        return { code: 0, output: '', errorOutput: '' };
      },
    });

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /不要再调用工具/);
    assert.match(prompts[1], /搜索结果：A公司/);
    assert.equal(result.error, undefined);
    assert.match(result.text, /优先看A公司/);
  });

  it('reports a clear failure when there is no final text and no tool evidence', async () => {
    const cwd = path.join(os.tmpdir(), `metame-agy-no-evidence-${Date.now()}-${Math.random()}`);
    const sessionId = 'sess-no-evidence';
    const records = [];

    const result = await adapter.run({
      cwd,
      model: 'auto',
      sessionId,
      timeoutMs: 1000,
      readOnly: false,
    }, '查一下结果', {
      readCache: () => ({ [cwd]: sessionId }),
      readTranscript: () => records.slice(),
      sleep: async () => {},
      spawnAgy: async (_options, prompt) => {
        records.push(
          { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: prompt },
          { type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', tool_calls: [{ name: 'search_web' }] },
        );
        return { code: 0, output: '', errorOutput: '' };
      },
    });

    assert.equal(result.error.code, 'AGY_EXEC_FAILURE');
    assert.match(result.error.message, /agy exited with code 0/);
  });

  it('retries once when agy OAuth refresh wins after the CLI auth timeout', async () => {
    const cwd = path.join(os.tmpdir(), `metame-agy-auth-retry-${Date.now()}-${Math.random()}`);
    const sessionId = 'sess-auth-retry';
    const records = [];
    const calls = [];

    const result = await adapter.run({
      cwd,
      model: 'auto',
      sessionId,
      timeoutMs: 1000,
      readOnly: false,
    }, '查一下登录态是否可用', {
      readCache: () => ({ [cwd]: sessionId }),
      readTranscript: () => records.slice(),
      sleep: async () => {},
      authRetryDelayMs: 0,
      spawnAgy: async (_options, prompt) => {
        calls.push(prompt);
        if (calls.length === 1) {
          return {
            code: 1,
            output: 'Waiting for authentication (timeout 30s)...\nError: authentication timed out.',
            errorOutput: '',
          };
        }
        records.push(
          { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: prompt },
          { type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: '登录态已复用，第二次运行成功。' },
        );
        return { code: 0, output: '', errorOutput: '' };
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(result.error, undefined);
    assert.match(result.text, /登录态已复用/);
  });

  it('does not retry successful answers that mention OAuth', async () => {
    const cwd = path.join(os.tmpdir(), `metame-agy-oauth-answer-${Date.now()}-${Math.random()}`);
    const records = [];
    const calls = [];

    const result = await adapter.run({
      cwd,
      model: 'auto',
      sessionId: 'stale-session',
      timeoutMs: 1000,
      readOnly: false,
    }, '解释 OAuth', {
      readCache: () => ({ [cwd]: 'stale-session' }),
      readTranscript: () => records.slice(),
      sleep: async () => {},
      spawnAgy: async (_options, prompt) => {
        calls.push(prompt);
        records.push(
          { type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: prompt },
          { type: 'PLANNER_RESPONSE', source: 'MODEL', status: 'DONE', content: 'OAuth 是一种授权协议。' },
        );
        return { code: 0, output: '', errorOutput: '' };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(result.error, undefined);
    assert.match(result.text, /OAuth 是一种授权协议/);
  });

  it('uses stdout text when agy does not persist a transcript for a successful run', async () => {
    const cwd = path.join(os.tmpdir(), `metame-agy-stdout-${Date.now()}-${Math.random()}`);
    const result = await adapter.run({
      cwd,
      model: 'auto',
      sessionId: 'stale-session',
      timeoutMs: 1000,
      readOnly: false,
    }, '怎么样', {
      readCache: () => ({ [cwd]: 'stale-session' }),
      readTranscript: () => [],
      sleep: async () => {},
      spawnAgy: async () => ({
        code: 0,
        output: '\u001b[32m这是 agy stdout 里的最终回答。\u001b[0m\n',
        errorOutput: '',
      }),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.sessionId, 'stale-session');
    assert.equal(result.text, '这是 agy stdout 里的最终回答。');
  });

  it('does not treat stdout-looking errors as final answers', async () => {
    const cwd = path.join(os.tmpdir(), `metame-agy-stdout-error-${Date.now()}-${Math.random()}`);
    const result = await adapter.run({
      cwd,
      model: 'auto',
      sessionId: 'stale-session',
      timeoutMs: 1000,
      readOnly: false,
    }, '怎么样', {
      readCache: () => ({ [cwd]: 'stale-session' }),
      readTranscript: () => [],
      sleep: async () => {},
      spawnAgy: async () => ({
        code: 0,
        output: 'Error: conversation not found',
        errorOutput: '',
      }),
    });

    assert.equal(result.error.code, 'AGY_SESSION_CAPTURE_FAILED');
    assert.match(result.error.message, /stdout 没有可用最终文本/);
  });
});
