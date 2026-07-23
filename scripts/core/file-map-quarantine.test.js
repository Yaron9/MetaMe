'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { quarantinePathFor, planQuarantineMoves, planRestore, planPurge } = require('./file-map-quarantine');

const NOW = Date.parse('2026-07-18T00:00:00Z');
const DAY = 24 * 3600 * 1000;

describe('file-map-quarantine plans', () => {
  it('derives an opaque destination that stays inside the batch dir', () => {
    const first = quarantinePathFor('/q', 'b-20260718-abab', '/Users/u/Downloads/x.dmg');
    assert.match(first, /^\/q\/b-20260718-abab\/[0-9a-f]{64}--x\.dmg$/);
    const hostile = quarantinePathFor('/q', 'b-20260718-abab', '/Users/u/a/../../../../Users/u/x');
    assert.ok(hostile.startsWith('/q/b-20260718-abab/'));
    const moves = planQuarantineMoves([{ path: '/a/1' }, { path: '/b/2' }], '/q', 'bid');
    assert.equal(moves.length, 2);
    assert.ok(moves.every(m => m.to.startsWith('/q/bid/')));
    assert.notEqual(moves[0].to, moves[1].to);
  });

  it('planRestore only touches moved items and honors the subset filter', () => {
    const manifest = {
      items: [
        { path: '/a/1', result: 'moved', quarantine_path: '/q/b/a/1' },
        { path: '/a/2', result: 'skipped:missing', quarantine_path: null },
        { path: '/a/3', result: 'moved', quarantine_path: '/q/b/a/3' },
      ],
    };
    assert.deepEqual(planRestore(manifest).map(m => m.path), ['/a/1', '/a/3']);
    assert.deepEqual(planRestore(manifest, { paths: ['/a/3'] }).map(m => m.path), ['/a/3']);
    assert.deepEqual(planRestore(manifest, { paths: [] }).map(m => m.path), ['/a/1', '/a/3'], 'empty subset means all');
  });

  it('planPurge selects only executed batches past retention', () => {
    const manifests = [
      { batch_id: 'old', status: 'executed', executed_at: new Date(NOW - 31 * DAY).toISOString(), items: [{ result: 'moved', quarantine_path: '/q/old' }] },
      { batch_id: 'young', status: 'executed', executed_at: new Date(NOW - 5 * DAY).toISOString(), items: [{ result: 'moved', quarantine_path: '/q/young' }] },
      { batch_id: 'restored', status: 'restored', executed_at: new Date(NOW - 90 * DAY).toISOString(), items: [] },
      { batch_id: 'broken', status: 'executed', executed_at: null, items: [] },
    ];
    const due = planPurge(manifests, { quarantineDays: 30, nowMs: NOW });
    assert.deepEqual(due.map(m => m.batch_id), ['old']);
  });

  it('never schedules native-only manifests for quarantine purge', () => {
    const manifests = [{
      batch_id: 'native', status: 'executed', executed_at: new Date(NOW - 40 * DAY).toISOString(),
      items: [{ action_type: 'native_adapter', result: 'cleaned', quarantine_path: null }],
    }];
    assert.deepEqual(planPurge(manifests, { quarantineDays: 30, nowMs: NOW }), []);
  });
});
