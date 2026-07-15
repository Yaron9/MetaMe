'use strict';

const fs = require('fs');
const path = require('path');
const { resolveWikiPageRelativePath } = require('./wiki-layout');
const os = require('os');
const crypto = require('crypto');

const yaml = require('../resolve-yaml');
const {
  formatCleanupManifestMarkdown,
  formatInventoryMarkdown,
} = require('./wiki-audit-format');
const {
  RUNTIME_WIKI_RELATIVE_PATH,
  expandHomePath,
  resolveConfiguredWikiOutputDir,
} = require('./wiki-paths');

const DEFAULT_CANDIDATES = [
  ['configured', null],
  ['legacy-documents', '~/Documents/MetaMe-Wiki'],
  ['legacy-metame', '~/.metame/wiki'],
];
const RUNTIME_WIKI_REL = RUNTIME_WIKI_RELATIVE_PATH;
const DEPRECATED_MARKER = '_DEPRECATED.md';

function expandHome(input, home = os.homedir()) {
  if (!input) return input;
  return path.resolve(expandHomePath(input, home));
}

function samePathOrRealPath(a, b) {
  if (!a || !b) return false;
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

function readConfig(configPath) {
  try { return yaml.load(fs.readFileSync(configPath, 'utf8')) || {}; } catch { return {}; }
}

function resolveActiveOutputDir({ home = os.homedir(), configPath = path.join(home, '.metame', 'daemon.yaml') } = {}) {
  return resolveConfiguredWikiOutputDir(readConfig(configPath), { home });
}

function findScriptsRoot() {
  const local = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(local, 'wiki-reflect.js'))) return local;
  const cwdScripts = path.join(process.cwd(), 'scripts');
  if (fs.existsSync(path.join(cwdScripts, 'wiki-reflect.js'))) return cwdScripts;
  return local;
}

function walkMarkdown(rootDir) {
  const files = [];
  if (!rootDir || !fs.existsSync(rootDir)) return files;
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(rootDir, relDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', '_review'].includes(entry.name)) stack.push(rel);
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== DEPRECATED_MARKER) {
        files.push(rel);
      }
    }
  }
  return files.sort();
}

function readFrontmatter(absFile) {
  let text = '';
  try { text = fs.readFileSync(absFile, 'utf8'); } catch { return { hasFrontmatter: false, title: null }; }
  if (!text.startsWith('---\n')) return { hasFrontmatter: false, title: null };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { hasFrontmatter: false, title: null };
  const titleMatch = text.slice(4, end).match(/^title:\s*(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].replace(/^['"]|['"]$/g, '').trim() : null;
  return { hasFrontmatter: true, title: title || null };
}

function classifyRel(rel) {
  const first = rel.split(path.sep)[0];
  if (['brain', 'archive', 'sessions', 'capsules', 'curated', 'decisions', 'lessons', 'research', 'topics', 'sources', 'external', '_review'].includes(first)) return first;
  if (rel === '_index.md' || rel === 'Home.md' || rel === '_audit.md' || rel === '_cleanup-manifest.md') return 'entrypoint';
  return 'root';
}

function isWeirdBasename(base) {
  return base.length < 2 || base === 'undefined' || base === 'null' || /^-\d*$/.test(base);
}

function shouldCheckDuplicateBasename(kind, base, rel = '') {
  if (base === '_index') return false;
  if (String(rel).split(path.sep).includes('projects')) return false;
  return ['root', 'brain', 'archive', 'research', 'topics', 'sources'].includes(kind);
}

function shouldRequireFrontmatterTitle(kind) {
  return ['root', 'brain', 'archive', 'research', 'topics', 'sources'].includes(kind);
}

function classifyOutputCandidate(label) {
  if (label === 'legacy-metame') {
    return {
      role: 'runtime-copy-candidate',
      cleanupAction: 'review-runtime-copy',
      recommendedAction: 'review-runtime-copy',
      reason: 'runtime path outside active output dir; verify no reader depends on it before cleanup',
    };
  }
  if (label === 'legacy-documents') {
    return {
      role: 'legacy-output-candidate',
      cleanupAction: 'deprecate-dir',
      recommendedAction: 'deprecate-dir',
      reason: 'legacy wiki output dir outside active output dir',
    };
  }
  return {
    role: 'extra-output-candidate',
    cleanupAction: 'review-dir',
    recommendedAction: 'review-dir',
    reason: 'extra wiki output candidate outside active output dir',
  };
}

function scanRuntimeCopyUsage({
  home = os.homedir(),
  activeOutputDir,
  scriptsRoot = findScriptsRoot(),
  hasConfiguredOutput = false,
} = {}) {
  const runtimeWikiDir = path.join(home, RUNTIME_WIKI_REL);
  const references = [];
  const files = walkCodeFiles(scriptsRoot);
  const patterns = [
    "'.metame', 'wiki'",
    '".metame", "wiki"',
    'DEFAULT_WIKI_DIR',
    'wiki_output_dir',
  ];

  for (const file of files) {
    const rel = path.relative(scriptsRoot, file);
    if (rel.includes('wiki-audit') || rel.endsWith('.test.js')) continue;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (patterns.some(pattern => line.includes(pattern))) {
        references.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160) });
      }
    }
  }
  const activeUsesRuntimeCopy = samePathOrRealPath(activeOutputDir, runtimeWikiDir);
  const classified = classifyRuntimeReferences(references);
  const classification = activeUsesRuntimeCopy
    ? 'active-output'
    : hasConfiguredOutput
      ? 'configured-output'
      : classified.fallbackDefaultRefs.length > 0
      ? 'configured-fallback'
      : 'unreferenced-copy';

  return {
    runtimeWikiDir,
    scriptsRoot,
    activeOutputDir,
    activeUsesRuntimeCopy,
    classification,
    referenceCount: references.length,
    configuredOutputRefs: classified.configuredOutputRefs,
    fallbackDefaultRefs: classified.fallbackDefaultRefs,
    directRuntimeRefs: classified.directRuntimeRefs,
    references,
    conclusion: activeUsesRuntimeCopy
      ? 'active output dir is runtime wiki dir'
      : classification === 'configured-output'
        ? 'configured wiki output dir points elsewhere; runtime wiki dir is not the active output'
      : classification === 'configured-fallback'
        ? 'runtime wiki dir is a no-config fallback; preserve unless fallback path is retired'
        : 'runtime wiki dir is outside active output dir and has no direct fallback references',
  };
}

