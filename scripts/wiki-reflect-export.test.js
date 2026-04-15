'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  exportWikiPage,
  rebuildIndex,
  exportSessionSummary,
  rebuildSessionsIndex,
  exportCapsuleFile,
  rebuildCapsulesIndex,
  exportReflectDir,
  rebuildReflectDirIndex,
  exportDocPages,          // add this
} = require('./wiki-reflect-export');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-export-test-'));
}

const SAMPLE_FRONTMATTER = {
  title: 'Session Management',
  slug: 'session-management',
  tags: ['session', 'resume'],
  created: '2026-04-08',
  last_built: '2026-04-08',
  raw_sources: 12,
  staleness: 0.0,
};

test('exportWikiPage creates a .md file in outputDir', () => {
  const dir = makeTmpDir();
  try {
    exportWikiPage('session-management', SAMPLE_FRONTMATTER, 'Body content here.', dir);
    const filePath = path.join(dir, 'session-management.md');
    assert.ok(fs.existsSync(filePath), 'file should be created');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportWikiPage file contains frontmatter and body', () => {
  const dir = makeTmpDir();
  try {
    exportWikiPage('session-management', SAMPLE_FRONTMATTER, 'Body text.', dir);
    const content = fs.readFileSync(path.join(dir, 'session-management.md'), 'utf8');
    assert.ok(content.includes('title: Session Management'), 'should include title in frontmatter');
    assert.ok(content.includes('slug: session-management'), 'should include slug');
    assert.ok(content.includes('raw_sources: 12'), 'should include raw_sources');
    assert.ok(content.includes('staleness: 0.00'), 'should include staleness');
    assert.ok(content.includes('Body text.'), 'should include body');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportWikiPage is atomic — no .tmp file remains after success', () => {
  const dir = makeTmpDir();
  try {
    exportWikiPage('my-page', SAMPLE_FRONTMATTER, 'Content.', dir);
    const tmpPath = path.join(dir, 'my-page.md.tmp');
    assert.ok(!fs.existsSync(tmpPath), '.tmp file should be cleaned up after success');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportWikiPage removes stale .tmp before writing', () => {
  const dir = makeTmpDir();
  try {
    // Simulate a stale .tmp from a previous interrupted write
    const tmpPath = path.join(dir, 'stale-page.md.tmp');
    fs.writeFileSync(tmpPath, 'stale content');
    assert.ok(fs.existsSync(tmpPath), 'stale .tmp should exist before export');

    exportWikiPage('stale-page', SAMPLE_FRONTMATTER, 'Fresh content.', dir);

    const finalPath = path.join(dir, 'stale-page.md');
    assert.ok(fs.existsSync(finalPath), 'final file should be created');
    assert.ok(!fs.existsSync(tmpPath), 'stale .tmp should be removed');
    const content = fs.readFileSync(finalPath, 'utf8');
    assert.ok(content.includes('Fresh content.'), 'final file should have new content');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportWikiPage creates outputDir if it does not exist', () => {
  const base = makeTmpDir();
  const newDir = path.join(base, 'nested', 'wiki');
  try {
    exportWikiPage('test-page', SAMPLE_FRONTMATTER, 'Content.', newDir);
    assert.ok(fs.existsSync(path.join(newDir, 'test-page.md')), 'should create nested dirs');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('rebuildIndex creates _index.md with table of pages', () => {
  const dir = makeTmpDir();
  const pages = [
    { slug: 'session-management', title: 'Session Management', primary_topic: 'session',
      staleness: 0.1, last_built_at: '2026-04-08T00:00:00', raw_source_count: 10 },
    { slug: 'model-switching', title: 'Model Switching', primary_topic: 'model',
      staleness: 0.45, last_built_at: null, raw_source_count: 5 },
  ];

  try {
    rebuildIndex(pages, dir);
    const indexPath = path.join(dir, '_index.md');
    assert.ok(fs.existsSync(indexPath), '_index.md should be created');
    const content = fs.readFileSync(indexPath, 'utf8');
    assert.ok(content.includes('Session Management'), 'should contain page title');
    assert.ok(content.includes('session-management'), 'should contain slug');
    assert.ok(content.includes('2 pages'), 'should show page count');
    assert.ok(content.includes('45%'), 'should show staleness percentage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildIndex handles empty pages array', () => {
  const dir = makeTmpDir();
  try {
    rebuildIndex([], dir);
    const content = fs.readFileSync(path.join(dir, '_index.md'), 'utf8');
    assert.ok(content.includes('0 pages'), 'should handle empty list');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildIndex is atomic — no .tmp file remains', () => {
  const dir = makeTmpDir();
  try {
    rebuildIndex([], dir);
    const tmpPath = path.join(dir, '_index.md.tmp');
    assert.ok(!fs.existsSync(tmpPath), 'no .tmp should remain after rebuild');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildIndex adds session summaries navigation', () => {
  const dir = makeTmpDir();
  try {
    rebuildIndex([], dir, { sessionCount: 75 });
    const content = fs.readFileSync(path.join(dir, '_index.md'), 'utf8');
    assert.ok(content.includes('[[sessions/_index|Session Summaries]] (75)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildIndex adds capsules navigation', () => {
  const dir = makeTmpDir();
  try {
    rebuildIndex([], dir, { capsuleCount: 2 });
    const content = fs.readFileSync(path.join(dir, '_index.md'), 'utf8');
    assert.ok(content.includes('[[capsules/_index|Knowledge Capsules]] (2)'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportSessionSummary writes session markdown under sessions/', () => {
  const dir = makeTmpDir();
  try {
    const filePath = exportSessionSummary({
      id: 'mi_ses_123',
      session_id: 'session-12345678',
      project: 'MetaMe',
      scope: null,
      title: 'MetaMe summary',
      content: 'This session fixed resume routing.',
      tags: JSON.stringify(['resume', 'routing']),
      created_at: '2026-04-09 12:00:00',
    }, dir, {
      wikiPages: [{ slug: 'daemon', title: 'Daemon', primary_topic: 'daemon' }],
      capsuleFiles: ['/tmp/metame-daemon-playbook.md'],
    });
    assert.ok(fs.existsSync(filePath), 'session summary file should exist');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('type: session-summary'));
    assert.ok(content.includes('## Summary'));
    assert.ok(content.includes('This session fixed resume routing.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportSessionSummary includes related knowledge links when tags match', () => {
  const dir = makeTmpDir();
  try {
    const filePath = exportSessionSummary({
      session_id: 'session-12345678',
      project: 'MetaMe',
      title: 'MetaMe summary',
      content: 'This session touched daemon resume routing.',
      tags: JSON.stringify(['daemon']),
      created_at: '2026-04-09 12:00:00',
    }, dir, {
      wikiPages: [{ slug: 'daemon', title: 'Daemon', primary_topic: 'daemon' }],
      capsuleFiles: ['/tmp/metame-daemon-playbook.md'],
    });
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('## Related Knowledge'));
    assert.ok(content.includes('[[daemon|Daemon]]'));
    assert.ok(content.includes('[[capsules/metame-daemon-playbook|metame-daemon-playbook]]'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuildSessionsIndex creates sessions/_index.md', () => {
  const dir = makeTmpDir();
  try {
    rebuildSessionsIndex([{
      id: 'mi_ses_1',
      session_id: 'session-abcdef12',
      project: 'MetaMe',
      content: 'A compact summary of the session.',
      created_at: '2026-04-09 12:00:00',
    }], dir);
    const indexPath = path.join(dir, 'sessions', '_index.md');
    assert.ok(fs.existsSync(indexPath), 'session index should exist');
    const content = fs.readFileSync(indexPath, 'utf8');
    assert.ok(content.includes('Session Summaries'));
    assert.ok(content.includes('MetaMe'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exportCapsuleFile copies markdown under capsules/', () => {
  const dir = makeTmpDir();
  const sourceDir = makeTmpDir();
  try {
    const sourcePath = path.join(sourceDir, 'metame-daemon-playbook.md');
    fs.writeFileSync(sourcePath, '# Capsule\n\nUseful content.\n', 'utf8');
    const targetPath = exportCapsuleFile(sourcePath, dir);
    assert.ok(targetPath, 'should return target path');
    assert.ok(fs.existsSync(targetPath), 'capsule file should exist');
    const content = fs.readFileSync(targetPath, 'utf8');
    assert.ok(content.includes('Useful content.'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('rebuildCapsulesIndex creates capsules/_index.md', () => {
  const dir = makeTmpDir();
  try {
    rebuildCapsulesIndex([
      '/tmp/metame-daemon-playbook.md',
      '/tmp/nightly-reflect-playbook.md',
    ], dir);
    const indexPath = path.join(dir, 'capsules', '_index.md');
    assert.ok(fs.existsSync(indexPath), 'capsule index should exist');
    const content = fs.readFileSync(indexPath, 'utf8');
    assert.ok(content.includes('Knowledge Capsules'));
    assert.ok(content.includes('[[capsules/metame-daemon-playbook|metame-daemon-playbook]]'));
    assert.ok(content.includes('2 capsules'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── exportReflectDir ────────────────────────────────────────────
test('exportReflectDir copies .md files to outputDir/subdir', (_t) => {
  const tmp = makeTmpDir();
  const srcDir = path.join(tmp, 'decisions');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, '2026-04-11-nightly-reflect.md'), '# test\ncontent', 'utf8');

  const outDir = path.join(tmp, 'vault');
  exportReflectDir(srcDir, 'decisions', outDir);

  const dest = path.join(outDir, 'decisions', '2026-04-11-nightly-reflect.md');
  assert.ok(fs.existsSync(dest), 'file copied to vault/decisions/');
  assert.ok(fs.readFileSync(dest, 'utf8').includes('content'));
  fs.rmSync(tmp, { recursive: true });
});

test('exportReflectDir skips non-.md files', (_t) => {
  const tmp = makeTmpDir();
  const srcDir = path.join(tmp, 'lessons');
  fs.mkdirSync(srcDir);
  fs.writeFileSync(path.join(srcDir, 'data.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(srcDir, 'lesson.md'), '# ok', 'utf8');

  const outDir = path.join(tmp, 'vault');
  exportReflectDir(srcDir, 'lessons', outDir);

  const destDir = path.join(outDir, 'lessons');
  const files = fs.readdirSync(destDir);
  assert.deepStrictEqual(files, ['lesson.md']);
  fs.rmSync(tmp, { recursive: true });
});

test('exportReflectDir returns empty array when srcDir missing', (_t) => {
  const tmp = makeTmpDir();
  const result = exportReflectDir(path.join(tmp, 'nonexistent'), 'decisions', tmp);
  assert.deepStrictEqual(result, []);
  fs.rmSync(tmp, { recursive: true });
});

test('exportReflectDir returns empty array when srcDir is a file not a dir', (_t) => {
  const tmp = makeTmpDir();
  const notADir = path.join(tmp, 'file.md');
  fs.writeFileSync(notADir, '# hello', 'utf8');
  const result = exportReflectDir(notADir, 'decisions', tmp);
  assert.deepStrictEqual(result, []);
  fs.rmSync(tmp, { recursive: true });
});

test('rebuildReflectDirIndex writes _index.md with entries', (_t) => {
  const tmp = makeTmpDir();
  const outDir = path.join(tmp, 'vault');
  const files = ['2026-04-11-nightly-reflect.md', '2026-04-12-nightly-reflect.md'];

  rebuildReflectDirIndex(files, 'decisions', outDir);

  const idx = path.join(outDir, 'decisions', '_index.md');
  assert.ok(fs.existsSync(idx));
  const content = fs.readFileSync(idx, 'utf8');
  assert.ok(content.includes('2026-04-11'));
  assert.ok(content.includes('Architecture Decisions'));
  fs.rmSync(tmp, { recursive: true });
});

test('rebuildReflectDirIndex uses "Operational Lessons" label for lessons subdir', (_t) => {
  const tmp = makeTmpDir();
  rebuildReflectDirIndex(['2026-04-11-nightly-reflect.md'], 'lessons', tmp);
  const content = fs.readFileSync(path.join(tmp, 'lessons', '_index.md'), 'utf8');
  assert.ok(content.includes('Operational Lessons'));
  fs.rmSync(tmp, { recursive: true });
});

// ── exportDocPages ────────────────────────────────────────────
test('exportDocPages exports doc and cluster pages, skips memory pages', (_t) => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wiki_pages (
      slug TEXT PRIMARY KEY,
      title TEXT,
      primary_topic TEXT,
      source_type TEXT,
      content TEXT,
      topic_tags TEXT,
      created_at TEXT,
      last_built_at TEXT,
      raw_source_count INTEGER DEFAULT 0,
      staleness REAL DEFAULT 0
    )
  `);
  db.prepare('INSERT INTO wiki_pages VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'doc-test', 'Doc Test', 'doc-test', 'doc',
    '## Content\nHello.', '[]', '2026-04-15', '2026-04-15', 3, 0.0
  );
  db.prepare('INSERT INTO wiki_pages VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'cluster-test', 'Cluster Test', 'cluster-test', 'topic_cluster',
    '## Cluster\nSynthesis.', '[]', '2026-04-15', '2026-04-15', 5, 0.0
  );
  // memory page — must NOT be exported
  db.prepare('INSERT INTO wiki_pages VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'mem-topic', 'Memory Topic', 'mem-topic', 'memory',
    '## Memory.', '[]', '2026-04-15', '2026-04-15', 2, 0.0
  );

  const tmp = makeTmpDir();
  const { exported, skipped } = exportDocPages(db, tmp);

  assert.ok(fs.existsSync(path.join(tmp, 'doc-test.md')), 'doc page exported');
  assert.ok(fs.existsSync(path.join(tmp, 'cluster-test.md')), 'cluster page exported');
  assert.ok(!fs.existsSync(path.join(tmp, 'mem-topic.md')), 'memory page not exported');
  assert.strictEqual(exported.length, 2);
  assert.strictEqual(skipped.length, 0);

  const content = fs.readFileSync(path.join(tmp, 'doc-test.md'), 'utf8');
  assert.ok(content.includes('slug: doc-test'), 'has slug frontmatter');
  assert.ok(content.includes('## Content'), 'has body content');

  db.close();
  fs.rmSync(tmp, { recursive: true });
});

test('exportDocPages skips pages with empty content', (_t) => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wiki_pages (
      slug TEXT PRIMARY KEY, title TEXT, primary_topic TEXT, source_type TEXT,
      content TEXT, topic_tags TEXT, created_at TEXT, last_built_at TEXT,
      raw_source_count INTEGER DEFAULT 0, staleness REAL DEFAULT 0
    )
  `);
  db.prepare('INSERT INTO wiki_pages VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    'empty-doc', 'Empty', 'empty-doc', 'doc',
    '', '[]', '2026-04-15', '2026-04-15', 0, 0.0
  );

  const tmp = makeTmpDir();
  const { exported } = exportDocPages(db, tmp);
  assert.strictEqual(exported.length, 0);
  db.close();
  fs.rmSync(tmp, { recursive: true });
});
