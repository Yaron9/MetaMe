'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportWikiPage, rebuildIndex } = require('./wiki-reflect-export');

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
