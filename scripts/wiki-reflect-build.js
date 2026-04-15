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
 *   generateWikiContent(prompt, providers, allowedSlugs)
 *     → { content, strippedLinks } | null
 *   writeWikiPageWithChunks(db, pageSpec, content, { docSourceIds, role })
 *     → void
 */

const crypto = require('node:crypto');
const { buildWikiPrompt, validateWikilinks } = require('./core/wiki-prompt');
const { upsertWikiPage, resetPageStaleness, appendWikiTimeline } = require('./core/wiki-db');
const { chunkText } = require('./core/chunker');
const { membershipHash, findMatchingCluster } = require('./wiki-cluster');

const LLM_TIMEOUT_MS = 60000; // Sonnet needs more time than Haiku

/**
 * Call the LLM with a prompt and validate [[wikilinks]] in the response.
 *
 * @param {string} prompt
 * @param {{ callHaiku: Function, buildDistillEnv: Function }} providers
 * @param {string[]} allowedSlugs
 * @returns {{ content: string, strippedLinks: string[] } | null}
 *   Returns null on LLM failure or empty response (caller enqueues for retry).
 */
async function generateWikiContent(prompt, providers, allowedSlugs) {
  const { callHaiku, buildDistillEnv } = providers;

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
  return { content, strippedLinks };
}

/**
 * Atomic DB write: upsert wiki_page, reset staleness, replace chunks, enqueue
 * embeddings, and optionally link doc_sources. All inside a single transaction.
 *
 * @param {object} db - DatabaseSync instance
 * @param {{ slug: string, title: string, primary_topic: string, source_type?: string,
 *           raw_source_ids?: string, capsule_refs?: string, raw_source_count?: number,
 *           topic_tags?: string, word_count?: number, membership_hash?: string,
 *           cluster_size?: number }} pageSpec
 * @param {string} content
 * @param {{ docSourceIds?: number[], role?: string }} opts
 */
function writeWikiPageWithChunks(db, pageSpec, content, { docSourceIds = [], role } = {}) {
  const {
    slug,
    title,
    primary_topic,
    source_type = 'memory',
    raw_source_ids,
    capsule_refs,
    raw_source_count = 0,
    topic_tags,
    membership_hash,
    cluster_size,
  } = pageSpec;

  const wordCount = content.split(/\s+/).filter(Boolean).length;

  db.prepare('BEGIN').run();
  try {
    upsertWikiPage(db, {
      slug,
      primary_topic,
      title,
      content,
      raw_source_ids: raw_source_ids !== undefined ? raw_source_ids : '[]',
      capsule_refs: capsule_refs !== undefined ? capsule_refs : '[]',
      raw_source_count,
      topic_tags: topic_tags !== undefined ? topic_tags : '[]',
      word_count: wordCount,
      source_type,
      membership_hash: membership_hash !== undefined ? membership_hash : null,
      cluster_size: cluster_size !== undefined ? cluster_size : null,
    });

    // Reset staleness counters via canonical helper (staleness=0, last_built_at=now)
    resetPageStaleness(db, slug, raw_source_count);

    // ── Chunk content + enqueue embeddings ──────────────────────────────────
    // Clean stale embedding_queue entries for this page's old chunks
    const oldChunkIds = db.prepare(
      'SELECT id FROM content_chunks WHERE page_slug = ?',
    ).all(slug).map(r => r.id);
    if (oldChunkIds.length > 0) {
      const ph = oldChunkIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM embedding_queue WHERE item_type = 'chunk' AND item_id IN (${ph})`).run(...oldChunkIds);
    }
    // Delete old chunks
    db.prepare('DELETE FROM content_chunks WHERE page_slug = ?').run(slug);

    // Create new chunks + enqueue
    const chunks = chunkText(content, { targetWords: 300 });
    const insertChunk = db.prepare(
      'INSERT INTO content_chunks (id, page_slug, chunk_text, chunk_idx) VALUES (?, ?, ?, ?)',
    );
    const enqueue = db.prepare(
      "INSERT INTO embedding_queue (item_type, item_id) VALUES ('chunk', ?)",
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `ck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      insertChunk.run(chunkId, slug, chunks[i], i);
      enqueue.run(chunkId);
    }

    // Link doc_sources if provided
    if (docSourceIds.length > 0) {
      const insertLink = db.prepare(
        'INSERT OR IGNORE INTO wiki_page_doc_sources (page_slug, doc_source_id, role) VALUES (?, ?, ?)',
      );
      const effectiveRole = role || 'primary';
      for (const docId of docSourceIds) {
        insertLink.run(slug, docId, effectiveRole);
      }
    }

    db.prepare('COMMIT').run();
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch { /* ignore */ }
    throw err; // propagate DB errors to caller
  }
}

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
  const { totalCount, facts, capsuleExcerpts } = queryResult;

  // Build prompt
  const prompt = buildWikiPrompt(topic, facts, capsuleExcerpts, allowedSlugs);

  // Call LLM — return null on failure so caller can schedule exponential-backoff retry
  const llmResult = await generateWikiContent(prompt, providers, allowedSlugs);
  if (!llmResult) return null;

  const { content, strippedLinks } = llmResult;

  // Collect source IDs from facts
  const rawSourceIds = facts.map(f => f.id).filter(Boolean);

  // Write to DB in a transaction
  const topicTagsArr = [topic.tag];
  writeWikiPageWithChunks(db, {
    slug: topic.slug,
    primary_topic: topic.tag,
    title: topic.label || topic.tag,
    raw_source_ids: JSON.stringify(rawSourceIds),
    capsule_refs: '[]',
    raw_source_count: totalCount,
    topic_tags: JSON.stringify(topicTagsArr),
  }, content, { docSourceIds: [] });

  // Append evidence to timeline (compiled truth was just rewritten above)
  const chunks = chunkText(content, { targetWords: 300 });
  appendWikiTimeline(db, topic.slug, `基于 ${totalCount} 条 facts 重建 (${rawSourceIds.length} 条直接引用, ${chunks.length} chunks)`);

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

