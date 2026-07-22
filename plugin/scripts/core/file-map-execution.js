'use strict';

function reconcileMoving({ sourceExists, destinationExists, method }) {
  if (method === 'trash') {
    return sourceExists
      ? { action: 'retry' }
      : { action: 'complete', result: 'trashed' };
  }
  if (sourceExists && !destinationExists) return { action: 'retry' };
  if (!sourceExists && destinationExists) return { action: 'complete', result: 'moved' };
  return { action: 'conflict', reason: sourceExists ? 'source-and-destination-exist' : 'source-and-destination-missing' };
}

function canReclaimLease(lease, { nowMs, leaseMs, isPidAlive }) {
  if (!lease || !Number.isFinite(lease.started_ms) || !Number.isInteger(lease.pid)) return true;
  if (nowMs - lease.started_ms <= leaseMs) return false;
  return !isPidAlive(lease.pid);
}

function summarizeExecution(items) {
  const movedItems = items.filter(item => item.result === 'moved' || item.result === 'trashed');
  const skipped = items
    .filter(item => typeof item.result === 'string' && item.result.startsWith('skipped:'))
    .map(item => ({ path: item.path, reason: item.result.slice('skipped:'.length) }));
  return {
    moved: movedItems.length,
    bytesFreed: movedItems.reduce((sum, item) => sum + (item.size || 0), 0),
    skipped,
  };
}

module.exports = { reconcileMoving, canReclaimLease, summarizeExecution };
