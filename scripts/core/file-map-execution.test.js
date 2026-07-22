'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileMoving, canReclaimLease, summarizeExecution } = require('./file-map-execution');

describe('file-map execution recovery', () => {
  it('reconciles every quarantine crash state without guessing', () => {
    assert.deepEqual(reconcileMoving({ sourceExists: true, destinationExists: false, method: 'quarantine' }), { action: 'retry' });
    assert.deepEqual(reconcileMoving({ sourceExists: false, destinationExists: true, method: 'quarantine' }), { action: 'complete', result: 'moved' });
    assert.equal(reconcileMoving({ sourceExists: true, destinationExists: true, method: 'quarantine' }).action, 'conflict');
    assert.equal(reconcileMoving({ sourceExists: false, destinationExists: false, method: 'quarantine' }).action, 'conflict');
  });

  it('treats a missing trash source as completed and an existing one as retryable', () => {
    assert.deepEqual(reconcileMoving({ sourceExists: false, destinationExists: false, method: 'trash' }), { action: 'complete', result: 'trashed' });
    assert.deepEqual(reconcileMoving({ sourceExists: true, destinationExists: false, method: 'trash' }), { action: 'retry' });
  });

  it('only reclaims an expired lease whose process is gone', () => {
    const lease = { pid: 42, started_ms: 1000 };
    assert.equal(canReclaimLease(lease, { nowMs: 2000, leaseMs: 5000, isPidAlive: () => false }), false);
    assert.equal(canReclaimLease(lease, { nowMs: 7000, leaseMs: 5000, isPidAlive: () => true }), false);
    assert.equal(canReclaimLease(lease, { nowMs: 7000, leaseMs: 5000, isPidAlive: () => false }), true);
    assert.equal(canReclaimLease(null, { nowMs: 0, leaseMs: 1, isPidAlive: () => true }), true);
  });

  it('summarizes terminal item results', () => {
    const out = summarizeExecution([
      { path: '/a', size: 10, result: 'moved' },
      { path: '/b', size: 20, result: 'trashed' },
      { path: '/c', size: 30, result: 'skipped:mtime-changed' },
    ]);
    assert.deepEqual(out, { moved: 2, bytesFreed: 30, skipped: [{ path: '/c', reason: 'mtime-changed' }] });
  });
});
