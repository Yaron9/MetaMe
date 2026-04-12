#!/usr/bin/env node

'use strict';

/**
 * daemon-embedding.js — Embedding queue consumer
 *
 * Processes pending items in embedding_queue:
 * 1. Reads batch from queue (attempts < 3)
 * 2. Fetches text from content_chunks
 * 3. Calls OpenAI embedding API
 * 4. Writes BLOB + metadata back to content_chunks
 * 5. Deletes completed queue rows; increments attempts on failure
 *
 * Designed to run as heartbeat task (interval: 30min) or post-wiki-reflect trigger.
 * Graceful degradation: no OPENAI_API_KEY → exits immediately, no error.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const DB_PATH = path.join(METAME_DIR, 'memory.db');
const LOCK_FILE = path.join(METAME_DIR, 'daemon-embedding.lock');
const LOG_FILE = path.join(METAME_DIR, 'embedding_log.jsonl');
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_BATCH = 50;

function loadModule(name) {
  const candidates = [
    path.join(HOME, '.metame', name),
    path.join(__dirname, name),
  ];
  for (const p of candidates) {
    try { return require(p); } catch { }
  }
  return null;
}

async function main() {
  const embedding = loadModule('core/embedding');
  if (!embedding || !embedding.isEmbeddingAvailable()) {
    // No API key — skip silently
    return;
  }

  // Atomic lock acquisition
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    // Lock exists — check if stale
    try {
      const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (lockAge < LOCK_TIMEOUT_MS) return; // another instance running
      fs.unlinkSync(LOCK_FILE);
      fs.openSync(LOCK_FILE, 'wx');
      fs.writeFileSync(LOCK_FILE, String(process.pid));
    } catch {
      return; // race lost or fs error
    }
  }

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');

    // Ensure schema exists
    try {
      const { applyWikiSchema } = loadModule('memory-wiki-schema') || {};
      if (applyWikiSchema) applyWikiSchema(db);
    } catch { }

    // Fetch pending queue items
    const pending = db.prepare(`
      SELECT eq.id AS queue_id, eq.item_type, eq.item_id, eq.model, eq.attempts,
             cc.chunk_text
      FROM embedding_queue eq
      JOIN content_chunks cc ON eq.item_id = cc.id
      WHERE eq.item_type = 'chunk'
        AND eq.attempts < 3
      ORDER BY eq.created_at ASC
      LIMIT ?
    `).all(MAX_BATCH);

    if (pending.length === 0) return;

    // Batch embed
    const texts = pending.map(p => p.chunk_text);
    let embeddings;
    try {
      embeddings = await embedding.batchEmbed(texts);
    } catch (err) {
      // API failure — increment attempts for all
      const updateAttempts = db.prepare(
        'UPDATE embedding_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?',
      );
      for (const p of pending) {
        updateAttempts.run(err.message.slice(0, 500), p.queue_id);
      }
      appendLog({ ts: new Date().toISOString(), error: err.message, batch_size: pending.length });
      return;
    }

    // Write results
    const updateChunk = db.prepare(`
      UPDATE content_chunks
      SET embedding = ?, embedding_model = ?, embedding_dim = ?
      WHERE id = ?
    `);
    const deleteQueue = db.prepare('DELETE FROM embedding_queue WHERE id = ?');
    const updateAttempts = db.prepare(
      'UPDATE embedding_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?',
    );

    let success = 0;
    let failed = 0;
    db.prepare('BEGIN').run();
    try {
      for (let i = 0; i < pending.length; i++) {
        const emb = embeddings[i];
        if (emb) {
          const buf = embedding.embeddingToBuffer(emb);
          updateChunk.run(buf, embedding.MODEL, embedding.DIMENSIONS, pending[i].item_id);
          deleteQueue.run(pending[i].queue_id);
          success++;
        } else {
          updateAttempts.run('null embedding returned', pending[i].queue_id);
          failed++;
        }
      }
      db.prepare('COMMIT').run();
    } catch (err) {
      try { db.prepare('ROLLBACK').run(); } catch { }
      appendLog({ ts: new Date().toISOString(), error: err.message, batch_size: pending.length });
      return;
    }

    appendLog({ ts: new Date().toISOString(), success, failed, batch_size: pending.length });

  } finally {
    if (db) try { db.close(); } catch { }
    try { fs.unlinkSync(LOCK_FILE); } catch { }
  }
}

function appendLog(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { }
}

main().catch(err => {
  appendLog({ ts: new Date().toISOString(), error: err.message });
  try { fs.unlinkSync(LOCK_FILE); } catch { }
});
