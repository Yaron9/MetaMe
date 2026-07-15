'use strict';

/**
 * wiki-reflect-query.js — DB read layer for wiki-reflect
 *
 * Fetches raw facts and capsule excerpts for a topic.
 * No DB writes, no LLM calls. File reads (capsule excerpts) are intentional and non-fatal.
 *
 * Exports:
 *   queryRawFacts(db, tag, { capsulesDir }) → { totalCount, facts, capsuleExcerpts }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DERIVED_RELATIONS = ['synthesized_insight', 'knowledge_capsule'];
const DEFAULT_CAPSULES_DIR = path.join(os.homedir(), '.metame', 'memory', 'capsules');
const CAPSULE_EXCERPT_CHARS = 200;
const CAPSULE_MAX = 3;
const FACTS_LIMIT = 30;
const DOSSIER_FACTS_LIMIT = 40;
const {
  isAtomicMemoryFact,
  normalizeProjectKey,
  normalizeTopicKey,
  planCanonicalTopics,
  relatedTopics,
} = require('./core/wiki-topic-model');

/**
 * Query raw facts for a wiki topic tag.
 *
 * Two-step approach:
 *   Step 1: COUNT(*) without LIMIT → totalCount (used as staleness denominator)
 *   Step 2: SELECT top 30 ordered by search_count DESC, confidence DESC → facts (LLM prompt)
 *
 * @param {object} db - DatabaseSync instance
 * @param {string} tag - The wiki topic tag
 * @param {{ capsulesDir?: string }} opts
 * @returns {{ totalCount: number, facts: object[], capsuleExcerpts: string }}
 */
function queryRawFacts(db, tag, { capsulesDir = DEFAULT_CAPSULES_DIR } = {}) {
  const placeholders = DERIVED_RELATIONS.map(() => '?').join(', ');

  // Step 1: total count (staleness denominator, no LIMIT)
  // Include 'candidate' so topics promoted via saveFacts aren't skipped on first build.
  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM memory_items mi
    JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(trim(?))
    WHERE mi.state IN ('active', 'candidate')
      AND (mi.relation NOT IN (${placeholders}) OR mi.relation IS NULL)
  `).get(tag, ...DERIVED_RELATIONS);

  const totalCount = countRow ? countRow.cnt : 0;

  // Step 2: top 30 for LLM prompt — include candidates so first build isn't empty
  const facts = db.prepare(`
    SELECT mi.id, mi.title, mi.content, mi.confidence, mi.search_count,
           mi.created_at, mi.tags
    FROM memory_items mi
    JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(trim(?))
    WHERE mi.state IN ('active', 'candidate')
      AND (mi.relation NOT IN (${placeholders}) OR mi.relation IS NULL)
    ORDER BY mi.state ASC, mi.search_count DESC, mi.confidence DESC
    LIMIT ?
  `).all(tag, ...DERIVED_RELATIONS, FACTS_LIMIT);

  // Capsule excerpts: read files from capsulesDir whose name contains the tag
  const capsuleExcerpts = _loadCapsuleExcerpts(tag, capsulesDir);

  return { totalCount, facts, capsuleExcerpts };
}

/**
 * Return the complete project-aware evidence set for a canonical topic.
 * Normalization deliberately happens in JavaScript: SQLite NOCASE only handles
 * ASCII and must not become a second canonicalization implementation.
 */
function queryTopicEvidence(db, aliases, { limitPerProject = DOSSIER_FACTS_LIMIT } = {}) {
  const wanted = new Set((Array.isArray(aliases) ? aliases : [aliases]).map(normalizeTopicKey).filter(Boolean));
  if (wanted.size === 0) return [];
  const rows = db.prepare(`
    SELECT id, title, content, confidence, search_count, created_at, tags,
           project, scope, state, kind, relation, source_type, source_id
    FROM memory_items
    WHERE state IN ('active', 'candidate')
      AND (relation NOT IN ('synthesized_insight', 'knowledge_capsule') OR relation IS NULL)
    ORDER BY state ASC, search_count DESC, confidence DESC, created_at DESC
  `).all();
  const perProject = new Map();
  return rows.filter(row => {
    let tags = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { return false; }
    if (!Array.isArray(tags) || !tags.some(tag => wanted.has(normalizeTopicKey(tag)))) return false;
    const key = normalizeTopicKey(row.project || row.scope || '*');
    const count = perProject.get(key) || 0;
    if (count >= limitPerProject) return false;
    perProject.set(key, count + 1);
    return true;
  });
}

function queryTopicResearch(db, aliases) {
  const wanted = new Set((Array.isArray(aliases) ? aliases : [aliases]).map(normalizeTopicKey).filter(Boolean));
  if (wanted.size === 0) return [];
  let entities;
  try { entities = db.prepare('SELECT id, name, aliases FROM research_entities ORDER BY created_at, id').all(); } catch { return []; }
  const entityIds = entities.filter(entity => {
    const names = [entity.name];
    try {
      const parsed = JSON.parse(entity.aliases || '[]');
      if (Array.isArray(parsed)) names.push(...parsed);
    } catch { /* ignore malformed optional aliases */ }
    return names.some(name => wanted.has(normalizeTopicKey(name)));
  }).map(entity => entity.id);
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT pf.id AS fact_id, pf.doc_source_id, ds.slug, ds.title
    FROM fact_entity_links fel
    JOIN paper_facts pf ON pf.id = fel.fact_id
    JOIN doc_sources ds ON ds.id = pf.doc_source_id
    WHERE fel.entity_id IN (${placeholders})
    ORDER BY ds.slug, pf.id
  `).all(...entityIds);
  if (new Set(rows.map(row => row.fact_id)).size < 2 || new Set(rows.map(row => row.doc_source_id)).size < 2) return [];
  const docs = new Map();
  for (const row of rows) {
    if (!docs.has(row.doc_source_id)) docs.set(row.doc_source_id, {
      docSourceId: row.doc_source_id,
      slug: row.slug,
      title: row.title || row.slug,
      factIds: [],
    });
    docs.get(row.doc_source_id).factIds.push(row.fact_id);
  }
  return [...docs.values()].map(doc => ({ ...doc, factCount: doc.factIds.length }));
}

