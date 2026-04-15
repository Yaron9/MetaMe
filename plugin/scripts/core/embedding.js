'use strict';

/**
 * core/embedding.js — Embedding adapter with two backends:
 *   1. OpenAI text-embedding-3-small (512-dim) — requires OPENAI_API_KEY
 *   2. Ollama bge-m3 (1024-dim, local) — fallback when OpenAI key absent
 *
 * Exports:
 *   getEmbedding(text)          → Float32Array | null
 *   batchEmbed(texts[])         → (Float32Array | null)[]
 *   embeddingToBuffer(f32)      → Buffer       (for SQLite BLOB write)
 *   bufferToEmbedding(blob)     → Float32Array  (for SQLite BLOB read)
 *   isEmbeddingAvailable()      → boolean
 *
 * Backend selection (automatic):
 *   OPENAI_API_KEY set  → OpenAI (512-dim)
 *   ollama installed    → bge-m3 via localhost:11434 (1024-dim)
 *   neither             → all functions return null gracefully
 */

const { existsSync } = require('node:fs');

// ── OpenAI backend ────────────────────────────────────────────────────────────
const OPENAI_MODEL      = 'text-embedding-3-small';
const OPENAI_DIMENSIONS = 512;
const OPENAI_API_URL    = 'https://api.openai.com/v1/embeddings';

// ── Ollama backend ────────────────────────────────────────────────────────────
const OLLAMA_MODEL      = 'bge-m3';
const OLLAMA_DIMENSIONS = 1024;
const OLLAMA_API_URL    = process.env.OLLAMA_HOST
  ? `${process.env.OLLAMA_HOST}/api/embed`
  : 'http://localhost:11434/api/embed';
const OLLAMA_BIN_PATHS  = [
  '/usr/local/bin/ollama',
  '/opt/homebrew/bin/ollama',
  '/usr/bin/ollama',
];

// ── Shared constants ──────────────────────────────────────────────────────────
const MAX_INPUT_CHARS = 8000;
const MAX_RETRIES     = 3;
const BASE_DELAY_MS   = 2000;
const BATCH_SIZE      = 100;

// Keep legacy export name for callers that read it directly
const MODEL      = OPENAI_MODEL;
const DIMENSIONS = OPENAI_DIMENSIONS;

// ── Backend detection ─────────────────────────────────────────────────────────

function getApiKey() {
  return process.env.OPENAI_API_KEY || '';
}

function isOllamaInstalled() {
  return OLLAMA_BIN_PATHS.some(p => existsSync(p));
}

function getBackend() {
  if (getApiKey()) return 'openai';
  if (isOllamaInstalled()) return 'ollama';
  return null;
}

function isEmbeddingAvailable() {
  return getBackend() !== null;
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

// ── OpenAI API call ───────────────────────────────────────────────────────────

async function callOpenAI(inputs) {
  const apiKey = getApiKey();
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: OPENAI_MODEL, input: inputs, dimensions: OPENAI_DIMENSIONS }),
      });
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
        await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, BASE_DELAY_MS * Math.pow(2, attempt))));
        continue;
      }
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`OpenAI API ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      return data.data.map(item => l2Normalize(new Float32Array(item.embedding)));
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

// ── Ollama API call (bge-m3, one text at a time — ollama /api/embed) ──────────

async function callOllama(inputs) {
  const results = [];
  for (const text of inputs) {
    let lastError;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(OLLAMA_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
        });
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          throw new Error(`Ollama API ${resp.status}: ${body.slice(0, 200)}`);
        }
        const data = await resp.json();
        const vec = data.embeddings?.[0];
        if (!vec || !Array.isArray(vec)) throw new Error('Ollama: unexpected response shape');
        results.push(l2Normalize(new Float32Array(vec)));
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_RETRIES - 1) await new Promise(r => setTimeout(r, BASE_DELAY_MS * Math.pow(2, attempt)));
      }
    }
    if (lastError) results.push(null);
  }
  return results;
}

// ── Unified router ────────────────────────────────────────────────────────────

async function callApi(inputs) {
  const backend = getBackend();
  if (backend === 'openai') return callOpenAI(inputs);
  if (backend === 'ollama') return callOllama(inputs);
  return inputs.map(() => null);
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
 * Dimension-agnostic: infers dim from blob length (supports both 512-dim OpenAI
 * and 1024-dim bge-m3 embeddings stored in the same DB).
 * @param {Buffer|Uint8Array} blob
 * @returns {Float32Array|null}
 */
function bufferToEmbedding(blob) {
  if (!blob || blob.length === 0 || blob.length % 4 !== 0) return null;
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
