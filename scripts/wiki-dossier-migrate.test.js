'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { upsertWikiTopic } = require('./core/wiki-db');
const { mkdtempForTest } = require('./test-support/test-utils');
const {
  buildMigrationManifest,
  cloneDatabase,
  main,
  stageMigration,
  unchangedTopics,
} = require('./wiki-dossier-migrate');

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function seed(root) {
  const dbPath = path.join(root, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT, state TEXT, title TEXT, content TEXT,
      confidence REAL DEFAULT .5, search_count INTEGER DEFAULT 0, relation TEXT,
      tags TEXT DEFAULT '[]', project TEXT, scope TEXT, source_type TEXT, source_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  upsertWikiTopic(db, 'Step3', { force: true });
  upsertWikiTopic(db, 'step3', { force: true });
  upsertWikiTopic(db, 'skill', { force: true });
  upsertWikiTopic(db, 'skills', { force: true });
  for (const id of ['m1', 'm2', 'm3']) {
    db.prepare(`INSERT INTO memory_items (id,kind,state,content,tags,project) VALUES (?,'insight','active',?,'["step3"]','MetaMe')`).run(id, `fact ${id}`);
  }
  db.close();
  return dbPath;
}

test('dry-run is database and Vault read-only while producing canonical manifest', async () => {
  const root = mkdtempForTest('wiki-migrate-');
  try {
    const dbPath = seed(root);
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    const manifestPath = path.join(root, 'out', 'manifest.json');
    const before = sha(dbPath);
    const manifest = await main(['--dry-run', '--db', dbPath, '--vault', vault, '--manifest', manifestPath]);
    assert.equal(sha(dbPath), before);
    assert.equal(manifest.summary.registeredTopics, 4);
    assert.equal(manifest.summary.canonicalTopics, 3);
    assert.equal(manifest.summary.expectedDossiers, 1);
    assert.deepEqual(manifest.semanticReview, [{ left: 'skill', right: 'skills', action: 'review_only' }]);
    assert.ok(fs.existsSync(manifestPath));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('clone and staging build operate only on cloned DB and Vault', async () => {
  const root = mkdtempForTest('wiki-stage-');
  try {
    const dbPath = seed(root);
    const vault = path.join(root, 'vault');
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, 'manual.md'), 'manual');
    const clone = path.join(root, 'clone.db');
    cloneDatabase(dbPath, clone);
    const cloneDb = new DatabaseSync(clone, { readOnly: true });
    assert.equal(cloneDb.prepare('SELECT COUNT(*) AS n FROM wiki_topics').get().n, 4);
    cloneDb.close();
    const before = sha(dbPath);
    const result = await stageMigration({
      dbPath, vaultRoot: vault, stageRoot: path.join(root, 'stage'),
      providers: {
        buildDistillEnv: () => ({}),
        callHaiku: async () => JSON.stringify({ claims: [{ section: 'current_state', text: 'staged', evidenceRefs: ['M:m1'] }] }),
      },
    });
    assert.equal(sha(dbPath), before);
    assert.ok(fs.existsSync(path.join(result.stagedVault, 'topics', 'step3.md')));
    assert.ok(fs.existsSync(path.join(result.stagedVault, 'topics', 'step3', 'projects', 'metame.md')));
    assert.ok(fs.existsSync(path.join(result.stagedVault, 'manual.md')));
    assert.equal(result.audit.activeDossiers, 1);
    assert.equal(result.audit.orphanEvidence, 0);
    assert.equal(result.audit.invalidFootnotes, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('drift selection skips changed sources and files per topic', () => {
  const root = mkdtempForTest('wiki-drift-');
  try {
    const dbPath = seed(root);
    const vault = path.join(root, 'vault');
    fs.mkdirSync(path.join(vault, 'topics'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'topics', 'step3.md'), '---\nslug: step3\nsource_type: memory\n---\nold');
    const writeDb = new DatabaseSync(dbPath);
    writeDb.prepare(`INSERT INTO wiki_pages (id,slug,title,content,primary_topic) VALUES ('wp-step3','step3','Step3','old','Step3')`).run();
    writeDb.close();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const previous = buildMigrationManifest(db, { vaultRoot: vault });
    db.close();
    fs.writeFileSync(path.join(vault, 'topics', 'step3.md'), 'manual edit');
    const selection = unchangedTopics(previous, previous, vault);
    assert.ok(selection.skipped.some(item => item.slug === 'step3' && item.reason === 'file_drift'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
