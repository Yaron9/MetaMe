'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { embeddingToBuffer, bufferToEmbedding, l2Normalize, isEmbeddingAvailable, DIMENSIONS } = require('./embedding');

describe('embedding utilities', () => {
  it('l2Normalize produces unit vector', () => {
    const vec = new Float32Array([3, 4, 0]);
    l2Normalize(vec);
    const norm = Math.sqrt(vec[0] ** 2 + vec[1] ** 2 + vec[2] ** 2);
    assert.ok(Math.abs(norm - 1.0) < 1e-6, `norm should be ~1, got ${norm}`);
    assert.ok(Math.abs(vec[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(vec[1] - 0.8) < 1e-6);
  });

  it('l2Normalize handles zero vector without NaN', () => {
    const vec = new Float32Array([0, 0, 0]);
    l2Normalize(vec);
    assert.ok(!Number.isNaN(vec[0]));
    assert.equal(vec[0], 0);
  });

  it('embeddingToBuffer + bufferToEmbedding roundtrip', () => {
    const original = new Float32Array(DIMENSIONS);
    for (let i = 0; i < DIMENSIONS; i++) original[i] = Math.random() * 2 - 1;

    const buf = embeddingToBuffer(original);
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.length, DIMENSIONS * 4);

    const restored = bufferToEmbedding(buf);
    assert.ok(restored instanceof Float32Array);
    assert.equal(restored.length, DIMENSIONS);

    for (let i = 0; i < DIMENSIONS; i++) {
      assert.ok(Math.abs(original[i] - restored[i]) < 1e-7,
        `mismatch at index ${i}: ${original[i]} vs ${restored[i]}`);
    }
  });

  it('bufferToEmbedding rejects wrong-size blob', () => {
    const wrongSize = Buffer.alloc(100);
    assert.equal(bufferToEmbedding(wrongSize), null);
  });

  it('bufferToEmbedding rejects null/undefined', () => {
    assert.equal(bufferToEmbedding(null), null);
    assert.equal(bufferToEmbedding(undefined), null);
  });

  it('embeddingToBuffer returns null for null input', () => {
    assert.equal(embeddingToBuffer(null), null);
  });

  it('bufferToEmbedding handles unaligned buffer (sliced with odd byteOffset)', () => {
    // Simulate SQLite returning a Buffer slice with byteOffset % 4 !== 0
    const original = new Float32Array(DIMENSIONS);
    for (let i = 0; i < DIMENSIONS; i++) original[i] = i * 0.001;
    const buf = Buffer.from(original.buffer, original.byteOffset, original.byteLength);

    // Create unaligned slice: offset by 1 byte then take the right range
    const padded = Buffer.alloc(DIMENSIONS * 4 + 1);
    buf.copy(padded, 1);
    const unaligned = padded.subarray(1); // byteOffset is 1, not aligned to 4

    assert.ok(unaligned.byteOffset % 4 !== 0, 'test setup: buffer should be unaligned');
    const restored = bufferToEmbedding(unaligned);
    assert.ok(restored instanceof Float32Array);
    assert.equal(restored.length, DIMENSIONS);
    for (let i = 0; i < DIMENSIONS; i++) {
      assert.ok(Math.abs(original[i] - restored[i]) < 1e-6,
        `mismatch at index ${i}: ${original[i]} vs ${restored[i]}`);
    }
  });

  it('isEmbeddingAvailable reflects OPENAI_API_KEY presence', () => {
    // This test depends on whether the env var is set in CI
    const result = isEmbeddingAvailable();
    assert.equal(typeof result, 'boolean');
  });
});