function classifyRuntimeReferences(references) {
  const configuredOutputRefs = [];
  const fallbackDefaultRefs = [];
  const directRuntimeRefs = [];
  for (const ref of references) {
    if (ref.text.includes('wiki_output_dir')) configuredOutputRefs.push(ref);
    if (ref.text.includes('DEFAULT_WIKI_DIR') || ref.text.includes('RUNTIME_WIKI_RELATIVE_PATH')) fallbackDefaultRefs.push(ref);
    if (ref.text.includes("'.metame', 'wiki'") || ref.text.includes('".metame", "wiki"')) directRuntimeRefs.push(ref);
  }
  return { configuredOutputRefs, fallbackDefaultRefs, directRuntimeRefs };
}

function walkCodeFiles(rootDir) {
  const files = [];
  if (!rootDir || !fs.existsSync(rootDir)) return files;
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(rootDir, relDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (!['node_modules', '.git', 'coverage'].includes(entry.name)) stack.push(rel);
      } else if (entry.isFile() && /\.(js|yaml|yml|json)$/.test(entry.name)) {
        files.push(path.join(rootDir, rel));
      }
    }
  }
  return files.sort();
}

function scanWikiDir(rootDir) {
  const files = walkMarkdown(rootDir);
  const byKind = {};
  const basenameMap = new Map();
  const weirdFilenames = [];
  const weirdFileDetails = [];
  const missingFrontmatter = [];
  const emptyTitle = [];
  const generatedIndexes = [];

  for (const rel of files) {
    const kind = classifyRel(rel);
    byKind[kind] = (byKind[kind] || 0) + 1;
    const base = path.basename(rel, '.md');
    if (shouldCheckDuplicateBasename(kind, base, rel)) {
      if (!basenameMap.has(base)) basenameMap.set(base, []);
      basenameMap.get(base).push(rel);
    }
    if (isWeirdBasename(base)) {
      const absFile = path.join(rootDir, rel);
      weirdFilenames.push(rel);
      weirdFileDetails.push({
        file: rel,
        contentHash: sha256Short(normalizeExportedMarkdownContent(readText(absFile))),
      });
    }
    if (path.basename(rel) === '_index.md') generatedIndexes.push(rel);

    const fm = readFrontmatter(path.join(rootDir, rel));
    if (!fm.hasFrontmatter) missingFrontmatter.push(rel);
    if (fm.hasFrontmatter && !fm.title && shouldRequireFrontmatterTitle(kind)) emptyTitle.push(rel);
  }

  const duplicateBasenames = [];
  for (const [basename, rels] of basenameMap.entries()) {
    if (rels.length > 1) duplicateBasenames.push({ basename, files: rels });
  }

  return {
    path: rootDir,
    exists: !!(rootDir && fs.existsSync(rootDir)),
    fileCount: files.length,
    deprecatedMarker: !!(rootDir && fs.existsSync(path.join(rootDir, DEPRECATED_MARKER))),
    byKind,
    weirdFilenames,
    weirdFileDetails,
    missingFrontmatter,
    emptyTitle,
    duplicateBasenames,
    generatedIndexes,
  };
}

function readText(absFile) {
  try { return fs.readFileSync(absFile, 'utf8'); } catch { return ''; }
}

