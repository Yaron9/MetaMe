'use strict';

require('./test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { ingestSessionSource } = require('./cognitive-ingestion');

function fixtureDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyWikiSchema(db);
  return db;
}

function fixtureAdapter({ revision = 'rev-1', valid = true, events = [] } = {}) {
  return {
    engineId: 'fixture-agent',
    probe: () => ({ state: 'verified' }),
    discover: () => [],
    inspect: ref => ({ ...ref, sourceHash: revision, sourceSize: events.length, cursor: { sequence: events.length } }),
    read: async function* read() {
      for (const event of events) yield event;
    },
    validate: () => valid ? ({ valid: true }) : ({ valid: false, errorCode: 'SOURCE_MISSING', detail: 'fixture removed' }),
  };
}

test('ingestion seam fingerprints, leases, canonicalizes, and completes one revision', async () => {
  const db = fixtureDb();
  const result = await ingestSessionSource({
    db,
    adapter: fixtureAdapter({ events: [
      { actor: 'user', kind: 'message', text: 'question', sequence: 0 },
      { actor: 'assistant', kind: 'message', text: 'answer', sequence: 1 },
    ] }),
    sessionRef: { nativeSessionId: 'native-1', sourceLocator: { opaque: 'fixture' } },
    pipelineVersion: 'v1',
    now: '2026-01-01T00:00:00Z',
  });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 2);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.processing_identity, '["fixture-agent","native-1","rev-1","v1"]');

  const replay = await ingestSessionSource({
    db,
    adapter: fixtureAdapter({ events: [
      { actor: 'user', kind: 'message', text: 'question', sequence: 0 },
      { actor: 'assistant', kind: 'message', text: 'answer', sequence: 1 },
    ] }),
    sessionRef: { nativeSessionId: 'native-1', sourceLocator: { opaque: 'fixture' } },
    pipelineVersion: 'v1',
    now: '2026-01-01T00:01:00Z',
  });
  assert.equal(replay.skipped, true);
  assert.equal(replay.run.status, 'completed');
  db.close();
});

test('changed revision and pipeline version are independently eligible', async () => {
  const db = fixtureDb();
  const options = {
    db,
    sessionRef: { nativeSessionId: 'native-1', sourceLocator: { opaque: 'fixture' } },
    pipelineVersion: 'v1',
    now: '2026-01-01T00:00:00Z',
  };
  const first = await ingestSessionSource({ ...options, adapter: fixtureAdapter({ revision: 'rev-1', events: [{ actor: 'user', kind: 'message', text: 'one' }] }) });
  const changed = await ingestSessionSource({ ...options, now: '2026-01-01T00:02:00Z', adapter: fixtureAdapter({ revision: 'rev-2', events: [{ actor: 'user', kind: 'message', text: 'two' }] }) });
  const pipeline = await ingestSessionSource({ ...options, now: '2026-01-01T00:03:00Z', pipelineVersion: 'v2', adapter: fixtureAdapter({ revision: 'rev-1', events: [{ actor: 'user', kind: 'message', text: 'one' }] }) });
  assert.equal(first.ok, true);
  assert.equal(changed.ok, true);
  assert.equal(pipeline.ok, true);
  assert.notEqual(first.sourceId, changed.sourceId);
  assert.notEqual(first.run.id, pipeline.run.id);
  db.close();
});

test('missing source preserves a readable source row and does not create an extraction run', async () => {
  const db = fixtureDb();
  const result = await ingestSessionSource({
    db,
    adapter: fixtureAdapter({ valid: false }),
    sessionRef: { nativeSessionId: 'gone', sourceLocator: { opaque: 'removed' } },
    pipelineVersion: 'v1',
    now: '2026-01-01T00:00:00Z',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SOURCE_MISSING');
  const row = db.prepare('SELECT source_state, error_code FROM session_sources WHERE id=?').get(result.sourceId);
  assert.equal(row.source_state, 'missing');
  assert.equal(row.error_code, 'SOURCE_MISSING');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get().n, 0);
  db.close();
});