function queryRelatedTopics(db, aliases) {
  const current = new Set((Array.isArray(aliases) ? aliases : [aliases]).map(normalizeTopicKey).filter(Boolean));
  if (current.size === 0) return [];
  const rows = db.prepare(`
    SELECT id, project, scope, state, kind, relation, tags FROM memory_items
    WHERE state='active' AND kind IN ('insight','convention')
  `).all().map(row => {
    let tags = [];
    try { tags = [...new Set(JSON.parse(row.tags || '[]').map(normalizeTopicKey).filter(Boolean))]; } catch { /* empty */ }
    return { ...row, tags, projectKey: normalizeProjectKey(row.project || row.scope) };
  }).filter(row => row.projectKey && isAtomicMemoryFact(row));
  const relevantProjects = new Set(rows.filter(row => row.tags.some(tag => current.has(tag))).map(row => row.projectKey));
  const relevant = rows.filter(row => relevantProjects.has(row.projectKey));
  const leftRows = relevant.filter(row => row.tags.some(tag => current.has(tag)));
  const candidates = new Map();
  for (const row of leftRows) {
    for (const tag of row.tags) {
      if (current.has(tag)) continue;
      if (!candidates.has(tag)) candidates.set(tag, new Set());
      candidates.get(tag).add(row.id);
    }
  }
  const canonical = new Map(planCanonicalTopics(db.prepare('SELECT * FROM wiki_topics').all())
    .map(topic => [topic.normalizedKey, topic]));
  const scored = [];
  for (const [key, sharedIds] of candidates) {
    const topic = canonical.get(key);
    if (!topic) continue;
    const rightTotal = relevant.filter(row => row.tags.includes(key)).length;
    scored.push({ slug: topic.slug, label: topic.label || topic.tag, shared: sharedIds.size, leftTotal: leftRows.length, rightTotal });
  }
  return relatedTopics(scored);
}

/**
 * Load capsule excerpts for the given tag.
 * Reads up to CAPSULE_MAX capsule files whose filename contains the tag slug.
 *
 * @param {string} tag
 * @param {string} capsulesDir
 * @returns {string} Concatenated excerpts, may be empty
 */
function _loadCapsuleExcerpts(tag, capsulesDir) {
  if (!fs.existsSync(capsulesDir)) return '';

  let files;
  try {
    files = fs.readdirSync(capsulesDir).filter(f => f.endsWith('.md'));
  } catch {
    return '';
  }

  // Match files whose name contains tag (lowercased, spaces→hyphens)
  const needle = tag.toLowerCase().replace(/\s+/g, '-');
  const matched = files
    .filter(f => f.toLowerCase().includes(needle))
    .slice(0, CAPSULE_MAX);

  if (matched.length === 0) return '';

  const parts = [];
  for (const filename of matched) {
    try {
      const text = fs.readFileSync(path.join(capsulesDir, filename), 'utf8');
      // Strip frontmatter (--- ... ---) before excerpting
      const body = text.replace(/^---[\s\S]*?---\n?/, '').trim();
      if (body) {
        parts.push(`[${filename}]\n${body.slice(0, CAPSULE_EXCERPT_CHARS)}`);
      }
    } catch { /* skip unreadable file */ }
  }

  return parts.join('\n\n');
}

module.exports = { queryRawFacts, queryRelatedTopics, queryTopicEvidence, queryTopicResearch };
