'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('../memory-wiki-schema');
const { upsertSessionSource } = require('./session-source-db');
const {
  claimExtractionLease,
  completeExtractionRun,
  ensureExtractionRun,
  failExtractionRun,
  findExtractionRuns,
  getExtractionRun,
  recoverExpiredExtractionLeases,
} = require('./extraction-run-db');

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyWikiSchema(db);
  return db;
}

test('extraction identity is unique by source revision and pipeline version', () => {
  const db = openDb();
  const first = upsertSessionSource(db, { engine: 'fixture-agent', sessionId: 's', sourceHash: 'rev-1' });
  const nextRevision = upsertSessionSource(db, { engine: 'fixture-agent', sessionId: 's', sourceHash: 'rev-2' });
  const v1 = ensureExtractionRun(db, { sessionSourceId: first.id, pipelineVersion: 'v1', now: '2026-01-01T00:00:00Z' });
  const v1Again = ensureExtractionRun(db, { sessionSourceId: first.id, pipelineVersion: 'v1', now: '2026-01-01T00:00:01Z' });
  const v2 = ensureExtractionRun(db, { sessionSourceId: first.id, pipelineVersion: 'v2', now: '2026-01-01T00:00:00Z' });
  const revised = ensureExtractionRun(db, { sessionSourceId: nextRevision.id, pipelineVersion: 'v1', now: '2026-01-01T00:00:00Z' });
  assert.equal(v1.id, v1Again.id);
  assert.notEqual(v1.id, v2.id);
  assert.notEqual(v1.id, revised.id);
  assert.equal(findExtractionRuns(db).length, 3);
  db.close();
});

test('leases recover after expiry and terminal completion is idempotent', () => {
  const db = openDb();
  const source = upsertSessionSource(db, { engine: 'fixture-agent', sessionId: 'leased', sourceHash: 'rev-1' });
  const claimed = claimExtractionLease(db, {
    sessionSourceId: source.id, pipelineVersion: 'v1', leaseMs: 1000, now: '2026-01-01T00:00:00Z',
  });
  assert.equal(claimed.claimed, true);
  const held = claimExtractionLease(db, {
    sessionSourceId: source.id, pipelineVersion: 'v1', leaseMs: 1000, now: '2026-01-01T00:00:00.500Z',
  });
  assert.equal(held.reason, 'LEASE_HELD');
  assert.equal(recoverExpiredExtractionLeases(db, { now: '2026-01-01T00:00:02Z' }).recovered, 1);
  const recovered = claimExtractionLease(db, {
    sessionSourceId: source.id, pipelineVersion: 'v1', leaseMs: 1000, now: '2026-01-01T00:00:02Z',
  });
  assert.equal(recovered.run.attempt, 2);
  const done = completeExtractionRun(db, {
    runId: recovered.run.id,
    leaseToken: recovered.leaseToken,
    metrics: { events: 4, bytes: 90 },
    now: '2026-01-01T00:00:03Z',
  });
  assert.equal(done.run.status, 'completed');
  assert.deepEqual(done.run.metrics, { events: 4, bytes: 90 });
  const repeated = completeExtractionRun(db, { runId: recovered.run.id, now: '2026-01-01T00:00:04Z' });
  assert.equal(repeated.idempotent, true);
  assert.equal(getExtractionRun(db, recovered.run.id).status, 'completed');
  db.close();
});

test('failed extraction retains stable error and can be retried', () => {
  const db = openDb();
  const source = upsertSessionSource(db, { engine: 'fixture-agent', sessionId: 'failed', sourceHash: 'rev-1' });
  const claimed = claimExtractionLease(db, { sessionSourceId: source.id, pipelineVersion: 'v1', now: '2026-01-01T00:00:00Z' });
  const failed = failExtractionRun(db, {
    runId: claimed.run.id,
    leaseToken: claimed.leaseToken,
    errorCode: 'source/read timeout',
    errorMessage: '  source read timed out  ',
    metrics: { events: 1 },
    now: '2026-01-01T00:00:01Z',
  });
  assert.equal(failed.run.status, 'failed');
  assert.equal(failed.run.error_code, 'SOURCE_READ_TIMEOUT');
  assert.equal(failed.run.error_message, 'source read timed out');
  const retry = claimExtractionLease(db, { sessionSourceId: source.id, pipelineVersion: 'v1', now: '2026-01-01T00:00:02Z' });
  assert.equal(retry.claimed, true);
  db.close();
});
