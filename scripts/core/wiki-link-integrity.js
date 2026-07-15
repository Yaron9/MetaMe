'use strict';

const path = require('node:path');

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function markdownPath(value) {
  const target = String(value || '').trim().split('#')[0].trim();
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return null;
  if (!/\.md$/i.test(target)) return null;
  return target;
}

function extractInternalLinks(content) {
  const links = [];
  const wikiPattern = /!?(?:\[\[)([^\]]+?)\]\]/g;
  const markdownPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = wikiPattern.exec(String(content || ''))) !== null) {
    const target = match[1].split('|')[0].split('#')[0].trim();
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) links.push({ kind: 'wiki', target });
  }
  while ((match = markdownPattern.exec(String(content || ''))) !== null) {
    const target = markdownPath(match[1]);
    if (target) links.push({ kind: 'markdown', target });
  }
  return links;
}

function createResolver(relativeFiles) {
  const exact = new Set();
  const basenames = new Map();
  for (const file of relativeFiles) {
    const normalized = normalizeRelative(file);
    const withoutExtension = normalized.replace(/\.md$/i, '');
    exact.add(normalized.toLowerCase());
    exact.add(withoutExtension.toLowerCase());
    const base = path.posix.basename(withoutExtension).toLowerCase();
    basenames.set(base, (basenames.get(base) || 0) + 1);
  }
  return { exact, basenames };
}

function resolvesLink(link, sourceFile, resolver) {
  const target = normalizeRelative(link.target);
  const sourceDir = path.posix.dirname(normalizeRelative(sourceFile));
  const relative = normalizeRelative(path.posix.normalize(path.posix.join(sourceDir, target)));
  const candidates = link.kind === 'markdown'
    ? [relative]
    : [target, relative];
  if (candidates.some(candidate => resolver.exact.has(candidate.replace(/\.md$/i, '').toLowerCase())
    || resolver.exact.has(candidate.toLowerCase()))) return true;
  if (target.includes('/')) return false;
  return resolver.basenames.get(path.posix.basename(target).replace(/\.md$/i, '').toLowerCase()) === 1;
}

function isManagedProjection(relativeFile) {
  const normalized = normalizeRelative(relativeFile);
  return normalized.startsWith('sessions/') || path.posix.basename(normalized) === '_index.md';
}

function auditDocuments(documents) {
  const relativeFiles = Object.keys(documents).map(normalizeRelative);
  const resolver = createResolver(relativeFiles);
  const broken = [];
  for (const [sourceFile, content] of Object.entries(documents)) {
    for (const link of extractInternalLinks(content)) {
      if (!resolvesLink(link, sourceFile, resolver)) {
        broken.push({
          source: normalizeRelative(sourceFile),
          target: link.target,
          kind: link.kind,
          severity: isManagedProjection(sourceFile) ? 'hard' : 'soft',
        });
      }
    }
  }
  return {
    files: relativeFiles.length,
    links: Object.values(documents).reduce((sum, content) => sum + extractInternalLinks(content).length, 0),
    broken,
    hardBroken: broken.filter(item => item.severity === 'hard'),
    softBroken: broken.filter(item => item.severity === 'soft'),
  };
}

function replaceMissingWorkspaceFiles(value, existingFiles, fallback) {
  let replaced = 0;
  function visit(node) {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const copy = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === 'file' && typeof child === 'string' && child.endsWith('.md')
        && !existingFiles.has(normalizeRelative(child).toLowerCase())) {
        copy[key] = fallback;
        replaced++;
      } else copy[key] = visit(child);
    }
    return copy;
  }
  return { workspace: visit(value), replaced };
}

function stripBrokenLinks(content, brokenLinks) {
  const targets = new Set(brokenLinks.map(link => `${link.kind}:${link.target}`));
  let stripped = 0;
  let next = String(content || '').replace(/(!?)\[\[([^\]]+?)\]\]/g, (full, embed, inner) => {
    const [rawTarget, ...aliases] = inner.split('|');
    const target = rawTarget.split('#')[0].trim();
    if (!targets.has(`wiki:${target}`)) return full;
    stripped++;
    return aliases.join('|').trim() || target;
  });
  next = next.replace(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g, (full, label, rawTarget) => {
    const target = markdownPath(rawTarget);
    if (!target || !targets.has(`markdown:${target}`)) return full;
    stripped++;
    return label || path.posix.basename(target, '.md');
  });
  return { content: next, stripped };
}

module.exports = {
  auditDocuments,
  extractInternalLinks,
  replaceMissingWorkspaceFiles,
  stripBrokenLinks,
};
