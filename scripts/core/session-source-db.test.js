'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('../memory-wiki-schema');
const {
  claimExtractionLease,
  completeExtractionRun,
  ensureExtractionRun,
  ensureSessionSourceSchema,
  failExtractionRun,
  findExtractionRuns,
  upsertSessionSource,
  getSessionSource,
  getExtractionRun,
  findSessionSources,
  markSessionSourceStatus,
  recoverExpiredExtractionLeases,
  updateSessionSourceProgress,
  _internal,
} = require('./session-source-db');

function openDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyWikiSchema(db);
  return db;
}

test('upsertSessionSource inserts and reads provenance by stable key', () => {
  const db = openDb();
  const result = upsertSessionSource(db, {
    engine: 'claude',
    sessionId: 's1',
    project: 'metame',
    scope: 'proj_MetaMe',
    cwd: '/tmp/metame',
    sourcePath: '/tmp/s1.jsonl',
    sourceHash: 'abc123',
    sourceSize: 42,
    messageCount: 3,
    toolCallCount: 2,
    toolErrorCount: 1,
    firstTs: '2026-04-28T00:00:00.000Z',
    lastTs: '2026-04-28T00:01:00.000Z',
  });

  assert.equal(result.ok, true);
  const row = getSessionSource(db, { engine: 'claude', sessionId: 's1', sourceHash: 'abc123' });
  assert.equal(row.id, result.id);
  assert.equal(row.project, 'metame');
  assert.equal(row.message_count, 3);
  assert.equal(row.status, 'indexed');
  db.close();
});

test('upsertSessionSource is idempotent for engine session_id source_hash', () => {
  const db = openDb();
  const first = upsertSessionSource(db, {
    engine: 'codex',
    sessionId: 's2',
    sourceHash: 'same-hash',
    project: 'old',
  });
  const second = upsertSessionSource(db, {
    engine: 'codex',
    sessionId: 's2',
    sourceHash: 'same-hash',
    project: 'new',
    status: 'extracted',
  });

  assert.equal(second.id, first.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM session_sources').get().n;
  assert.equal(count, 1);
  const row = getSessionSource(db, { engine: 'codex', sessionId: 's2', sourceHash: 'same-hash' });
  assert.equal(row.project, 'new');
  assert.equal(row.status, 'extracted');
  db.close();
});

test('findSessionSources filters by project scope and engine', () => {
  const db = openDb();
  upsertSessionSource(db, { engine: 'claude', sessionId: 'a', sourceHash: 'h1', project: 'metame', scope: 's' });
  upsertSessionSource(db, { engine: 'codex', sessionId: 'b', sourceHash: 'h2', project: 'metame', scope: 's' });
  upsertSessionSource(db, { engine: 'claude', sessionId: 'c', sourceHash: 'h3', project: 'other', scope: 's' });

  const rows = findSessionSources(db, { project: 'metame', scope: 's', engine: 'claude' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 'a');
  db.close();
});

test('markSessionSourceStatus updates status and error message', () => {
  const db = openDb();
  const { id } = upsertSessionSource(db, { engine: 'claude', sessionId: 's3', sourceHash: 'h3' });
  const result = markSessionSourceStatus(db, id, 'error', 'model timeout');
  assert.equal(result.changed, 1);
  const row = getSessionSource(db, { engine: 'claude', sessionId: 's3', sourceHash: 'h3' });
  assert.equal(row.status, 'error');
  assert.equal(row.error_message, 'model timeout');
  db.close();
});

test('stableId normalizes invalid engines to unknown', () => {
  const id1 = _internal.stableId({ engine: 'bad', sessionId: 's', sourceHash: 'h' });
  const id2 = _internal.stableId({ engine: 'unknown', sessionId: 's', sourceHash: 'h' });
  assert.equal(id1, id2);
});

test('schema migration keeps old rows readable and accepts a new Engine ID', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE session_sources (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL DEFAULT 'unknown' CHECK (engine IN ('claude','codex','unknown')),
      session_id TEXT NOT NULL,
      project TEXT DEFAULT '*',
      source_path TEXT,
      source_hash TEXT NOT NULL,
      status TEXT DEFAULT 'indexed' CHECK (status IN ('indexed','summarized','extracted','error','archived')),
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(engine, session_id, source_hash)
    );
    INSERT INTO session_sources (id, engine, session_id, source_hash)
    VALUES ('legacy', 'claude', 'old-session', 'old-revision');
  `);
  ensureSessionSourceSchema(db);
  const legacy = getSessionSource(db, { engine: 'claude', sessionId: 'old-session', sourceHash: 'old-revision' });
  assert.equal(legacy.id, 'legacy');
  assert.equal(legacy.source_revision, 'old-revision');
  const modern = upsertSessionSource(db, { engine: 'pi', sessionId: 'pi-1', sourceHash: 'pi-rev' });
  assert.equal(getSessionSource(db, { engine: 'pi', sessionId: 'pi-1', sourceHash: 'pi-rev' }).id, modern.id);
  db.close();
});

test('source cursor and parent attribution persist without replacing history', () => {
  const db = openDb();
  const first = upsertSessionSource(db, {
    engine: 'fixture-agent', sessionId: 'parent', sourceHash: 'rev-1',
    discoveryCursor: { offset: 20, sequence: 3 }, lastIngestedSequence: 2,
  });
  const child = upsertSessionSource(db, {
    engine: 'fixture-agent', sessionId: 'child', sourceHash: 'rev-1', parentNativeSessionId: 'parent',
  });
  updateSessionSourceProgress(db, first.id, { discoveryCursor: { offset: 30, sequence: 4 }, lastIngestedSequence: 3 });
  const row = getSessionSource(db, { engine: 'fixture-agent', sessionId: 'parent', sourceHash: 'rev-1' });
  assert.deepEqual(row.discovery_cursor_value, { offset: 30, sequence: 4 });
  assert.equal(row.last_ingested_sequence, 3);
  assert.equal(getSessionSource(db, { engine: 'fixture-agent', sessionId: 'child', sourceHash: 'rev-1' }).parent_native_session_id, 'parent');
  assert.equal(findSessionSources(db, { engine: 'fixture-agent' }).length, 2);
  assert.equal(child.processingIdentity.engineId, 'fixture-agent');
  db.close();
});

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
