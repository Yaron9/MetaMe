#!/usr/bin/env node

'use strict';

/**
 * memory-backfill-chunks.js — One-time backfill for existing wiki pages
 *
 * For each wiki page that has content but no content_chunks rows:
 * 1. Splits content into chunks via recursive chunker
 * 2. Inserts chunk rows
 * 3. Enqueues each chunk for embedding generation
 *
 * Idempotent: pages with existing chunks are skipped.
 *
 * Usage: node scripts/memory-backfill-chunks.js
 */

const path = require('path');
const os = require('os');

const DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

function main() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');

  // Ensure schema is up to date
  try {
    const { applyWikiSchema } = require('./memory-wiki-schema');
    applyWikiSchema(db);
  } catch (err) {
    process.stderr.write(`Schema init failed: ${err.message}\n`);
    db.close();
    process.exit(1);
  }

  const { chunkText } = require('./core/chunker');

  // Find pages without chunks
  const pages = db.prepare(`
    SELECT wp.slug, wp.content
    FROM wiki_pages wp
    WHERE wp.content IS NOT NULL
      AND wp.content != ''
      AND NOT EXISTS (
        SELECT 1 FROM content_chunks cc WHERE cc.page_slug = wp.slug
      )
  `).all();

  if (pages.length === 0) {
    console.log('All wiki pages already have chunks. Nothing to backfill.');
    db.close();
    return;
  }

  console.log(`Backfilling ${pages.length} wiki pages...`);

  const insertChunk = db.prepare(
    'INSERT INTO content_chunks (id, page_slug, chunk_text, chunk_idx) VALUES (?, ?, ?, ?)',
  );
  const enqueue = db.prepare(
    "INSERT INTO embedding_queue (item_type, item_id) VALUES ('chunk', ?)",
  );

  let totalChunks = 0;

  db.prepare('BEGIN').run();
  try {
    for (const page of pages) {
      const chunks = chunkText(page.content, { targetWords: 300 });
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = `ck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        insertChunk.run(chunkId, page.slug, chunks[i], i);
        enqueue.run(chunkId);
        totalChunks++;
      }
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch { }
    process.stderr.write(`Backfill failed: ${err.message}\n`);
    db.close();
    process.exit(1);
  }

  console.log(`Done. Created ${totalChunks} chunks for ${pages.length} pages. Run daemon-embedding.js to generate embeddings.`);
  db.close();
}

main();
