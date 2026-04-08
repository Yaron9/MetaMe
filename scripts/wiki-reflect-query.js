'use strict';

/**
 * wiki-reflect-query.js — DB read layer for wiki-reflect
 *
 * Fetches raw facts and capsule excerpts for a topic.
 * No DB writes, no LLM calls, no file IO.
 *
 * Exports:
 *   queryRawFacts(db, tag, { capsulesDir }) → { totalCount, facts, capsuleExcerpts }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DERIVED_RELATIONS = ['synthesized_insight', 'knowledge_capsule'];
const DEFAULT_CAPSULES_DIR = path.join(os.homedir(), '.metame', 'capsules');
const CAPSULE_EXCERPT_CHARS = 200;
const CAPSULE_MAX = 3;
const FACTS_LIMIT = 30;

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
  const countRow = db.prepare(`
    SELECT COUNT(*) as cnt
    FROM memory_items mi
    JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(trim(?))
    WHERE mi.state = 'active'
      AND (mi.relation NOT IN (${placeholders}) OR mi.relation IS NULL)
  `).get(tag, ...DERIVED_RELATIONS);

  const totalCount = countRow ? countRow.cnt : 0;

  // Step 2: top 30 for LLM prompt
  const facts = db.prepare(`
    SELECT mi.id, mi.title, mi.content, mi.confidence, mi.search_count,
           mi.created_at, mi.tags
    FROM memory_items mi
    JOIN json_each(mi.tags) jt ON lower(trim(jt.value)) = lower(trim(?))
    WHERE mi.state = 'active'
      AND (mi.relation NOT IN (${placeholders}) OR mi.relation IS NULL)
    ORDER BY mi.search_count DESC, mi.confidence DESC
    LIMIT ?
  `).all(tag, ...DERIVED_RELATIONS, FACTS_LIMIT);

  // Capsule excerpts: read files from capsulesDir whose name contains the tag
  const capsuleExcerpts = _loadCapsuleExcerpts(tag, capsulesDir);

  return { totalCount, facts, capsuleExcerpts };
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

module.exports = { queryRawFacts };
