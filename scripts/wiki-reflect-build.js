'use strict';

/**
 * wiki-reflect-build.js — LLM call + DB write layer for wiki-reflect
 *
 * Calls callHaiku to generate wiki article content, validates [[wikilinks]],
 * then writes the result to DB in a transaction.
 * No file IO.
 *
 * Exports:
 *   buildWikiPage(db, topic, queryResult, { allowedSlugs, providers })
 *     → { slug, content, strippedLinks, rawSourceIds } | null
 */

const { buildWikiPrompt, validateWikilinks } = require('./core/wiki-prompt');
const { upsertWikiPage, resetPageStaleness } = require('./core/wiki-db');

const LLM_TIMEOUT_MS = 30000;

/**
 * Build a wiki page: call LLM, validate links, write to DB.
 *
 * @param {object} db - DatabaseSync instance
 * @param {{ tag: string, slug: string, label: string }} topic
 * @param {{ totalCount: number, facts: object[], capsuleExcerpts: string }} queryResult
 * @param {{ allowedSlugs: string[], providers: { callHaiku: Function, buildDistillEnv: Function } }} opts
 * @returns {{ slug: string, content: string, strippedLinks: string[], rawSourceIds: string[] } | null}
 *   Returns null on LLM failure. DB write failure throws (caller handles).
 */
async function buildWikiPage(db, topic, queryResult, { allowedSlugs = [], providers }) {
  const { callHaiku, buildDistillEnv } = providers;
  const { totalCount, facts, capsuleExcerpts } = queryResult;

  // Build prompt
  const prompt = buildWikiPrompt(topic, facts, capsuleExcerpts, allowedSlugs);

  // Call LLM
  let rawContent;
  try {
    const env = buildDistillEnv();
    rawContent = await callHaiku(prompt, env, LLM_TIMEOUT_MS, { model: 'haiku' });
  } catch (err) {
    // LLM failure → return null (caller logs to failed_slugs)
    return null;
  }

  if (!rawContent || typeof rawContent !== 'string' || !rawContent.trim()) {
    return null;
  }

  // Validate and strip illegal [[wikilinks]]
  const { content, stripped: strippedLinks } = validateWikilinks(rawContent.trim(), allowedSlugs);

  // Collect source IDs from facts
  const rawSourceIds = facts.map(f => f.id).filter(Boolean);

  // Write to DB in a transaction
  const topicTagsArr = [topic.tag];
  db.prepare('BEGIN').run();
  try {
    upsertWikiPage(db, {
      slug: topic.slug,
      primary_topic: topic.tag,
      title: topic.label || topic.tag,
      content,
      raw_source_ids: JSON.stringify(rawSourceIds),
      capsule_refs: '[]',
      raw_source_count: totalCount,
      topic_tags: JSON.stringify(topicTagsArr),
      word_count: content.split(/\s+/).filter(Boolean).length,
    });

    // Reset staleness counters via canonical helper (staleness=0, last_built_at=now)
    resetPageStaleness(db, topic.slug, totalCount);

    db.prepare('COMMIT').run();
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch { /* ignore */ }
    throw err; // propagate DB errors to caller
  }

  return { slug: topic.slug, content, strippedLinks, rawSourceIds };
}

module.exports = { buildWikiPage };
