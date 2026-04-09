'use strict';

/**
 * wiki-reflect-build.js — LLM call + DB write layer for wiki-reflect
 *
 * Calls Sonnet to generate wiki article content, validates [[wikilinks]],
 * then writes the result to DB in a transaction.
 * No file IO.
 *
 * Exports:
 *   buildWikiPage(db, topic, queryResult, { allowedSlugs, providers })
 *     → { slug, content, strippedLinks, rawSourceIds } | null
 */

const { buildWikiPrompt, validateWikilinks } = require('./core/wiki-prompt');
const { upsertWikiPage, resetPageStaleness } = require('./core/wiki-db');

const LLM_TIMEOUT_MS = 60000; // Sonnet needs more time than Haiku

/**
 * Build a wiki page: call LLM, validate links, write to DB.
 *
 * @param {object} db - DatabaseSync instance
 * @param {{ tag: string, slug: string, label: string }} topic
 * @param {{ totalCount: number, facts: object[], capsuleExcerpts: string }} queryResult
 * @param {{ allowedSlugs: string[], providers: { callHaiku: Function, buildDistillEnv: Function } }} opts
 * @returns {{ slug: string, content: string, strippedLinks: string[], rawSourceIds: string[] } | null}
 *   Returns null on LLM failure (caller enqueues for retry). DB write failure throws.
 */
async function buildWikiPage(db, topic, queryResult, { allowedSlugs = [], providers }) {
  const { callHaiku, buildDistillEnv } = providers;
  const { totalCount, facts, capsuleExcerpts } = queryResult;

  // Build prompt
  const prompt = buildWikiPrompt(topic, facts, capsuleExcerpts, allowedSlugs);

  // Call LLM — return null on failure so caller can schedule exponential-backoff retry
  let rawContent;
  try {
    const env = buildDistillEnv();
    rawContent = await callHaiku(prompt, env, LLM_TIMEOUT_MS, { model: 'sonnet' });
  } catch {
    return null;
  }

  if (!rawContent || typeof rawContent !== 'string' || !rawContent.trim()) {
    return null; // Empty response — treat as failure, schedule retry
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

function buildFallbackWikiContent(topic, queryResult) {
  const { totalCount = 0, facts = [], capsuleExcerpts = '' } = queryResult || {};
  const title = topic.label || topic.tag || topic.slug || '未命名主题';
  const lines = [
    `## 概览`,
    '',
    `${title} 当前基于 ${totalCount} 条已归档记忆自动生成。以下内容由事实汇总得到，供 Obsidian 检索与人工补充使用。`,
  ];

  if (capsuleExcerpts && capsuleExcerpts.trim()) {
    lines.push('', '## 背景补充', '', capsuleExcerpts.trim());
  }

  if (facts.length > 0) {
    lines.push('', '## 关键事实', '');
    facts.slice(0, 12).forEach((fact, index) => {
      const factTitle = (fact.title || `事实 ${index + 1}`).trim();
      const content = String(fact.content || '').trim();
      const meta = [];
      if (typeof fact.confidence === 'number') meta.push(`可信度 ${fact.confidence}`);
      if (typeof fact.search_count === 'number') meta.push(`检索 ${fact.search_count}`);
      lines.push(`### ${index + 1}. ${factTitle}`);
      if (meta.length > 0) lines.push('', meta.join(' · '));
      if (content) lines.push('', content);
      lines.push('');
    });
  } else {
    lines.push('', '## 当前状态', '', '该主题已注册，但暂时没有可用于汇总的事实。');
  }

  return lines.join('\n').trim();
}

module.exports = { buildWikiPage, buildFallbackWikiContent };
