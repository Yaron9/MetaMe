'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
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
});
