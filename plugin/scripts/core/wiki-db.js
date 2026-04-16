'use strict';

/**
 * core/wiki-db.js — Wiki DB read/write layer
 *
 * All functions accept a DatabaseSync instance as first arg.
 * No DB lifecycle management here — caller provides db.
 *
 * Exports:
 *   // wiki_pages CRUD
 *   getWikiPageBySlug(db, slug) → row | null
 *   listWikiPages(db, { limit=20, orderBy='updated_at' }) → row[]
 *   getStalePages(db, threshold=0.4) → row[]
 *   upsertWikiPage(db, { slug, primary_topic, title, content, raw_source_ids,
 *                        capsule_refs, raw_source_count, topic_tags, word_count }) → void
 *   resetPageStaleness(db, slug, rawSourceCount) → void
 *
 *   // wiki_topics CRUD
 *   upsertWikiTopic(db, tag, { label, pinned=0, force=false }) → { slug, isNew }
 *   checkTopicThreshold(db, tag) → boolean
 *   listWikiTopics(db) → row[]
 *
 *   // search
 *   searchWikiAndFacts(db, query, { trackSearch=true }) → { wikiPages, facts }
 *   listRecentSessionSummaries(db, { limit=200 }) → row[]
 *
 *   // staleness
 *   updateStalenessForTags(db, dirtyTagCounts: Map<string, number>) → void
 */

const { toSlug, sanitizeFts5 } = require('./wiki-slug');
const { calcStaleness } = require('./wiki-staleness');

// ── wiki_pages CRUD ────────────────────────────────────────────────────────────

/**
 * @param {object} db
 * @param {string} slug
 * @returns {object|null}
 */
function getWikiPageBySlug(db, slug) {
  return db.prepare('SELECT * FROM wiki_pages WHERE slug = ?').get(slug) ?? null;
}

/**
 * @param {object} db
 * @param {{ limit?: number, orderBy?: string }} opts
 * @returns {object[]}
 */
function listWikiPages(db, { limit = 20, orderBy = 'updated_at' } = {}) {
  // Whitelist orderBy to prevent SQL injection
  const allowed = ['updated_at', 'created_at', 'staleness', 'title', 'last_built_at', 'word_count'];
  const col = allowed.includes(orderBy) ? orderBy : 'updated_at';
  return db.prepare(`SELECT * FROM wiki_pages ORDER BY ${col} DESC LIMIT ?`).all(limit);
}

/**
 * @param {object} db
 * @param {number} threshold
 * @returns {object[]}
 */
function getStalePages(db, threshold = 0.4) {
  return db.prepare('SELECT * FROM wiki_pages WHERE staleness >= ? ORDER BY staleness DESC').all(threshold);
}

/**
 * Upsert a wiki page (INSERT OR REPLACE).
 * On insert: id = wp_<timestamp>_<random>, created_at = now.
 * On update: preserves existing id/created_at, updates all provided fields.
 *
 * @param {object} db
 * @param {{ slug: string, primary_topic: string, title: string, content: string,
 *           raw_source_ids?: any, capsule_refs?: any, raw_source_count?: number,
 *           topic_tags?: any, word_count?: number }} opts
 */
function upsertWikiPage(db, {
  slug,
  primary_topic,
  title,
  content,
  raw_source_ids = '[]',
  capsule_refs = '[]',
  raw_source_count = 0,
  topic_tags = '[]',
  word_count = 0,
  source_type = 'memory',
  membership_hash = null,
  cluster_size = null,
}) {
  const rawSourceIdsStr = typeof raw_source_ids === 'string'
    ? raw_source_ids : JSON.stringify(raw_source_ids);
  const capsuleRefsStr = typeof capsule_refs === 'string'
    ? capsule_refs : JSON.stringify(capsule_refs);
  const topicTagsStr = typeof topic_tags === 'string'
    ? topic_tags : JSON.stringify(topic_tags);

  // Check if page exists
  const existing = db.prepare('SELECT id, created_at FROM wiki_pages WHERE slug = ?').get(slug);

  if (existing) {
    db.prepare(`
      UPDATE wiki_pages
      SET primary_topic = ?,
          title = ?,
          content = ?,
          raw_source_ids = ?,
          capsule_refs = ?,
          raw_source_count = ?,
          topic_tags = ?,
          word_count = ?,
          source_type = ?,
          membership_hash = ?,
          cluster_size = ?,
          updated_at = datetime('now')
      WHERE slug = ?
    `).run(primary_topic, title, content, rawSourceIdsStr, capsuleRefsStr, raw_source_count, topicTagsStr, word_count, source_type, membership_hash, cluster_size, slug);
  } else {
    const id = `wp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`
      INSERT INTO wiki_pages
        (id, slug, primary_topic, title, content, raw_source_ids, capsule_refs,
         raw_source_count, topic_tags, word_count, staleness, new_facts_since_build,
         source_type, membership_hash, cluster_size,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, 0, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, slug, primary_topic, title, content, rawSourceIdsStr, capsuleRefsStr, raw_source_count, topicTagsStr, word_count, source_type, membership_hash, cluster_size);
  }
}

