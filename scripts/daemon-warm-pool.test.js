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

test('hasWarm returns false for unknown key', () => {
  const warmPool = createWarmPool({ log: () => {} });
  assert.equal(warmPool.hasWarm('nonexistent'), false);
});

test('hasWarm returns true for live process and does not consume the entry', () => {
  const child = createChild(40003);
  const warmPool = createWarmPool({ log: () => {} });
  warmPool.storeWarm('k1', child, { sessionId: 's1', cwd: '/tmp' });

  assert.equal(warmPool.hasWarm('k1'), true);
  // calling twice — entry not consumed
  assert.equal(warmPool.hasWarm('k1'), true);
  assert.ok(warmPool._pool.has('k1'));
  warmPool.releaseAll();
});

test('hasWarm returns false and cleans up dead process (killed = true)', () => {
  const child = createChild(40004);
  const warmPool = createWarmPool({ log: () => {} });
  warmPool.storeWarm('k2', child, { sessionId: 's2', cwd: '/tmp' });
  child.killed = true; // simulate process death

  assert.equal(warmPool.hasWarm('k2'), false);
  assert.equal(warmPool._pool.has('k2'), false); // cleaned up
});

test('hasWarm returns false and cleans up dead process (exitCode set)', () => {
  const child = createChild(40005);
  const warmPool = createWarmPool({ log: () => {} });
  warmPool.storeWarm('k3', child, { sessionId: 's3', cwd: '/tmp' });
  child.exitCode = 1; // simulate process exit

  assert.equal(warmPool.hasWarm('k3'), false);
  assert.equal(warmPool._pool.has('k3'), false); // cleaned up
});
