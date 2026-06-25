'use strict';

const { chunkText } = require('./chunker');

function defaultChunkIdFactory() {
  return `ck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function enqueueContentChunks(db, slug, content, {
  idFactory = defaultChunkIdFactory,
  targetWords = 300,
} = {}) {
  const chunks = chunkText(content, { targetWords });
  if (chunks.length === 0) return [];

  const insertChunk = db.prepare(
    'INSERT INTO content_chunks (id, page_slug, chunk_text, chunk_idx) VALUES (?, ?, ?, ?)',
  );
  const enqueue = db.prepare(
    "INSERT INTO embedding_queue (item_type, item_id) VALUES ('chunk', ?)",
  );

  const ids = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunkId = idFactory({ slug, index: i, text: chunks[i] });
    insertChunk.run(chunkId, slug, chunks[i], i);
    enqueue.run(chunkId);
    ids.push(chunkId);
  }
  return ids;
}

module.exports = { enqueueContentChunks };
