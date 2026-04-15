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
    const embeddings = {
      'a': [1, 0.1, 0], 'b': [0.9, 0.2, 0], 'c': [0.95, 0, 0.1], 'd': [0, 0, 1],
    };
    const clusters = buildConnectedComponents(embeddings, { threshold: 0.7, minSize: 3 });
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].includes('a'));
    assert.ok(!clusters[0].includes('d')); // isolated doc not in cluster
  });

  it('returns empty when no cluster meets minSize', () => {
    const { buildConnectedComponents } = require('./wiki-cluster');
    const embeddings = { 'a': [1, 0], 'b': [0, 1] };
    assert.equal(buildConnectedComponents(embeddings, { threshold: 0.7, minSize: 3 }).length, 0);
  });

  it('returns empty for fewer than minSize total docs', () => {
    const { buildConnectedComponents } = require('./wiki-cluster');
    const embeddings = { 'a': [1, 0], 'b': [1, 0.1] };
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
  it('returns 0.5 for half overlap', () => {
    const { jaccardOverlap } = require('./wiki-cluster');
    assert.equal(jaccardOverlap([1, 2], [2, 3]), 0.5);
  });
});

describe('findMatchingCluster', () => {
  it('finds cluster with Jaccard > 0.5', () => {
    const { findMatchingCluster } = require('./wiki-cluster');
    const existing = [{ slug: 'cluster-abc', memberIds: [1, 2, 3] }];
    const result = findMatchingCluster(existing, [1, 2, 3, 4]); // 3/4 = 0.75
    assert.equal(result.slug, 'cluster-abc');
  });

  it('returns null when no cluster matches', () => {
    const { findMatchingCluster } = require('./wiki-cluster');
    const existing = [{ slug: 'cluster-abc', memberIds: [1, 2] }];
    assert.equal(findMatchingCluster(existing, [3, 4, 5]), null);
  });

  it('prefers higher overlap cluster on tie-break', () => {
    const { findMatchingCluster } = require('./wiki-cluster');
    const existing = [
      { slug: 'c1', memberIds: [1, 2, 3] },  // overlap 2/4=0.5 (below threshold)
      { slug: 'c2', memberIds: [1, 2, 3, 4, 5] }, // overlap 3/5=0.6
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
