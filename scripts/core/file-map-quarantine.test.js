'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { quarantinePathFor, planQuarantineMoves, planRestore, planPurge } = require('./file-map-quarantine');

const NOW = Date.parse('2026-07-18T00:00:00Z');
const DAY = 24 * 3600 * 1000;

describe('file-map-quarantine plans', () => {
  it('mirrors the absolute original path under the batch dir', () => {
    assert.equal(
      quarantinePathFor('/q', 'b-20260718-abab', '/Users/u/Downloads/x.dmg'),
      '/q/b-20260718-abab/Users/u/Downloads/x.dmg'
    );
    const moves = planQuarantineMoves([{ path: '/a/1' }, { path: '/b/2' }], '/q', 'bid');
    assert.deepEqual(moves.map(m => m.to), ['/q/bid/a/1', '/q/bid/b/2']);
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
      { batch_id: 'old', status: 'executed', executed_at: new Date(NOW - 31 * DAY).toISOString() },
      { batch_id: 'young', status: 'executed', executed_at: new Date(NOW - 5 * DAY).toISOString() },
      { batch_id: 'restored', status: 'restored', executed_at: new Date(NOW - 90 * DAY).toISOString() },
      { batch_id: 'broken', status: 'executed', executed_at: null },
    ];
    const due = planPurge(manifests, { quarantineDays: 30, nowMs: NOW });
    assert.deepEqual(due.map(m => m.batch_id), ['old']);
  });
});
