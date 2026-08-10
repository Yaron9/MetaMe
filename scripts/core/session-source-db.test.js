'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('../memory-wiki-schema');
const {
  ensureSessionSourceSchema,
  upsertSessionSource,
  getSessionSource,
  findSessionSources,
  markSessionSourceStatus,
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

test('source schema ownership is separate from extraction-run schema ownership', () => {
  const db = new DatabaseSync(':memory:');
  ensureSessionSourceSchema(db);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_sources'").get());
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_runs'").get(), undefined);
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

test('numeric zero discovery cursor survives source persistence and restart lookup', () => {
  const db = openDb();
  const source = upsertSessionSource(db, {
    engine: 'fixture-agent', sessionId: 'zero-cursor', sourceHash: 'rev-zero', discoveryCursor: 0,
  });
  const row = getSessionSource(db, { engine: 'fixture-agent', sessionId: 'zero-cursor', sourceHash: 'rev-zero' });
  assert.equal(row.discovery_cursor_value, 0);
  assert.equal(db.prepare('SELECT discovery_cursor FROM session_sources WHERE id=?').get(source.id).discovery_cursor, '@number:0');
  db.close();
});

test('source locators remain opaque across object and array serialization', () => {
  const db = openDb();
  const locator = { database: 'native', path: ['sessions', 0], key: { id: 'opaque' } };
  const objectSource = upsertSessionSource(db, {
    engine: 'fixture-agent', sessionId: 'object-locator', sourceHash: 'rev-object', sourceLocator: locator,
  });
  const arrayLocator = ['workspace', { row: 4 }, false];
  const arraySource = upsertSessionSource(db, {
    engine: 'fixture-agent', sessionId: 'array-locator', sourceHash: 'rev-array', sourceLocator: arrayLocator,
  });
  const objectRow = getSessionSource(db, { engine: 'fixture-agent', sessionId: 'object-locator', sourceHash: 'rev-object' });
  const arrayRow = getSessionSource(db, { engine: 'fixture-agent', sessionId: 'array-locator', sourceHash: 'rev-array' });
  assert.deepEqual(objectRow.sourceLocator, locator);
  assert.deepEqual(objectRow.source_locator_value, locator);
  assert.deepEqual(arrayRow.sourceLocator, arrayLocator);
  assert.deepEqual(arrayRow.source_locator_value, arrayLocator);
  assert.notEqual(objectSource.id, arraySource.id);
  db.close();
});
