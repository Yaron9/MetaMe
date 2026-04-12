'use strict';

/**
 * core/embedding.js — OpenAI embedding adapter (zero dependencies beyond native fetch)
 *
 * Exports:
 *   getEmbedding(text)          → Float32Array | null
 *   batchEmbed(texts[])         → (Float32Array | null)[]
 *   embeddingToBuffer(f32)      → Buffer       (for SQLite BLOB write)
 *   bufferToEmbedding(blob)     → Float32Array  (for SQLite BLOB read)
 *   isEmbeddingAvailable()      → boolean
 *
 * Config:
 *   OPENAI_API_KEY env var required. Without it, all functions degrade gracefully (return null).
 *   Model: text-embedding-3-small, 512 dimensions, L2-normalized.
 */

const MODEL = 'text-embedding-3-small';
const DIMENSIONS = 512;
const MAX_INPUT_CHARS = 8000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const BATCH_SIZE = 100;
const API_URL = 'https://api.openai.com/v1/embeddings';

function getApiKey() {
  return process.env.OPENAI_API_KEY || '';
}

function isEmbeddingAvailable() {
  return !!getApiKey();
}

/**
 * L2-normalize a Float32Array in-place and return it.
 * @param {Float32Array} vec
 * @returns {Float32Array}
 */
function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * Call OpenAI embeddings API with retry.
 * @param {string[]} inputs — already truncated
 * @returns {Float32Array[]}
 */
async function callApi(inputs) {
  const apiKey = getApiKey();
  if (!apiKey) return inputs.map(() => null);

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          input: inputs,
          dimensions: DIMENSIONS,
        }),
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
        const delay = Math.max(retryAfter * 1000, BASE_DELAY_MS * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`OpenAI API ${resp.status}: ${body.slice(0, 200)}`);
      }

      const data = await resp.json();
      return data.data.map(item => {
        const vec = new Float32Array(item.embedding);
        return l2Normalize(vec);
      });
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

/**
 * Get embedding for a single text.
 * @param {string} text
 * @returns {Promise<Float32Array|null>}
 */
async function getEmbedding(text) {
  if (!isEmbeddingAvailable()) return null;
  if (!text || typeof text !== 'string') return null;
  const truncated = text.slice(0, MAX_INPUT_CHARS);
  const results = await callApi([truncated]);
  return results[0] || null;
}

/**
 * Get embeddings for multiple texts in batches.
 * @param {string[]} texts
 * @returns {Promise<(Float32Array|null)[]>}
 */
async function batchEmbed(texts) {
  if (!isEmbeddingAvailable()) return texts.map(() => null);
  if (!texts || texts.length === 0) return [];

  const results = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE).map(t =>
      (typeof t === 'string' ? t : '').slice(0, MAX_INPUT_CHARS),
    );
    const embeddings = await callApi(batch);
    results.push(...embeddings);
  }
  return results;
}

/**
 * Convert Float32Array to Buffer for SQLite BLOB storage.
 * @param {Float32Array} f32
 * @returns {Buffer}
 */
function embeddingToBuffer(f32) {
  if (!f32) return null;
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/**
 * Read Buffer from SQLite BLOB back to Float32Array.
 * Validates byte length matches expected dimensions.
 * @param {Buffer|Uint8Array} blob
 * @returns {Float32Array|null}
 */
function bufferToEmbedding(blob) {
  if (!blob || blob.length !== DIMENSIONS * 4) return null;
  // Copy into aligned ArrayBuffer to avoid RangeError on unaligned byteOffset
  const aligned = new ArrayBuffer(blob.length);
  new Uint8Array(aligned).set(new Uint8Array(blob.buffer, blob.byteOffset, blob.length));
  return new Float32Array(aligned);
}

module.exports = {
  getEmbedding,
  batchEmbed,
  embeddingToBuffer,
  bufferToEmbedding,
  isEmbeddingAvailable,
  l2Normalize,
  MODEL,
  DIMENSIONS,
};
