'use strict';

const path = require('node:path');

const WORKSPACE_FILE_VIEWS = new Set(['markdown', 'backlink', 'outgoing-link', 'outline']);
const MANAGED_INDEX_PATHS = new Set([
  '_index.md', 'topics/_index.md', 'sources/_index.md', 'curated/_index.md',
  'sessions/_index.md', 'capsules/_index.md', 'decisions/_index.md', 'lessons/_index.md',
]);

function normalizeRelative(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function withoutCode(content) {
  const mask = value => value.replace(/[^\n]/g, ' ');
  return String(content || '')
    .replace(/<!--[^]*?-->/g, mask)
    .replace(/(^|\n)[ \t]*(?:```|~~~)[^\n]*\n[^]*?(?:\n[ \t]*(?:```|~~~)[ \t]*(?=\n|$)|$)/g, mask)
    .replace(/`[^`\n]*`/g, mask);
}

function markdownPath(value) {
  const raw = String(value || '').trim().replace(/^<|>$/g, '');
  const target = raw.split(/\s+["']/)[0].split('#')[0].trim();
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return null;
  if (!/\.md$/i.test(target)) return null;
  try { return decodeURIComponent(target); } catch { return target; }
}

function lineAt(content, offset) {
  const start = content.lastIndexOf('\n', offset - 1) + 1;
  const end = content.indexOf('\n', offset);
  return content.slice(start, end < 0 ? content.length : end);
}

function extractInternalLinks(content) {
  const source = withoutCode(content);
  const links = [];
  const wikiPattern = /(!?)\[\[([^\]]+?)\]\]/g;
  const markdownPattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = wikiPattern.exec(source)) !== null) {
    const target = match[2].split('|')[0].split('#')[0].trim();
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      links.push({ kind: 'wiki', target, embed: match[1] === '!', line: lineAt(source, match.index), offset: match.index });
    }
  }
  while ((match = markdownPattern.exec(source)) !== null) {
    const target = markdownPath(match[1]);
    if (target) links.push({ kind: 'markdown', target, embed: false, line: lineAt(source, match.index), offset: match.index });
  }
  return links;
}

function createResolver(relativeFiles) {
  const exact = new Set();
  const basenames = new Map();
  for (const file of relativeFiles) {
    const normalized = normalizeRelative(file);
    const withoutExtension = normalized.replace(/\.md$/i, '');
    exact.add(normalized);
    exact.add(withoutExtension);
    const base = path.posix.basename(withoutExtension);
    basenames.set(base, (basenames.get(base) || 0) + 1);
  }
  return { exact, basenames };
}

function resolvesLink(link, sourceFile, resolver) {
  const target = normalizeRelative(link.target);
  const sourceDir = path.posix.dirname(normalizeRelative(sourceFile));
  const relative = normalizeRelative(path.posix.normalize(path.posix.join(sourceDir, target)));
  const candidates = link.kind === 'markdown' ? [relative] : [target, relative];
  if (candidates.some(candidate => resolver.exact.has(candidate)
    || resolver.exact.has(candidate.replace(/\.md$/i, '')))) return true;
  if (target.includes('/')) return false;
  return resolver.basenames.get(path.posix.basename(target).replace(/\.md$/i, '')) === 1;
}

function isGeneratedLink(relativeFile, link, content) {
  const normalized = normalizeRelative(relativeFile);
  if (MANAGED_INDEX_PATHS.has(normalized)) return true;
  if (!normalized.startsWith('sessions/')) return false;
  const marker = String(content || '').lastIndexOf('## Related Knowledge\n');
  return marker >= 0 && link.offset > marker && /^- (?:Wiki|Capsule):\s+\[\[/u.test(link.line.trim());
}

function auditDocuments(documents, { availableFiles = Object.keys(documents) } = {}) {
  const relativeFiles = Object.keys(documents).map(normalizeRelative);
  const resolver = createResolver(availableFiles.map(normalizeRelative));
  const broken = [];
  let linkCount = 0;
  for (const [sourceFile, content] of Object.entries(documents)) {
    const links = extractInternalLinks(content);
    linkCount += links.length;
    for (const link of links) {
      if (!resolvesLink(link, sourceFile, resolver)) {
        broken.push({
          source: normalizeRelative(sourceFile),
          target: link.target,
          kind: link.kind,
          severity: isGeneratedLink(sourceFile, link, content) ? 'hard' : 'soft',
        });
      }
    }
  }
  return {
    files: relativeFiles.length,
    links: linkCount,
    broken,
    hardBroken: broken.filter(item => item.severity === 'hard'),
    softBroken: broken.filter(item => item.severity === 'soft'),
  };
}

function collectWorkspaceFileRefs(workspace) {
  const refs = [];
  function visit(node, trail = []) {
    if (Array.isArray(node)) return node.forEach((item, index) => visit(item, trail.concat(index)));
    if (!node || typeof node !== 'object') return;
    if (node.type === 'leaf' && WORKSPACE_FILE_VIEWS.has(node.state?.type)) {
      const file = node.state?.state?.file;
      if (typeof file === 'string' && file.endsWith('.md')) refs.push({ file: normalizeRelative(file), trail });
    }
    for (const [key, child] of Object.entries(node)) visit(child, trail.concat(key));
  }
  visit(workspace);
  return refs;
}

function auditWorkspaceState(workspace, existingFiles) {
  const refs = collectWorkspaceFileRefs(workspace);
  const existing = new Set([...existingFiles].map(normalizeRelative));
  return { refs, missing: refs.filter(ref => !existing.has(ref.file)) };
}

function replaceMissingWorkspaceFiles(workspace, missingRefs, fallback) {
  const missingTrails = new Set(missingRefs.map(ref => ref.trail.join('\0')));
  let replaced = 0;
  function visit(node, trail = []) {
    if (Array.isArray(node)) return node.map((item, index) => visit(item, trail.concat(index)));
    if (!node || typeof node !== 'object') return node;
    const copy = { ...node };
    if (node.type === 'leaf' && missingTrails.has(trail.join('\0'))
      && WORKSPACE_FILE_VIEWS.has(node.state?.type)) {
      copy.state = { ...node.state, state: { ...node.state.state, file: fallback } };
      replaced++;
    }
    for (const [key, child] of Object.entries(copy)) {
      if (key !== 'state' || copy.state === node.state) copy[key] = visit(child, trail.concat(key));
    }
    return copy;
  }
  return { workspace: visit(workspace), replaced };
}

module.exports = {
  auditDocuments,
  auditWorkspaceState,
  collectWorkspaceFileRefs,
  extractInternalLinks,
  replaceMissingWorkspaceFiles,
};