/**
 * Build a prompt for a Tier 1 document wiki page.
 */
function buildDocWikiPrompt(title, text) {
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n\n[...truncated]' : text;
  return `You are writing a wiki page for a knowledge base.

Title: ${title}

Source document content:
${truncated}

Write a well-structured wiki page that:
- Starts with a brief summary paragraph
- Organizes information under ## headings
- Preserves key facts, numbers, and terminology from the source
- Uses [[wikilink]] syntax for concepts that deserve their own pages
- Is 200–600 words

Respond with only the wiki page content, starting with the summary paragraph.`;
}

/**
 * Build a Tier 1 wiki page from a document source.
 * @param {object} db
 * @param {object} docSource — row from doc_sources
 * @param {string} extractedText — full text from wiki-extract.js
 * @param {{ allowedSlugs: string[], providers: object }} opts
 * @returns {Promise<{slug, content, strippedLinks}|null>}
 */
async function buildDocWikiPage(db, docSource, extractedText, { allowedSlugs, providers }) {
  const { slug, title, id: docSourceId } = docSource;
  const displayTitle = title || slug;

  const prompt = buildDocWikiPrompt(displayTitle, extractedText);
  const result = await generateWikiContent(prompt, providers, allowedSlugs);
  if (!result) return null;

  const { content, strippedLinks } = result;

  writeWikiPageWithChunks(db, {
    slug,
    title: displayTitle,
    primary_topic: slug,
    source_type: 'doc',
    raw_source_ids: '[]',
    topic_tags: '[]',
    raw_source_count: 0,
    word_count: content.split(/\s+/).length,
  }, content, { docSourceIds: [docSourceId], role: 'primary' });

  return { slug, content, strippedLinks };
}

async function buildTopicClusterPage(db, docSourceRows, { allowedSlugs, providers, existingClusters = [] }) {
  if (!docSourceRows || docSourceRows.length === 0) return null;

  const memberIds = docSourceRows.map(r => r.id);
  const memberSlugs = docSourceRows.map(r => r.slug);
  const mHash = membershipHash(memberSlugs);

  // Find or create stable slug
  const match = findMatchingCluster(existingClusters, memberIds);
  const clusterSlug = match ? match.slug : 'cluster-' + crypto.randomBytes(4).toString('hex');

  // Build synthesis content
  const memberTitles = docSourceRows.map(r => r.title || r.slug);
  const prompt = buildClusterPrompt(memberTitles, memberSlugs);
  const result = await generateWikiContent(prompt, providers, allowedSlugs);
  if (!result) return null;
  const { content, strippedLinks: clusterStrippedLinks } = result;

  const clusterLabel = inferClusterLabel(memberTitles);

  writeWikiPageWithChunks(db, {
    slug: clusterSlug,
    title: clusterLabel,
    primary_topic: clusterSlug,
    source_type: 'topic_cluster',
    staleness: 0.0,
    raw_source_ids: '[]',
    raw_source_count: 0,
    topic_tags: '[]',
    word_count: content.split(/\s+/).length,
    membership_hash: mHash,
    cluster_size: memberIds.length,
  }, content, { docSourceIds: memberIds, role: 'cluster_member' });

  return { slug: clusterSlug, strippedLinks: clusterStrippedLinks || [] };
}

function inferClusterLabel(titles) {
  const words = titles.flatMap(t => t.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const top = Object.entries(freq).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return top.length ? top.map(([w]) => w).join(' & ') + ' cluster' : 'Document Cluster';
}

function buildClusterPrompt(titles, slugs) {
  const links = slugs.map((s, i) => {
    const safeTitle = (titles[i] || '').slice(0, 120).replace(/[\r\n]/g, ' ');
    return `- [[${s}]] — ${safeTitle}`;
  }).join('\n');
  return `You are writing a wiki overview page that synthesizes multiple related documents.

Member documents:
${links}

Write a concise wiki overview page (150–300 words) that:
- Opens with a paragraph explaining what these documents share in common
- Briefly notes what each document covers (1 sentence each)
- Uses [[wikilink]] syntax when referencing the member documents by slug
- Ends with a "## See Also" section listing all members as [[wikilinks]]

Respond with only the wiki page content.`;
}

module.exports = { buildWikiPage, buildFallbackWikiContent, generateWikiContent, writeWikiPageWithChunks, buildDocWikiPage, buildTopicClusterPage };
