'use strict';

const crypto = require('node:crypto');

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function membershipHash(slugs) {
  const sorted = [...slugs].sort().join(',');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

function jaccardOverlap(setA, setB) {
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const minSize = Math.min(a.size, b.size);
  return minSize === 0 ? 0 : intersection / minSize;
}

/**
 * Find existing cluster with Jaccard overlap > 0.5 with newMemberIds.
 * Tie-break: prefer larger stored cluster.
 */
function findMatchingCluster(existingClusters, newMemberIds) {
  let best = null;
  let bestScore = 0.5; // strict threshold: must exceed 0.5
  for (const cluster of existingClusters) {
    const score = jaccardOverlap(cluster.memberIds, newMemberIds);
    if (score > bestScore) {
      best = cluster;
      bestScore = score;
    } else if (score === bestScore && best && cluster.memberIds.length > best.memberIds.length) {
      best = cluster;
    }
  }
  return best;
}

/**
 * Build connected components from embeddings using cosine similarity threshold.
 * Uses union-find.
 */
function buildConnectedComponents(embeddings, { threshold = 0.75, minSize = 3 } = {}) {
  const slugs = Object.keys(embeddings);
  const n = slugs.length;
  const parent = Object.fromEntries(slugs.map(s => [s, s]));

  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x, y) { parent[find(x)] = find(y); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(embeddings[slugs[i]], embeddings[slugs[j]]) >= threshold) {
        union(slugs[i], slugs[j]);
      }
    }
  }

  const groups = {};
  for (const s of slugs) {
    const root = find(s);
    if (!groups[root]) groups[root] = [];
    groups[root].push(s);
  }

  return Object.values(groups).filter(g => g.length >= minSize);
}

/**
 * Fetch doc-level embeddings from content_chunks by averaging all chunk embeddings per page.
 */
function getDocEmbeddings(db, slugs) {
  const result = {};
  for (const slug of slugs) {
    const chunks = db.prepare(
      "SELECT embedding FROM content_chunks WHERE page_slug=? AND embedding IS NOT NULL"
    ).all(slug);
    if (chunks.length === 0) continue;
    const vecs = chunks.map(c => {
      const buf = Buffer.isBuffer(c.embedding) ? c.embedding : Buffer.from(c.embedding);
      const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return Array.from(arr);
    });
    const dim = vecs[0].length;
    const avg = new Array(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) avg[i] += v[i] / vecs.length;
    result[slug] = avg;
  }
  return result;
}

module.exports = { cosineSimilarity, buildConnectedComponents, jaccardOverlap,
                   findMatchingCluster, membershipHash, getDocEmbeddings };
