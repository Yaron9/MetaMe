'use strict';

/**
 * core/hybrid-search.js — Hybrid wiki search (FTS5 + Vector + RRF fusion)
 *
 * Exports:
 *   hybridSearchWiki(db, query, opts?) → { wikiPages: object[], facts: object[] }
 *
 * When vector embeddings are available:
 *   1. FTS5 search → page candidates with rank
 *   2. Vector cosine search on content_chunks → chunk candidates
 *   3. Chunk → page aggregation (max score per slug, keep best chunk as excerpt)
 *   4. RRF fusion of FTS page ranks + vector page ranks
 *   5. Normalize scores to 0-1
 *
 * Degradation: no embeddings in DB → pure FTS5 (same as searchWikiAndFacts)
 */

const { sanitizeFts5 } = require('./wiki-slug');
const { bufferToEmbedding, getEmbedding, isEmbeddingAvailable } = require('./embedding');

const RRF_K = 60;
const STALE_THRESHOLD = 0.3;
const MAX_FTS_RESULTS = 10;
const MAX_VECTOR_RESULTS = 20;

/**
 * Dot product of two Float32Arrays (assumes L2-normalized → equals cosine similarity).
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Top-K selection via bounded insertion (avoids full sort).
 * @param {{ score: number }[]} items
 * @param {number} k
 * @returns {{ score: number }[]}
 */
function topK(items, k) {
  if (items.length <= k) return items.slice().sort((a, b) => b.score - a.score);
  const heap = items.slice(0, k).sort((a, b) => a.score - b.score);
  for (let i = k; i < items.length; i++) {
    if (items[i].score > heap[0].score) {
      heap[0] = items[i];
      heap.sort((a, b) => a.score - b.score);
    }
  }
  return heap.sort((a, b) => b.score - a.score);
}

/**
 * FTS5 search for wiki pages.
 * @param {object} db
 * @param {string} safeQuery — already sanitized
 * @returns {{ slug: string, title: string, staleness: number, excerpt: string, ftsRank: number }[]}
 */
