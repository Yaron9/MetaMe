'use strict';

function createLoopReconciler(deps = {}) {
  if (!deps.executionStore || !deps.governanceStore) {
    throw new TypeError('createLoopReconciler requires executionStore and governanceStore');
  }
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();

  function recoverExecutions(bootId) {
    return deps.executionStore.recoverInterruptedExecutions(bootId);
  }

  async function flushOutbox(deliver, limit = 50) {
    if (typeof deliver !== 'function') throw new TypeError('outbox deliver function required');
    const pending = deps.governanceStore.listPendingOutbox(limit);
    const results = [];
    for (const message of pending) {
      try {
        await deliver(message);
        deps.governanceStore.markOutboxDelivered(message.outbox_id);
        results.push({ outbox_id: message.outbox_id, delivered: true });
      } catch (err) {
        const delayMs = Math.min(60 * 60 * 1000, 1000 * (2 ** Math.min(10, message.attempts)));
        deps.governanceStore.markOutboxFailed(
          message.outbox_id,
          err && err.message ? err.message : String(err),
          new Date(now().getTime() + delayMs).toISOString()
        );
        results.push({ outbox_id: message.outbox_id, delivered: false });
      }
    }
    return results;
  }

  function cleanupWorkspaces(maxAgeMs = 24 * 60 * 60 * 1000) {
    const utils = deps.worktreeUtils;
    if (!utils || typeof utils.listRunWorktrees !== 'function') return [];
    const active = new Set(deps.executionStore.listActiveWorkspaceIds());
    const cutoff = now().getTime() - maxAgeMs;
    const removed = [];
    for (const workspace of utils.listRunWorktrees()) {
      if (active.has(workspace.path) || workspace.modifiedAt > cutoff) continue;
      if (utils.removeRunWorktree(workspace.path)) removed.push(workspace.path);
    }
    return removed;
  }

  return { recoverExecutions, flushOutbox, cleanupWorkspaces };
}

module.exports = { createLoopReconciler };
