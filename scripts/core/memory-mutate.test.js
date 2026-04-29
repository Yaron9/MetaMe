'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { archiveMemoryItem } = require('./memory-mutate');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE memory_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'candidate',
      content         TEXT NOT NULL,
      supersedes_id   TEXT,
      archive_reason  TEXT,
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return db;
}

function insertItem(db, id, state = 'active') {
  db.prepare(
    `INSERT INTO memory_items (id, kind, state, content) VALUES (?, 'fact', ?, 'x')`
  ).run(id, state);
}

function getItem(db, id) {
  return db.prepare(`SELECT id, state, supersedes_id, archive_reason FROM memory_items WHERE id = ?`).get(id);
}

test('memory-mutate.archiveMemoryItem', async (t) => {
  await t.test('archives an active item with reason only', () => {
    const db = makeDb();
    insertItem(db, 'a1');
    archiveMemoryItem(db, 'a1', { reason: 'aged_out' });
    const row = getItem(db, 'a1');
    assert.equal(row.state, 'archived');
    assert.equal(row.archive_reason, 'aged_out');
    assert.equal(row.supersedes_id, null);
  });

  await t.test('archives with both supersededBy and reason', () => {
    const db = makeDb();
    insertItem(db, 'a1');
    insertItem(db, 'a2');
    archiveMemoryItem(db, 'a1', { supersededBy: 'a2', reason: 'merged_by_review' });
    const row = getItem(db, 'a1');
    assert.equal(row.state, 'archived');
    assert.equal(row.supersedes_id, 'a2');
    assert.equal(row.archive_reason, 'merged_by_review');
  });

  await t.test('archives without options leaves nullable fields untouched', () => {
    const db = makeDb();
    insertItem(db, 'a1');
    archiveMemoryItem(db, 'a1');
    const row = getItem(db, 'a1');
    assert.equal(row.state, 'archived');
    assert.equal(row.archive_reason, null);
    assert.equal(row.supersedes_id, null);
  });

  await t.test('does not overwrite existing supersedes_id when supersededBy is null', () => {
    const db = makeDb();
    insertItem(db, 'a1');
    db.prepare(`UPDATE memory_items SET supersedes_id = 'preexisting' WHERE id = ?`).run('a1');
    archiveMemoryItem(db, 'a1', { reason: 'aged_out' });
    const row = getItem(db, 'a1');
    assert.equal(row.supersedes_id, 'preexisting');
    assert.equal(row.archive_reason, 'aged_out');
  });

  await t.test('idempotent: archiving an already-archived item is safe', () => {
    const db = makeDb();
    insertItem(db, 'a1');
    archiveMemoryItem(db, 'a1', { reason: 'first' });
    archiveMemoryItem(db, 'a1', { reason: 'second' });
    const row = getItem(db, 'a1');
    assert.equal(row.state, 'archived');
    assert.equal(row.archive_reason, 'second');
  });

  await t.test('refreshes updated_at on archive', () => {
    const db = makeDb();
    insertItem(db, 'a1');
    const sentinelStamp = '2020-01-01 00:00:00';
    db.prepare(`UPDATE memory_items SET updated_at = ? WHERE id='a1'`).run(sentinelStamp);
    archiveMemoryItem(db, 'a1', { reason: 'x' });
    const after = db.prepare(`SELECT updated_at FROM memory_items WHERE id='a1'`).get().updated_at;
    assert.notEqual(after, sentinelStamp);
  });

  await t.test('throws TypeError on bad db', () => {
    assert.throws(() => archiveMemoryItem(null, 'a1', {}), TypeError);
    assert.throws(() => archiveMemoryItem({}, 'a1', {}), TypeError);
  });

  await t.test('throws TypeError on bad id', () => {
    const db = makeDb();
    assert.throws(() => archiveMemoryItem(db, '', {}), TypeError);
    assert.throws(() => archiveMemoryItem(db, null, {}), TypeError);
    assert.throws(() => archiveMemoryItem(db, 42, {}), TypeError);
  });

  await t.test('archiving a non-existent id is a no-op (does not throw)', () => {
    const db = makeDb();
    archiveMemoryItem(db, 'does-not-exist', { reason: 'x' });
    // No assertion needed; absence of throw is the contract.
  });
});
