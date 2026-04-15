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
const os = require('os');

const DEFAULT_WIKI_DIR = path.join(os.homedir(), '.metame', 'wiki');

/**
 * Write a wiki page as a Markdown file (atomic: write .tmp → rename).
 *
 * @param {string} slug
 * @param {{ title: string, tags: string[], created: string, last_built: string,
 *           raw_sources: number, staleness: number }} frontmatter
 * @param {string} content - Article body (no frontmatter)
 * @param {string} [outputDir]
 */
function exportWikiPage(slug, frontmatter, content, outputDir = DEFAULT_WIKI_DIR) {
  _ensureDir(outputDir);

  // Ensure slug in frontmatter matches the positional slug argument
  const yaml = _buildFrontmatter({ ...frontmatter, slug });
  const fileContent = `${yaml}\n${content}\n`;
  const filePath = path.join(outputDir, `${slug}.md`);
  const tmpPath = `${filePath}.tmp`;

  // Remove stale .tmp if present (previous interrupted write)
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }

  fs.writeFileSync(tmpPath, fileContent, 'utf8');
  fs.renameSync(tmpPath, filePath);
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
function rebuildIndex(pages, outputDir = DEFAULT_WIKI_DIR, options = {}) {
  _ensureDir(outputDir);
  const sessionCount = Number(options.sessionCount) || 0;
  const capsuleCount = Number(options.capsuleCount) || 0;

  const now = new Date().toISOString().slice(0, 10);
  const lines = [
    '---',
    'title: Wiki Index',
    `updated: ${now}`,
    '---',
    '',
    '# MetaMe Knowledge Wiki',
    '',
    `> ${pages.length} pages · 自动生成，勿手动编辑`,
    '',
    '| 页面 | 主题标签 | 来源数 | 陈旧度 | 最后更新 |',
    '|------|---------|--------|--------|---------|',
  ];

  for (const p of pages) {
    const stalePct = Math.round((p.staleness || 0) * 100);
    const built = p.last_built_at ? p.last_built_at.slice(0, 10) : '—';
    lines.push(
      `| [[${p.slug}\\|${p.title}]] | \`${p.primary_topic}\` | ${p.raw_source_count || 0} | ${stalePct}% | ${built} |`
    );
  }

  lines.push('', '## Navigation', '');
  lines.push(`- [[sessions/_index|Session Summaries]]${sessionCount > 0 ? ` (${sessionCount})` : ''}`);
  lines.push(`- [[capsules/_index|Knowledge Capsules]]${capsuleCount > 0 ? ` (${capsuleCount})` : ''}`);

  const content = lines.join('\n') + '\n';
  const filePath = path.join(outputDir, '_index.md');
  const tmpPath = `${filePath}.tmp`;

  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function exportSessionSummary(entry, outputDir = DEFAULT_WIKI_DIR, options = {}) {
  const sessionsDir = path.join(outputDir, 'sessions');
  _ensureDir(sessionsDir);

  const created = String(entry.created_at || '').slice(0, 10);
  const sessionId = String(entry.session_id || entry.id || '');
  const project = String(entry.project || 'unknown');
  const slug = _sanitizeSlug(`${created || 'session'}-${project}-${sessionId.slice(-8)}`, 'session');
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

function rebuildSessionsIndex(entries, outputDir = DEFAULT_WIKI_DIR) {
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
      const sessionId = String(entry.session_id || entry.id || '');
      const slug = _sanitizeSlug(`${created || 'session'}-${project}-${sessionId.slice(-8)}`, 'session');
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

function exportCapsuleFile(sourcePath, outputDir = DEFAULT_WIKI_DIR) {
  const capsulesDir = path.join(outputDir, 'capsules');
  _ensureDir(capsulesDir);

  const source = String(sourcePath || '');
  const base = path.basename(source);
  if (!source || !base.endsWith('.md') || !fs.existsSync(source)) return null;

  const targetPath = path.join(capsulesDir, base);
  const tmpPath = `${targetPath}.tmp`;
  const content = fs.readFileSync(source, 'utf8');

  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  fs.renameSync(tmpPath, targetPath);
  return targetPath;
}

function rebuildCapsulesIndex(capsuleFiles, outputDir = DEFAULT_WIKI_DIR) {
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
    const base = path.basename(String(sourcePath || ''), '.md');
    if (!base) continue;
    lines.push(`- [[capsules/${base}|${base}]]`);
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
function exportReflectDir(srcDir, subdir, outputDir = DEFAULT_WIKI_DIR) {
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
function rebuildReflectDirIndex(fileNames, subdir, outputDir = DEFAULT_WIKI_DIR) {
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
function exportDocPages(db, outputDir = DEFAULT_WIKI_DIR) {
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
      exportWikiPage(row.slug, frontmatter, row.content, outputDir);
      exported.push(row.slug);
    } catch {
      skipped.push(row.slug);
    }
  }

  return { exported, skipped };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function _ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Serialize frontmatter object to YAML block string.
 */
function _buildFrontmatter({ title, slug, tags = [], created, last_built, raw_sources, staleness }) {
  const tagsYaml = JSON.stringify(tags); // compact array
  const stalePct = typeof staleness === 'number' ? staleness.toFixed(2) : '0.00';
  return [
    '---',
    `title: ${_yamlStr(title)}`,
    `slug: ${slug}`,
    `tags: ${tagsYaml}`,
    `created: ${created || ''}`,
    `last_built: ${last_built || ''}`,
    `raw_sources: ${raw_sources || 0}`,
    `staleness: ${stalePct}`,
    '---',
  ].join('\n');
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

  const wiki = [];
  for (const page of wikiPages) {
    const slug = String(page.slug || '').trim();
    const topic = String(page.primary_topic || '').trim().toLowerCase();
    if (!slug) continue;
    if (candidates.has(slug.toLowerCase()) || candidates.has(topic)) {
      wiki.push({ path: slug, label: page.title || slug });
    }
  }

  const capsules = [];
  for (const file of capsuleFiles) {
    const base = path.basename(String(file || ''), '.md');
    const lower = base.toLowerCase();
    if ([...candidates].some(token => token && lower.includes(token.replace(/\s+/g, '-')))) {
      capsules.push({ path: `capsules/${base}`, label: base });
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
  rebuildIndex,
  exportSessionSummary,
  rebuildSessionsIndex,
  exportCapsuleFile,
  rebuildCapsulesIndex,
  exportReflectDir,
  rebuildReflectDirIndex,
  exportDocPages,          // new
};
