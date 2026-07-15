'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { _internal } = require('./daemon-embedding');

function openDb() {
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  return db;
}

describe('daemon embedding queue reconciliation', () => {
  it('invalidates incompatible vectors and queues every missing chunk once', () => {
    const db = openDb();
    const insert = db.prepare(`
      INSERT INTO content_chunks
        (id, page_slug, chunk_text, chunk_idx, embedding, embedding_model, embedding_dim)
      VALUES (?, 'page', ?, ?, ?, ?, ?)
    `);
    insert.run('old', 'old vector', 0, Buffer.alloc(512 * 4), 'text-embedding-3-small', 512);
    insert.run('missing', 'missing vector', 1, null, null, null);
    insert.run('current', 'current vector', 2, Buffer.alloc(1024 * 4), 'bge-m3', 1024);
    db.prepare(`
      INSERT INTO embedding_queue (item_type, item_id, model, attempts, last_error)
      VALUES ('chunk', 'old', 'text-embedding-3-small', 3, 'old failure')
    `).run();

    const first = _internal.reconcileEmbeddingQueue(db, {
      backend: 'ollama', model: 'bge-m3', dimensions: 1024,
    });
    assert.deepEqual(first, { orphaned: 0, invalidated: 1, reset: 1, enqueued: 1 });

    const old = db.prepare('SELECT * FROM content_chunks WHERE id = ?').get('old');
    assert.equal(old.embedding, null);
    const queued = db.prepare(
      'SELECT item_id, model, attempts, last_error FROM embedding_queue ORDER BY item_id',
    ).all().map(row => ({ ...row }));
    assert.deepEqual(queued, [
      { item_id: 'missing', model: 'bge-m3', attempts: 0, last_error: null },
      { item_id: 'old', model: 'bge-m3', attempts: 0, last_error: null },
    ]);

    const second = _internal.reconcileEmbeddingQueue(db, {
      backend: 'ollama', model: 'bge-m3', dimensions: 1024,
    });
    assert.deepEqual(second, { orphaned: 0, invalidated: 0, reset: 0, enqueued: 0 });
    db.close();
  });

  it('invalidates blobs whose byte length contradicts their metadata', () => {
    const db = openDb();
    db.prepare(`
      INSERT INTO content_chunks
        (id, page_slug, chunk_text, chunk_idx, embedding, embedding_model, embedding_dim)
      VALUES ('bad-size', 'page', 'bad size', 0, ?, 'bge-m3', 1024)
    `).run(Buffer.alloc(512 * 4));
    db.prepare(`
      INSERT INTO embedding_queue (item_type, item_id, model)
      VALUES ('chunk', 'gone', 'bge-m3')
    `).run();

    const result = _internal.reconcileEmbeddingQueue(db, {
      backend: 'ollama', model: 'bge-m3', dimensions: 1024,
    });
    assert.equal(result.invalidated, 1);
    assert.equal(result.enqueued, 1);
    assert.equal(result.orphaned, 1);
    db.close();
  });
});
