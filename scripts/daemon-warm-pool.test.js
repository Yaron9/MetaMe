'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWarmPool } = require('./daemon-warm-pool');

function createChild(pid = 12345) {
  return {
    pid,
    killed: false,
    exitCode: null,
    once() {},
    kill(signal) {
      this.killed = true;
      this.signal = signal;
    },
  };
}

test('warm pool does not kill idle process when background descendants still exist', async () => {
  const logs = [];
  const child = createChild(40001);
  const warmPool = createWarmPool({
    log: (_level, msg) => logs.push(msg),
    idleTimeoutMs: 20,
    hasBackgroundDescendants: () => true,
  });

  warmPool.storeWarm('3d', child, { sessionId: 'sess-1', cwd: '/tmp' });
  await new Promise(resolve => setTimeout(resolve, 35));

  assert.equal(child.killed, false);
  assert.ok(warmPool._pool.has('3d'));
  assert.ok(logs.some(msg => msg.includes('Idle timeout skipped')));

  warmPool.releaseAll();
});

test('warm pool kills idle process when no background descendants exist', async () => {
  const child = createChild(40002);
  const warmPool = createWarmPool({
    log: () => {},
    idleTimeoutMs: 20,
    hasBackgroundDescendants: () => false,
  });

  warmPool.storeWarm('3d', child, { sessionId: 'sess-2', cwd: '/tmp' });
  await new Promise(resolve => setTimeout(resolve, 35));

  assert.equal(child.killed, true);
  assert.equal(child.signal, 'SIGTERM');
  assert.equal(warmPool._pool.has('3d'), false);
});
