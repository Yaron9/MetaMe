'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoopReconciler } = require('./daemon-loop-reconciler');

test('reconciler delivers outbox once and backs off failures', async () => {
  const delivered = [];
  const failed = [];
  const governanceStore = {
    listPendingOutbox: () => [{ outbox_id: 1, attempts: 2 }, { outbox_id: 2, attempts: 0 }],
    markOutboxDelivered: id => delivered.push(id),
    markOutboxFailed: (...args) => failed.push(args),
  };
  const reconciler = createLoopReconciler({
    executionStore: { recoverInterruptedExecutions: () => [] },
    governanceStore,
    now: () => new Date('2026-06-23T00:00:00.000Z'),
  });
  const result = await reconciler.flushOutbox(async message => {
    if (message.outbox_id === 2) throw new Error('offline');
  });
  assert.deepEqual(delivered, [1]);
  assert.equal(failed[0][0], 2);
  assert.equal(result[1].delivered, false);
});

test('reconciler removes only stale inactive run worktrees', () => {
  const removed = [];
  const reconciler = createLoopReconciler({
    executionStore: {
      recoverInterruptedExecutions: () => [],
      listActiveWorkspaceIds: () => ['/tmp/run_active'],
    },
    governanceStore: { listPendingOutbox: () => [] },
    worktreeUtils: {
      listRunWorktrees: () => [
        { path: '/tmp/run_active', modifiedAt: 0 },
        { path: '/tmp/run_stale', modifiedAt: 0 },
        { path: '/tmp/run_recent', modifiedAt: Date.parse('2026-06-23T00:00:00Z') },
      ],
      removeRunWorktree: value => { removed.push(value); return true; },
    },
    now: () => new Date('2026-06-23T01:00:00Z'),
  });
  reconciler.cleanupWorkspaces(2 * 60 * 60 * 1000);
  assert.deepEqual(removed, ['/tmp/run_stale']);
});