function ftsSearch(db, safeQuery) {
  try {
    return db.prepare(`
      SELECT wp.slug, wp.title, wp.staleness, wp.last_built_at,
             snippet(wiki_pages_fts, 2, '<b>', '</b>', '...', 20) as excerpt,
             rank as ftsRank
      FROM wiki_pages_fts
      JOIN wiki_pages wp ON wiki_pages_fts.rowid = wp.rowid
      WHERE wiki_pages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, MAX_FTS_RESULTS);
  } catch {
    return [];
  }
}

/**
 * Vector cosine search on content_chunks.
 * Brute-force scan with top-K heap. Only scans rows with embedding IS NOT NULL.
 *
 * @param {object} db
 * @param {Float32Array} queryEmbedding
 * @returns {{ page_slug: string, chunk_text: string, score: number }[]}
 */
function vectorSearch(db, queryEmbedding) {
  let rows;
  try {
    rows = db.prepare(`
      SELECT page_slug, chunk_text, embedding
      FROM content_chunks
      WHERE embedding IS NOT NULL
    `).all();
  } catch {
    return [];
  }

  const scored = [];
  for (const row of rows) {
    const emb = bufferToEmbedding(row.embedding);
    if (!emb) continue;
    const score = dotProduct(queryEmbedding, emb);
    scored.push({ page_slug: row.page_slug, chunk_text: row.chunk_text, score });
  }

  return topK(scored, MAX_VECTOR_RESULTS);
}

/**
 * Aggregate chunk-level vector results to page-level.
 * Per slug: keep max score and best chunk text as excerpt.
 * @param {{ page_slug: string, chunk_text: string, score: number }[]} chunks
 * @returns {Map<string, { score: number, excerpt: string }>}
 */
function aggregateChunksToPages(chunks) {
  const pages = new Map();
  for (const c of chunks) {
    const existing = pages.get(c.page_slug);
    if (!existing || c.score > existing.score) {
      pages.set(c.page_slug, { score: c.score, excerpt: c.chunk_text.slice(0, 200) });
    }
  }
  return pages;
}

/**
 * RRF fusion of two ranked lists.
 * @param {Map<string, { ftsRank?: number, vectorRank?: number, title?: string, excerpt?: string, staleness?: number }>} merged
 * @returns {{ slug: string, score: number, title: string, excerpt: string, staleness: number, stale: boolean, source: string }[]}
 */
function rrfFuse(merged) {
  const results = [];
  for (const [slug, info] of merged) {
    let score = 0;
    let source = '';
    if (typeof info.ftsRank === 'number') {
      score += 1 / (RRF_K + info.ftsRank);
      source = 'fts';
    }
    if (typeof info.vectorRank === 'number') {
      score += 1 / (RRF_K + info.vectorRank);
      source = source ? 'hybrid' : 'vector';
    }
    const staleness = info.staleness || 0;
    results.push({
      slug,
      score,
      title: info.title || slug,
      excerpt: info.excerpt || '',
      staleness,
      stale: staleness >= STALE_THRESHOLD,
      source,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Normalize scores to 0-1 range.
 * @param {{ score: number }[]} results
 */
function normalizeScores(results) {
  if (results.length === 0) return;
  const max = results[0].score;
  const min = results[results.length - 1].score;
  for (const r of results) {
    r.score = max === min ? 1.0 : (r.score - min) / (max - min);
  }
}

/**
 * Main entry: hybrid wiki search.
 *
 * @param {object} db
 * @param {string} query
 * @param {{ ftsOnly?: boolean, trackSearch?: boolean }} [opts]
 * @returns {{ wikiPages: object[], facts: object[] }}
 */
async function hybridSearchWiki(db, query, { ftsOnly = false, trackSearch = true } = {}) {
  const safeQuery = sanitizeFts5(query);
  if (!safeQuery) return { wikiPages: [], facts: [] };

  // 1. FTS5 search (always)
  const ftsResults = ftsSearch(db, safeQuery);

  // 2. Vector search (if available and not forced FTS-only)
  let vectorPages = new Map();
  const hasEmbeddings = !ftsOnly && isEmbeddingAvailable();

  if (hasEmbeddings) {
    try {
      const queryEmb = await getEmbedding(query);
      if (queryEmb) {
        const chunks = vectorSearch(db, queryEmb);
        vectorPages = aggregateChunksToPages(chunks);
      }
    } catch {
      // Vector search failed — degrade gracefully
    }
  }

  // 3. Merge FTS + vector results into unified map
  const merged = new Map();

  for (let i = 0; i < ftsResults.length; i++) {
    const r = ftsResults[i];
    merged.set(r.slug, {
      ftsRank: i + 1,
      title: r.title,
      excerpt: r.excerpt,
      staleness: r.staleness,
    });
  }

  for (const [slug, vInfo] of vectorPages) {
    const existing = merged.get(slug);
    const rank = [...vectorPages.keys()].indexOf(slug) + 1;
    if (existing) {
      existing.vectorRank = rank;
      // Prefer vector excerpt if FTS didn't have a good one
      if (vInfo.excerpt && (!existing.excerpt || existing.excerpt.length < 20)) {
        existing.excerpt = vInfo.excerpt;
      }
    } else {
      // Vector-only result — need to fetch page metadata
      let title = slug;
      let staleness = 0;
      try {
        const page = db.prepare('SELECT title, staleness FROM wiki_pages WHERE slug = ?').get(slug);
        if (page) { title = page.title; staleness = page.staleness || 0; }
      } catch { }
      merged.set(slug, {
        vectorRank: rank,
        title,
        excerpt: vInfo.excerpt,
        staleness,
      });
    }
  }

  // 4. RRF fusion + normalize
  const wikiPages = rrfFuse(merged);
  normalizeScores(wikiPages);

  // 5. Facts search (same as searchWikiAndFacts — FTS5 only)
  let facts = [];
  try {
    facts = db.prepare(`
      SELECT mi.id, mi.title, mi.content, mi.kind, mi.confidence,
             snippet(memory_items_fts, 1, '<b>', '</b>', '...', 20) as excerpt,
             rank as score
      FROM memory_items_fts
      JOIN memory_items mi ON memory_items_fts.rowid = mi.rowid
      WHERE memory_items_fts MATCH ?
        AND mi.state = 'active'
      ORDER BY rank
      LIMIT 10
    `).all(safeQuery);
  } catch {
    facts = [];
  }

  // 6. Track search counts on matched facts
  if (trackSearch && facts.length > 0) {
    const ids = facts.map(r => r.id).filter(Boolean);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(', ');
      try {
        db.prepare(`
          UPDATE memory_items SET search_count = search_count + 1, last_searched_at = datetime('now')
          WHERE id IN (${ph})
        `).run(...ids);
      } catch { }
    }
  }

  return { wikiPages: wikiPages.slice(0, 5), facts };
}

module.exports = {
  hybridSearchWiki,
  _internal: { dotProduct, topK, ftsSearch, vectorSearch, aggregateChunksToPages, rrfFuse, normalizeScores },
};
