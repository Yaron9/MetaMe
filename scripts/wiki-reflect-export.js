'use strict';

/**
 * wiki-reflect-export.js — File write layer for wiki-reflect
 *
 * Writes wiki pages as Obsidian-compatible Markdown files.
 * No DB access, no LLM calls.
 *
 * Exports:
 *   exportWikiPage(slug, frontmatter, content, outputDir) → void
 *   rebuildIndex(pages, outputDir) → void
 *   exportSessionSummary(entry, outputDir, options) → string
 *   rebuildSessionsIndex(entries, outputDir) → void
 *   exportCapsuleFile(sourcePath, outputDir) → string|null
 *   rebuildCapsulesIndex(capsuleFiles, outputDir) → void
 */

const fs = require('fs');
const path = require('path');
const { defaultWikiOutputDir } = require('./core/wiki-paths');
const {
  WIKI_COLLECTIONS,
  partitionWikiPages,
  resolveWikiPageRelativePath,
  wikiPageLink,
} = require('./core/wiki-layout');

/**
 * Write a wiki page as a Markdown file (atomic: write .tmp → rename).
 *
 * @param {string} slug
 * @param {{ title: string, tags: string[], created: string, last_built: string,
 *           raw_sources: number, staleness: number }} frontmatter
 * @param {string} content - Article body (no frontmatter)
 * @param {string} [outputDir]
 */
function exportWikiPage(slug, frontmatter, content, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  const page = { ...frontmatter, slug };
  const relativePath = resolveWikiPageRelativePath(page);
  const filePath = path.join(outputDir, ...relativePath.split('/'));
  _ensureDir(path.dirname(filePath));

  // Ensure slug in frontmatter matches the positional slug argument
  const yaml = _buildFrontmatter(page);
  const fileContent = `${yaml}\n${content}\n`;
  const tmpPath = `${filePath}.tmp`;

  // Remove stale .tmp if present (previous interrupted write)
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }

  fs.writeFileSync(tmpPath, fileContent, 'utf8');
  fs.renameSync(tmpPath, filePath);

  const legacyPath = path.join(outputDir, `${slug}.md`);
  if (legacyPath !== filePath && fs.existsSync(legacyPath)) fs.rmSync(legacyPath, { force: true });
  return filePath;
}

/**
 * Rebuild the _index.md (Map of Content) from all wiki pages.
 * Pages list is provided by caller (from DB query) — this file does not access DB.
 *
 * @param {Array<{ slug: string, title: string, primary_topic: string,
 *                 staleness: number, last_built_at: string|null,
 *                 raw_source_count: number }>} pages
 * @param {string} [outputDir]
 */
