'use strict';

const path = require('path');

const WIKI_COLLECTIONS = Object.freeze({
  topics: Object.freeze({ title: '主题知识 Topics', description: '从长期记忆持续提炼的主题知识。' }),
  sources: Object.freeze({ title: '来源资料 Sources', description: '导入文档与研究资料形成的来源页。' }),
});

// These are the only wiki_pages rows whose Markdown is owned by the Wiki
// projector. OpenWiki and knowledge-artifact rows have their own authorities
// and must not enter projection Base/Current/User reconciliation.
const MANAGED_WIKI_SOURCE_TYPES = Object.freeze([
  'memory', 'managed_redirect', 'doc', 'topic_cluster',
]);

function isManagedWikiSourceType(sourceType) {
  return MANAGED_WIKI_SOURCE_TYPES.includes(String(sourceType || 'memory').trim());
}

function normalizeSlug(slug) {
  const value = String(slug || '').trim().replaceAll('\\', '/');
  if (!value || value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid wiki slug: ${slug}`);
  }
  return value;
}

function wikiPageCollection(page = {}) {
  const sourceType = String(page.source_type || '').trim();
  if (sourceType === 'knowledge_artifact' && page.page_kind === 'decision') return 'decisions';
  if (sourceType === 'knowledge_artifact' && page.page_kind === 'playbook') return 'capsules';
  if (sourceType === 'doc') return 'sources';
  if (sourceType === 'topic_cluster') return 'topics/clusters';
  if (sourceType === 'memory') return 'topics';
  if (sourceType === 'managed_redirect') return 'topics';
  return null;
}

function resolveWikiPageRelativePath(page = {}) {
  if (String(page.source_type || '') === 'knowledge_artifact' && page.source_path) {
    const sourcePath = String(page.source_path).replaceAll('\\', '/');
    if (sourcePath.startsWith('/') || sourcePath.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error(`invalid artifact source path: ${page.source_path}`);
    }
    return sourcePath;
  }
  const slug = normalizeSlug(page.slug);
  const collection = wikiPageCollection(page);
  return collection ? path.posix.join(collection, `${slug}.md`) : `${slug}.md`;
}

function wikiPageLink(page = {}) {
  return resolveWikiPageRelativePath(page).replace(/\.md$/, '');
}

function partitionWikiPages(pages = []) {
  const result = { topics: [], sources: [], external: [], other: [] };
  for (const page of Array.isArray(pages) ? pages : []) {
    const collection = wikiPageCollection(page);
    if (collection && collection.startsWith('topics')) result.topics.push(page);
    else if (collection === 'sources') result.sources.push(page);
    else if (String(page.source_type || '') === 'openwiki' || String(page.slug || '').startsWith('external/')) {
      result.external.push(page);
    } else result.other.push(page);
  }
  return result;
}

module.exports = {
  isManagedWikiSourceType,
  MANAGED_WIKI_SOURCE_TYPES,
  WIKI_COLLECTIONS,
  normalizeSlug,
  partitionWikiPages,
  resolveWikiPageRelativePath,
  wikiPageCollection,
  wikiPageLink,
};
