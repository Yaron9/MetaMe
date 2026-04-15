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
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
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
 * @param {Array<{ slug: string, vector: Float32Array|number[] }>} embeddings
 * @param {{ threshold?: number, minSize?: number }} options
 * Uses union-find.
 */
function buildConnectedComponents(embeddings, { threshold = 0.75, minSize = 3 } = {}) {
  const n = embeddings.length;
  const slugs = embeddings.map(e => e.slug);
  const parent = Object.fromEntries(slugs.map(s => [s, s]));

  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x, y) { parent[find(x)] = find(y); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(embeddings[i].vector, embeddings[j].vector) >= threshold) {
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
 * @param {object} db - node:sqlite DatabaseSync instance
 * @param {string[]} slugs
 * @returns {Array<{ slug: string, vector: Float32Array }>} one entry per slug that has embeddings
 */
function getDocEmbeddings(db, slugs) {
  if (slugs.length === 0) return [];
  const placeholders = ',?'.repeat(slugs.length).slice(1);
  const rows = db.prepare(
    `SELECT page_slug, embedding FROM content_chunks WHERE page_slug IN (${placeholders}) AND embedding IS NOT NULL`
  ).all(...slugs);

  // Group rows by slug
  const bySlug = {};
  for (const row of rows) {
    if (!bySlug[row.page_slug]) bySlug[row.page_slug] = [];
    const buf = Buffer.isBuffer(row.embedding) ? row.embedding : Buffer.from(row.embedding);
    bySlug[row.page_slug].push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }

  // Average chunk vectors per slug
  const result = [];
  for (const [slug, vecs] of Object.entries(bySlug)) {
    const dim = vecs[0].length;
    const avg = new Float32Array(dim);
    for (const v of vecs) {
      for (let i = 0; i < dim; i++) avg[i] += v[i] / vecs.length;
    }
    result.push({ slug, vector: avg });
  }
  return result;
}

module.exports = { cosineSimilarity, buildConnectedComponents, jaccardOverlap,
                   findMatchingCluster, membershipHash, getDocEmbeddings };