function rebuildIndex(pages, outputDir, options = {}) {
  outputDir = resolveOutputDir(outputDir);
  _ensureDir(outputDir);
  const sessionCount = Number(options.sessionCount) || 0;
  const capsuleCount = Number(options.capsuleCount) || 0;
  const grouped = partitionWikiPages(pages);
  const hasCanonicalHubs = grouped.topics.some(page => page.build_profile === 'local-hub-v1');
  const topicHubs = grouped.topics.filter(page => page.source_type === 'memory'
    && (page.page_kind || 'topic_hub') === 'topic_hub'
    && (!hasCanonicalHubs || page.build_profile === 'local-hub-v1'));
  const curatedPages = _listCuratedPages(outputDir);

  const now = new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    'title: Wiki Index',
    `updated: ${now}`,
    '---',
    '',
    '# MetaMe Knowledge Wiki',
    '',
    `> ${pages.length} pages · 自动生成的可重建投影，数据库仍是事实源`,
    '',
    '## 从这里开始',
    '',
    `- [[topics/_index|主题知识 Topics]] (${topicHubs.length}) — canonical Hub 导航`,
    `- [[sources/_index|来源资料 Sources]] (${grouped.sources.length}) — 文档与研究资料`,
    `- [[curated/_index|人工精选 Curated]] (${curatedPages.length}) — 人工维护、不会被自动覆盖的页面`,
    ...(fs.existsSync(path.join(outputDir, 'external', 'openwiki', 'quickstart.md'))
      ? [`- [[external/openwiki/quickstart|外部证据 External Evidence]] (${grouped.external.length}) — OpenWiki 外部证据`]
      : []),
    `- [[sessions/_index|对话 Sessions]]${sessionCount > 0 ? ` (${sessionCount})` : ''} — 对话过程`,
    `- [[decisions/_index|决策 Decisions]] — 已沉淀决策`,
    `- [[lessons/_index|经验 Lessons]] — 可复用经验`,
    `- [[capsules/_index|行动手册 Capsules]]${capsuleCount > 0 ? ` (${capsuleCount})` : ''} — 可执行知识`,
    '',
    '## 最近更新',
    '',
  ];

  for (const p of [...pages]
    .filter(page => page.last_built_at)
    .sort((a, b) => String(b.last_built_at).localeCompare(String(a.last_built_at)))
    .slice(0, 12)) {
    const built = p.last_built_at ? p.last_built_at.slice(0, 10) : '—';
    lines.push(`- [[${wikiPageLink(p)}|${p.title}]] · ${built}`);
  }

  lines.push('', '## Agent 查阅', '');
  lines.push('- Search canonical memory: `node ~/.metame/memory-search.js "query"`');
  lines.push('- Start filesystem browsing from this page, then follow collection indexes.');
  lines.push('- Treat files as rebuildable projections; use frontmatter `slug` as stable identity.');
  lines.push('', '## 系统', '');
  if (fs.existsSync(path.join(outputDir, '_audit.md'))) lines.push('- [[_audit|Wiki Audit]]');
  if (fs.existsSync(path.join(outputDir, '_cleanup-manifest.md'))) {
    lines.push('- [[_cleanup-manifest|Cleanup Manifest]]');
  }

  _writeAtomic(path.join(outputDir, '_index.md'), lines.join('\n') + '\n');
  _rebuildCollectionIndex('topics', topicHubs, outputDir);
  _rebuildCollectionIndex('sources', grouped.sources, outputDir);
  _rebuildCuratedIndex(curatedPages, outputDir);
}

function organizeWikiProjection(pages, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  const result = { moved: 0, deduplicated: 0, conflicts: [] };
  for (const page of Array.isArray(pages) ? pages : []) {
    const relativePath = resolveWikiPageRelativePath(page);
    if (!relativePath.includes('/')) continue;
    const source = path.join(outputDir, `${page.slug}.md`);
    const target = path.join(outputDir, ...relativePath.split('/'));
    if (!fs.existsSync(source) || source === target) continue;
    _ensureDir(path.dirname(target));
    if (fs.existsSync(target)) {
      if (fs.readFileSync(source).equals(fs.readFileSync(target))) {
        fs.rmSync(source, { force: true });
        result.deduplicated++;
      } else result.conflicts.push(page.slug);
      continue;
    }
    fs.renameSync(source, target);
    result.moved++;
  }
  return result;
}

function _rebuildCollectionIndex(collection, pages, outputDir) {
  const metadata = WIKI_COLLECTIONS[collection];
  const dir = path.join(outputDir, collection);
  _ensureDir(dir);
  const lines = [
    '---',
    `title: ${metadata.title}`,
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    `type: ${collection}-index`,
    '---',
    '',
    `# ${metadata.title}`,
    '',
    `> ${metadata.description} ${pages.length} pages.`,
    '',
    '| Page | Type / Topic | Sources | Updated |',
    '|------|--------------|---------|---------|',
  ];
  for (const page of [...pages].sort((a, b) => String(a.title || a.slug).localeCompare(String(b.title || b.slug)))) {
    const built = page.last_built_at ? String(page.last_built_at).slice(0, 10) : '—';
    const type = page.source_type === 'topic_cluster' ? 'cluster' : (page.primary_topic || page.source_type || '—');
    lines.push(`| [[${wikiPageLink(page)}|${page.title || page.slug}]] | \`${type}\` | ${page.raw_source_count || 0} | ${built} |`);
  }
  _writeAtomic(path.join(dir, '_index.md'), lines.join('\n') + '\n');
}

