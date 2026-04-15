'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const { cosineSimilarity } = require('./wiki-cluster');
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  });
  it('returns 0 for orthogonal vectors', () => {
    const { cosineSimilarity } = require('./wiki-cluster');
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it('returns ~0.707 for 45-degree vectors', () => {
    const { cosineSimilarity } = require('./wiki-cluster');
    const r = cosineSimilarity([1, 1], [1, 0]);
    assert.ok(Math.abs(r - Math.SQRT1_2) < 0.001);
  });
  it('returns 0 for zero vector', () => {
    const { cosineSimilarity } = require('./wiki-cluster');
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});

describe('buildConnectedComponents', () => {
  it('groups similar docs into one cluster of >=3', () => {
    const { buildConnectedComponents } = require('./wiki-cluster');
    const embeddings = [
      { slug: 'a', vector: [1, 0.1, 0] },
      { slug: 'b', vector: [0.9, 0.2, 0] },
      { slug: 'c', vector: [0.95, 0, 0.1] },
      { slug: 'd', vector: [0, 0, 1] },
    ];
    const clusters = buildConnectedComponents(embeddings, { threshold: 0.7, minSize: 3 });
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].includes('a'));
    assert.ok(!clusters[0].includes('d')); // isolated doc not in cluster
  });

  it('returns empty when no cluster meets minSize', () => {
    const { buildConnectedComponents } = require('./wiki-cluster');
    const embeddings = [
      { slug: 'a', vector: [1, 0] },
      { slug: 'b', vector: [0, 1] },
    ];
    assert.equal(buildConnectedComponents(embeddings, { threshold: 0.7, minSize: 3 }).length, 0);
  });

  it('returns empty for fewer than minSize total docs', () => {
    const { buildConnectedComponents } = require('./wiki-cluster');
    const embeddings = [
      { slug: 'a', vector: [1, 0] },
      { slug: 'b', vector: [1, 0.1] },
    ];
    assert.equal(buildConnectedComponents(embeddings, { minSize: 3 }).length, 0);
  });
});

describe('jaccardOverlap', () => {
  it('returns 1 for identical sets', () => {
    const { jaccardOverlap } = require('./wiki-cluster');
    assert.equal(jaccardOverlap([1, 2, 3], [1, 2, 3]), 1);
  });
  it('returns 0 for disjoint sets', () => {
    const { jaccardOverlap } = require('./wiki-cluster');
    assert.equal(jaccardOverlap([1, 2], [3, 4]), 0);
  });
  it('returns 1/3 for one-element overlap out of three unique', () => {
    // intersection=1, union=3 → 1/3
    const { jaccardOverlap } = require('./wiki-cluster');
    const result = jaccardOverlap([1, 2], [2, 3]);
    assert.ok(Math.abs(result - 1 / 3) < 1e-10);
  });
  it('returns 0 for two empty sets', () => {
    const { jaccardOverlap } = require('./wiki-cluster');
    assert.equal(jaccardOverlap([], []), 0);
  });
});

describe('findMatchingCluster', () => {
  it('finds cluster with Jaccard > 0.5', () => {
    const { findMatchingCluster } = require('./wiki-cluster');
    // intersection=3, union=4 → Jaccard=0.75 > 0.5
    const existing = [{ slug: 'cluster-abc', memberIds: [1, 2, 3] }];
    const result = findMatchingCluster(existing, [1, 2, 3, 4]);
    assert.equal(result.slug, 'cluster-abc');
  });

  it('returns null when no cluster matches', () => {
    const { findMatchingCluster } = require('./wiki-cluster');
    const existing = [{ slug: 'cluster-abc', memberIds: [1, 2] }];
    assert.equal(findMatchingCluster(existing, [3, 4, 5]), null);
  });

  it('prefers cluster with higher Jaccard when multiple exceed threshold', () => {
    const { findMatchingCluster } = require('./wiki-cluster');
    const existing = [
      // c1: intersection=2, union=5 → Jaccard=0.4 (below threshold)
      { slug: 'c1', memberIds: [1, 2, 10, 11] },
      // c2: intersection=3, union=4 → Jaccard=0.75 (above threshold)
      { slug: 'c2', memberIds: [1, 2, 3] },
    ];
    const result = findMatchingCluster(existing, [1, 2, 3]);
    assert.equal(result.slug, 'c2');
  });
});

describe('membershipHash', () => {
  it('is order-independent', () => {
    const { membershipHash } = require('./wiki-cluster');
    assert.equal(membershipHash(['b', 'a', 'c']), membershipHash(['c', 'a', 'b']));
  });
  it('returns 64-char hex string', () => {
    const { membershipHash } = require('./wiki-cluster');
    assert.equal(membershipHash(['x']).length, 64);
  });
});

describe('getDocEmbeddings', () => {
  function makeFloat32Blob(values) {
    const arr = new Float32Array(values);
    return Buffer.from(arr.buffer);
  }

  it('returns array of { slug, vector: Float32Array } from blob embeddings', () => {
    const { getDocEmbeddings } = require('./wiki-cluster');
    const mockDb = {
      prepare(sql) {
        return {
          all(...args) {
            // Return two chunks for 'doc-a', one chunk for 'doc-b'
            return [
              { page_slug: 'doc-a', embedding: makeFloat32Blob([1.0, 0.0, 0.0]) },
              { page_slug: 'doc-a', embedding: makeFloat32Blob([0.0, 1.0, 0.0]) },
              { page_slug: 'doc-b', embedding: makeFloat32Blob([0.5, 0.5, 0.0]) },
            ].filter(r => args.includes(r.page_slug));
          },
        };
      },
    };

    const result = getDocEmbeddings(mockDb, ['doc-a', 'doc-b']);
    assert.equal(result.length, 2);

    const docA = result.find(r => r.slug === 'doc-a');
    const docB = result.find(r => r.slug === 'doc-b');

    assert.ok(docA, 'doc-a should be present');
    assert.ok(docA.vector instanceof Float32Array, 'vector should be Float32Array');
    // Average of [1,0,0] and [0,1,0] = [0.5, 0.5, 0]
    assert.ok(Math.abs(docA.vector[0] - 0.5) < 1e-5);
    assert.ok(Math.abs(docA.vector[1] - 0.5) < 1e-5);
    assert.ok(Math.abs(docA.vector[2] - 0.0) < 1e-5);

    assert.ok(docB, 'doc-b should be present');
    assert.ok(docB.vector instanceof Float32Array, 'vector should be Float32Array');
    assert.ok(Math.abs(docB.vector[0] - 0.5) < 1e-5);
  });

  it('omits slugs with no embeddings from result', () => {
    const { getDocEmbeddings } = require('./wiki-cluster');
    const mockDb = {
      prepare(sql) {
        return {
          all(...args) {
            // Only doc-x has embeddings; doc-y has none
            return [
              { page_slug: 'doc-x', embedding: makeFloat32Blob([1.0, 2.0]) },
            ].filter(r => args.includes(r.page_slug));
          },
        };
      },
    };

    const result = getDocEmbeddings(mockDb, ['doc-x', 'doc-y']);
    assert.equal(result.length, 1);
    assert.equal(result[0].slug, 'doc-x');
  });

  it('returns empty array when slugs list is empty', () => {
    const { getDocEmbeddings } = require('./wiki-cluster');
    const mockDb = { prepare() { throw new Error('should not be called'); } };
    const result = getDocEmbeddings(mockDb, []);
    assert.deepEqual(result, []);
  });
});
