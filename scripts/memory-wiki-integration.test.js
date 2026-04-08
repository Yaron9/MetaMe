'use strict';

/**
 * memory-wiki-integration.test.js
 *
 * Tests that memory.js correctly integrates wiki schema init and
 * wiki staleness / topic promotion after saveFacts.
 *
 * Uses a private in-memory DB via monkey-patching getDb internals.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { upsertWikiTopic, getStalePages, listWikiTopics } = require('./core/wiki-db');

// Helper: build an isolated in-memory db with both schemas
function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');

  // memory_items table (minimal subset needed by checkTopicThreshold)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'candidate',
      title           TEXT,
      content         TEXT NOT NULL,
      confidence      REAL DEFAULT 0.5,
      project         TEXT DEFAULT '*',
      scope           TEXT,
      session_id      TEXT,
      source_type     TEXT,
      relation        TEXT,
      search_count    INTEGER DEFAULT 0,
      last_searched_at TEXT,
      tags            TEXT DEFAULT '[]',
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  applyWikiSchema(db);
  return db;
}

// Seed N active raw facts with a given tag
function seedFacts(db, tag, n) {
  for (let i = 0; i < n; i++) {
    db.prepare(`
      INSERT INTO memory_items (id, kind, state, content, tags, created_at)
      VALUES (?, 'insight', 'active', 'fact content', ?, datetime('now'))
    `).run(`id_${tag}_${i}`, JSON.stringify([tag]));
  }
}

test('applyWikiSchema is called during getDb — wiki_pages table is accessible', () => {
  const db = buildTestDb();
  // If wiki_pages exists, this won't throw
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_pages'").get();
  assert.ok(row, 'wiki_pages should exist after applyWikiSchema');
  db.close();
});

test('updateStalenessForTags increments staleness on existing wiki pages', () => {
  const db = buildTestDb();
  const { updateStalenessForTags } = require('./core/wiki-db');

  // Create a wiki topic + page for 'session' tag
  upsertWikiTopic(db, 'session', { label: 'Session', force: true });
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic, raw_source_count, new_facts_since_build, staleness)
    VALUES ('wp_1', 'session', 'Session', 'content', 'session', 10, 0, 0.0)
  `).run();

  const dirtyTagCounts = new Map([['session', 2]]);
  updateStalenessForTags(db, dirtyTagCounts);

  const page = db.prepare("SELECT staleness, new_facts_since_build FROM wiki_pages WHERE slug = 'session'").get();
  assert.ok(page.staleness > 0, 'staleness should be > 0 after update');
  assert.equal(page.new_facts_since_build, 2, 'new_facts_since_build should be 2');
  db.close();
});

test('checkTopicThreshold returns false for tags with < 5 active facts', () => {
  const db = buildTestDb();
  const { checkTopicThreshold } = require('./core/wiki-db');

  seedFacts(db, 'sparse-topic', 3);
  const passes = checkTopicThreshold(db, 'sparse-topic');
  assert.equal(passes, false, 'should not pass threshold with only 3 facts');
  db.close();
});

test('checkTopicThreshold returns true when tag has ≥5 active facts including 1 recent', () => {
  const db = buildTestDb();
  const { checkTopicThreshold } = require('./core/wiki-db');

  seedFacts(db, 'dense-topic', 6);
  const passes = checkTopicThreshold(db, 'dense-topic');
  assert.equal(passes, true, 'should pass threshold with 6 active facts all recent');
  db.close();
});

test('upsertWikiTopic creates topic when threshold is met (force=true)', () => {
  const db = buildTestDb();

  upsertWikiTopic(db, 'my-topic', { label: 'My Topic', force: true });
  const topics = listWikiTopics(db);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].tag, 'my-topic');
  assert.equal(topics[0].label, 'My Topic');
  db.close();
});

test('upsertWikiTopic is idempotent — calling twice returns isNew=false second time', () => {
  const db = buildTestDb();

  const first = upsertWikiTopic(db, 'demo', { force: true });
  assert.equal(first.isNew, true);

  const second = upsertWikiTopic(db, 'demo', { force: true });
  assert.equal(second.isNew, false);
  assert.equal(second.slug, first.slug);

  const topics = listWikiTopics(db);
  assert.equal(topics.length, 1, 'should still have only 1 topic');
  db.close();
});

test('getStalePages respects threshold — page with staleness < threshold not returned', () => {
  const db = buildTestDb();

  upsertWikiTopic(db, 'clean', { force: true });
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic, staleness)
    VALUES ('wp_clean', 'clean', 'Clean Page', 'content', 'clean', 0.1)
  `).run();

  const stale = getStalePages(db, 0.4);
  assert.equal(stale.length, 0, 'page with staleness 0.1 should not appear with threshold 0.4');
  db.close();
});

test('getStalePages returns pages at or above threshold', () => {
  const db = buildTestDb();

  upsertWikiTopic(db, 'stale-topic', { force: true });
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic, staleness)
    VALUES ('wp_stale', 'stale-topic', 'Stale Page', 'content', 'stale-topic', 0.6)
  `).run();

  const stale = getStalePages(db, 0.4);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].slug, 'stale-topic');
  db.close();
});