function _listCuratedPages(outputDir) {
  const dir = path.join(outputDir, 'curated');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== '_index.md')
    .map(entry => {
      const slug = entry.name.slice(0, -3);
      const content = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      const title = content.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] || slug;
      return { slug, title };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function _rebuildCuratedIndex(pages, outputDir) {
  const dir = path.join(outputDir, 'curated');
  _ensureDir(dir);
  const lines = [
    '---',
    'title: 人工精选 Curated',
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'type: curated-index',
    '---',
    '',
    '# 人工精选 Curated',
    '',
    '> 人工维护的兼容层；自动整理只更新本索引，不覆盖正文。',
    '',
    ...pages.map(page => `- [[curated/${page.slug}|${page.title}]]`),
  ];
  _writeAtomic(path.join(dir, '_index.md'), lines.join('\n') + '\n');
}

function _writeAtomic(filePath, content) {
  _ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp`;
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function exportSessionSummary(entry, outputDir, options = {}) {
  outputDir = resolveOutputDir(outputDir);
  const sessionsDir = path.join(outputDir, 'sessions');
  _ensureDir(sessionsDir);

  const created = String(entry.created_at || '').slice(0, 10);
  const sessionId = String(entry.session_id || entry.id || '');
  const project = String(entry.project || 'unknown');
  const slug = sessionSlug(entry);
  const tags = _safeJsonArray(entry.tags);
  const filePath = path.join(sessionsDir, `${slug}.md`);
  const tmpPath = `${filePath}.tmp`;
  const body = String(entry.content || '').trim() || '(empty)';
  const related = _collectSessionRelated(project, tags, options);
  const yaml = [
    '---',
    `title: ${_yamlStr(entry.title || body.slice(0, 40) || sessionId || slug)}`,
    `session_id: ${_yamlStr(sessionId)}`,
    `project: ${_yamlStr(project)}`,
    `scope: ${_yamlStr(String(entry.scope || ''))}`,
    `created: ${created}`,
    `tags: ${JSON.stringify(tags)}`,
    'type: session-summary',
    '---',
    '',
  ].join('\n');

  const parts = [yaml, '## Summary', '', body];
  if (related.wiki.length > 0 || related.capsules.length > 0) {
    parts.push('', '## Related Knowledge', '');
    for (const item of related.wiki) parts.push(`- Wiki: [[${item.path}|${item.label}]]`);
    for (const item of related.capsules) parts.push(`- Capsule: [[${item.path}|${item.label}]]`);
  }

  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, parts.join('\n') + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

function sessionSlug(entry) {
  const created = String(entry.created_at || '').slice(0, 10);
  const sessionId = String(entry.session_id || entry.id || '');
  const project = String(entry.project || 'unknown');
  return _sanitizeSlug(`${created || 'session'}-${project}-${sessionId.slice(-8)}`, 'session');
}

function reconcileSessionProjection(entries, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  const sessionsDir = path.join(outputDir, 'sessions');
  _ensureDir(sessionsDir);
  const manifestPath = path.join(sessionsDir, '.metame-manifest.json');
  const expected = new Set(entries.map(entry => `${sessionSlug(entry)}.md`));
  let previous = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.version === 1 && Array.isArray(manifest.managed)) previous = manifest.managed;
  } catch {
    previous = fs.readdirSync(sessionsDir).filter(name => {
      if (!name.endsWith('.md') || name === '_index.md') return false;
      try { return /^type:\s*session-summary\s*$/m.test(fs.readFileSync(path.join(sessionsDir, name), 'utf8')); }
      catch { return false; }
    });
  }

  const removed = [];
  const preserved = [];
  for (const name of previous) {
    if (!/^[^/\\]+\.md$/u.test(name) || expected.has(name)) continue;
    const filePath = path.join(sessionsDir, name);
    if (!fs.existsSync(filePath)) continue;
    let managed = false;
    try { managed = /^type:\s*session-summary\s*$/m.test(fs.readFileSync(filePath, 'utf8')); } catch { }
    if (!managed) {
      preserved.push(name);
      continue;
    }
    fs.rmSync(filePath);
    removed.push(name);
  }

  const manifest = {
    version: 1,
    updated_at: new Date().toISOString(),
    managed: [...expected].sort(),
  };
  _writeAtomic(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  return { expected: expected.size, removed, preserved };
}

function rebuildSessionsIndex(entries, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  const sessionsDir = path.join(outputDir, 'sessions');
  _ensureDir(sessionsDir);
  const lines = [
    '---',
    'title: Session Summaries',
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'type: session-index',
    '---',
    '',
    '# Session Summaries',
    '',
    `> ${entries.length} sessions`,
    '',
  ];

  const grouped = new Map();
  for (const entry of entries) {
    const project = String(entry.project || 'unknown');
    if (!grouped.has(project)) grouped.set(project, []);
    grouped.get(project).push(entry);
  }

  for (const [project, items] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${project}`, '');
    for (const entry of items) {
      const created = String(entry.created_at || '').slice(0, 10);
      const slug = sessionSlug(entry);
      const preview = String(entry.content || '').replace(/\s+/g, ' ').slice(0, 100);
      lines.push(`- [[sessions/${slug}|${created} · ${project}]]`);
      if (preview) lines.push(`  ${preview}`);
    }
    lines.push('');
  }

  const filePath = path.join(sessionsDir, '_index.md');
  const tmpPath = `${filePath}.tmp`;
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function exportCapsuleFile(sourcePath, outputDir, sourceRoot = path.dirname(String(sourcePath || ''))) {
  outputDir = resolveOutputDir(outputDir);
  const capsulesDir = path.join(outputDir, 'capsules');
  _ensureDir(capsulesDir);

  const source = String(sourcePath || '');
  const base = path.basename(source);
  if (!source || !base.endsWith('.md') || !fs.existsSync(source)) return null;

  const relative = path.relative(sourceRoot, source);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const targetPath = path.join(capsulesDir, relative);
  _ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.tmp`;
  const content = fs.readFileSync(source, 'utf8');

  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  fs.renameSync(tmpPath, targetPath);
  return targetPath;
}

function rebuildCapsulesIndex(capsuleFiles, outputDir, sourceRoot = null) {
  outputDir = resolveOutputDir(outputDir);
  const capsulesDir = path.join(outputDir, 'capsules');
  _ensureDir(capsulesDir);

  const lines = [
    '---',
    'title: Knowledge Capsules',
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'type: capsule-index',
    '---',
    '',
    '# Knowledge Capsules',
    '',
    `> ${capsuleFiles.length} capsules`,
    '',
  ];

  for (const sourcePath of capsuleFiles) {
    const source = String(sourcePath || '');
    const relative = sourceRoot ? path.relative(sourceRoot, source) : path.basename(source);
    if (!relative || relative.startsWith('..')) continue;
    const link = relative.slice(0, -3).split(path.sep).join('/');
    lines.push(`- [[capsules/${link}|${path.basename(link)}]]`);
  }

  const filePath = path.join(capsulesDir, '_index.md');
  const tmpPath = `${filePath}.tmp`;
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Mirror all .md files from srcDir into outputDir/subdir (atomic write).
 * Pattern mirrors exportCapsuleFile.
 *
 * @param {string} srcDir   — e.g. ~/.metame/memory/decisions
 * @param {string} subdir   — vault subdirectory name, e.g. 'decisions'
 * @param {string} [outputDir]
 * @returns {string[]}      — list of destination file paths written
 */
function exportReflectDir(srcDir, subdir, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return [];
  const destDir = path.join(outputDir, subdir);
  _ensureDir(destDir);

  const written = [];
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.md')) continue;
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    const tmp = `${dest}.tmp`;
    try {
      const content = fs.readFileSync(src, 'utf8');
      if (/^archive:\s*true\s*$/m.test(content) || /^status:\s*archived\s*$/m.test(content)) continue;
      try { fs.unlinkSync(tmp); } catch { /* not present */ }
      fs.writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      fs.renameSync(tmp, dest);
      written.push(dest);
    } catch { /* skip unreadable file */ }
  }
  return written;
}

/**
 * Write _index.md for a reflect subdirectory (decisions or lessons).
 *
 * @param {string[]} fileNames  — bare filenames (not full paths)
 * @param {string}   subdir     — 'decisions' | 'lessons'
 * @param {string}   [outputDir]
 */
function rebuildReflectDirIndex(fileNames, subdir, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  const destDir = path.join(outputDir, subdir);
  _ensureDir(destDir);

  const label = subdir === 'decisions' ? 'Architecture Decisions' : 'Operational Lessons';
  const lines = [
    '---',
    `title: ${label}`,
    `updated: ${new Date().toISOString().slice(0, 10)}`,
    'type: reflect-index',
    '---',
    '',
    `# ${label}`,
    '',
    `> ${fileNames.length} entries · 自动生成，勿手动编辑`,
    '',
  ];

  for (const name of [...fileNames].sort().reverse()) {
    const base = path.basename(name, '.md');
    lines.push(`- [[${subdir}/${base}|${base}]]`);
  }

  const filePath = path.join(destDir, '_index.md');
  const tmpPath = `${filePath}.tmp`;
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, lines.join('\n') + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Export all doc/cluster wiki pages from DB to Obsidian vault.
 * Called by runWikiReflect after the memory-topic loop.
 * Pages with empty content are skipped.
 *
 * @param {object} db — DatabaseSync instance
 * @param {string} [outputDir]
 * @returns {{ exported: string[], skipped: string[] }}
 */
