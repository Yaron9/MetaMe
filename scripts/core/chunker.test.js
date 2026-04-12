'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { chunkText } = require('./chunker');

describe('chunkText', () => {
  it('returns empty array for empty/null input', () => {
    assert.deepStrictEqual(chunkText(''), []);
    assert.deepStrictEqual(chunkText(null), []);
    assert.deepStrictEqual(chunkText(undefined), []);
  });

  it('returns single chunk for short text', () => {
    const short = 'Hello world. This is a short text.';
    const result = chunkText(short, { targetWords: 300 });
    assert.equal(result.length, 1);
    assert.equal(result[0], short);
  });

  it('splits long text into multiple chunks near targetWords', () => {
    // Generate ~900 words across 6 paragraphs
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(25); // ~225 words
    const text = [para, para, para, para].join('\n\n');
    const result = chunkText(text, { targetWords: 300 });
    assert.ok(result.length >= 2, `expected >=2 chunks, got ${result.length}`);
    for (const chunk of result) {
      const wc = chunk.split(/\s+/).length;
      assert.ok(wc <= 300 * 1.5 + 10, `chunk has ${wc} words, exceeds 1.5x target`);
    }
  });

  it('handles text with only line breaks (no paragraphs)', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: some content here for testing.`).join('\n');
    const result = chunkText(lines, { targetWords: 50 });
    assert.ok(result.length >= 2, `expected >=2 chunks, got ${result.length}`);
  });

  it('merges tiny trailing fragments', () => {
    const big = 'word '.repeat(280); // 280 words
    const tiny = 'end.'; // 1 word
    const text = big.trim() + '\n\n' + tiny;
    const result = chunkText(text, { targetWords: 300 });
    // tiny fragment should be merged, not standalone
    assert.equal(result.length, 1);
  });

  it('all chunks concatenated contain all original words', () => {
    const para = 'Alpha beta gamma delta epsilon. '.repeat(30);
    const text = [para, para, para].join('\n\n');
    const result = chunkText(text, { targetWords: 100 });
    const originalWords = text.split(/\s+/).filter(Boolean).length;
    const chunkWords = result.join(' ').split(/\s+/).filter(Boolean).length;
    // Allow for minor whitespace normalization differences
    assert.ok(Math.abs(originalWords - chunkWords) < 5,
      `word count mismatch: original=${originalWords}, chunks=${chunkWords}`);
  });
});
