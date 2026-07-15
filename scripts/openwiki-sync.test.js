'use strict';

require('./test-support/env-setup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { _internal } = require('./openwiki-sync');

const tempDirs = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-openwiki-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('OpenWiki sync projection', () => {
  it('derives an explicit allowlist of enabled connector targets', () => {
    const base = tempDir();
    const configPath = path.join(base, 'daemon.yaml');
    fs.writeFileSync(configPath, `
daemon:
  wiki_output_dir: ${base}/wiki
wiki:
  external:
    openwiki:
      connectors:
        git:
          - id: metame
            path: ${base}/repo
        web:
          - id: disabled
            enabled: false
`);
    const config = _internal.loadOpenWikiConfig(configPath);
    assert.deepEqual(config.connectorTargets, ['git-repo']);
  });

  it('passes only explicit provider credentials to OpenWiki', () => {
    assert.deepEqual(_internal.selectProviderEnvironment({
      OPENAI_API_KEY: 'openai-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      PATH: '/unsafe',
      RANDOM_SECRET: 'must-not-pass',
    }), {
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
    });
  });

  it('uses sandbox-exec only on macOS and fails explicitly elsewhere', () => {
    assert.equal(_internal.shouldUseSandbox('disabled', 'linux'), false);
    assert.equal(_internal.shouldUseSandbox('required', 'darwin', () => true), true);
    assert.throws(() => _internal.shouldUseSandbox('required', 'linux'), /unsupported on linux/);
    assert.throws(() => _internal.shouldUseSandbox('required', 'darwin', () => false), /unavailable/);
  });

  it('indexes recursively, skips unchanged content and deletes after two clean misses', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'sources'));
    fs.writeFileSync(path.join(root, 'quickstart.md'), '# Quickstart\n\nMetaMe overview.');
    fs.writeFileSync(path.join(root, 'sources', 'git.md'), '# Git source\n\nCommit evidence.');
    const pages = _internal.preparePages(root, ['metame']);
    const db = new DatabaseSync(':memory:');

    const first = _internal.applyProjection(db, pages, 'run-1');
    assert.deepEqual(first, { scanned: 2, changed: 2, unchanged: 0, missing: 0, deleted: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE source_type='openwiki'").get().n, 2);
    const queueBefore = db.prepare('SELECT COUNT(*) AS n FROM embedding_queue').get().n;

    const second = _internal.applyProjection(db, pages, 'run-2');
    assert.deepEqual(second, { scanned: 2, changed: 0, unchanged: 2, missing: 0, deleted: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM embedding_queue').get().n, queueBefore);

    fs.unlinkSync(path.join(root, 'sources', 'git.md'));
    const remaining = _internal.preparePages(root, ['metame']);
    const missOnce = _internal.applyProjection(db, remaining, 'run-3');
    assert.equal(missOnce.missing, 1);
    assert.equal(missOnce.deleted, 0);
    assert.equal(db.prepare("SELECT missing_count FROM wiki_external_sources WHERE relative_path='sources/git.md'").get().missing_count, 1);

    const missTwice = _internal.applyProjection(db, remaining, 'run-4');
    assert.equal(missTwice.deleted, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wiki_pages WHERE slug='external/openwiki/sources/git'").get().n, 0);
    db.close();
  });

  it('rolls back the whole projection when two files collapse to one slug', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'A B.md'), '# One\nbody');
    fs.writeFileSync(path.join(root, 'A-B.md'), '# Two\nbody');
    assert.throws(() => _internal.preparePages(root, ['metame']), /slug collision/);
  });

  it('rejects symlinks inside generated output', () => {
    const root = tempDir();
    const outside = path.join(tempDir(), 'outside.md');
    fs.writeFileSync(outside, '# Outside\nsecret');
    fs.symlinkSync(outside, path.join(root, 'linked.md'));
    assert.throws(() => _internal.listMarkdownFiles(root), /contains symlink/);
  });

  it('removes OpenWiki transient plan without hiding unexpected artifacts', () => {
    const root = tempDir();
    const plan = path.join(root, '_plan.md');
    fs.writeFileSync(plan, '');
    assert.equal(_internal.removeInternalArtifacts(root), 1);
    assert.equal(fs.existsSync(plan), false);
    assert.equal(_internal.removeInternalArtifacts(root), 0);
  });

  it('adds stable external frontmatter without changing projected content', () => {
    const root = tempDir();
    const page = path.join(root, 'topic.md');
    fs.writeFileSync(page, '# Topic\n\nEvidence.');
    assert.equal(_internal.ensureExternalFrontmatter(root, ['metame'], '2026-07-15T00:00:00.000Z'), 1);
    const once = fs.readFileSync(page, 'utf8');
    assert.match(once, /^---\ntitle: Topic\nsource: openwiki\nsource_type: external\n/);
    assert.equal(_internal.ensureExternalFrontmatter(root, ['metame']), 0);
    assert.equal(fs.readFileSync(page, 'utf8'), once);
    assert.equal(_internal.preparePages(root, ['metame'])[0].content, '# Topic\n\nEvidence.');
  });

  it('moves last-good recovery state outside the visible wiki tree', () => {
    const root = tempDir();
    const output = path.join(root, 'external', 'openwiki');
    const backup = path.join(root, 'external', '.openwiki-last-good');
    const lastGood = path.join(root, 'runtime', 'openwiki-last-good');
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(output, 'page.md'), '# Current');
    fs.writeFileSync(path.join(backup, 'page.md'), '# Previous');
    assert.equal(_internal.finalizePublish(output, backup, lastGood), lastGood);
    assert.equal(fs.existsSync(backup), false);
    assert.equal(fs.readFileSync(path.join(lastGood, 'page.md'), 'utf8'), '# Current');
  });

  it('builds a sandbox that denies the home directory and permits only declared roots', () => {
    const profile = _internal.buildSandboxProfile({
      openwikiHome: '/Users/test/.openwiki',
      outputRoot: '/Users/test/Vault/wiki/external/openwiki',
      binary: '/Users/test/.metame/tools/openwiki/node_modules/.bin/openwiki',
      repoPaths: ['/Users/test/project'],
      developerDir: '/Applications/Xcode.app/Contents/Developer',
    });
    assert.match(profile, /deny file-read\* \(subpath "\/Users\/test"\)/);
    assert.match(profile, /allow file-read-metadata .*literal "\/Users\/test"/);
    assert.match(profile, /subpath "\/Users\/test\/project"/);
    assert.match(profile, /subpath "\/Users\/test\/\.metame\/tools\/openwiki\/node_modules"/);
    assert.match(profile, /subpath "\/Applications\/Xcode\.app\/Contents"/);
    assert.match(profile, /deny file-write\*/);
    assert.match(profile, /allow network-outbound/);
  });

  it('garbage-collects old raw runs while protecting the newest evidence', () => {
    const home = tempDir();
    const raw = path.join(home, 'connectors', 'git-repo', 'raw');
    fs.mkdirSync(raw, { recursive: true });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const run = path.join(raw, `run-${i}`);
      fs.mkdirSync(run);
      fs.writeFileSync(path.join(run, 'manifest.json'), 'x'.repeat(10));
      const time = new Date(now - i * 40 * 86400000);
      fs.utimesSync(run, time, time);
    }
    const result = _internal.gcRawConnectorData(home, {
      raw_days: 90,
      successful_runs: 2,
      raw_max_gb: 2,
    }, now);
    assert.equal(result.removed, 2);
    assert.ok(fs.existsSync(path.join(raw, 'run-0')));
    assert.ok(fs.existsSync(path.join(raw, 'run-1')));
    assert.ok(!fs.existsSync(path.join(raw, 'run-4')));
  });

  it('rebinds a renamed path that preserves the same slug', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'Foo Bar.md'), '# Topic\nbody');
    const db = new DatabaseSync(':memory:');
    _internal.applyProjection(db, _internal.preparePages(root, ['metame']), 'run-1');
    fs.renameSync(path.join(root, 'Foo Bar.md'), path.join(root, 'foo-bar.md'));
    const result = _internal.applyProjection(db, _internal.preparePages(root, ['metame']), 'run-2');
    assert.equal(result.changed, 1);
    assert.equal(result.missing, 0);
    const rows = db.prepare('SELECT source_key,page_slug FROM wiki_external_sources').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_key, 'openwiki:foo-bar.md');
    assert.equal(rows[0].page_slug, 'external/openwiki/foo-bar');
    db.close();
  });

  it('keeps dry-run schema migration read-only', () => {
    const dbPath = path.join(tempDir(), 'old.db');
    let db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE legacy (id INTEGER)');
    db.close();
    db = _internal.openProjectionDatabase({ dbPath, readOnly: true });
    assert.throws(() => _internal.applyProjection(db, [], 'dry', { dryRun: true }), /no such table/);
    db.close();
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(verify.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='wiki_external_sources'").get().n, 0);
    verify.close();
  });

  it('configures WAL and a busy timeout for projection writers', () => {
    const dbPath = path.join(tempDir(), 'projection.db');
    const db = _internal.openProjectionDatabase({ dbPath });
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.close();
  });

  it('rolls files back when the projection database cannot open', () => {
    const base = tempDir();
    const output = path.join(base, 'external', 'openwiki');
    const backup = path.join(base, 'external', '.openwiki-last-good');
    const link = path.join(base, 'runtime', 'wiki');
    fs.mkdirSync(output, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(output, 'page.md'), '# New');
    fs.writeFileSync(path.join(backup, 'page.md'), '# Old');
    assert.throws(() => _internal.projectPublishedOutput({
      pages: [], runId: 'run', outputRoot: output, backup, linkPath: link,
      openDatabase: () => { throw new Error('database unavailable'); },
    }), /database unavailable/);
    assert.equal(fs.readFileSync(path.join(output, 'page.md'), 'utf8'), '# Old');
  });

  it('restores an unpublished state when the first projection database cannot open', () => {
    const base = tempDir();
    const output = path.join(base, 'external', 'openwiki');
    const backup = path.join(base, 'external', '.openwiki-last-good');
    const link = path.join(base, 'runtime', 'wiki');
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'page.md'), '# New');
    assert.throws(() => _internal.projectPublishedOutput({
      pages: [], runId: 'run', outputRoot: output, backup, linkPath: link,
      openDatabase: () => { throw new Error('database unavailable'); },
    }), /database unavailable/);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(link), false);
  });

  it('does not throw or roll back for post-commit housekeeping failures', () => {
    const completed = _internal.runPostCommitHousekeeping({ changed: 1 }, {
      gc: () => { throw new Error('gc failed'); },
      finalize: () => { throw new Error('finalize failed'); },
      log: () => { throw new Error('log failed'); },
    });
    assert.equal(completed.changed, 1);
    assert.deepEqual(completed.gc, { status: 'degraded', error: 'gc failed' });
    assert.deepEqual(completed.recovery, { status: 'degraded', error: 'finalize failed' });
    assert.deepEqual(completed.logging, { status: 'degraded', error: 'log failed' });
  });
});
