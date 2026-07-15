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
const {
  bufferToEmbedding,
  getBackendInfo,
  getEmbedding,
  isEmbeddingAvailable,
} = require('./embedding');

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
  if (!a || !b || a.length !== b.length) return null;
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
function normalizeSourceTypes(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeScopeKeys(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').normalize('NFKC').trim().toLowerCase())
    .filter(Boolean))];
}

function scopePredicate(alias, values) {
  const scopes = normalizeScopeKeys(values);
  if (scopes.length === 0) {
    return { sql: `AND COALESCE(${alias}.page_kind, 'topic_hub') != 'project_dossier' AND ${alias}.source_type != 'managed_redirect'`, args: [] };
  }
  const placeholders = scopes.map(() => '?').join(',');
  return {
    sql: `AND ${alias}.source_type != 'managed_redirect' AND (
      (COALESCE(${alias}.page_kind, 'topic_hub') = 'project_dossier'
        AND EXISTS (SELECT 1 FROM wiki_page_scopes wps WHERE wps.page_slug=${alias}.slug AND lower(wps.scope_key) IN (${placeholders})))
      OR
      (COALESCE(${alias}.page_kind, 'topic_hub') != 'project_dossier' AND (
        NOT EXISTS (SELECT 1 FROM wiki_page_scopes wps WHERE wps.page_slug=${alias}.slug)
        OR EXISTS (SELECT 1 FROM wiki_page_scopes wps WHERE wps.page_slug=${alias}.slug AND lower(wps.scope_key) IN (${placeholders}))
      ))
    )`,
    args: [...scopes, ...scopes],
  };
}

