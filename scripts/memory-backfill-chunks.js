#!/usr/bin/env node

'use strict';

const path = require('path');
const os = require('os');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

function findPagesWithoutChunks(db) {
  return db.prepare(`
    SELECT wp.slug, wp.content
    FROM wiki_pages wp
    WHERE wp.content IS NOT NULL
      AND wp.content != ''
      AND NOT EXISTS (
        SELECT 1 FROM content_chunks cc WHERE cc.page_slug = wp.slug
      )
    ORDER BY wp.slug
  `).all();
}

function runBackfill({
  dbPath = DEFAULT_DB_PATH,
  dryRun = false,
  idFactory,
} = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const { applyWikiSchema } = require('./memory-wiki-schema');
  const { enqueueContentChunks } = require('./core/wiki-chunks');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');
  applyWikiSchema(db);

  const pages = findPagesWithoutChunks(db);
  if (dryRun || pages.length === 0) {
    db.close();
    return { pages: pages.length, chunks: 0, dryRun };
  }

  let totalChunks = 0;
  db.prepare('BEGIN').run();
  try {
    for (const page of pages) {
      totalChunks += enqueueContentChunks(db, page.slug, page.content, { idFactory }).length;
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch { /* ignore rollback failure */ }
    db.close();
    throw err;
  }

  db.close();
  return { pages: pages.length, chunks: totalChunks, dryRun: false };
}

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    dbPath: argv.find(arg => arg.startsWith('--db='))?.slice('--db='.length) || DEFAULT_DB_PATH,
  };
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const result = runBackfill(opts);
  if (result.pages === 0) {
    console.log('All wiki pages already have chunks. Nothing to backfill.');
    return;
  }
  if (result.dryRun) {
    console.log(`Would backfill ${result.pages} wiki pages.`);
    return;
  }
  console.log(`Done. Created ${result.chunks} chunks for ${result.pages} pages. Run daemon-embedding.js to generate embeddings.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`Backfill failed: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { findPagesWithoutChunks, runBackfill, parseArgs };
