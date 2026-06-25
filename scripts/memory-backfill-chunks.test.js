'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const { applyWikiSchema } = require('./memory-wiki-schema');
const { mkdtempForTest } = require('./test-support/test-utils');
const { parseArgs, runBackfill } = require('./memory-backfill-chunks');

function makeDb() {
  const dir = mkdtempForTest('metame-backfill-chunks-');
  const dbPath = path.join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  applyWikiSchema(db);
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic)
    VALUES (?, ?, ?, ?, ?)
  `).run('wp_missing', 'missing-chunks', 'Missing Chunks', 'alpha beta gamma', 'test');
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic)
    VALUES (?, ?, ?, ?, ?)
  `).run('wp_existing', 'existing-chunks', 'Existing Chunks', 'delta epsilon', 'test');
  db.prepare(`
    INSERT INTO content_chunks (id, page_slug, chunk_text, chunk_idx)
    VALUES (?, ?, ?, ?)
  `).run('ck_existing', 'existing-chunks', 'delta epsilon', 0);
  db.close();
  return { dir, dbPath };
}

function scalar(dbPath, sql) {
  const db = new DatabaseSync(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get().n;
  } finally {
    db.close();
  }
}

test('parseArgs supports dry-run and explicit db path', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--db=/tmp/memory.db']), {
    dryRun: true,
    dbPath: '/tmp/memory.db',
  });
});

test('runBackfill dry-run counts missing pages without writing chunks', () => {
  const { dir, dbPath } = makeDb();
  try {
    const result = runBackfill({ dbPath, dryRun: true });

    assert.deepEqual(result, { pages: 1, chunks: 0, dryRun: true });
    assert.equal(scalar(dbPath, 'SELECT COUNT(*) AS n FROM content_chunks'), 1);
    assert.equal(scalar(dbPath, 'SELECT COUNT(*) AS n FROM embedding_queue'), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runBackfill creates chunks only for pages missing chunks and is idempotent', () => {
  const { dir, dbPath } = makeDb();
  try {
    let n = 0;
    const result = runBackfill({
      dbPath,
      idFactory: ({ slug, index }) => `ck_${slug}_${index}_${++n}`,
    });

    assert.deepEqual(result, { pages: 1, chunks: 1, dryRun: false });
    assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM content_chunks WHERE page_slug='missing-chunks'"), 1);
    assert.equal(scalar(dbPath, "SELECT COUNT(*) AS n FROM content_chunks WHERE page_slug='existing-chunks'"), 1);
    assert.equal(scalar(dbPath, 'SELECT COUNT(*) AS n FROM embedding_queue'), 1);

    const second = runBackfill({ dbPath });
    assert.deepEqual(second, { pages: 0, chunks: 0, dryRun: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
