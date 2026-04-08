'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');

function openMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

test('applyWikiSchema is idempotent — two calls do not throw', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);
  applyWikiSchema(db); // must not throw
  db.close();
});

test('wiki_pages table exists after applyWikiSchema', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);

  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'"
  ).get();
  assert.ok(row, 'wiki_pages table should exist');
  db.close();
});

test('wiki_topics table exists after applyWikiSchema', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);

  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_topics'"
  ).get();
  assert.ok(row, 'wiki_topics table should exist');
  db.close();
});

test('INSERT wiki_pages creates corresponding FTS row', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);

  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic)
    VALUES ('wp_001', 'session-management', 'Session Management', 'Sessions are managed via daemon.js.', 'session')
  `).run();

  // Retrieve the rowid of the inserted page
  const page = db.prepare("SELECT rowid FROM wiki_pages WHERE id='wp_001'").get();
  assert.ok(page, 'wiki_pages row should exist');

  // FTS should contain an entry with matching rowid
  const ftsRow = db.prepare('SELECT rowid FROM wiki_pages_fts WHERE rowid = ?').get(page.rowid);
  assert.ok(ftsRow, 'wiki_pages_fts should contain rowid after INSERT');
  db.close();
});

test('UPDATE wiki_pages syncs content to FTS', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);

  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic)
    VALUES ('wp_002', 'memory-system', 'Memory System', 'Initial content.', 'memory')
  `).run();

  db.prepare(`
    UPDATE wiki_pages SET content = 'Updated content about memory.' WHERE id = 'wp_002'
  `).run();

  const page = db.prepare("SELECT rowid, content FROM wiki_pages WHERE id='wp_002'").get();

  // Verify the wiki_pages row has been updated
  assert.equal(page.content, 'Updated content about memory.', 'wiki_pages content should be updated');

  // FTS rowid entry should still exist after UPDATE (trigger deleted old + inserted new)
  const ftsRow = db.prepare('SELECT rowid FROM wiki_pages_fts WHERE rowid = ?').get(page.rowid);
  assert.ok(ftsRow, 'wiki_pages_fts should still contain rowid after UPDATE trigger');
  assert.equal(ftsRow.rowid, page.rowid);
  db.close();
});

test('DELETE wiki_pages removes rowid from FTS', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);

  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic)
    VALUES ('wp_003', 'topic-gc', 'Topic GC', 'GC removes stale topics.', 'gc')
  `).run();

  const page = db.prepare("SELECT rowid FROM wiki_pages WHERE id='wp_003'").get();
  const savedRowid = page.rowid;

  db.prepare("DELETE FROM wiki_pages WHERE id='wp_003'").run();

  // After DELETE, FTS rowid lookup should return nothing
  const ftsRow = db.prepare('SELECT rowid FROM wiki_pages_fts WHERE rowid = ?').get(savedRowid);
  assert.equal(ftsRow, undefined, 'wiki_pages_fts rowid should be gone after DELETE');
  db.close();
});
