'use strict';

require('./test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempForTest } = require('./test-support/test-utils');

const {
  applyReviewedDbCleanupPlan,
  applySafeFixPlan,
  buildReviewedDbCleanupPlan,
  buildSafeFixPlan,
  buildInventory,
  classifyOutputCandidate,
  classifyRel,
  scanRuntimeCopyUsage,
  scanWikiDb,
  scanWikiDir,
  writeDbReviewBundle,
  writeDeprecationMarkers,
  writeAuditReport,
  writeCleanupManifest,
  _internal,
} = require('./core/wiki-audit');
const {
  formatCleanupManifestMarkdown,
  formatInventoryMarkdown,
  formatReviewedDbCleanupPlan,
  formatSafeFixPlanMarkdown,
} = require('./core/wiki-audit-format');

function makeTempHome() {
  return mkdtempForTest('metame-wiki-audit-');
}

function makeWikiDb() {
  const dir = makeTempHome();
  const dbPath = path.join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db._testDir = dir;
  db.exec(`
    CREATE TABLE wiki_pages (
      id TEXT PRIMARY KEY,
      slug TEXT,
      title TEXT NOT NULL,
      content TEXT DEFAULT '',
      primary_topic TEXT DEFAULT '',
      source_type TEXT DEFAULT 'memory'
    )
  `);
  return db;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function page(title = 'Page') {
  return [
    '---',
    `title: ${title}`,
    '---',
    '',
    `# ${title}`,
    '',
  ].join('\n');
}

test('classifyRel separates curated, archive, and legacy root files', () => {
  assert.equal(classifyRel('brain/projects/metame.md'), 'brain');
  assert.equal(classifyRel('archive/sessions/one.md'), 'archive');
  assert.equal(classifyRel('sessions/one.md'), 'sessions');
  assert.equal(classifyRel('capsules/a.md'), 'capsules');
  assert.equal(classifyRel('Home.md'), 'entrypoint');
  assert.equal(classifyRel('daemon.md'), 'root');
});

test('classifyOutputCandidate separates legacy output from runtime copy', () => {
  assert.deepEqual(classifyOutputCandidate('legacy-documents'), {
    role: 'legacy-output-candidate',
    cleanupAction: 'deprecate-dir',
    recommendedAction: 'deprecate-dir',
    reason: 'legacy wiki output dir outside active output dir',
  });
  assert.deepEqual(classifyOutputCandidate('legacy-metame'), {
    role: 'runtime-copy-candidate',
    cleanupAction: 'review-runtime-copy',
    recommendedAction: 'review-runtime-copy',
    reason: 'runtime path outside active output dir; verify no reader depends on it before cleanup',
  });
});

test('scanRuntimeCopyUsage records fallback references without marking active when configured elsewhere', () => {
  const home = makeTempHome();
  const scriptsRoot = path.join(home, 'scripts');
  const active = path.join(home, 'Vault', 'MetaMe', 'wiki');
  writeFile(path.join(scriptsRoot, 'core', 'wiki-paths.js'), "const RUNTIME_WIKI_RELATIVE_PATH = path.join('.metame', 'wiki');\n");
  writeFile(path.join(scriptsRoot, 'daemon-default.yaml'), 'wiki_output_dir: ~/Vault/MetaMe/wiki\n');

  const usage = scanRuntimeCopyUsage({ home, activeOutputDir: active, scriptsRoot });
  assert.equal(usage.activeUsesRuntimeCopy, false);
  assert.equal(usage.referenceCount, 2);
  assert.equal(usage.classification, 'configured-fallback');
  assert.equal(usage.configuredOutputRefs.length, 1);
  assert.equal(usage.fallbackDefaultRefs.length, 1);
  assert.equal(usage.directRuntimeRefs.length, 1);
  assert.match(usage.conclusion, /no-config fallback/);
});

test('scanRuntimeCopyUsage treats runtime wiki as archiveable when output is configured elsewhere', () => {
  const home = makeTempHome();
  const scriptsRoot = path.join(home, 'scripts');
  const active = path.join(home, 'Vault', 'MetaMe', 'wiki');
  writeFile(path.join(scriptsRoot, 'core', 'wiki-paths.js'), "const RUNTIME_WIKI_RELATIVE_PATH = path.join('.metame', 'wiki');\n");

  const usage = scanRuntimeCopyUsage({
    home,
    activeOutputDir: active,
    scriptsRoot,
    hasConfiguredOutput: true,
  });

  assert.equal(usage.activeUsesRuntimeCopy, false);
  assert.equal(usage.classification, 'configured-output');
  assert.match(usage.conclusion, /points elsewhere/);
});

test('buildInventory treats runtime wiki symlink to active output as compatibility entrypoint', () => {
  const home = makeTempHome();
  const active = path.join(home, 'Vault', 'MetaMe', 'wiki');
  const runtimeCopy = path.join(home, '.metame', 'wiki');
  const configPath = path.join(home, '.metame', 'daemon.yaml');
  writeFile(configPath, [
    'daemon:',
    '  wiki_output_dir: ~/Vault/MetaMe/wiki',
    '',
  ].join('\n'));
  writeFile(path.join(active, 'Home.md'), page('Home'));
  fs.mkdirSync(path.dirname(runtimeCopy), { recursive: true });
  fs.symlinkSync(active, runtimeCopy);

  const inventory = buildInventory({ home, configPath, scriptsRoot: path.join(home, 'missing-scripts') });

  assert.equal(inventory.runtimeCopy.activeUsesRuntimeCopy, true);
  assert.equal(inventory.runtimeCopy.classification, 'active-output');
  assert.equal(inventory.deprecatedOutputDirs.some(dir => dir.path === runtimeCopy), false);
  assert.equal(inventory.cleanupCandidates.some(item => item.file === runtimeCopy), false);
});

test('scanWikiDir reports weird filenames, frontmatter gaps, and duplicate basenames', () => {
  const root = makeTempHome();
  writeFile(path.join(root, 'brain', 'topics', 'metame.md'), page('MetaMe'));
  writeFile(path.join(root, 'archive', 'sessions', 'metame.md'), page('MetaMe Session'));
  writeFile(path.join(root, 'decisions', '2026-01-01-nightly-reflect.md'), '---\nkind: decision\n---\n\n# Decision\n');
  writeFile(path.join(root, 'lessons', '2026-01-01-nightly-reflect.md'), '---\nkind: lesson\n---\n\n# Lesson\n');
  writeFile(path.join(root, 'untitled.md'), '---\nkind: wiki\n---\n\n# Untitled\n');
  writeFile(path.join(root, '-2.md'), page('Bad Slug'));
  writeFile(path.join(root, '_review', 'weird-files', '-3.md'), page('Quarantined Bad Slug'));
  writeFile(path.join(root, '_DEPRECATED.md'), page('Deprecated Marker'));
  writeFile(path.join(root, 'raw.md'), '# no frontmatter\n');

  const scan = scanWikiDir(root);
  assert.equal(scan.fileCount, 7);
  assert.equal(scan.deprecatedMarker, true);
  assert.equal(scan.byKind.brain, 1);
  assert.equal(scan.byKind.archive, 1);
  assert.equal(scan.byKind.decisions, 1);
  assert.equal(scan.byKind.lessons, 1);
  assert.equal(scan.byKind.root, 3);
  assert.deepEqual(scan.weirdFilenames, ['-2.md']);
  assert.equal(scan.weirdFileDetails.length, 1);
  assert.equal(scan.weirdFileDetails[0].file, '-2.md');
  assert.equal(scan.weirdFileDetails[0].contentHash.length, 12);
  assert.deepEqual(scan.missingFrontmatter, ['raw.md']);
  assert.deepEqual(scan.emptyTitle, ['untitled.md']);
  assert.equal(scan.duplicateBasenames.length, 1);
  assert.equal(scan.duplicateBasenames[0].basename, 'metame');
});

test('scanWikiDb reports empty slugs, weird slugs, and missing exports', () => {
  const root = makeTempHome();
  const db = makeWikiDb();
  try {
    writeFile(path.join(root, 'good-page.md'), page('Good Page'));
    db.prepare('INSERT INTO wiki_pages (id, slug, title) VALUES (?, ?, ?)').run('wp_1', 'good-page', 'Good Page');
    db.prepare('INSERT INTO wiki_pages (id, slug, title) VALUES (?, ?, ?)').run('wp_2', '', 'Empty Slug');
    db.prepare('INSERT INTO wiki_pages (id, slug, title) VALUES (?, ?, ?)').run('wp_3', '-2', 'Bad Slug');
    db.prepare('INSERT INTO wiki_pages (id, slug, title) VALUES (?, ?, ?)').run('wp_4', 'missing-page', 'Missing Export');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_5', 'dup-a', 'Duplicate', 'same content line');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_6', 'dup-b', 'Duplicate', 'same content line');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_7', 'diff-a', 'Different Duplicate', 'shared line value\nkeep only value');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_8', 'diff-b', 'Different Duplicate', 'shared line value\nreview only value');

    const scan = scanWikiDb(db, root);
    assert.equal(scan.checked, true);
    assert.equal(scan.pageCount, 8);
    assert.deepEqual(scan.emptySlugs, [{ id: 'wp_2', title: 'Empty Slug' }]);
    assert.deepEqual(scan.weirdSlugs, [{ id: 'wp_3', slug: '-2', title: 'Bad Slug' }]);
    assert.ok(scan.missingExportFiles.some(item => item.slug === 'missing-page'));
    assert.equal(scan.duplicateTitles.length, 2);
    assert.equal(scan.duplicateTitles[0].title, 'Duplicate');
    assert.equal(scan.cleanupPlans.length, 2);
    const samePlan = scan.cleanupPlans.find(plan => plan.title === 'Duplicate');
    const diffPlan = scan.cleanupPlans.find(plan => plan.title === 'Different Duplicate');
    assert.equal(samePlan.keep, 'dup-a');
    assert.deepEqual(samePlan.reviewRows, [
      {
        id: 'wp_6',
        slug: 'dup-b',
        reason: 'duplicate title',
        contentHash: samePlan.keepContentHash,
        contentLength: 17,
        contentLineCount: 1,
        contentCoveredByKeep: 1,
        contentMatchesKeep: true,
        reviewFile: '_review/wiki-db/duplicate-dup-b.md',
        suggestedSql: "DELETE FROM wiki_pages WHERE id = 'wp_6';",
      },
    ]);
    assert.equal(diffPlan.reviewRows[0].suggestedSql, null);
    assert.equal(diffPlan.reviewRows[0].reviewFile, '_review/wiki-db/different-duplicate-diff-b.md');
    assert.equal(diffPlan.reviewRows[0].contentMatchesKeep, false);
    assert.equal(diffPlan.reviewRows[0].contentCoveredByKeep, 0.5);
  } finally {
    db.close();
    fs.rmSync(db._testDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildInventory resolves configured active dir and flags legacy dirs as deprecated', () => {
  const home = makeTempHome();
  const active = path.join(home, 'Vault', 'MetaMe', 'wiki');
  const legacy = path.join(home, 'Documents', 'MetaMe-Wiki');
  const runtimeCopy = path.join(home, '.metame', 'wiki');
  const configPath = path.join(home, '.metame', 'daemon.yaml');
  writeFile(configPath, [
    'daemon:',
    '  wiki_output_dir: ~/Vault/MetaMe/wiki',
    '',
  ].join('\n'));

  writeFile(path.join(active, 'Home.md'), page('Home'));
  writeFile(path.join(active, 'brain', 'projects', 'metame.md'), page('MetaMe'));
  writeFile(path.join(legacy, '_index.md'), page('Old Index'));
  writeFile(path.join(runtimeCopy, '_index.md'), page('Runtime Index'));

  const inventory = buildInventory({ home, configPath });
  assert.equal(inventory.activeOutputDir, active);
  assert.equal(inventory.active.fileCount, 2);
  assert.equal(inventory.deprecatedOutputDirs.length, 2);
  assert.equal(inventory.deprecatedOutputDirs.find(dir => dir.path === legacy).cleanupAction, 'deprecate-dir');
  assert.equal(inventory.deprecatedOutputDirs.find(dir => dir.path === runtimeCopy).cleanupAction, 'archive-runtime-copy');
  assert.equal(inventory.deprecatedOutputDirs.find(dir => dir.path === runtimeCopy).recommendedAction, 'archive-runtime-copy');
  assert.ok(inventory.cleanupCandidates.some(item => item.action === 'deprecate-dir'));
  assert.ok(inventory.cleanupCandidates.some(item => item.action === 'archive-runtime-copy'));
});

test('buildInventory does not duplicate DB inspect candidates already covered by cleanup plans', () => {
  const root = makeTempHome();
  const db = makeWikiDb();
  try {
    writeFile(path.join(root, 'good-page.md'), page('Good Page'));
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_keep', 'good-page', 'Good Page', 'keep line value');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_review', '-2', 'Good Page', 'review line value');
    const inventory = buildInventory({ activeOutputDir: root, db, scriptsRoot: path.join(root, 'missing-scripts') });

    assert.ok(inventory.db.missingExportFiles.some(item => item.id === 'wp_review'));
    assert.ok(inventory.cleanupCandidates.some(item => item.action === 'review-db-plan' && item.file === 'Good Page'));
    assert.equal(inventory.cleanupCandidates.some(item => item.action === 'inspect-db-row' && item.file === 'wiki_pages:-2'), false);
  } finally {
    db.close();
    fs.rmSync(db._testDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeDeprecationMarkers marks only legacy output candidates', () => {
  const home = makeTempHome();
  const active = path.join(home, 'Vault', 'MetaMe', 'wiki');
  const legacy = path.join(home, 'Documents', 'MetaMe-Wiki');
  const runtimeCopy = path.join(home, '.metame', 'wiki');
  try {
    writeFile(path.join(active, 'Home.md'), page('Home'));
    writeFile(path.join(legacy, 'old.md'), page('Old'));
    writeFile(path.join(runtimeCopy, 'runtime.md'), page('Runtime'));
    const inventory = buildInventory({
      home,
      activeOutputDir: active,
      scriptsRoot: path.join(home, 'missing-scripts'),
    });

    const written = writeDeprecationMarkers(inventory);
    assert.deepEqual(written, [path.join(legacy, '_DEPRECATED.md')]);
    assert.equal(fs.existsSync(path.join(legacy, '_DEPRECATED.md')), true);
    assert.equal(fs.existsSync(path.join(runtimeCopy, '_DEPRECATED.md')), false);
    assert.match(fs.readFileSync(path.join(legacy, '_DEPRECATED.md'), 'utf8'), /active dir:/);
    const after = buildInventory({
      home,
      activeOutputDir: active,
      scriptsRoot: path.join(home, 'missing-scripts'),
    });
    assert.equal(after.deprecatedOutputDirs.find(dir => dir.path === legacy).cleanupAction, 'deprecated-output-marked');
    assert.ok(after.cleanupCandidates.some(item => item.action === 'deprecated-output-marked'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('formatInventoryMarkdown is stable enough for CLI and _audit projection', () => {
  const inventory = {
    generatedAt: '2026-06-24T00:00:00.000Z',
    activeOutputDir: '/tmp/wiki',
    active: {
      fileCount: 2,
      byKind: { brain: 1, entrypoint: 1 },
      weirdFilenames: [],
      missingFrontmatter: [],
      emptyTitle: [],
      duplicateBasenames: [],
      generatedIndexes: ['_index.md'],
    },
    deprecatedOutputDirs: [],
    cleanupCandidates: [],
    runtimeCopy: {
      runtimeWikiDir: '/tmp/home/.metame/wiki',
      activeUsesRuntimeCopy: false,
      classification: 'configured-fallback',
      referenceCount: 1,
      configuredOutputRefs: [],
      fallbackDefaultRefs: [{ file: 'core/wiki-paths.js', line: 1, text: 'RUNTIME_WIKI_RELATIVE_PATH' }],
      directRuntimeRefs: [],
      conclusion: 'runtime wiki dir appears to be fallback/runtime copy; verify references before archive',
      references: [{ file: 'core/wiki-paths.js', line: 1, text: 'RUNTIME_WIKI_RELATIVE_PATH' }],
    },
  };

  const markdown = formatInventoryMarkdown(inventory);
  assert.match(markdown, /# MetaMe Wiki Inventory/);
  assert.match(markdown, /## Active Output Dir/);
  assert.match(markdown, /brain: 1/);
  assert.match(markdown, /## Runtime Copy Evidence/);
  assert.match(markdown, /classification: configured-fallback/);
  assert.match(markdown, /none detected/);
});

test('formatCleanupManifestMarkdown makes cleanup proposals explicit and dry-run', () => {
  const inventory = {
    generatedAt: '2026-06-24T00:00:00.000Z',
    activeOutputDir: '/tmp/wiki',
    active: {
      fileCount: 1,
      byKind: { root: 1 },
      weirdFilenames: ['-2.md'],
      weirdFileDetails: [
        {
          file: '-2.md',
          coveredByDbReview: {
            canonical: 'dup-a',
            sourceRow: 'wp_7',
            reviewFile: '_review/wiki-db/duplicate-wp_7.md',
          },
        },
      ],
      missingFrontmatter: [],
      emptyTitle: [],
      duplicateBasenames: [],
      generatedIndexes: [],
    },
    deprecatedOutputDirs: [
      {
        path: '/tmp/old-wiki',
        label: 'legacy',
        role: 'legacy-output-candidate',
        fileCount: 3,
        recommendedAction: 'deprecate-dir',
        reason: 'legacy wiki output dir outside active output dir',
      },
      {
        path: '/tmp/runtime-wiki',
        label: 'legacy-metame',
        role: 'runtime-copy-candidate',
        fileCount: 3,
        recommendedAction: 'preserve-runtime-fallback',
        reason: 'runtime path outside active output dir; verify no reader depends on it before cleanup; no-config fallback defaults still reference this path',
      },
    ],
    cleanupCandidates: [
      {
        action: 'quarantine-covered-weird-file',
        file: '-2.md',
        reason: 'weird filename; content covered by DB review row wp_7',
        coveredByDbReview: {
          canonical: 'dup-a',
          sourceRow: 'wp_7',
          reviewFile: '_review/wiki-db/duplicate-wp_7.md',
        },
      },
      { action: 'deprecate-dir', file: '/tmp/old-wiki', reason: '3 markdown files outside active output dir' },
      { action: 'preserve-runtime-fallback', file: '/tmp/runtime-wiki', reason: 'runtime path outside active output dir; verify no reader depends on it before cleanup; no-config fallback defaults still reference this path; 3 markdown files' },
      { action: 'review-db-plan', file: 'Duplicate', reason: 'review-duplicate-title; keep dup-a' },
    ],
    db: {
      cleanupPlans: [
        {
          action: 'review-duplicate-title',
          title: 'Duplicate',
          keep: 'dup-a',
          reviewRows: [
            {
              id: 'wp_6',
              slug: 'dup-b',
              reason: 'duplicate title',
              contentHash: 'abc123',
              contentLength: 12,
              contentLineCount: 1,
              contentCoveredByKeep: 1,
              contentMatchesKeep: true,
              suggestedSql: "DELETE FROM wiki_pages WHERE id = 'wp_6';",
            },
            {
              id: 'wp_7',
              slug: 'dup-c',
              reason: 'duplicate title',
              contentHash: 'def456',
              contentLength: 8,
              contentLineCount: 2,
              contentCoveredByKeep: 0.5,
              contentMatchesKeep: false,
              suggestedSql: null,
            },
          ],
        },
      ],
    },
    reviewedDbCleanupPlan: {
      confirmationRequired: true,
      confirmationFlag: '--confirm-reviewed-db-cleanup',
      applyCommand: 'node scripts/wiki-audit.js --cleanup-db-duplicates --apply --confirm-reviewed-db-cleanup --json',
    },
    runtimeCopy: {
      runtimeWikiDir: '/tmp/home/.metame/wiki',
      activeUsesRuntimeCopy: false,
      classification: 'configured-fallback',
      referenceCount: 1,
      configuredOutputRefs: [],
      fallbackDefaultRefs: [{ file: 'core/wiki-paths.js', line: 1, text: 'RUNTIME_WIKI_RELATIVE_PATH' }],
      directRuntimeRefs: [],
      conclusion: 'runtime wiki dir appears to be fallback/runtime copy; verify references before archive',
    },
  };

  const markdown = formatCleanupManifestMarkdown(inventory);
  assert.match(markdown, /# MetaMe Wiki Cleanup Manifest/);
  assert.match(markdown, /Dry-run manifest/);
  assert.match(markdown, /target: -2.md/);
  assert.match(markdown, /covered_by_db_review: yes/);
  assert.match(markdown, /review_file: _review\/wiki-db\/duplicate-wp_7\.md/);
  assert.match(markdown, /Destructive DB cleanup is blocked/);
  assert.match(markdown, /confirmation flag: --confirm-reviewed-db-cleanup/);
  assert.match(markdown, /apply command: node scripts\/wiki-audit\.js --cleanup-db-duplicates --apply --confirm-reviewed-db-cleanup --json/);
  assert.match(markdown, /backup dir: /);
  assert.match(markdown, /recommended action: deprecate-dir/);
  assert.match(markdown, /recommended action: preserve-runtime-fallback/);
  assert.match(markdown, /preserve-runtime-fallback/);
  assert.match(markdown, /retirement_gate:/);
  assert.match(markdown, /Confirm active_output_dir is the only documented wiki entrypoint/);
  assert.match(markdown, /Retire only after fallback default is removed or redirected in core\/wiki-paths\.js/);
  assert.match(markdown, /## Runtime Copy Evidence/);
  assert.match(markdown, /active uses runtime copy: no/);
  assert.match(markdown, /fallback default refs: 1/);
  assert.match(markdown, /## DB Cleanup Review/);
  assert.match(markdown, /keep: dup-a/);
  assert.match(markdown, /suggested_sql: DELETE FROM wiki_pages WHERE id = 'wp_6';/);
  assert.match(markdown, /content_covered_by_keep: 50%/);
  assert.match(markdown, /content_matches_keep: no/);
  assert.match(markdown, /suggested_sql: none; use reviewed cleanup command after confirmation/);
});

test('writeCleanupManifest writes only the manifest file atomically', () => {
  const root = makeTempHome();
  writeFile(path.join(root, 'keep.md'), page('Keep'));
  const inventory = {
    generatedAt: '2026-06-24T00:00:00.000Z',
    activeOutputDir: root,
    active: {
      fileCount: 1,
      byKind: { root: 1 },
      weirdFilenames: [],
      missingFrontmatter: [],
      emptyTitle: [],
      duplicateBasenames: [],
      generatedIndexes: [],
    },
    deprecatedOutputDirs: [],
    cleanupCandidates: [
      { action: 'inspect', file: 'keep.md', reason: 'test candidate' },
    ],
  };

  const written = writeCleanupManifest(inventory);
  assert.equal(written, path.join(root, '_cleanup-manifest.md'));
  assert.equal(fs.existsSync(written), true);
  assert.equal(fs.existsSync(`${written}.tmp`), false);
  assert.equal(fs.readFileSync(path.join(root, 'keep.md'), 'utf8'), page('Keep'));
  assert.match(fs.readFileSync(written, 'utf8'), /No files were moved, renamed, or deleted/);
});

test('writeDbReviewBundle writes review files and annotates cleanup plans', () => {
  const root = makeTempHome();
  const db = makeWikiDb();
  try {
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_keep', 'good-page', 'Good Page', 'keep content line');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content) VALUES (?, ?, ?, ?)').run('wp_review', '', 'Good Page', 'review content line');
    writeFile(path.join(root, 'good-page.md'), page('Good Page'));
    writeFile(path.join(root, '.md'), page('Good Page') + 'review content line\n');
    const inventory = buildInventory({ activeOutputDir: root, db, scriptsRoot: path.join(root, 'missing-scripts') });
    assert.equal(inventory.cleanupCandidates.find(item => item.file === '.md').action, 'quarantine-covered-weird-file');
    assert.equal(inventory.cleanupCandidates.find(item => item.file === '.md').coveredByDbReview.reviewFile, '_review/wiki-db/good-page-wp_review.md');

    const written = writeDbReviewBundle(inventory, db);
    assert.equal(written.length, 1);
    assert.equal(fs.existsSync(written[0]), true);
    assert.match(written[0], /_review/);
    assert.equal(inventory.db.cleanupPlans[0].reviewRows[0].reviewFile.endsWith('.md'), true);
    assert.equal(inventory.cleanupCandidates.find(item => item.file === '.md').coveredByDbReview.reviewFile.endsWith('.md'), true);

    const content = fs.readFileSync(written[0], 'utf8');
    assert.match(content, /source_row_id: "wp_review"/);
    assert.match(content, /merge status: manual-merge-required/);
    assert.match(content, /## Canonical Excerpt/);
    assert.match(content, /keep content line/);
    assert.match(content, /## Source Content/);
    assert.match(content, /review content line/);
  } finally {
    db.close();
    fs.rmSync(db._testDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeAuditReport writes only the audit report file atomically', () => {
  const root = makeTempHome();
  writeFile(path.join(root, 'keep.md'), page('Keep'));
  const inventory = {
    generatedAt: '2026-06-24T00:00:00.000Z',
    activeOutputDir: root,
    active: {
      fileCount: 1,
      byKind: { root: 1 },
      weirdFilenames: [],
      missingFrontmatter: [],
      emptyTitle: [],
      duplicateBasenames: [],
      generatedIndexes: [],
    },
    deprecatedOutputDirs: [],
    cleanupCandidates: [],
  };

  const written = writeAuditReport(inventory);
  assert.equal(written, path.join(root, '_audit.md'));
  assert.equal(fs.existsSync(written), true);
  assert.equal(fs.existsSync(`${written}.tmp`), false);
  assert.equal(fs.readFileSync(path.join(root, 'keep.md'), 'utf8'), page('Keep'));
  assert.match(fs.readFileSync(written, 'utf8'), /# MetaMe Wiki Inventory/);
});

test('buildSafeFixPlan only emits manual dry-run actions for safe boundaries', () => {
  const inventory = {
    generatedAt: '2026-06-24T00:00:00.000Z',
    activeOutputDir: '/tmp/wiki',
    active: {
      weirdFilenames: ['-2.md'],
      weirdFileDetails: [
        {
          file: '-2.md',
          coveredByDbReview: {
            canonical: 'good-page',
            sourceRow: 'wp_review',
            reviewFile: '_review/wiki-db/good-page-wp_review.md',
          },
        },
      ],
    },
    deprecatedOutputDirs: [
      {
        path: '/tmp/old-wiki',
        fileCount: 3,
        cleanupAction: 'review-runtime-copy',
        reason: 'runtime path outside active output dir; verify no reader depends on it before cleanup',
      },
    ],
    db: {
      emptySlugs: [{ id: 'wp_review', title: 'Good Page' }],
      weirdSlugs: [{ id: 'wp_review', slug: '-2', title: 'Good Page' }],
      missingExportFiles: [{ id: 'wp_review', slug: '-2', title: 'Good Page' }],
      cleanupPlans: [
        {
          title: 'Good Page',
          reviewRows: [{ id: 'wp_review', slug: '-2' }],
        },
      ],
    },
  };

  const plan = buildSafeFixPlan(inventory);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions.map(a => a.mode), ['manual', 'review-then-apply']);
  assert.equal(plan.actions[0].command, null);
  assert.match(plan.actions[1].command, /mkdir -p/);
  assert.match(plan.actions[1].command, /test ! -e/);
  assert.match(plan.actions[1].command, /mv -n/);
  assert.match(plan.actions[1].destination, /_review\/weird-files\/-2\.md$/);
  assert.equal(plan.actions[1].expectedContentHash, null);
  assert.deepEqual(plan.actions[1].preconditions, [
    'source file exists',
    'destination does not exist',
    'source content hash matches covered DB review row',
  ]);
  assert.equal(plan.actions[0].action, 'review-runtime-copy');
  assert.equal(plan.actions[1].action, 'quarantine-covered-weird-file');
  assert.equal(plan.actions.some(action => action.action === 'inspect-db-row'), false);

  const markdown = formatSafeFixPlanMarkdown(plan);
  assert.match(markdown, /Dry-run only/);
  assert.match(markdown, /destination: \/tmp\/wiki\/_review\/weird-files\/-2\.md/);
  assert.match(markdown, /preconditions: source file exists; destination does not exist/);
  assert.match(markdown, /manual review required/);
});

test('buildSafeFixPlan skips status-only directory actions', () => {
  const inventory = {
    generatedAt: '2026-06-24T00:00:00.000Z',
    activeOutputDir: '/tmp/wiki',
    active: {
      weirdFilenames: [],
      weirdFileDetails: [],
    },
    deprecatedOutputDirs: [
      {
        path: '/tmp/old-wiki',
        fileCount: 3,
        cleanupAction: 'deprecated-output-marked',
        reason: 'legacy wiki output dir outside active output dir; deprecation marker present',
      },
      {
        path: '/tmp/runtime-wiki',
        fileCount: 3,
        cleanupAction: 'preserve-runtime-fallback',
        reason: 'runtime path outside active output dir; no-config fallback defaults still reference this path',
      },
    ],
    db: {
      emptySlugs: [],
      weirdSlugs: [],
      missingExportFiles: [],
      cleanupPlans: [],
    },
  };

  const plan = buildSafeFixPlan(inventory);
  assert.deepEqual(plan.actions, []);
});

test('applySafeFixPlan only quarantines covered weird files with matching content hash', () => {
  const root = makeTempHome();
  try {
    const source = path.join(root, '-2.md');
    const destination = path.join(root, '_review', 'weird-files', '-2.md');
    writeFile(source, page('Bad Slug') + 'review content line\n');
    const expectedContentHash = scanWikiDir(root).weirdFileDetails[0].contentHash;
    const inventory = {
      generatedAt: '2026-06-24T00:00:00.000Z',
      activeOutputDir: root,
      active: {
        weirdFilenames: ['-2.md'],
        weirdFileDetails: [
          {
            file: '-2.md',
            contentHash: expectedContentHash,
            coveredByDbReview: {
              canonical: 'good-page',
              sourceRow: 'wp_review',
              reviewFile: '_review/wiki-db/good-page-wp_review.md',
            },
          },
        ],
      },
      deprecatedOutputDirs: [],
    };
    const result = applySafeFixPlan(buildSafeFixPlan(inventory));
    assert.equal(result.applied, 1);
    assert.equal(result.skipped, 0);
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(destination), true);

    const second = applySafeFixPlan(buildSafeFixPlan(inventory));
    assert.equal(second.applied, 0);
    assert.equal(second.results[0].status, 'blocked');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('applySafeFixPlan blocks covered weird files when content hash changes', () => {
  const root = makeTempHome();
  try {
    const source = path.join(root, '-2.md');
    writeFile(source, page('Bad Slug') + 'changed content line\n');
    const plan = {
      actions: [
        {
          action: 'quarantine-covered-weird-file',
          target: source,
          destination: path.join(root, '_review', 'weird-files', '-2.md'),
          expectedContentHash: 'definitely-wrong',
        },
      ],
    };
    const result = applySafeFixPlan(plan);
    assert.equal(result.applied, 0);
    assert.equal(result.results[0].status, 'blocked');
    assert.equal(result.results[0].reason, 'source content hash mismatch');
    assert.equal(fs.existsSync(source), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reviewed DB cleanup plan appends differing source content before deleting duplicate row', () => {
  const root = makeTempHome();
  const db = makeWikiDb();
  try {
    db.exec(`
      CREATE TABLE content_chunks (
        id TEXT PRIMARY KEY,
        page_slug TEXT NOT NULL,
        chunk_text TEXT NOT NULL
      );
      CREATE TABLE wiki_page_doc_sources (
        page_slug TEXT NOT NULL,
        doc_source_id INTEGER NOT NULL,
        role TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content, primary_topic) VALUES (?, ?, ?, ?, ?)')
      .run('keep_1', 'canonical-page', 'Canonical Page', '# Canonical\n\nCurrent synthesis.', 'topic');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content, primary_topic) VALUES (?, ?, ?, ?, ?)')
      .run('dup_1', '-2', 'Canonical Page', '# Source\n\nUseful older summary.', 'topic');
    db.prepare('INSERT INTO content_chunks (id, page_slug, chunk_text) VALUES (?, ?, ?)').run('c_keep', 'canonical-page', 'stale canonical chunk');
    db.prepare('INSERT INTO content_chunks (id, page_slug, chunk_text) VALUES (?, ?, ?)').run('c_dup', '-2', 'duplicate chunk');
    db.prepare('INSERT INTO wiki_page_doc_sources (page_slug, doc_source_id, role) VALUES (?, ?, ?)').run('-2', 7, 'primary');

    const inventory = buildInventory({ db, activeOutputDir: root, candidates: [] });
    const reviewFiles = writeDbReviewBundle(inventory, db);
    assert.equal(reviewFiles.length, 1);

    const plan = buildReviewedDbCleanupPlan(inventory);
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.destructive, true);
    assert.equal(plan.confirmationRequired, true);
    assert.equal(plan.confirmationFlag, '--confirm-reviewed-db-cleanup');
    assert.match(plan.applyCommand, /--cleanup-db-duplicates --apply --confirm-reviewed-db-cleanup --json/);
    assert.equal(plan.backupDir, path.join(root, '_review', 'wiki-db', 'backups'));
    assert.equal(plan.actions[0].action, 'merge-and-delete-reviewed-duplicate-db-row');
    assert.equal(plan.actions[0].mode, 'requires-confirmation');
    assert.equal(plan.actions[0].destructive, true);
    assert.equal(plan.actions[0].confirmationRequired, true);
    assert.equal(plan.actions[0].confirmationFlag, '--confirm-reviewed-db-cleanup');
    assert.equal(plan.actions[0].applyCommand, plan.applyCommand);
    const markdown = formatReviewedDbCleanupPlan(plan);
    assert.match(markdown, /Destructive: yes/);
    assert.match(markdown, /Confirmation required: --confirm-reviewed-db-cleanup/);
    assert.match(markdown, /Backup dir: .*_review\/wiki-db\/backups/);
    assert.match(markdown, /Apply command: node scripts\/wiki-audit\.js --cleanup-db-duplicates --apply --confirm-reviewed-db-cleanup --json/);

    const unconfirmed = applyReviewedDbCleanupPlan(plan, db);
    assert.equal(unconfirmed.applied, 0);
    assert.equal(unconfirmed.backupPath, null);
    assert.equal(unconfirmed.results[0].status, 'blocked');
    assert.match(unconfirmed.results[0].reason, /explicit confirmation required/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wiki_pages WHERE id=?').get('dup_1').n, 1);

    const backupPath = path.join(root, '_review', 'wiki-db', 'backups', 'before-cleanup.db');
    const result = applyReviewedDbCleanupPlan(plan, db, { confirmed: true, backupPath });
    assert.equal(result.applied, 1);
    assert.equal(result.backupPath, backupPath);
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wiki_pages WHERE id=?').get('dup_1').n, 0);
    const canonical = db.prepare('SELECT content FROM wiki_pages WHERE slug=?').get('canonical-page');
    assert.match(canonical.content, /## Reviewed Duplicate Source/);
    assert.match(canonical.content, /source row: dup_1/);
    assert.match(canonical.content, /Useful older summary/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_chunks WHERE page_slug=?').get('-2').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_chunks WHERE page_slug=?').get('canonical-page').n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wiki_page_doc_sources WHERE page_slug=?').get('-2').n, 0);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(db._testDir, { recursive: true, force: true });
  }
});

test('reviewed DB cleanup blocks when review file does not match source hash', () => {
  const root = makeTempHome();
  const db = makeWikiDb();
  try {
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content, primary_topic) VALUES (?, ?, ?, ?, ?)')
      .run('keep_1', 'canonical-page', 'Canonical Page', '# Canonical', 'topic');
    db.prepare('INSERT INTO wiki_pages (id, slug, title, content, primary_topic) VALUES (?, ?, ?, ?, ?)')
      .run('dup_1', '-2', 'Canonical Page', '# Source', 'topic');
    const inventory = buildInventory({ db, activeOutputDir: root, candidates: [] });
    writeDbReviewBundle(inventory, db);
    const plan = buildReviewedDbCleanupPlan(inventory);
    const reviewPath = path.join(root, plan.actions[0].reviewFile);
    fs.writeFileSync(reviewPath, fs.readFileSync(reviewPath, 'utf8').replace(plan.actions[0].expectedContentHash, 'bad-hash'), 'utf8');

    const result = applyReviewedDbCleanupPlan(plan, db, { confirmed: true });
    assert.equal(result.applied, 0);
    assert.equal(result.results[0].status, 'blocked');
    assert.match(result.results[0].reason, /review file/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wiki_pages WHERE id=?').get('dup_1').n, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(db._testDir, { recursive: true, force: true });
  }
});

test('internal helpers keep home expansion and weird basename checks explicit', () => {
  assert.equal(_internal.expandHome('~/x', '/home/test'), path.resolve('/home/test/x'));
  assert.equal(_internal.isWeirdBasename('-2'), true);
  assert.equal(_internal.isWeirdBasename('metame'), false);
});