/**
 * Reset staleness after wiki-reflect rebuilds a page.
 * @param {object} db
 * @param {string} slug
 * @param {number} rawSourceCount
 */
function resetPageStaleness(db, slug, rawSourceCount) {
  db.prepare(`
    UPDATE wiki_pages
    SET staleness = 0.0,
        new_facts_since_build = 0,
        raw_source_count = ?,
        last_built_at = datetime('now'),
        updated_at = datetime('now')
    WHERE slug = ?
  `).run(rawSourceCount, slug);
}

// ── wiki_topics CRUD ──────────────────────────────────────────────────────────

/**
 * Upsert a wiki topic.
 * Handles slug collision by appending -2 ... -10.
 * force=true skips checkTopicThreshold.
 *
 * @param {object} db
 * @param {string} tag
 * @param {{ label?: string, pinned?: number, force?: boolean }} opts
 * @returns {{ slug: string, isNew: boolean }}
 */
function upsertWikiTopic(db, tag, { label, pinned = 0, force = false } = {}) {
  if (typeof tag !== 'string' || !tag.trim()) {
    throw new Error('upsertWikiTopic: tag must be a non-empty string');
  }

  // Check if this exact tag already exists → idempotent update
  const existing = db.prepare('SELECT slug FROM wiki_topics WHERE tag = ?').get(tag);
  if (existing) {
    // Update label/pinned if provided
    db.prepare(`
      UPDATE wiki_topics
      SET label = COALESCE(?, label),
          pinned = MAX(pinned, ?)
      WHERE tag = ?
    `).run(label ?? null, pinned, tag);
    return { slug: existing.slug, isNew: false };
  }

  // New tag — check threshold unless force
  if (!force) {
    const passes = checkTopicThreshold(db, tag);
    if (!passes) {
      throw new Error(`upsertWikiTopic: tag "${tag}" does not meet threshold (need ≥5 active raw facts AND ≥1 in last 30 days)`);
    }
  }

  // Generate slug with collision handling
  let baseSlug;
  try {
    baseSlug = toSlug(tag);
  } catch (err) {
    throw new Error(`upsertWikiTopic: ${err.message}`);
  }

  let finalSlug = baseSlug;
  // Check collision: same slug, different tag
  const collision = db.prepare('SELECT tag FROM wiki_topics WHERE slug = ? AND tag != ?').get(finalSlug, tag);
  if (collision) {
    let found = false;
    for (let i = 2; i <= 10; i++) {
      const candidate = `${baseSlug}-${i}`;
      const exists = db.prepare('SELECT tag FROM wiki_topics WHERE slug = ?').get(candidate);
      if (!exists) {
        finalSlug = candidate;
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`upsertWikiTopic: slug collision for tag "${tag}" — exhausted -2 to -10 suffixes`);
    }
  }

  const effectiveLabel = label ?? tag;
  db.prepare(`
    INSERT INTO wiki_topics (tag, slug, label, pinned)
    VALUES (?, ?, ?, ?)
  `).run(tag, finalSlug, effectiveLabel, pinned);

  return { slug: finalSlug, isNew: true };
}

/**
 * Check whether a tag meets the threshold for wiki topic registration.
 * Condition 1: active raw facts COUNT >= 5 (lifetime)
 * Condition 2: active raw facts COUNT >= 1 WHERE created_at >= datetime('now', '-30 days') (UTC)
 * Both must be true.
 *
 * "raw facts" = state IN ('active', 'candidate') AND (relation NOT IN (...) OR relation IS NULL)
 * Counts both states so that topic promotion can fire during saveFacts (facts enter
 * as 'candidate' and are promoted to 'active' by nightly-reflect).
 *
 * @param {object} db
 * @param {string} tag
 * @returns {boolean}
 */
function checkTopicThreshold(db, tag) {
  const DERIVED = ['synthesized_insight', 'knowledge_capsule'];
  const placeholders = DERIVED.map(() => '?').join(', ');

  // Condition 1: lifetime count >= 5 (active or candidate)
  const row1 = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM memory_items mi
    JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(trim(?))
    WHERE mi.state IN ('active', 'candidate')
      AND (mi.relation NOT IN (${placeholders}) OR mi.relation IS NULL)
  `).get(tag, ...DERIVED);

  if (!row1 || row1.cnt < 5) return false;

  // Condition 2: at least 1 in last 30 days (active or candidate)
  const row2 = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM memory_items mi
    JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(trim(?))
    WHERE mi.state IN ('active', 'candidate')
      AND (mi.relation NOT IN (${placeholders}) OR mi.relation IS NULL)
      AND mi.created_at >= datetime('now', '-30 days')
  `).get(tag, ...DERIVED);

  if (!row2 || row2.cnt < 1) return false;

  return true;
}