function exportDocPages(db, outputDir) {
  outputDir = resolveOutputDir(outputDir);
  _ensureDir(outputDir);
  const rows = db.prepare(
    `SELECT slug, title, primary_topic, source_type, content,
            topic_tags, created_at, last_built_at, raw_source_count, staleness
     FROM wiki_pages
     WHERE source_type IN ('doc', 'topic_cluster')
       AND content IS NOT NULL AND content != ''`
  ).all();

  const exported = [];
  const skipped = [];

  for (const row of rows) {
    try {
      const tags = _safeJsonArray(row.topic_tags);
      const frontmatter = {
        title: row.title || row.slug,
        slug: row.slug,
        tags,
        created: (row.created_at || '').slice(0, 10),
        last_built: (row.last_built_at || '').slice(0, 10),
        raw_sources: row.raw_source_count || 0,
        staleness: row.staleness || 0,
      };
      exportWikiPage(row.slug, { ...frontmatter, source_type: row.source_type }, row.content, outputDir);
      exported.push(row.slug);
    } catch {
      skipped.push(row.slug);
    }
  }

  return { exported, skipped };
}

function exportStoredWikiPages(pages, outputDir) {
  const exportable = new Set(['memory', 'managed_redirect', 'doc', 'topic_cluster']);
  const exported = [];
  const skipped = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!exportable.has(String(page.source_type || 'memory')) || !String(page.content || '').trim()) continue;
    try {
      exportWikiPage(page.slug, {
        title: page.title || page.slug,
        tags: _safeJsonArray(page.topic_tags),
        created: String(page.created_at || '').slice(0, 10),
        last_built: String(page.last_built_at || '').slice(0, 10),
        raw_sources: page.raw_source_count || 0,
        staleness: page.staleness || 0,
        source_type: page.source_type || 'memory',
      }, page.content, outputDir);
      exported.push(page.slug);
    } catch { skipped.push(page.slug); }
  }
  return { exported, skipped };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function resolveOutputDir(outputDir) {
  return outputDir || defaultWikiOutputDir();
}

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Serialize frontmatter object to YAML block string.
 */
