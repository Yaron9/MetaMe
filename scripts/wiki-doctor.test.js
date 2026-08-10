'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { exportManagedWikiPage } = require('./wiki-reflect-export');
const { _internal } = require('./wiki-doctor');

const tempFiles = [];
afterEach(() => {
  while (tempFiles.length) try { fs.rmSync(tempFiles.pop(), { recursive: true, force: true }); } catch { }
});

describe('wiki doctor reporting', () => {
  it('keeps the most severe status and renders Unix-friendly lines', () => {
    const report = { status: 'ok', checks: [] };
    _internal.addCheck(report, 'a', 'degraded', 'slow');
    _internal.addCheck(report, 'b', 'ok', 'fine');
    _internal.addCheck(report, 'c', 'error', 'broken');
    _internal.addCheck(report, 'd', 'degraded', 'still degraded');
    assert.equal(report.status, 'error');
    assert.match(_internal.renderHuman(report), /✗ c: broken/);
  });

  it('reads the latest valid JSONL entry and ignores a truncated tail', () => {
    const file = path.join(os.tmpdir(), `wiki-doctor-${process.pid}-${Date.now()}.jsonl`);
    tempFiles.push(file);
    fs.writeFileSync(file, '{"ts":"first"}\nnot-json\n{"ts":"latest"}\ntruncated');
    assert.equal(_internal.lastJsonLine(file).ts, 'latest');
  });

  it('diagnoses a pre-migration database instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-doctor-old-'));
    tempFiles.push(dir);
    const dbPath = path.join(dir, 'memory.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE wiki_pages (slug TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE memory_items (id TEXT PRIMARY KEY);
      CREATE TABLE content_chunks (id TEXT PRIMARY KEY);
      CREATE TABLE embedding_queue (id TEXT PRIMARY KEY);
    `);
    db.close();
    const report = { status: 'ok', checks: [], metrics: {} };
    _internal.inspectDatabase(report, { enabled: true, outputRoot: path.join(dir, 'wiki'), recall_mode: 'shadow' }, { dbPath });
    assert.equal(report.metrics.openwiki_pages, 0);
    assert.equal(report.checks.find(check => check.name === 'openwiki-schema').level, 'degraded');
  });

  it('checks managed memory projections but ignores OpenWiki and artifact rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-doctor-projections-'));
    tempFiles.push(dir);
    const db = new DatabaseSync(':memory:');
    applyWikiSchema(db);
    db.prepare(`
      INSERT INTO wiki_pages (id, slug, title, content, primary_topic, source_type)
      VALUES
        ('memory-1', 'managed', 'Managed', 'canonical', 'managed', 'memory'),
        ('openwiki-1', 'external/openwiki/page', 'OpenWiki', 'external', 'external', 'openwiki'),
        ('artifact-1', 'artifact/playbook/a1', 'Artifact', 'artifact', 'artifact', 'knowledge_artifact')
    `).run();
    const page = db.prepare("SELECT * FROM wiki_pages WHERE slug='managed'").get();
    const frontmatter = {
      title: page.title, slug: page.slug, tags: [],
      created: String(page.created_at || '').slice(0, 10),
      last_built: String(page.last_built_at || '').slice(0, 10),
      raw_sources: page.raw_source_count || 0, staleness: page.staleness || 0, source_type: 'memory',
    };
    exportManagedWikiPage(db, 'managed', frontmatter, 'canonical', dir);

    const healthy = { status: 'ok', checks: [], metrics: {} };
    _internal.inspectWikiProjections(healthy, db, dir);
    assert.equal(healthy.status, 'ok');
    assert.equal(healthy.metrics.wiki_projection.tracked, 1);
    assert.equal(healthy.metrics.wiki_projection.untracked, 0);
    assert.equal(healthy.metrics.wiki_projection.details.some(item => item.slug.includes('external')), false);
    assert.equal(healthy.metrics.wiki_projection.details.some(item => item.slug.includes('artifact')), false);

    fs.appendFileSync(path.join(dir, 'topics', 'managed.md'), '\nuser edit\n');
    const degraded = { status: 'ok', checks: [], metrics: {} };
    _internal.inspectWikiProjections(degraded, db, dir);
    assert.equal(degraded.status, 'degraded');
    assert.equal(degraded.metrics.wiki_projection.modified, 1);
    db.close();
  });

  it('marks parse_failed reflection records as unhealthy', () => {
    const file = path.join(os.tmpdir(), `wiki-doctor-reflect-${process.pid}-${Date.now()}.jsonl`);
    tempFiles.push(file);
    fs.writeFileSync(file, JSON.stringify({ status: 'error', reason: 'parse_failed' }) + '\n');
    const report = { status: 'ok', checks: [] };
    _internal.inspectReflection(report, file);
    assert.equal(report.checks[0].level, 'degraded');
    assert.match(report.checks[0].message, /failed/);
  });

  it('reports generated broken links as errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-doctor-links-'));
    tempFiles.push(dir);
    fs.mkdirSync(path.join(dir, 'sessions'));
    fs.writeFileSync(path.join(dir, 'sessions', 'broken.md'), 'Summary\n\n## Related Knowledge\n\n- Capsule: [[capsules/missing]]\n');
    const report = { status: 'ok', checks: [], metrics: {} };
    _internal.inspectWikiLinks(report, dir);
    assert.equal(report.status, 'error');
    assert.equal(report.metrics.wiki_hard_broken_links, 1);
  });

  it('reports stale workspace file references as errors', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-doctor-workspace-'));
    tempFiles.push(dir);
    fs.mkdirSync(path.join(dir, '.obsidian'));
    fs.writeFileSync(path.join(dir, '.obsidian', 'workspace.json'), JSON.stringify({
      main: { type: 'leaf', state: { type: 'markdown', state: { file: 'missing.md' } } },
    }));
    const report = { status: 'ok', checks: [], metrics: {} };
    _internal.inspectWikiLinks(report, dir);
    assert.equal(report.status, 'error');
    assert.equal(report.metrics.workspace_missing_refs, 1);
  });
});