/**
 * @param {object} db
 * @returns {object[]}
 */
function listWikiTopics(db) {
  return db.prepare('SELECT * FROM wiki_topics ORDER BY created_at DESC').all();
}

function listRecentSessionSummaries(db, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT
      id,
      session_id,
      project,
      scope,
      title,
      content,
      tags,
      created_at,
      updated_at
    FROM memory_items
    WHERE kind = 'episode'
      AND state = 'active'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);
}

// ── Timeline ──────────────────────────────────────────────────────────────────

/**
 * Append a timestamped entry to a wiki page's timeline (evidence trail).
 * Does NOT touch content (compiled truth) — timeline is append-only.
 *
 * @param {object} db
 * @param {string} slug
 * @param {string} entry — free-text description of what happened
 */
function appendWikiTimeline(db, slug, entry) {
  const ts = new Date().toISOString().slice(0, 10);
  const line = `[${ts}] ${entry}`;
  db.prepare(
    `UPDATE wiki_pages SET timeline = COALESCE(timeline, '') || ? || char(10), updated_at = datetime('now') WHERE slug = ?`,
  ).run(line, slug);
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Search wiki pages and memory facts via FTS5.
 * trackSearch=true → UPDATE search_count on matched facts.
 *
 * @param {object} db
 * @param {string} query
 * @param {{ trackSearch?: boolean }} opts
 * @returns {{ wikiPages: object[], facts: object[] }}
 */
function searchWikiAndFacts(db, query, { trackSearch = true } = {}) {
  const safeQuery = sanitizeFts5(query);
  if (!safeQuery) return { wikiPages: [], facts: [] };

  // 1. FTS5 search wiki_pages_fts (weight 1.5x)
  const wikiPages = db.prepare(`
    SELECT wp.slug, wp.title, wp.staleness, wp.last_built_at,
           snippet(wiki_pages_fts, 2, '<b>', '</b>', '...', 20) as excerpt,
           rank * 1.5 as score
    FROM wiki_pages_fts
    JOIN wiki_pages wp ON wiki_pages_fts.rowid = wp.rowid
    WHERE wiki_pages_fts MATCH ?
    ORDER BY rank
    LIMIT 5
  `).all(safeQuery);

  // Add stale flag to wiki results (staleness >= 0.3 means compiled truth may be outdated)
  for (const wp of wikiPages) {
    wp.stale = typeof wp.staleness === 'number' && wp.staleness >= 0.3;
  }

  // 2. FTS5 search memory_items_fts — graceful fallback if table doesn't exist
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

  // 3. trackSearch: update search_count on matched facts
  if (trackSearch && facts.length > 0) {
    _trackSearch(db, facts.map(r => r.id));
  }

  return { wikiPages, facts };
}

/**
 * Increment search_count and update last_searched_at for given memory item IDs.
 * @param {object} db
 * @param {string[]} ids
 */
function _trackSearch(db, ids) {
  if (!ids || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(`
    UPDATE memory_items
    SET search_count = search_count + 1,
        last_searched_at = datetime('now')
    WHERE id IN (${placeholders})
  `).run(...ids);
}

// ── Staleness ─────────────────────────────────────────────────────────────────

/**
 * Update staleness for wiki pages matching dirty tags.
 * Routes through wiki_topics (the canonical tag registry) so that casing
 * differences between fact tags and wiki_pages.primary_topic are bridged.
 * RHS expressions in a single UPDATE see pre-update column values (SQLite semantics),
 * so new_facts_since_build in the staleness formula is the original value.
 *
 * @param {object} db
 * @param {Map<string, number>} dirtyTagCounts
 */
function updateStalenessForTags(db, dirtyTagCounts) {
  for (const [tag, newCount] of dirtyTagCounts) {
    if (newCount <= 0) continue;

    // Match via wiki_topics.tag (canonical registry) → wiki_pages.slug
    db.prepare(`
      UPDATE wiki_pages
      SET new_facts_since_build = new_facts_since_build + ?,
          staleness = MIN(1.0,
            CAST(new_facts_since_build + ? AS REAL)
            / NULLIF(raw_source_count + new_facts_since_build + ?, 0)
          ),
          updated_at = datetime('now')
      WHERE slug IN (
        SELECT slug FROM wiki_topics WHERE lower(trim(tag)) = lower(trim(?))
      )
    `).run(newCount, newCount, newCount, tag);
  }
}

// ── doc_sources CRUD ──────────────────────────────────────────────────────────

function upsertDocSource(db, { filePath, fileHash, mtimeMs, sizeBytes, fileType,
    extractor, extractStatus, extractedTextHash, title, slug }) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT file_hash, extracted_text_hash FROM doc_sources WHERE file_path=?').get(filePath);
  const hashChanged = !existing
    || existing.file_hash !== fileHash
    || existing.extracted_text_hash !== (extractedTextHash || null);

  db.prepare(`
    INSERT INTO doc_sources
      (file_path, file_hash, mtime_ms, size_bytes, extracted_text_hash, file_type, extractor,
       extract_status, title, slug, status, indexed_at, last_seen_at, content_stale)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash=excluded.file_hash,
      mtime_ms=excluded.mtime_ms,
      size_bytes=excluded.size_bytes,
      extracted_text_hash=excluded.extracted_text_hash,
      extractor=excluded.extractor,
      extract_status=excluded.extract_status,
      title=excluded.title,
      status='active',
      last_seen_at=excluded.last_seen_at,
      content_stale=CASE
        WHEN excluded.file_hash != doc_sources.file_hash
          OR COALESCE(excluded.extracted_text_hash,'') != COALESCE(doc_sources.extracted_text_hash,'')
        THEN 1
        ELSE doc_sources.content_stale
      END
  `).run(
    filePath, fileHash, mtimeMs || null, sizeBytes || null,
    extractedTextHash || null, fileType, extractor || null,
    extractStatus || 'pending', title || null, slug,
    now, now, hashChanged ? 1 : 0
  );
}

function getDocSourceByPath(db, filePath) {
  return db.prepare('SELECT * FROM doc_sources WHERE file_path=?').get(filePath) || null;
}

function getDocSourceBySlug(db, slug) {
  return db.prepare('SELECT * FROM doc_sources WHERE slug=?').get(slug) || null;
}

function listStaleDocSources(db) {
  return db.prepare("SELECT * FROM doc_sources WHERE content_stale=1 AND status='active'").all();
}

function markDocSourcesMissing(db, seenPaths) {
  if (seenPaths.length === 0) return;
  const set = new Set(seenPaths);
  // Infer the scan directory from the seen paths so we only mark files
  // within that directory scope as missing (not docs imported from other paths).
  const path = require('node:path');
  const dirs = new Set(seenPaths.map(p => path.dirname(p)));
  const all = db.prepare("SELECT id, file_path FROM doc_sources WHERE status='active'").all();
  const missingIds = all
    .filter(r => dirs.has(path.dirname(r.file_path)) && !set.has(r.file_path))
    .map(r => r.id);
  if (missingIds.length === 0) return;
  const ph = missingIds.map(() => '?').join(',');
  db.prepare(`UPDATE doc_sources SET status='missing' WHERE id IN (${ph})`).run(...missingIds);
}

function upsertDocPageLink(db, pageSlug, docSourceId, role) {
  db.prepare(`
    INSERT OR IGNORE INTO wiki_page_doc_sources (page_slug, doc_source_id, role)
    VALUES (?, ?, ?)
  `).run(pageSlug, docSourceId, role);
}

function getClusterMemberIds(db, pageSlug) {
  return db.prepare(
    "SELECT doc_source_id FROM wiki_page_doc_sources WHERE page_slug=? AND role='cluster_member'"
  ).all(pageSlug).map(r => r.doc_source_id);
}

function replaceClusterMembers(db, pageSlug, docSourceIds) {
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM wiki_page_doc_sources WHERE page_slug=? AND role='cluster_member'").run(pageSlug);
    const ins = db.prepare("INSERT INTO wiki_page_doc_sources (page_slug, doc_source_id, role) VALUES (?,?,'cluster_member')");
    for (const id of docSourceIds) ins.run(pageSlug, id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function listClusterPages(db) {
  return db.prepare(
    "SELECT slug, membership_hash, cluster_size FROM wiki_pages WHERE source_type='topic_cluster'"
  ).all();
}

module.exports = {
  // wiki_pages
  getWikiPageBySlug,
  listWikiPages,
  getStalePages,
  upsertWikiPage,
  resetPageStaleness,
  appendWikiTimeline,
  // wiki_topics
  upsertWikiTopic,
  checkTopicThreshold,
  listWikiTopics,
  listRecentSessionSummaries,
  // search
  searchWikiAndFacts,
  // staleness
  updateStalenessForTags,
  // doc_sources CRUD
  upsertDocSource,
  getDocSourceByPath,
  getDocSourceBySlug,
  listStaleDocSources,
  markDocSourcesMissing,
  // wiki_page_doc_sources CRUD
  upsertDocPageLink,
  getClusterMemberIds,
  replaceClusterMembers,
  listClusterPages,
};
