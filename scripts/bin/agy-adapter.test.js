'use strict';

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
});
