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

test('session_sources table exists after applyWikiSchema', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);

  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_sources'"
  ).get();
  assert.ok(row, 'session_sources table should exist');
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

  // FTS content should reflect updated text (trigger deleted old + inserted new)
  const ftsMatch = db.prepare(
    "SELECT rowid FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'Updated'"
  ).get();
  assert.ok(ftsMatch, 'wiki_pages_fts should match updated content after UPDATE trigger');
  assert.equal(ftsMatch.rowid, page.rowid, 'matched rowid should equal wiki_pages rowid');

  // Old content should no longer match
  const oldMatch = db.prepare(
    "SELECT rowid FROM wiki_pages_fts WHERE wiki_pages_fts MATCH 'Initial'"
  ).get();
  assert.equal(oldMatch, undefined, 'old content should not match in FTS after UPDATE');
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

test('recall_audit table exists after applyWikiSchema', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='recall_audit'"
  ).get();
  assert.ok(row, 'recall_audit table should exist');
  db.close();
});

test('recall_audit accepts observe-only insert with hashed/redacted columns', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);
  db.prepare(`
    INSERT INTO recall_audit (id, phase, project, should_recall, router_reason, query_hashes, anchor_labels)
    VALUES ('ra_001', 'observe', 'metame', 1, 'explicit-history', '["abc123"]', '["fn:saveFacts"]')
  `).run();
  const row = db.prepare("SELECT phase, should_recall, router_reason, anchor_labels FROM recall_audit WHERE id='ra_001'").get();
  assert.equal(row.phase, 'observe');
  assert.equal(row.should_recall, 1);
  assert.equal(row.router_reason, 'explicit-history');
  assert.equal(row.anchor_labels, '["fn:saveFacts"]');
  db.close();
});

test('recall_audit rejects invalid outcome value via CHECK constraint', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);
  assert.throws(() => {
    db.prepare(`INSERT INTO recall_audit (id, outcome) VALUES ('ra_bad', 'totally-invalid')`).run();
  }, /CHECK constraint/);
  db.close();
});

test('memory_review_decisions table exists after applyWikiSchema', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_review_decisions'"
  ).get();
  assert.ok(row, 'memory_review_decisions table should exist');
  db.close();
});

test('memory_review_decisions enforces decision CHECK and primary key', () => {
  const db = openMemoryDb();
  applyWikiSchema(db);
  db.prepare(`
    INSERT INTO memory_review_decisions (content_hash, item_id, decision)
    VALUES ('h1', 'item_a', 'promoted')
  `).run();
  // duplicate content_hash blocked
  assert.throws(() => {
    db.prepare(`INSERT INTO memory_review_decisions (content_hash, item_id, decision)
                VALUES ('h1', 'item_b', 'promoted')`).run();
  }, /UNIQUE|PRIMARY/);
  // invalid decision blocked
  assert.throws(() => {
    db.prepare(`INSERT INTO memory_review_decisions (content_hash, item_id, decision)
                VALUES ('h2', 'item_c', 'maybe')`).run();
  }, /CHECK constraint/);
  // INSERT OR IGNORE on duplicate is no-op (idempotency contract)
  db.prepare(`INSERT OR IGNORE INTO memory_review_decisions (content_hash, item_id, decision)
              VALUES ('h1', 'item_a', 'promoted')`).run();
  const count = db.prepare(`SELECT COUNT(*) AS n FROM memory_review_decisions WHERE content_hash='h1'`).get();
  assert.equal(count.n, 1);
  db.close();
});

test('memory_items.archive_reason ALTER is idempotent and adds nullable column', () => {
  const db = openMemoryDb();
  // Simulate memory.js creating memory_items first.
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'candidate',
      content TEXT NOT NULL,
      supersedes_id TEXT
    )
  `);
  applyWikiSchema(db);
  applyWikiSchema(db); // second call must not throw

  // Verify column exists by inserting a row with archive_reason set.
  db.prepare(`INSERT INTO memory_items (id, kind, content, archive_reason) VALUES ('mi_1', 'fact', 'x', 'aged_out')`).run();
  const row = db.prepare(`SELECT archive_reason FROM memory_items WHERE id='mi_1'`).get();
  assert.equal(row.archive_reason, 'aged_out');

  // NULL semantics: legacy archive without reason.
  db.prepare(`INSERT INTO memory_items (id, kind, content) VALUES ('mi_legacy', 'fact', 'x')`).run();
  const legacy = db.prepare(`SELECT archive_reason FROM memory_items WHERE id='mi_legacy'`).get();
  assert.equal(legacy.archive_reason, null);
  db.close();
});

test('archive_reason ALTER does not throw when memory_items does not exist (table-absent path)', () => {
  const db = openMemoryDb();
  applyWikiSchema(db); // memory_items absent — ALTER should be swallowed silently
  db.close();
});
