'use strict';

/**
 * memory-track-search.test.js — verifies the trackSearch parameter on
 * searchMemoryItems / searchFacts / searchSessions per v4.1 §P1.3.
 *
 * Recall facade (Step 10) MUST pass trackSearch:false so prompt-bound
 * recall paths never reverse-pollute hot-fact distillation. Existing
 * callers (no trackSearch arg) get default true, preserving baseline.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function withFreshMemoryHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-track-search-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  delete require.cache[require.resolve('./memory')];
  delete require.cache[require.resolve('./memory-wiki-schema')];
  const memory = require('./memory');
  // Open a SECOND read-only handle to the same DB for assertions; the memory module
  // owns its own primary handle. SQLite WAL mode permits concurrent readers.
  const inspectDbPath = () => path.join(tmpDir, '.metame', 'memory.db');
  const inspect = () => {
    if (!fs.existsSync(inspectDbPath())) return null;
    return new DatabaseSync(inspectDbPath(), { readOnly: true });
  };
  try {
    fn(memory, inspect);
  } finally {
    process.env.HOME = prevHome;
    delete require.cache[require.resolve('./memory')];
    delete require.cache[require.resolve('./memory-wiki-schema')];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function seedItems(memory) {
  // saveMemoryItem with explicit state='active' bypasses the candidate/active
  // state machine; default search filters state='active' so this is the
  // shortest path to a row that surfaces in tests.
  memory.saveMemoryItem({
    id: 'mi_fact_1',
    kind: 'convention',
    state: 'active',
    title: 'searchFacts returns',
    content: 'fact rows about queries that match returns keyword',
    project: 'metame',
    scope: 'main',
  });
  memory.saveMemoryItem({
    id: 'mi_fact_2',
    kind: 'insight',
    state: 'active',
    title: 'recall never bumps',
    content: 'recall should never bump search_count when called from prompt path',
    project: 'metame',
    scope: 'main',
  });
}

function getAllCounts(inspect) {
  const db = inspect();
  if (!db) return [];
  try {
    return db.prepare(`SELECT id, search_count FROM memory_items ORDER BY id`).all();
  } finally {
    db.close();
  }
}

test('searchMemoryItems trackSearch parameter', async (t) => {
  await t.test('default (trackSearch=true) bumps search_count', () => {
    withFreshMemoryHome((memory, inspect) => {
      seedItems(memory);
      const before = getAllCounts(inspect);
      memory.searchMemoryItems('returns');
      const after = getAllCounts(inspect);
      // At least one row's count increased.
      const changed = after.some((row, i) => row.search_count > (before[i] && before[i].search_count) || 0);
      assert.ok(changed, 'default trackSearch should bump at least one search_count');
    });
  });

  await t.test('trackSearch=false leaves search_count unchanged', () => {
    withFreshMemoryHome((memory, inspect) => {
      seedItems(memory);
      const before = getAllCounts(inspect);
      const rows = memory.searchMemoryItems('returns', { trackSearch: false });
      assert.ok(rows.length > 0, 'sanity: search returned rows');
      const after = getAllCounts(inspect);
      assert.deepEqual(after, before, 'trackSearch:false must not bump any search_count');
    });
  });
});

test('searchFacts trackSearch parameter', async (t) => {
  await t.test('default trackSearch bumps; trackSearch:false does not', () => {
    withFreshMemoryHome((memory, inspect) => {
      seedItems(memory);
      const before = getAllCounts(inspect);
      const facts1 = memory.searchFacts('returns', { trackSearch: false });
      assert.ok(facts1.length > 0, 'sanity: searchFacts returned facts');
      const after1 = getAllCounts(inspect);
      assert.deepEqual(after1, before, 'trackSearch:false: no count delta');

      memory.searchFacts('returns');
      const after2 = getAllCounts(inspect);
      const changed = after2.some((row, i) => row.search_count > (after1[i] && after1[i].search_count) || 0);
      assert.ok(changed, 'default: at least one count bumps');
    });
  });
});

test('searchSessions trackSearch parameter', async (t) => {
  await t.test('default trackSearch bumps; trackSearch:false does not', () => {
    withFreshMemoryHome((memory, inspect) => {
      memory.saveSession({
        sessionId: 'sess_episode_1',
        project: 'metame',
        scope: 'main',
        summary: 'session content for searchSessions',
        keywords: 'session,content',
      });
      const before = getAllCounts(inspect);
      const rows1 = memory.searchSessions('content', { trackSearch: false });
      assert.ok(rows1.length > 0, 'sanity: searchSessions returned rows');
      const after1 = getAllCounts(inspect);
      assert.deepEqual(after1, before, 'trackSearch:false: no count delta');

      memory.searchSessions('content');
      const after2 = getAllCounts(inspect);
      const changed = after2.some((row, i) => row.search_count > (after1[i] && after1[i].search_count) || 0);
      assert.ok(changed, 'default: at least one count bumps');
    });
  });
});
