'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { toSlug } = require('./wiki-slug');

const SLUG_PREFIX = 'external/openwiki';

function normalizeRelativePath(input) {
  const relative = String(input || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = relative.split('/');
  if (parts.length === 0 || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe OpenWiki path: ${JSON.stringify(input)}`);
  }
  if (!/\.md$/i.test(parts.at(-1))) {
    throw new Error(`OpenWiki projection only accepts Markdown: ${relative}`);
  }
  return parts.join('/');
}

function slugForRelativePath(input) {
  const relative = normalizeRelativePath(input).replace(/\.md$/i, '');
  const segments = relative.split('/').map(segment => toSlug(segment));
  return `${SLUG_PREFIX}/${segments.join('/')}`;
}

function splitFrontmatter(markdown) {
  const normalized = String(markdown || '').replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n') && !normalized.startsWith('---\r\n')) {
    return { body: normalized, frontmatter: '' };
  }
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { body: normalized, frontmatter: '' };
  return { body: normalized.slice(match[0].length), frontmatter: match[1] };
}

function cleanTitle(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
}

function titleForMarkdown(relativePath, markdown) {
  const { body, frontmatter } = splitFrontmatter(markdown);
  const frontmatterTitle = frontmatter.match(/^title:\s*(.+)$/im);
  if (frontmatterTitle) return cleanTitle(frontmatterTitle[1]);
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading) return cleanTitle(heading[1]);
  const base = path.posix.basename(normalizeRelativePath(relativePath), '.md');
  return cleanTitle(base.replace(/[-_]+/g, ' '));
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function projectMarkdown({ relativePath, markdown, scopeTags = ['metame'] }) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const { body } = splitFrontmatter(markdown);
  const content = body.trim();
  if (!content) throw new Error(`empty OpenWiki page: ${normalizedPath}`);
  const slug = slugForRelativePath(normalizedPath);
  const pathTags = slug.split('/').slice(2, -1);
  const topicTags = [...new Set([
    ...scopeTags.map(String).map(tag => tag.trim()).filter(Boolean),
    'external',
    'openwiki',
    ...pathTags,
  ])];
  const sourceKey = `openwiki:${normalizedPath}`;
  const title = titleForMarkdown(normalizedPath, markdown);
  const primaryTopic = scopeTags[0] || 'external';
  const contentHash = hashContent(JSON.stringify({
    content,
    title,
    primaryTopic,
    topicTags,
    sourceType: 'openwiki',
  }));
  return {
    sourceKey,
    relativePath: normalizedPath,
    contentHash,
    content,
    pageSpec: {
      slug,
      title,
      primary_topic: primaryTopic,
      source_type: 'openwiki',
      raw_source_ids: [sourceKey],
      raw_source_count: 1,
      topic_tags: topicTags,
    },
  };
}

module.exports = {
  SLUG_PREFIX,
  hashContent,
  normalizeRelativePath,
  projectMarkdown,
  slugForRelativePath,
  splitFrontmatter,
  titleForMarkdown,
};
