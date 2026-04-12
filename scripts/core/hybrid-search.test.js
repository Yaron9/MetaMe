'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('./hybrid-search');
const { dotProduct, topK, aggregateChunksToPages, rrfFuse, normalizeScores } = _internal;

describe('hybrid-search internals', () => {
  describe('dotProduct', () => {
    it('computes cosine similarity of normalized vectors', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0, 0]);
      assert.ok(Math.abs(dotProduct(a, b) - 1.0) < 1e-6);
    });

    it('orthogonal vectors return 0', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([0, 1, 0]);
      assert.ok(Math.abs(dotProduct(a, b)) < 1e-6);
    });
  });

  describe('topK', () => {
    it('returns top K items sorted by score descending', () => {
      const items = [
        { score: 0.1 }, { score: 0.9 }, { score: 0.5 },
        { score: 0.3 }, { score: 0.7 },
      ];
      const result = topK(items, 3);
      assert.equal(result.length, 3);
      assert.equal(result[0].score, 0.9);
      assert.equal(result[1].score, 0.7);
      assert.equal(result[2].score, 0.5);
    });

    it('returns all items when fewer than K', () => {
      const items = [{ score: 0.5 }, { score: 0.3 }];
      const result = topK(items, 10);
      assert.equal(result.length, 2);
      assert.equal(result[0].score, 0.5);
    });
  });

  describe('aggregateChunksToPages', () => {
    it('keeps max score per page_slug with best excerpt', () => {
      const chunks = [
        { page_slug: 'a', chunk_text: 'low', score: 0.3 },
        { page_slug: 'a', chunk_text: 'high relevance chunk', score: 0.9 },
        { page_slug: 'b', chunk_text: 'only one', score: 0.5 },
      ];
      const pages = aggregateChunksToPages(chunks);
      assert.equal(pages.size, 2);
      assert.equal(pages.get('a').score, 0.9);
      assert.ok(pages.get('a').excerpt.includes('high'));
      assert.equal(pages.get('b').score, 0.5);
    });
  });

  describe('rrfFuse', () => {
    it('produces hybrid source when slug appears in both lists', () => {
      const merged = new Map([
        ['a', { ftsRank: 1, vectorRank: 2, title: 'A', excerpt: 'ex', staleness: 0 }],
        ['b', { ftsRank: 2, title: 'B', excerpt: 'ex', staleness: 0.5 }],
        ['c', { vectorRank: 1, title: 'C', excerpt: 'ex', staleness: 0 }],
      ]);
      const results = rrfFuse(merged);
      const a = results.find(r => r.slug === 'a');
      const b = results.find(r => r.slug === 'b');
      const c = results.find(r => r.slug === 'c');
      assert.equal(a.source, 'hybrid');
      assert.equal(b.source, 'fts');
      assert.equal(c.source, 'vector');
      assert.equal(b.stale, true);
      assert.equal(a.stale, false);
    });

    it('hybrid slug scores higher than single-source', () => {
      const merged = new Map([
        ['hybrid', { ftsRank: 1, vectorRank: 1, title: 'H', excerpt: '', staleness: 0 }],
        ['fts-only', { ftsRank: 1, title: 'F', excerpt: '', staleness: 0 }],
      ]);
      const results = rrfFuse(merged);
      assert.ok(results[0].slug === 'hybrid', 'hybrid slug should rank first');
    });
  });

  describe('normalizeScores', () => {
    it('normalizes to 0-1 range', () => {
      const results = [{ score: 0.03 }, { score: 0.02 }, { score: 0.01 }];
      normalizeScores(results);
      assert.equal(results[0].score, 1.0);
      assert.equal(results[2].score, 0.0);
      assert.ok(Math.abs(results[1].score - 0.5) < 1e-6);
    });

    it('handles single result without NaN', () => {
      const results = [{ score: 0.05 }];
      normalizeScores(results);
      assert.equal(results[0].score, 1.0);
      assert.ok(!Number.isNaN(results[0].score));
    });

    it('handles empty array', () => {
      const results = [];
      normalizeScores(results);
      assert.equal(results.length, 0);
    });

    it('handles equal scores without NaN', () => {
      const results = [{ score: 0.05 }, { score: 0.05 }];
      normalizeScores(results);
      assert.equal(results[0].score, 1.0);
      assert.equal(results[1].score, 1.0);
    });
  });
});
