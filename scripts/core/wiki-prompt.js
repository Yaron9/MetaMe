'use strict';

/**
 * core/wiki-prompt.js — Pure functions for wiki article generation prompts
 *
 * Builds prompts for callHaiku and validates [[wikilinks]] against a whitelist.
 * Zero I/O, zero DB, zero side effects.
 */

/**
 * Build a prompt string for generating a wiki article section.
 *
 * @param {{ tag: string, slug: string, label: string }} topic
 * @param {Array<{ title: string, content: string, confidence: number, search_count: number }>} facts
 * @param {string} capsuleExcerpts - Optional background context (may be empty)
 * @param {string[]} allowedSlugs - Whitelist of [[wikilink]] slugs
 * @returns {string} Prompt string ready to pass to callHaiku
 */
function buildWikiPrompt(topic, facts, capsuleExcerpts, allowedSlugs) {
  const parts = [];

  parts.push(`你是一个中文知识百科写作助手。请为以下主题撰写一段简洁、准确的百科条目正文。`);
  parts.push('');
  parts.push(`## 主题`);
  parts.push(`标签：${topic.tag}`);
  parts.push(`Slug：${topic.slug}`);
  parts.push(`名称：${topic.label}`);
  parts.push('');

  if (facts && facts.length > 0) {
    parts.push('## 参考事实');
    facts.forEach((fact, i) => {
      parts.push(`${i + 1}. **${fact.title}**（可信度：${fact.confidence}，搜索次数：${fact.search_count}）`);
      parts.push(`   ${fact.content}`);
    });
    parts.push('');
  }

  if (capsuleExcerpts && capsuleExcerpts.trim()) {
    parts.push('## 背景补充');
    parts.push(capsuleExcerpts.trim());
    parts.push('');
  }

  if (allowedSlugs && allowedSlugs.length > 0) {
    parts.push('## 允许的内链（[[wikilinks]]）');
    parts.push('正文中如需引用以下条目，请使用 [[slug]] 格式；其余 slug 请勿使用 [[]] 包裹：');
    parts.push(allowedSlugs.map(s => `- [[${s}]]`).join('\n'));
    parts.push('');
  } else {
    parts.push('## 内链说明');
    parts.push('正文中不得使用任何 [[wikilinks]] 格式。');
    parts.push('');
  }

  parts.push('## 要求');
  parts.push('- 用中文撰写');
  parts.push('- 语言简洁准确，适合百科风格');
  parts.push('- 只使用上方允许列表中的 [[slug]] 内链，其他 slug 直接用纯文本');
  parts.push('- 不要重复本条目自身的 slug 作为内链');
  parts.push('- 直接输出正文，不需要标题');

  return parts.join('\n');
}

/**
 * Validate and strip [[wikilinks]] not in the allowedSlugs whitelist.
 *
 * @param {string} content - Article body text possibly containing [[slug]] links
 * @param {string[]} allowedSlugs - Whitelist of permitted slugs
 * @returns {{ content: string, stripped: string[] }}
 */
function validateWikilinks(content, allowedSlugs) {
  const allowed = new Set(allowedSlugs || []);
  const stripped = [];

  const cleaned = content.replace(/\[\[([^\]]+)\]\]/g, (match, slug) => {
    if (allowed.has(slug)) {
      return match; // keep [[slug]]
    }
    stripped.push(slug);
    return slug; // strip [[ ]]
  });

  return { content: cleaned, stripped };
}

module.exports = { buildWikiPrompt, validateWikilinks };