function normalizeExportedMarkdownContent(value) {
  return String(value || '')
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .replace(/^# .*\n+/, '')
    .trim();
}

function scanWikiDb(db, activeOutputDir) {
  const empty = {
    checked: false,
    pageCount: 0,
    weirdSlugs: [],
    emptySlugs: [],
    missingExportFiles: [],
    duplicateTitles: [],
    cleanupPlans: [],
    error: null,
  };
  if (!db) return empty;

  let rows = [];
  try {
    rows = db.prepare('SELECT id, slug, title, content, primary_topic, source_type FROM wiki_pages').all();
  } catch (err) {
    return { ...empty, error: err.message };
  }

  const titleMap = new Map();
  const weirdSlugs = [];
  const emptySlugs = [];
  const missingExportFiles = [];
  for (const row of rows) {
    const slug = String(row.slug || '').trim();
    const title = String(row.title || '').trim();
    const content = String(row.content || '');
    const scannedRow = {
      id: row.id || null,
      slug,
      title: title || null,
      contentHash: sha256Short(content),
      contentLength: content.length,
      contentLines: normalizeContentLines(content),
    };
    if (!slug) {
      emptySlugs.push({ id: row.id || null, title: title || null });
    } else {
      if (isWeirdBasename(slug)) weirdSlugs.push({ id: row.id || null, slug, title: title || null });
      const relativePath = resolveWikiPageRelativePath(row);
      const exportPath = path.join(activeOutputDir, ...relativePath.split('/'));
      if (activeOutputDir && !fs.existsSync(exportPath)) {
        missingExportFiles.push({ id: row.id || null, slug, title: title || null });
        scannedRow.exportExists = false;
      } else {
        scannedRow.exportExists = true;
      }
    }
    if (title) {
      if (!titleMap.has(title)) titleMap.set(title, []);
      titleMap.get(title).push(scannedRow);
    }
  }

  const duplicateTitles = [];
  const cleanupPlans = [];
  for (const [title, titleRows] of titleMap.entries()) {
    if (titleRows.length <= 1) continue;
    const canonical = chooseCanonicalWikiRow(titleRows);
    const duplicates = titleRows.filter(row => row !== canonical);
    duplicateTitles.push({ title, slugs: titleRows.map(row => row.slug || row.id || '(empty slug)'), canonicalSlug: canonical.slug || null });
    cleanupPlans.push({
      action: 'review-duplicate-title',
      title,
      keep: canonical.slug || canonical.id || null,
      keepContentHash: canonical.contentHash,
      keepContentLength: canonical.contentLength,
      keepLineCount: canonical.contentLines.length,
      reviewRows: duplicates.map(row => ({
        id: row.id || null,
        slug: row.slug || null,
        reason: row.slug ? 'duplicate title' : 'empty slug duplicate',
        contentHash: row.contentHash,
        contentLength: row.contentLength,
        contentLineCount: row.contentLines.length,
        contentCoveredByKeep: calcLineCoverage(row.contentLines, canonical.contentLines),
        contentMatchesKeep: row.contentHash === canonical.contentHash,
        reviewFile: buildDbReviewRelPath(title, row),
        suggestedSql: row.id && row.contentHash === canonical.contentHash
          ? `DELETE FROM wiki_pages WHERE id = ${sqlString(row.id)};`
          : null,
      })),
    });
  }

  return {
    checked: true,
    pageCount: rows.length,
    weirdSlugs,
    emptySlugs,
    missingExportFiles,
    duplicateTitles,
    cleanupPlans,
    error: null,
  };
}

function chooseCanonicalWikiRow(rows) {
  return rows.find(row => row.slug && !isWeirdBasename(row.slug) && row.exportExists)
    || rows.find(row => row.slug && !isWeirdBasename(row.slug))
    || rows.find(row => row.slug)
    || rows[0];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sha256Short(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function normalizeContentLines(value) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(value || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line.length < 8 || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function calcLineCoverage(reviewLines, keepLines) {
  if (!Array.isArray(reviewLines) || reviewLines.length === 0) return null;
  const keep = new Set(Array.isArray(keepLines) ? keepLines : []);
  const matched = reviewLines.filter(line => keep.has(line)).length;
  return Number((matched / reviewLines.length).toFixed(3));
}

function buildInventory({
  home = os.homedir(),
  configPath = path.join(home, '.metame', 'daemon.yaml'),
  activeOutputDir: explicitOutputDir = null,
  extraCandidates = [],
  db = null,
  scriptsRoot = findScriptsRoot(),
} = {}) {
  const config = readConfig(configPath);
  const activeOutputDir = explicitOutputDir
    ? expandHome(explicitOutputDir, home)
    : resolveConfiguredWikiOutputDir(config, { home });
  const hasConfiguredOutput = !!explicitOutputDir || !!(config && config.daemon && config.daemon.wiki_output_dir);
  const candidates = new Map();
  for (const [label, candidate] of DEFAULT_CANDIDATES) candidates.set(candidate ? expandHome(candidate, home) : activeOutputDir, label);
  for (const candidate of extraCandidates) candidates.set(expandHome(candidate, home), 'extra');

  const deprecatedOutputDirs = [];
  for (const [dir, label] of candidates.entries()) {
    if (!dir || samePathOrRealPath(dir, activeOutputDir)) continue;
    const scan = scanWikiDir(dir);
    if (scan.exists) deprecatedOutputDirs.push({ label, ...classifyOutputCandidate(label), ...scan });
  }

  const active = scanWikiDir(activeOutputDir);
  const dbScan = scanWikiDb(db, activeOutputDir);
  markWeirdFilesCoveredByDbReview(active, dbScan);
  const runtimeCopy = scanRuntimeCopyUsage({ home, activeOutputDir, scriptsRoot, hasConfiguredOutput });
  applyLegacyCandidateClassification(deprecatedOutputDirs);
  applyRuntimeCandidateClassification(deprecatedOutputDirs, runtimeCopy);
  const cleanupCandidates = [];
  const weirdDetails = new Map((active.weirdFileDetails || []).map(item => [item.file, item]));
  for (const rel of active.weirdFilenames) {
    const detail = weirdDetails.get(rel) || {};
    cleanupCandidates.push({
      action: detail.coveredByDbReview ? 'quarantine-covered-weird-file' : 'rename-or-archive',
      file: rel,
      reason: detail.coveredByDbReview ? `weird filename; content covered by DB review row ${detail.coveredByDbReview.sourceRow}` : 'weird filename',
      coveredByDbReview: detail.coveredByDbReview || null,
    });
  }
  for (const rel of active.missingFrontmatter) cleanupCandidates.push({ action: 'inspect', file: rel, reason: 'missing frontmatter' });
  for (const item of active.duplicateBasenames) cleanupCandidates.push({ action: 'merge-or-rename', file: item.basename, reason: `duplicate basename (${item.files.length})` });
  for (const dir of deprecatedOutputDirs) cleanupCandidates.push({ action: dir.cleanupAction, file: dir.path, reason: `${dir.reason}; ${dir.fileCount} markdown files` });
  for (const item of dbScan.cleanupPlans) cleanupCandidates.push({ action: 'review-db-plan', file: item.title, reason: `${item.action}; keep ${item.keep}` });
  const dbRowsCoveredByCleanupPlan = collectCleanupPlanRowKeys(dbScan.cleanupPlans);
  for (const item of dbScan.missingExportFiles) {
    if (dbRowsCoveredByCleanupPlan.has(dbRowKey(item))) continue;
    cleanupCandidates.push({ action: 'inspect-db-row', file: `wiki_pages:${item.slug}`, reason: 'wiki_pages row has no exported markdown file' });
  }

  const inventory = { generatedAt: new Date().toISOString(), activeOutputDir, active, db: dbScan, runtimeCopy, deprecatedOutputDirs, cleanupCandidates };
  inventory.reviewedDbCleanupPlan = buildReviewedDbCleanupPlan(inventory);
  return inventory;
}

function applyLegacyCandidateClassification(deprecatedOutputDirs) {
  if (!Array.isArray(deprecatedOutputDirs)) return;
  for (const dir of deprecatedOutputDirs) {
    if (dir.role !== 'legacy-output-candidate' || !dir.deprecatedMarker) continue;
    dir.recommendedAction = 'deprecated-output-marked';
    dir.cleanupAction = 'deprecated-output-marked';
    dir.reason = `${dir.reason}; deprecation marker present`;
  }
}

function applyRuntimeCandidateClassification(deprecatedOutputDirs, runtimeCopy) {
  if (!Array.isArray(deprecatedOutputDirs) || !runtimeCopy) return;
  for (const dir of deprecatedOutputDirs) {
    if (dir.role !== 'runtime-copy-candidate') continue;
    if (runtimeCopy.classification === 'configured-fallback') {
      dir.recommendedAction = 'preserve-runtime-fallback';
      dir.cleanupAction = 'preserve-runtime-fallback';
      dir.reason = `${dir.reason}; no-config fallback defaults still reference this path`;
    } else if (runtimeCopy.classification === 'configured-output') {
      dir.recommendedAction = 'archive-runtime-copy';
      dir.cleanupAction = 'archive-runtime-copy';
      dir.reason = `${dir.reason}; configured wiki_output_dir points elsewhere`;
    }
  }
}

function collectCleanupPlanRowKeys(cleanupPlans = []) {
  const keys = new Set();
  for (const plan of cleanupPlans || []) {
    for (const row of plan.reviewRows || []) keys.add(dbRowKey(row));
  }
  return keys;
}

function dbRowKey(row) {
  return row && row.id ? `id:${row.id}` : `slug:${row && row.slug ? row.slug : ''}`;
}

function markWeirdFilesCoveredByDbReview(active, dbScan) {
  if (!active || !Array.isArray(active.weirdFileDetails) || !dbScan || !Array.isArray(dbScan.cleanupPlans)) return;
  const reviewRowsByHash = new Map();
  for (const plan of dbScan.cleanupPlans) {
    for (const row of plan.reviewRows || []) {
      if (!row.contentHash) continue;
      reviewRowsByHash.set(row.contentHash, {
        title: plan.title,
        canonical: plan.keep || null,
        sourceRow: row.id || row.slug || null,
        reviewFile: row.reviewFile || buildDbReviewRelPath(plan.title, row),
      });
    }
  }
  for (const detail of active.weirdFileDetails) {
    const match = reviewRowsByHash.get(detail.contentHash);
    if (match) detail.coveredByDbReview = match;
  }
}

function writeGeneratedMarkdown(outputDir, filename, content) {
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, filename);
  const tmpPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try { fs.unlinkSync(tmpPath); } catch { /* not present */ }
  fs.writeFileSync(tmpPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

function writeAuditReport(inventory) {
  return writeGeneratedMarkdown(inventory.activeOutputDir, '_audit.md', formatInventoryMarkdown(inventory));
}

function writeCleanupManifest(inventory) {
  return writeGeneratedMarkdown(inventory.activeOutputDir, '_cleanup-manifest.md', formatCleanupManifestMarkdown(inventory));
}

function writeDeprecationMarkers(inventory) {
  const written = [];
  if (!inventory || !Array.isArray(inventory.deprecatedOutputDirs)) return written;
  for (const dir of inventory.deprecatedOutputDirs) {
    if (dir.role !== 'legacy-output-candidate') continue;
    const content = formatDeprecationMarkerMarkdown(dir, inventory);
    written.push(writeGeneratedMarkdown(dir.path, DEPRECATED_MARKER, content));
    dir.deprecatedMarker = true;
  }
  return written;
}

function writeDbReviewBundle(inventory, db) {
  const written = [];
  if (!inventory || !inventory.db || !Array.isArray(inventory.db.cleanupPlans) || !db) return written;

  const getRow = db.prepare('SELECT id, slug, title, content FROM wiki_pages WHERE id = ?');
  const getCanonicalRow = db.prepare('SELECT id, slug, title, content FROM wiki_pages WHERE slug = ? OR id = ? LIMIT 1');
  for (const plan of inventory.db.cleanupPlans) {
    const canonicalRow = plan.keep ? getCanonicalRow.get(plan.keep, plan.keep) : null;
    for (const row of plan.reviewRows || []) {
      if (!row.id) continue;
      const dbRow = getRow.get(row.id);
      if (!dbRow) continue;
      const relPath = row.reviewFile || buildDbReviewRelPath(plan.title, row);
      const content = formatDbReviewMarkdown(plan, row, dbRow, canonicalRow);
      const filePath = writeGeneratedMarkdown(inventory.activeOutputDir, relPath, content);
      row.reviewFile = relPath;
      linkReviewFileToCoveredWeirdFile(inventory, row, relPath);
      written.push(filePath);
    }
  }
  return written;
}

function linkReviewFileToCoveredWeirdFile(inventory, row, relPath) {
  if (!inventory || !inventory.active || !Array.isArray(inventory.active.weirdFileDetails)) return;
  const sourceRow = row.id || row.slug || null;
  for (const detail of inventory.active.weirdFileDetails) {
    if (detail.contentHash !== row.contentHash) continue;
    if (!detail.coveredByDbReview || detail.coveredByDbReview.sourceRow !== sourceRow) continue;
    detail.coveredByDbReview.reviewFile = relPath;
  }
  if (!Array.isArray(inventory.cleanupCandidates)) return;
  for (const item of inventory.cleanupCandidates) {
    if (!item.coveredByDbReview || item.coveredByDbReview.sourceRow !== sourceRow) continue;
    item.coveredByDbReview.reviewFile = relPath;
  }
}

function formatDbReviewMarkdown(plan, row, dbRow, canonicalRow = null) {
  return [
    '---',
    `title: ${yamlString(`DB Review - ${plan.title}`)}`,
    'type: generated-audit',
    `source_row_id: ${yamlString(row.id || '')}`,
    `source_slug: ${yamlString(row.slug || '')}`,
    `canonical_slug: ${yamlString(plan.keep || '')}`,
    `content_hash: ${yamlString(row.contentHash || '')}`,
    '---',
    '',
    `# DB Review - ${plan.title}`,
    '',
    `- canonical: [[${plan.keep}]]`,
    `- source row id: \`${row.id || ''}\``,
    `- source slug: \`${row.slug || ''}\``,
    `- content covered by canonical: ${typeof row.contentCoveredByKeep === 'number' ? `${Math.round(row.contentCoveredByKeep * 100)}%` : 'unknown'}`,
    `- content matches canonical: ${row.contentMatchesKeep ? 'yes' : 'no'}`,
    `- merge status: ${row.contentMatchesKeep ? 'duplicate-safe-delete-candidate' : 'manual-merge-required'}`,
    '',
    '## Canonical Excerpt',
    '',
    canonicalRow && canonicalRow.content ? excerptMarkdown(canonicalRow.content) : '(canonical row not found)',
    '',
    '## Source Content',
    '',
    String(dbRow.content || '').trim() || '(empty)',
    '',
  ].join('\n');
}

function excerptMarkdown(content, maxChars = 1200) {
  const text = String(content || '').trim();
  if (text.length <= maxChars) return text || '(empty)';
  return `${text.slice(0, maxChars).trim()}\n\n...(truncated; review canonical page for full content)`;
}

function formatDeprecationMarkerMarkdown(dir, inventory) {
  return [
    '---',
    'title: Deprecated Wiki Output',
    'type: generated-audit',
    `updated: ${inventory.generatedAt.slice(0, 10)}`,
    '---',
    '',
    '# Deprecated Wiki Output',
    '',
    `This directory is not the active MetaMe wiki output directory.`,
    '',
    `- legacy dir: ${dir.path}`,
    `- active dir: ${inventory.activeOutputDir}`,
    `- markdown files at audit time: ${dir.fileCount}`,
    `- reason: ${dir.reason || 'legacy wiki output dir outside active output dir'}`,
    '',
    'No files were deleted or moved by this marker.',
    '',
  ].join('\n');
}

function safeFileStem(title, suffix) {
  const base = String(title || 'wiki-page')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'wiki-page';
  const tail = String(suffix || 'row')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
    .slice(0, 32) || 'row';
  return `${base}-${tail}`;
}

function buildDbReviewRelPath(title, row) {
  return path.join('_review', 'wiki-db', `${safeFileStem(title, row && (row.slug || row.id))}.md`);
}

function yamlString(value) {
  return JSON.stringify(String(value || ''));
}

const STATUS_ONLY_SAFE_FIX_ACTIONS = new Set([
  'deprecated-output-marked',
  'preserve-runtime-fallback',
]);

function buildSafeFixPlan(inventory) {
  const actions = [];
  for (const dir of inventory.deprecatedOutputDirs) {
    if (STATUS_ONLY_SAFE_FIX_ACTIONS.has(dir.cleanupAction)) continue;
    actions.push({
      mode: 'manual',
      action: dir.cleanupAction || 'review-dir',
      target: dir.path,
      reason: dir.reason || `${dir.fileCount} markdown files outside active output dir`,
      command: null,
    });
  }
  const weirdDetails = new Map((inventory.active.weirdFileDetails || []).map(item => [item.file, item]));
  for (const rel of inventory.active.weirdFilenames) {
    const detail = weirdDetails.get(rel) || {};
    const covered = detail.coveredByDbReview || null;
    const target = path.join(inventory.activeOutputDir, rel);
    const quarantineTarget = covered
      ? path.join(inventory.activeOutputDir, '_review', 'weird-files', rel === '.md' ? 'empty-slug.md' : rel)
      : null;
    const preconditions = covered
      ? [
        'source file exists',
        'destination does not exist',
        'source content hash matches covered DB review row',
      ]
      : [];
    actions.push({
      mode: covered ? 'review-then-apply' : 'manual',
      action: covered ? 'quarantine-covered-weird-file' : 'archive-weird-file',
      target,
      destination: quarantineTarget,
      expectedContentHash: detail.contentHash || null,
      preconditions,
      reason: covered
        ? `weird auto-generated filename; content is preserved in ${covered.reviewFile || 'DB review bundle'}`
        : 'weird auto-generated filename; inspect before moving',
      command: covered ? [
        `test -f ${shellString(target)}`,
        `test ! -e ${shellString(quarantineTarget)}`,
        `mkdir -p ${shellString(path.dirname(quarantineTarget))}`,
        `mv -n ${shellString(target)} ${shellString(quarantineTarget)}`,
      ].join(' && ') : null,
    });
  }
  const dbIssues = [
    ...(inventory.db && inventory.db.emptySlugs ? inventory.db.emptySlugs : []),
    ...(inventory.db && inventory.db.weirdSlugs ? inventory.db.weirdSlugs : []),
    ...(inventory.db && inventory.db.missingExportFiles ? inventory.db.missingExportFiles : []),
  ];
  const dbRowsCoveredByCleanupPlan = collectCleanupPlanRowKeys(inventory.db && inventory.db.cleanupPlans);
  const seenDbIssueRows = new Set();
  for (const item of dbIssues) {
    const key = dbRowKey(item);
    if (dbRowsCoveredByCleanupPlan.has(key) || seenDbIssueRows.has(key)) continue;
    seenDbIssueRows.add(key);
    actions.push({
      mode: 'manual',
      action: 'inspect-db-row',
      target: item.slug ? `wiki_pages:${item.slug}` : `wiki_pages:${item.id || '(unknown id)'}`,
      reason: 'wiki_pages metadata does not match clean exported wiki state',
      command: null,
    });
  }
  return {
    generatedAt: inventory.generatedAt,
    dryRun: true,
    activeOutputDir: inventory.activeOutputDir,
    actions,
  };
}

function applySafeFixPlan(plan) {
  const results = [];
  if (!plan || !Array.isArray(plan.actions)) return { applied: 0, skipped: 0, results };

  for (const action of plan.actions) {
    if (action.action !== 'quarantine-covered-weird-file') {
      results.push({ action: action.action, target: action.target, status: 'skipped', reason: 'manual action' });
      continue;
    }
    const result = applyQuarantineCoveredWeirdFile(action);
    results.push(result);
  }

  return {
    applied: results.filter(result => result.status === 'applied').length,
    skipped: results.filter(result => result.status !== 'applied').length,
    results,
  };
}

function buildReviewedDbCleanupPlan(inventory) {
  const actions = [];
  const confirmationFlag = '--confirm-reviewed-db-cleanup';
  const applyCommand = `node scripts/wiki-audit.js --cleanup-db-duplicates --apply ${confirmationFlag} --json`;
  const cleanupPlans = inventory && inventory.db && Array.isArray(inventory.db.cleanupPlans)
    ? inventory.db.cleanupPlans
    : [];
  for (const plan of cleanupPlans) {
    for (const row of plan.reviewRows || []) {
      if (!row.id || !row.reviewFile) continue;
      actions.push({
        mode: row.contentMatchesKeep ? 'review-then-apply' : 'requires-confirmation',
        action: row.contentMatchesKeep
          ? 'delete-reviewed-duplicate-db-row'
          : 'merge-and-delete-reviewed-duplicate-db-row',
        title: plan.title,
        canonicalSlug: plan.keep,
        sourceRowId: row.id,
        sourceSlug: row.slug || '',
        reviewFile: row.reviewFile,
        expectedContentHash: row.contentHash || null,
        expectedCanonicalContentHash: plan.keepContentHash || null,
        contentMatchesKeep: Boolean(row.contentMatchesKeep),
        destructive: true,
        confirmationRequired: true,
        confirmationFlag,
        applyCommand,
        reason: row.contentMatchesKeep
          ? 'duplicate DB row content already matches canonical'
          : 'duplicate DB row content differs; append reviewed source content to canonical before deleting source row',
      });
    }
  }
  return {
    generatedAt: inventory.generatedAt,
    dryRun: true,
    destructive: true,
    confirmationRequired: actions.length > 0,
    confirmationFlag,
    applyCommand: actions.length > 0 ? applyCommand : null,
    backupDir: actions.length > 0 ? path.join(inventory.activeOutputDir, '_review', 'wiki-db', 'backups') : null,
    activeOutputDir: inventory.activeOutputDir,
    actions,
  };
}

function applyReviewedDbCleanupPlan(plan, db, { confirmed = false, backupPath = null } = {}) {
  const results = [];
  if (!plan || !Array.isArray(plan.actions) || !db) return { applied: 0, skipped: 0, results };
  let dbBackupPath = null;
  const supportedActions = plan.actions.filter(action => ['delete-reviewed-duplicate-db-row', 'merge-and-delete-reviewed-duplicate-db-row'].includes(action.action));
  if (confirmed && supportedActions.length > 0) {
    const backup = createReviewedDbCleanupBackup(plan, db, backupPath);
    if (backup.status !== 'created') {
      return {
        applied: 0,
        skipped: supportedActions.length,
        backupPath: null,
        results: supportedActions.map(action => ({
          action: action.action,
          target: action.sourceRowId || null,
          status: 'blocked',
          reason: `DB backup failed: ${backup.reason}`,
        })),
      };
    }
    dbBackupPath = backup.path;
  }

  for (const action of plan.actions) {
    if (!['delete-reviewed-duplicate-db-row', 'merge-and-delete-reviewed-duplicate-db-row'].includes(action.action)) {
      results.push({ action: action.action, target: action.sourceRowId || null, status: 'skipped', reason: 'unsupported action' });
      continue;
    }
    if (!confirmed) {
      results.push({
        action: action.action,
        target: action.sourceRowId || null,
        status: 'blocked',
        reason: 'explicit confirmation required: pass --confirm-reviewed-db-cleanup',
      });
      continue;
    }
    results.push(applyReviewedDbCleanupAction(plan, action, db));
  }

  return {
    applied: results.filter(result => result.status === 'applied').length,
    skipped: results.filter(result => result.status !== 'applied').length,
    backupPath: dbBackupPath,
    results,
  };
}

function createReviewedDbCleanupBackup(plan, db, backupPath = null) {
  const target = backupPath || defaultReviewedDbCleanupBackupPath(plan);
  if (!target) return { status: 'blocked', reason: 'missing backup path' };
  if (fs.existsSync(target)) return { status: 'blocked', reason: 'backup destination already exists', path: target };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    db.prepare('VACUUM INTO ?').run(target);
    return { status: 'created', path: target };
  } catch (err) {
    try { fs.rmSync(target, { force: true }); } catch { /* ignore cleanup failure */ }
    return { status: 'blocked', reason: err.message, path: target };
  }
}

function defaultReviewedDbCleanupBackupPath(plan) {
  if (!plan || !plan.activeOutputDir) return null;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return path.join(plan.activeOutputDir, '_review', 'wiki-db', 'backups', `memory-before-db-cleanup-${stamp}.db`);
}

function applyReviewedDbCleanupAction(plan, action, db) {
  if (!action.sourceRowId || !action.expectedContentHash || !action.canonicalSlug) {
    return { action: action.action, target: action.sourceRowId || null, status: 'blocked', reason: 'missing required DB cleanup precondition' };
  }

  const reviewPath = path.isAbsolute(action.reviewFile)
    ? action.reviewFile
    : path.join(plan.activeOutputDir || '', action.reviewFile || '');
  const reviewCheck = validateDbReviewFile(reviewPath, action);
  if (reviewCheck) return reviewCheck;

  const sourceRow = db.prepare('SELECT id, slug, title, content FROM wiki_pages WHERE id = ?').get(action.sourceRowId);
  if (!sourceRow) return { action: action.action, target: action.sourceRowId, status: 'skipped', reason: 'source row already absent' };

  const actualContentHash = sha256Short(sourceRow.content || '');
  if (actualContentHash !== action.expectedContentHash) {
    return {
      action: action.action,
      target: action.sourceRowId,
      status: 'blocked',
      reason: 'source row content hash mismatch',
      expectedContentHash: action.expectedContentHash,
      actualContentHash,
    };
  }

  const canonicalRow = db.prepare('SELECT id, slug, content FROM wiki_pages WHERE slug = ?').get(action.canonicalSlug);
  if (!canonicalRow) return { action: action.action, target: action.sourceRowId, status: 'blocked', reason: 'canonical row missing' };
  const actualCanonicalHash = sha256Short(canonicalRow.content || '');
  if (action.expectedCanonicalContentHash && actualCanonicalHash !== action.expectedCanonicalContentHash) {
    return {
      action: action.action,
      target: action.sourceRowId,
      status: 'blocked',
      reason: 'canonical row content hash mismatch',
      expectedCanonicalContentHash: action.expectedCanonicalContentHash,
      actualCanonicalContentHash: actualCanonicalHash,
    };
  }

  db.exec('BEGIN');
  try {
    if (action.action === 'merge-and-delete-reviewed-duplicate-db-row') {
      const mergedContent = appendReviewedDuplicateContent(canonicalRow.content, action, sourceRow);
      if (columnExists(db, 'wiki_pages', 'updated_at')) {
        db.prepare("UPDATE wiki_pages SET content = ?, updated_at = datetime('now') WHERE slug = ?").run(mergedContent, action.canonicalSlug);
      } else {
        db.prepare('UPDATE wiki_pages SET content = ? WHERE slug = ?').run(mergedContent, action.canonicalSlug);
      }
      deleteRowsByPageSlug(db, action.canonicalSlug, { chunksOnly: true });
    }
    deleteRowsByPageSlug(db, sourceRow.slug || '');
    db.prepare('DELETE FROM wiki_pages WHERE id = ?').run(action.sourceRowId);
    db.exec('COMMIT');
    return {
      action: action.action,
      target: action.sourceRowId,
      canonicalSlug: action.canonicalSlug,
      status: 'applied',
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    return { action: action.action, target: action.sourceRowId, status: 'blocked', reason: err.message };
  }
}

function validateDbReviewFile(reviewPath, action) {
  if (!reviewPath || !fs.existsSync(reviewPath)) {
    return { action: action.action, target: action.sourceRowId, status: 'blocked', reason: 'review file missing' };
  }
  const content = readText(reviewPath);
  if (!content.includes(`source_row_id: ${yamlString(action.sourceRowId)}`) || !content.includes(`content_hash: ${yamlString(action.expectedContentHash)}`)) {
    return { action: action.action, target: action.sourceRowId, status: 'blocked', reason: 'review file does not match source row and hash' };
  }
  return null;
}

function appendReviewedDuplicateContent(canonicalContent, action, sourceRow) {
  const marker = `source row: ${action.sourceRowId}`;
  if (String(canonicalContent || '').includes(marker)) return canonicalContent;
  return [
    String(canonicalContent || '').trimEnd(),
    '',
    '---',
    '',
    '## Reviewed Duplicate Source',
    '',
    `- source row: ${action.sourceRowId}`,
    `- source slug: ${sourceRow.slug || '(empty)'}`,
    `- content hash: ${action.expectedContentHash}`,
    `- review file: ${action.reviewFile}`,
    '',
    String(sourceRow.content || '').trim(),
    '',
  ].join('\n');
}

function deleteRowsByPageSlug(db, slug, { chunksOnly = false } = {}) {
  if (tableExists(db, 'content_chunks')) {
    db.prepare('DELETE FROM content_chunks WHERE page_slug = ?').run(slug);
  }
  if (!chunksOnly && tableExists(db, 'wiki_page_doc_sources')) {
    db.prepare('DELETE FROM wiki_page_doc_sources WHERE page_slug = ?').run(slug);
  }
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column);
}

function applyQuarantineCoveredWeirdFile(action) {
  if (!action.target || !action.destination) {
    return { action: action.action, target: action.target || null, status: 'blocked', reason: 'missing target or destination' };
  }
  if (!action.expectedContentHash) {
    return { action: action.action, target: action.target, status: 'blocked', reason: 'missing expected content hash' };
  }
  if (!fs.existsSync(action.target)) {
    return { action: action.action, target: action.target, status: 'blocked', reason: 'source file missing' };
  }
  if (fs.existsSync(action.destination)) {
    return { action: action.action, target: action.target, destination: action.destination, status: 'blocked', reason: 'destination already exists' };
  }
  const actualHash = sha256Short(normalizeExportedMarkdownContent(readText(action.target)));
  if (actualHash !== action.expectedContentHash) {
    return {
      action: action.action,
      target: action.target,
      status: 'blocked',
      reason: 'source content hash mismatch',
      expectedContentHash: action.expectedContentHash,
      actualContentHash: actualHash,
    };
  }
  fs.mkdirSync(path.dirname(action.destination), { recursive: true });
  fs.renameSync(action.target, action.destination);
  return {
    action: action.action,
    target: action.target,
    destination: action.destination,
    status: 'applied',
  };
}

function shellString(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  buildSafeFixPlan,
  buildReviewedDbCleanupPlan,
  buildInventory,
  classifyRel,
  classifyOutputCandidate,
  scanRuntimeCopyUsage,
  scanWikiDb,
  scanWikiDir,
  applySafeFixPlan,
  applyReviewedDbCleanupPlan,
  writeDbReviewBundle,
  writeDeprecationMarkers,
  writeAuditReport,
  writeCleanupManifest,
  _internal: { expandHome, isWeirdBasename, resolveActiveOutputDir },
};
