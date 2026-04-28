'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('../memory-wiki-schema');
const {
  upsertSessionSource,
  getSessionSource,
  findSessionSources,
  markSessionSourceStatus,
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
