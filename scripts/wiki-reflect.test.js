'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { upsertWikiTopic, getWikiPageBySlug } = require('./core/wiki-db');
const { runWikiReflect } = require('./wiki-reflect');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id        TEXT PRIMARY KEY,
      kind      TEXT NOT NULL DEFAULT 'insight',
      state     TEXT NOT NULL DEFAULT 'active',
      title     TEXT,
      content   TEXT NOT NULL DEFAULT '',
      confidence REAL DEFAULT 0.5,
      search_count INTEGER DEFAULT 0,
      relation  TEXT,
      tags      TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  return db;
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-reflect-test-'));
}

function makeProviders({ response = 'Wiki content.', shouldFail = false } = {}) {
  return {
    callHaiku: async () => {
      if (shouldFail) throw new Error('LLM error');
      return response;
    },
    buildDistillEnv: () => ({}),
  };
}

function seedFact(db, tag, id = `f_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
  db.prepare(`
    INSERT OR IGNORE INTO memory_items (id, state, content, tags)
    VALUES (?, 'active', 'fact content', ?)
  `).run(id, JSON.stringify([tag]));
}

async function runReflect(db, { dir, providers, logPath, threshold = 0.4 } = {}) {
  const tmpDir = dir || makeTmpDir();
  const tmpLog = logPath || path.join(tmpDir, 'log.jsonl');
  return runWikiReflect(db, {
    outputDir: tmpDir,
    capsulesDir: path.join(tmpDir, 'capsules'),
    logPath: tmpLog,
    providers: providers || makeProviders(),
    threshold,
  });
}

test('runWikiReflect returns empty results when no topics registered', async () => {
  const db = buildTestDb();
  const result = await runReflect(db);
  assert.deepEqual(result.built, []);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.exportFailed, []);
  db.close();
});

test('runWikiReflect builds a stale page (staleness=1.0 for new topic)', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();

  try {
    upsertWikiTopic(db, 'session', { label: 'Session', force: true });
    seedFact(db, 'session');

    const result = await runReflect(db, { dir });
    assert.ok(result.built.includes('session'), 'session should be built');

    const page = getWikiPageBySlug(db, 'session');
    assert.ok(page, 'wiki page should exist in DB');
    assert.equal(page.staleness, 0.0, 'staleness should be 0 after build');

    const mdFile = path.join(dir, 'session.md');
    assert.ok(fs.existsSync(mdFile), 'markdown file should be written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect skips pages below staleness threshold', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();

  try {
    upsertWikiTopic(db, 'model', { force: true });
    seedFact(db, 'model');

    // Pre-insert page with low staleness
    db.prepare(`
      INSERT INTO wiki_pages (id, slug, title, content, primary_topic, staleness, last_built_at)
      VALUES ('wp_1', 'model', 'Model', 'Content', 'model', 0.1, datetime('now'))
    `).run();

    const result = await runReflect(db, { dir, threshold: 0.4 });
    assert.ok(!result.built.includes('model'), 'model should be skipped (staleness=0.1 < 0.4)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect enqueues page in failed[] when LLM fails (no file, retry scheduled)', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();

  try {
    upsertWikiTopic(db, 'broken', { force: true });
    seedFact(db, 'broken');

    const result = await runReflect(db, {
      dir,
      providers: makeProviders({ shouldFail: true }),
    });

    assert.ok(!result.built.includes('broken'), 'LLM failure must NOT be in built[]');
    assert.equal(result.failed.length, 1, 'should be enqueued in failed[]');
    assert.equal(result.failed[0].slug, 'broken');
    assert.equal(result.failed[0].retries, 1);
    assert.strictEqual(getWikiPageBySlug(db, 'broken'), null, 'no DB row written on LLM failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect escalates to permanent_error after MAX_RETRIES LLM failures', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();
  const logPath = path.join(dir, 'log.jsonl');

  try {
    upsertWikiTopic(db, 'badtopic', { force: true });
    seedFact(db, 'badtopic');
    const failingProviders = makeProviders({ shouldFail: true });

    // Simulate 2 previous failures — next retry has already passed
    const prevLog = {
      ts: new Date().toISOString(),
      slugs_built: [],
      export_failed_slugs: [],
      failed_slugs: [{ slug: 'badtopic', retries: 2, next_retry: new Date(Date.now() - 1000).toISOString() }],
      stripped_links: {},
      duration_ms: 100,
    };
    fs.writeFileSync(logPath, JSON.stringify(prevLog) + '\n');

    const result = await runWikiReflect(db, {
      outputDir: dir,
      capsulesDir: path.join(dir, 'capsules'),
      logPath,
      providers: failingProviders,
      threshold: 0.4,
    });

    // retries goes 2→3 which equals MAX_RETRIES (3), so permanent_error=true
    assert.ok(!result.built.includes('badtopic'), 'still-failing page must not be in built[]');
    assert.equal(result.failed.length, 1, 'should remain in failed[]');
    assert.ok(result.failed[0].permanent_error, 'should be marked permanent_error after MAX_RETRIES');
    assert.strictEqual(result.failed[0].next_retry, null, 'permanent_error entries get null next_retry');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect retries failed slug when next_retry has passed', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();
  const logPath = path.join(dir, 'log.jsonl');

  try {
    upsertWikiTopic(db, 'retried', { force: true });
    seedFact(db, 'retried');

    // Pre-insert page with low staleness (would normally be skipped)
    db.prepare(`
      INSERT INTO wiki_pages (id, slug, title, content, primary_topic, staleness)
      VALUES ('wp_r', 'retried', 'Retried', 'Old', 'retried', 0.1)
    `).run();

    // Simulate a previous failure with next_retry in the past
    const prevLog = {
      ts: new Date().toISOString(),
      failed_slugs: [{
        slug: 'retried',
        retries: 1,
        next_retry: new Date(Date.now() - 1000).toISOString(), // expired
      }],
    };
    fs.writeFileSync(logPath, JSON.stringify(prevLog) + '\n');

    const result = await runWikiReflect(db, {
      outputDir: dir,
      capsulesDir: path.join(dir, 'capsules'),
      logPath,
      providers: makeProviders({ response: 'Rebuilt content.' }),
      threshold: 0.4,
    });

    assert.ok(result.built.includes('retried'), 'retried slug should be rebuilt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect skips topics with zero facts without marking as failed', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();

  try {
    upsertWikiTopic(db, 'empty-topic', { force: true });
    // No facts seeded

    const result = await runReflect(db, { dir });
    assert.ok(!result.built.includes('empty-topic'), 'empty topic should not be built');
    assert.equal(result.failed.length, 0, 'empty topic should not be marked as failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect writes audit log', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();
  const logPath = path.join(dir, 'log.jsonl');

  try {
    upsertWikiTopic(db, 'audited', { force: true });
    seedFact(db, 'audited');

    await runWikiReflect(db, {
      outputDir: dir,
      capsulesDir: path.join(dir, 'capsules'),
      logPath,
      providers: makeProviders(),
    });

    assert.ok(fs.existsSync(logPath), 'audit log should be created');
    const entry = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
    assert.ok(entry.ts, 'log should have timestamp');
    assert.ok(Array.isArray(entry.slugs_built), 'log should have slugs_built');
    assert.ok(typeof entry.duration_ms === 'number', 'log should have duration_ms');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

function _setupSchema(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id        TEXT PRIMARY KEY,
      kind      TEXT NOT NULL DEFAULT 'insight',
      state     TEXT NOT NULL DEFAULT 'active',
      title     TEXT,
      content   TEXT NOT NULL DEFAULT '',
      confidence REAL DEFAULT 0.5,
      search_count INTEGER DEFAULT 0,
      relation  TEXT,
      tags      TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
}

test('runWikiReflect skips permanent_error slugs', async () => {
  const db = buildTestDb();
  const dir = makeTmpDir();
  const logPath = path.join(dir, 'log.jsonl');

  try {
    upsertWikiTopic(db, 'permfail', { force: true });
    seedFact(db, 'permfail');

    // Log shows permanent_error
    const prevLog = {
      ts: new Date().toISOString(),
      failed_slugs: [{ slug: 'permfail', retries: 3, next_retry: null, permanent_error: true }],
    };
    fs.writeFileSync(logPath, JSON.stringify(prevLog) + '\n');

    const result = await runWikiReflect(db, {
      outputDir: dir,
      capsulesDir: path.join(dir, 'capsules'),
      logPath,
      providers: makeProviders(),
      threshold: 0.4,
    });

    assert.ok(!result.built.includes('permfail'), 'permanent error slug should be skipped');
    assert.equal(result.failed.length, 0, 'no new failures since it was skipped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  db.close();
});

test('runWikiReflect exports doc pages from DB to vault', async (_t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wkr-'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');

  // Use the same minimal schema as the other tests in this file
  _setupSchema(db);

  // Insert a doc page (already built in DB, just needs file export)
  db.prepare(`INSERT INTO wiki_pages
    (slug, title, primary_topic, source_type, content, topic_tags,
     created_at, last_built_at, raw_source_count, staleness)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run('doc-paper', 'Doc Paper', 'doc-paper', 'doc',
         '## Analysis\nContent.', '[]', '2026-04-15', '2026-04-15', 3, 0.0);

  const outDir = path.join(tmp, 'vault');
  const capsulesDir = path.join(tmp, 'capsules');
  const logPath = path.join(tmp, 'reflect.log');

  const fakeProviders = {
    callHaiku: async () => '## content\ntest',
    buildDistillEnv: () => ({}),
  };

  const result = await runWikiReflect(db, {
    outputDir: outDir,
    capsulesDir,
    logPath,
    providers: fakeProviders,
  });

  assert.ok(
    fs.existsSync(path.join(outDir, 'doc-paper.md')),
    'doc page exported to vault'
  );
  assert.ok(typeof result.docsExported === 'number', 'result.docsExported is a number');
  assert.strictEqual(result.docsExported, 1);

  db.close();
  fs.rmSync(tmp, { recursive: true });
});