function ftsSearch(db, safeQuery, excludedSourceTypes = [], scopeKeys = []) {
  const excluded = normalizeSourceTypes(excludedSourceTypes);
  const sourceClause = excluded.length > 0
    ? `AND wp.source_type NOT IN (${excluded.map(() => '?').join(',')})`
    : '';
  const scope = scopePredicate('wp', scopeKeys);
  try {
    return db.prepare(`
      SELECT wp.slug, wp.title, wp.staleness, wp.last_built_at, wp.source_type, wp.page_kind, wp.project_key,
             snippet(wiki_pages_fts, 2, '<b>', '</b>', '...', 20) as excerpt,
             rank as ftsRank
      FROM wiki_pages_fts
      JOIN wiki_pages wp ON wiki_pages_fts.rowid = wp.rowid
      LEFT JOIN wiki_external_sources wes ON wes.page_slug = wp.slug
      WHERE wiki_pages_fts MATCH ?
        AND (wp.source_type != 'openwiki' OR COALESCE(wes.missing_count, 0) = 0)
        ${sourceClause}
        ${scope.sql}
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, ...excluded, ...scope.args, MAX_FTS_RESULTS);
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
function vectorSearch(db, queryEmbedding, backendInfo = null, excludedSourceTypes = [], scopeKeys = []) {
  const excluded = normalizeSourceTypes(excludedSourceTypes);
  const sourceClause = excluded.length > 0
    ? `AND wp.source_type NOT IN (${excluded.map(() => '?').join(',')})`
    : '';
  const scope = scopePredicate('wp', scopeKeys);
  let rows;
  try {
    if (backendInfo) {
      rows = db.prepare(`
        SELECT cc.page_slug, cc.chunk_text, cc.embedding, wp.source_type, wp.page_kind, wp.project_key
        FROM content_chunks cc
        JOIN wiki_pages wp ON wp.slug = cc.page_slug
        LEFT JOIN wiki_external_sources wes ON wes.page_slug = wp.slug
        WHERE cc.embedding IS NOT NULL
          AND cc.embedding_model = ?
          AND cc.embedding_dim = ?
          AND (wp.source_type != 'openwiki' OR COALESCE(wes.missing_count, 0) = 0)
          ${sourceClause}
          ${scope.sql}
      `).all(backendInfo.model, backendInfo.dimensions, ...excluded, ...scope.args);
    } else {
      rows = db.prepare(`
        SELECT cc.page_slug, cc.chunk_text, cc.embedding, wp.source_type, wp.page_kind, wp.project_key
        FROM content_chunks cc
        JOIN wiki_pages wp ON wp.slug = cc.page_slug
        LEFT JOIN wiki_external_sources wes ON wes.page_slug = wp.slug
        WHERE cc.embedding IS NOT NULL
          AND (wp.source_type != 'openwiki' OR COALESCE(wes.missing_count, 0) = 0)
          ${sourceClause}
          ${scope.sql}
      `).all(...excluded, ...scope.args);
    }
  } catch {
    return [];
  }

  const scored = [];
  for (const row of rows) {
    const emb = bufferToEmbedding(row.embedding);
    if (!emb || emb.length !== queryEmbedding.length) continue;
    const score = dotProduct(queryEmbedding, emb);
    if (!Number.isFinite(score)) continue;
    scored.push({
      page_slug: row.page_slug,
      chunk_text: row.chunk_text,
      source_type: row.source_type,
      page_kind: row.page_kind,
      project_key: row.project_key,
      score,
    });
  }

  return topK(scored, MAX_VECTOR_RESULTS);
}

function countFtsSourceMatches(db, safeQuery, sourceTypes = [], scopeKeys = []) {
  const included = normalizeSourceTypes(sourceTypes);
  if (included.length === 0) return {};
  const scope = scopePredicate('wp', scopeKeys);
  try {
    const rows = db.prepare(`
      SELECT wp.source_type, COUNT(*) AS count
      FROM wiki_pages_fts
      JOIN wiki_pages wp ON wiki_pages_fts.rowid = wp.rowid
      LEFT JOIN wiki_external_sources wes ON wes.page_slug = wp.slug
      WHERE wiki_pages_fts MATCH ?
        AND wp.source_type IN (${included.map(() => '?').join(',')})
        AND (wp.source_type != 'openwiki' OR COALESCE(wes.missing_count, 0) = 0)
        ${scope.sql}
      GROUP BY wp.source_type
    `).all(safeQuery, ...included, ...scope.args);
    return Object.fromEntries(rows.map(row => [row.source_type, row.count]));
  } catch {
    return {};
  }
}

/**
 * Check if any content_chunks have stored embeddings.
 * Avoids wasting OpenAI API calls when no embeddings exist yet.
 */
function hasStoredEmbeddings(db, backendInfo = null) {
  try {
    if (!backendInfo) {
      return !!db.prepare('SELECT 1 FROM content_chunks WHERE embedding IS NOT NULL LIMIT 1').get();
    }
    return !!db.prepare(`
      SELECT 1 FROM content_chunks
      WHERE embedding IS NOT NULL AND embedding_model = ? AND embedding_dim = ?
      LIMIT 1
    `).get(backendInfo.model, backendInfo.dimensions);
  } catch { return false; }
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
      pages.set(c.page_slug, {
        score: c.score,
        excerpt: c.chunk_text.slice(0, 200),
        source_type: c.source_type,
        page_kind: c.page_kind,
        project_key: c.project_key,
      });
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
    if (info.page_kind === 'project_dossier') score *= 1.15;
    const staleness = info.staleness || 0;
    results.push({
      slug,
      score,
      title: info.title || slug,
      excerpt: info.excerpt || '',
      staleness,
      stale: staleness >= STALE_THRESHOLD,
      source,
      source_type: info.source_type || 'memory',
      page_kind: info.page_kind || 'topic_hub',
      project_key: info.project_key || null,
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
async function hybridSearchWiki(db, query, {
  ftsOnly = false,
  trackSearch = true,
  excludeSourceTypes = [],
  observeSourceTypes = [],
  scopeKeys = [],
} = {}) {
  const safeQuery = sanitizeFts5(query);
  if (!safeQuery) return { wikiPages: [], facts: [] };

  // 1. FTS5 search (always)
  const ftsResults = ftsSearch(db, safeQuery, excludeSourceTypes, scopeKeys);
  const sourceHitCounts = countFtsSourceMatches(db, safeQuery, observeSourceTypes, scopeKeys);

  // 2. Vector search (if available and not forced FTS-only)
  let vectorPages = new Map();
  const backendInfo = !ftsOnly ? getBackendInfo() : null;
  const hasEmbeddings = !!backendInfo && isEmbeddingAvailable();

  if (hasEmbeddings && hasStoredEmbeddings(db, backendInfo)) {
    try {
      const queryEmb = await getEmbedding(query);
      if (queryEmb) {
        const chunks = vectorSearch(db, queryEmb, backendInfo, excludeSourceTypes, scopeKeys);
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
      source_type: r.source_type,
      page_kind: r.page_kind,
      project_key: r.project_key,
    });
  }

  for (const [slug, vInfo] of vectorPages) {
    const existing = merged.get(slug);
    const rank = [...vectorPages.keys()].indexOf(slug) + 1;
    if (existing) {
      existing.vectorRank = rank;
      if (!existing.source_type) existing.source_type = vInfo.source_type;
      if (!existing.page_kind) existing.page_kind = vInfo.page_kind;
      if (!existing.project_key) existing.project_key = vInfo.project_key;
      // Prefer vector excerpt if FTS didn't have a good one
      if (vInfo.excerpt && (!existing.excerpt || existing.excerpt.length < 20)) {
        existing.excerpt = vInfo.excerpt;
      }
    } else {
      // Vector-only result — need to fetch page metadata
      let title = slug;
      let staleness = 0;
      let sourceType = vInfo.source_type || 'memory';
      try {
        const page = db.prepare('SELECT title, staleness, source_type, page_kind, project_key FROM wiki_pages WHERE slug = ?').get(slug);
        if (page) {
          title = page.title;
          staleness = page.staleness || 0;
          sourceType = page.source_type || sourceType;
          vInfo.page_kind = page.page_kind || vInfo.page_kind;
          vInfo.project_key = page.project_key || vInfo.project_key;
        }
      } catch { }
      merged.set(slug, {
        vectorRank: rank,
        title,
        excerpt: vInfo.excerpt,
        staleness,
        source_type: sourceType,
        page_kind: vInfo.page_kind,
        project_key: vInfo.project_key,
      });
    }
  }

  // 4. RRF fusion + normalize
  const wikiPages = filterScopeEligible(db, rrfFuse(merged), scopeKeys);
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

  return { wikiPages: wikiPages.slice(0, 5), facts, sourceHitCounts };
}

function filterScopeEligible(db, pages, scopeKeys) {
  if (pages.length === 0) return pages;
  const scope = scopePredicate('wp', scopeKeys);
  const placeholders = pages.map(() => '?').join(',');
  try {
    const eligible = new Set(db.prepare(`
      SELECT wp.slug FROM wiki_pages wp WHERE wp.slug IN (${placeholders}) ${scope.sql}
    `).all(...pages.map(page => page.slug), ...scope.args).map(row => row.slug));
    return pages.filter(page => eligible.has(page.slug));
  } catch {
    return [];
  }
}

module.exports = {
  hybridSearchWiki,
  _internal: {
    dotProduct,
    topK,
    ftsSearch,
    vectorSearch,
    aggregateChunksToPages,
    rrfFuse,
    normalizeScores,
    hasStoredEmbeddings,
    countFtsSourceMatches,
  },
};
