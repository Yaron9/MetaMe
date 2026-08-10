'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { exportManagedWikiPage } = require('./wiki-reflect-export');

function fixture() {
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  db.prepare(`
    INSERT INTO wiki_pages (id,slug,title,content,primary_topic,source_type)
    VALUES ('wp-1','page','Page','v1','page','memory')
  `).run();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-projection-'));
  const page = {
    slug: 'page', title: 'Page', topic_tags: '[]', created_at: '2026-01-01',
    last_built_at: '2026-01-01', raw_source_count: 1, staleness: 0, source_type: 'memory',
  };
  return { db, dir, page };
}

function clean(f) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test('managed export establishes Base and preserves sidecar notes', () => {
  const f = fixture();
  const first = exportManagedWikiPage(f.db, 'page', f.page, 'v1', f.dir);
  assert.equal(first.written, true);
  const pagePath = path.join(f.dir, 'topics', 'page.md');
  const sidecar = `${pagePath}.notes.md`;
  fs.writeFileSync(sidecar, 'keep this note\n');
  const second = exportManagedWikiPage(f.db, 'page', f.page, 'v2', f.dir);
  assert.equal(second.classification, 'drift');
  assert.equal(fs.readFileSync(sidecar, 'utf8'), 'keep this note\n');
  assert.match(fs.readFileSync(pagePath, 'utf8'), /v2/);
  assert.ok(f.db.prepare("SELECT projection_hash FROM wiki_pages WHERE slug='page'").get().projection_hash);
  clean(f);
});

test('managed export preserves user-only and concurrent edits', () => {
  const f = fixture();
  exportManagedWikiPage(f.db, 'page', f.page, 'v1', f.dir);
  const pagePath = path.join(f.dir, 'topics', 'page.md');
  fs.appendFileSync(pagePath, '\nuser edit\n');
  const before = fs.readFileSync(pagePath, 'utf8');
  const userOnly = exportManagedWikiPage(f.db, 'page', f.page, 'v1', f.dir);
  assert.equal(userOnly.classification, 'modified');
  assert.equal(fs.readFileSync(pagePath, 'utf8'), before);
  const conflict = exportManagedWikiPage(f.db, 'page', f.page, 'v2', f.dir);
  assert.equal(conflict.classification, 'conflict');
  assert.equal(fs.readFileSync(pagePath, 'utf8'), before);
  clean(f);
});

test('managed export does not overwrite a legacy file without Base', () => {
  const f = fixture();
  const pagePath = path.join(f.dir, 'topics', 'page.md');
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(pagePath, 'legacy human page\n');
  const result = exportManagedWikiPage(f.db, 'page', f.page, 'canonical', f.dir);
  assert.equal(result.classification, 'untracked');
  assert.equal(result.written, false);
  assert.equal(fs.readFileSync(pagePath, 'utf8'), 'legacy human page\n');
  clean(f);
});
