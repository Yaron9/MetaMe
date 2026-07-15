#!/usr/bin/env node

'use strict';

/**
 * daemon-embedding.js — Embedding queue consumer
 *
 * Processes pending items in embedding_queue:
 * 1. Reads batch from queue (attempts < 3)
 * 2. Fetches text from content_chunks
 * 3. Calls the configured embedding backend
 * 4. Writes BLOB + metadata back to content_chunks
 * 5. Deletes completed queue rows; increments attempts on failure
 *
 * Designed to run as heartbeat task (interval: 30min) or post-wiki-reflect trigger.
 * Graceful degradation: unavailable backend is logged and leaves the queue intact.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const DB_PATH = process.env.METAME_MEMORY_DB_PATH
  ? path.resolve(process.env.METAME_MEMORY_DB_PATH) : path.join(METAME_DIR, 'memory.db');
const LOCK_FILE = process.env.METAME_EMBEDDING_LOCK_PATH
  ? path.resolve(process.env.METAME_EMBEDDING_LOCK_PATH) : path.join(METAME_DIR, 'daemon-embedding.lock');
const LOG_FILE = process.env.METAME_EMBEDDING_LOG_PATH
  ? path.resolve(process.env.METAME_EMBEDDING_LOG_PATH) : path.join(METAME_DIR, 'embedding_log.jsonl');
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
    appendLog({ ts: new Date().toISOString(), status: 'backend_unavailable' });
    return { status: 'backend_unavailable' };
  }
  const backendInfo = embedding.getBackendInfo();

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
    if (!(await ensureBackendReady(embedding, backendInfo))) {
      const result = { status: 'backend_unavailable', backend: backendInfo };
      appendLog({ ts: new Date().toISOString(), ...result });
      return result;
    }
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');

    // Ensure schema exists
    try {
      const { applyWikiSchema } = loadModule('memory-wiki-schema') || {};
      if (applyWikiSchema) applyWikiSchema(db);
    } catch { }

    const reconciled = reconcileEmbeddingQueue(db, backendInfo);

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

    if (pending.length === 0) {
      appendLog({ ts: new Date().toISOString(), status: 'idle', backend: backendInfo, reconciled });
      return { status: 'idle', backend: backendInfo, reconciled };
    }

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
          updateChunk.run(buf, backendInfo.model, backendInfo.dimensions, pending[i].item_id);
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

    const result = { status: 'ok', backend: backendInfo, reconciled, success, failed, batch_size: pending.length };
    appendLog({ ts: new Date().toISOString(), ...result });
    return result;

  } finally {
    if (db) try { db.close(); } catch { }
    try { fs.unlinkSync(LOCK_FILE); } catch { }
  }
}

function ollamaBaseUrl() {
  return String(process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
}

async function probeOllama() {
  try {
    const response = await fetch(`${ollamaBaseUrl()}/api/tags`, {
      signal: globalThis.AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function startOllamaService() {
  if (process.platform === 'darwin' && fs.existsSync('/Applications/Ollama.app')) {
    const child = spawn('/usr/bin/open', ['-gja', 'Ollama'], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function ensureBackendReady(embedding, backendInfo) {
  if (backendInfo.backend !== 'ollama') return true;
  if (!(await probeOllama())) {
    try { startOllamaService(); } catch { return false; }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await probeOllama()) break;
    }
  }
  if (!(await probeOllama())) return false;
  try {
    const warm = await embedding.getEmbedding('MetaMe embedding health check');
    return !!warm && warm.length === backendInfo.dimensions;
  } catch {
    return false;
  }
}

function reconcileEmbeddingQueue(db, backendInfo) {
  const model = backendInfo.model;
  const dimensions = backendInfo.dimensions;
  db.prepare('BEGIN').run();
  try {
    const orphaned = db.prepare(`
      DELETE FROM embedding_queue
      WHERE item_type = 'chunk'
        AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.id = embedding_queue.item_id)
    `).run().changes;
    const invalidated = db.prepare(`
      UPDATE content_chunks
      SET embedding = NULL, embedding_model = NULL, embedding_dim = NULL
      WHERE embedding IS NOT NULL
        AND (embedding_model IS NOT ? OR embedding_dim IS NOT ? OR length(embedding) != ?)
    `).run(model, dimensions, dimensions * 4).changes;

    const reset = db.prepare(`
      UPDATE embedding_queue
      SET model = ?, attempts = 0, last_error = NULL
      WHERE item_type = 'chunk' AND model IS NOT ?
    `).run(model, model).changes;

    const enqueued = db.prepare(`
      INSERT INTO embedding_queue (item_type, item_id, model)
      SELECT 'chunk', cc.id, ?
      FROM content_chunks cc
      WHERE cc.embedding IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM embedding_queue eq
          WHERE eq.item_type = 'chunk' AND eq.item_id = cc.id
        )
    `).run(model).changes;

    db.prepare('COMMIT').run();
    return { orphaned, invalidated, reset, enqueued };
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch { }
    throw err;
  }
}

function appendLog(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { }
}

if (require.main === module) {
  main().catch(err => {
    appendLog({ ts: new Date().toISOString(), error: err.message });
    try { fs.unlinkSync(LOCK_FILE); } catch { }
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  _internal: { ensureBackendReady, probeOllama, reconcileEmbeddingQueue },
};
