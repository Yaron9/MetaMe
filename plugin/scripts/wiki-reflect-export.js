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
function rebuildIndex(pages, outputDir = DEFAULT_WIKI_DIR) {
  _ensureDir(outputDir);

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

  const content = lines.join('\n') + '\n';
  const filePath = path.join(outputDir, '_index.md');
  const tmpPath = `${filePath}.tmp`;

  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
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

module.exports = { exportWikiPage, rebuildIndex };