function _buildFrontmatter({ title, slug, tags = [], created, last_built, raw_sources, staleness, source_type }) {
  const tagsYaml = JSON.stringify(tags); // compact array
  const stalePct = typeof staleness === 'number' ? staleness.toFixed(2) : '0.00';
  const lines = [
    '---',
    `title: ${_yamlStr(title)}`,
    `slug: ${slug}`,
    `tags: ${tagsYaml}`,
    `created: ${created || ''}`,
    `last_built: ${last_built || ''}`,
    `raw_sources: ${raw_sources || 0}`,
    `staleness: ${stalePct}`,
  ];
  if (source_type) lines.push(`source_type: ${_yamlStr(source_type)}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * Escape a string value for inline YAML (quote if contains special chars).
 */
function _yamlStr(s) {
  const str = String(s || '');
  if (/[:#\[\]{}|>&*!,'"]/.test(str)) return `"${str.replace(/"/g, '\\"')}"`;
  return str;
}

function _sanitizeSlug(input, fallback = 'item') {
  const cleaned = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function _safeJsonArray(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _collectSessionRelated(project, tags, options = {}) {
  const wikiPages = Array.isArray(options.wikiPages) ? options.wikiPages : [];
  const capsuleFiles = Array.isArray(options.capsuleFiles) ? options.capsuleFiles : [];
  const candidates = new Set([
    String(project || '').trim().toLowerCase(),
    ...tags.map(tag => String(tag || '').trim().toLowerCase()),
  ]);
  const projectToken = String(project || '').trim().toLowerCase().replace(/[\s_/]+/g, '-');
  const tagTokens = tags.map(tag => String(tag || '').trim().toLowerCase().replace(/[\s_/]+/g, '-')).filter(Boolean);

  const wiki = [];
  for (const page of wikiPages) {
    const slug = String(page.slug || '').trim();
    const topic = String(page.primary_topic || '').trim().toLowerCase();
    if (!slug) continue;
    if (candidates.has(slug.toLowerCase()) || candidates.has(topic)) {
      wiki.push({ path: wikiPageLink(page), label: page.title || slug });
    }
  }

  const capsules = [];
  for (const file of capsuleFiles) {
    const base = path.basename(String(file || ''), '.md');
    const relative = options.capsulesRoot
      ? path.relative(options.capsulesRoot, file).replace(/\\/g, '/').replace(/\.md$/i, '')
      : base;
    const segments = relative.toLowerCase().split('/').map(value => value.replace(/[\s_]+/g, '-'));
    const baseToken = segments.at(-1);
    const projectMatches = segments.length === 1
      ? (!projectToken || baseToken.includes(projectToken))
      : (!projectToken || segments[0] === projectToken);
    if (projectMatches && tagTokens.some(token => baseToken.includes(token))) {
      capsules.push({ path: `capsules/${relative}`, label: base });
    }
  }

  return {
    wiki: _dedupeRelated(wiki),
    capsules: _dedupeRelated(capsules),
  };
}

function _dedupeRelated(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.path}|${item.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  exportWikiPage,
  organizeWikiProjection,
  rebuildIndex,
  exportSessionSummary,
  reconcileSessionProjection,
  sessionSlug,
  rebuildSessionsIndex,
  exportCapsuleFile,
  rebuildCapsulesIndex,
  exportReflectDir,
  rebuildReflectDirIndex,
  exportDocPages,          // new
  exportStoredWikiPages,
};