test('runWikiReflect mirrors decisions dir to vault', async (_t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wkr-'));
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  _setupSchema(db);

  // Write a decisions file in a temp location
  const decisionsDir = path.join(tmp, 'decisions');
  fs.mkdirSync(decisionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(decisionsDir, '2026-04-15-nightly-reflect.md'),
    '# Decision\nX over Y.',
    'utf8'
  );

  const outDir = path.join(tmp, 'vault');
  const logPath = path.join(tmp, 'reflect.log');

  const fakeProviders = {
    callHaiku: async () => '## content',
    buildDistillEnv: () => ({}),
  };

  const result = await runWikiReflect(db, {
    outputDir: outDir,
    decisionsDir,
    lessonsDir: path.join(tmp, 'lessons_empty'),   // doesn't exist — should not throw
    capsulesDir: path.join(tmp, 'caps'),
    logPath,
    providers: fakeProviders,
  });

  assert.ok(
    fs.existsSync(path.join(outDir, 'decisions', '2026-04-15-nightly-reflect.md')),
    'decisions file mirrored to vault'
  );
  assert.ok(typeof result.reflectExported === 'number', 'result.reflectExported is a number');
  assert.ok(result.reflectExported >= 1);

  db.close();
  fs.rmSync(tmp, { recursive: true });
});
