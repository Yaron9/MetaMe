'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempForTest } = require('./test-support/test-utils');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { applyMigration, buildManifest, parseArgs, recoverMigration, stageMigration } = require('./memory-artifact-migrate');

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture() {
  const root = mkdtempForTest('artifact-migrate-');
  const memoryRoot = path.join(root, 'memory');
  const vaultRoot = path.join(root, 'vault');
  for (const name of ['decisions', 'lessons', 'capsules']) fs.mkdirSync(path.join(memoryRoot, name), { recursive: true });
  fs.mkdirSync(vaultRoot);
  const dbPath = path.join(root, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE memory_items (
    id TEXT PRIMARY KEY, kind TEXT, state TEXT, title TEXT, content TEXT, relation TEXT,
    source_id TEXT, session_id TEXT, task_key TEXT, tags TEXT DEFAULT '[]',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.prepare("INSERT INTO memory_items (id,kind,state,title,content,relation,source_id,created_at) VALUES ('primary_1','fact','active','metame.deploy.release','deploy evidence','observed','session-1','2026-07-14')").run();
  db.prepare("INSERT INTO memory_items (id,kind,state,title,content,relation,source_id,created_at) VALUES ('decision_1','insight','active','MetaMe.deploy.strategy · tech_decision','use staged deploy','tech_decision','session-a','2026-07-13')").run();
  db.prepare("INSERT INTO memory_items (id,kind,state,title,content,relation,source_id,created_at) VALUES ('decision_2','insight','active','MetaMe.deploy.rollback · tech_decision','retain backup','tech_decision','session-b','2026-07-14')").run();
  db.prepare("INSERT INTO memory_items (id,kind,state,content,relation,source_id) VALUES ('derived_1','insight','active','derived','synthesized_insight','nightly-reflect-2026-07-15')").run();
  applyWikiSchema(db);
  db.close();
  fs.writeFileSync(path.join(memoryRoot, 'capsules', 'metame-deploy-playbook.md'), `---\nentity_prefix: metame.deploy\ndate: 2026-07-15\n---\n# 📕 Playbook: Deploy safely\n\n## Steps\n\nShip it.\n`);
  fs.writeFileSync(path.join(memoryRoot, 'decisions', '2026-07-15-nightly-reflect.md'), `---\ndate: 2026-07-15\n---\n# Decisions\n\n## Use safe deploy\n\nBecause.\n`);
  fs.writeFileSync(path.join(memoryRoot, 'lessons', '2026-07-15-nightly-reflect.md'), `---\ndate: 2026-07-15\n---\n# Lessons\n\n## Verify first\n\nAlways.\n`);
  return { root, memoryRoot, vaultRoot, dbPath };
}

test('manifest inspection is read-only', () => {
  const f = fixture();
  const before = hash(f.dbPath);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  const manifest = buildManifest(db, f);
  db.close();
  assert.equal(hash(f.dbPath), before);
  assert.equal(manifest.readOnly, true);
  assert.equal(manifest.derived.classified, 1);
  assert.equal(manifest.capsules[0].action, 'canonicalize');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('stage migration canonicalizes artifacts and isolates derived evidence', () => {
  const f = fixture();
  const result = stageMigration({ ...f, stageRoot: path.join(f.root, 'stage') });
  assert.equal(result.projection.ok, true);
  assert.equal(result.playbooks.length, 1);
  assert.equal(result.decisions.length, 1);
  assert.equal(fs.existsSync(path.join(result.stagedMemory, 'capsules', 'metame', 'deploy.md')), true);
  assert.match(fs.readFileSync(path.join(result.stagedMemory, 'decisions', '2026-07-15-nightly-reflect.md'), 'utf8'), /archive: true/);
  const db = new DatabaseSync(result.stagedDb, { readOnly: true });
  assert.equal(db.prepare("SELECT origin_class FROM memory_items WHERE id='derived_1'").get().origin_class, 'derived');
  assert.equal(db.prepare('SELECT count(*) n FROM knowledge_artifact_registry').get().n, 2);
  assert.equal(db.prepare("SELECT count(*) n FROM knowledge_artifact_registry WHERE kind='decision' AND status='active'").get().n, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM knowledge_lineage').get().n, 5);
  db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('parseArgs accepts one migration mode and explicit paths', () => {
  assert.deepEqual(parseArgs(['--stage', '--stage-root', '/tmp/stage']), { mode: 'stage', stage_root: '/tmp/stage' });
  assert.throws(() => parseArgs(['--wat']), /unknown argument/);
  assert.throws(() => parseArgs(['--stage', '--apply']), /exactly one/);
  assert.throws(() => parseArgs(['--stage', '--stage-root']), /missing value/);
});

test('apply atomically publishes the validated DB, source directories and vault views', () => {
  const f = fixture();
  for (const name of ['decisions', 'lessons', 'capsules']) {
    fs.mkdirSync(path.join(f.vaultRoot, name), { recursive: true });
    fs.writeFileSync(path.join(f.vaultRoot, name, 'stale.md'), '# stale\n');
  }
  const backupRoot = path.join(f.root, 'backup');
  const result = applyMigration({
    ...f,
    backupRoot,
    _stageMigration: options => stageMigration({ ...options, drainEmbeddings: false }),
  });
  assert.equal(result.projection.ok, true);
  assert.equal(fs.existsSync(path.join(backupRoot, 'previous-memory.db')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'memory-maintenance.lock')), false);
  assert.equal(fs.existsSync(path.join(f.vaultRoot, 'lessons', 'stale.md')), false);
  const db = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) n FROM knowledge_artifact_registry WHERE kind='decision'").get().n, 1);
  db.close();
  recoverMigration({ ...f, backupRoot });
  const restored = new DatabaseSync(f.dbPath, { readOnly: true });
  assert.equal(restored.prepare('SELECT count(*) n FROM knowledge_artifact_registry').get().n, 0);
  restored.close();
  assert.equal(fs.existsSync(path.join(f.vaultRoot, 'lessons', 'stale.md')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot, 'publish-journal.json'))).phase, 'rolled_back');
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('apply refuses to start while the daemon writer is alive', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'daemon.pid'), String(process.pid));
  const backupRoot = path.join(f.root, 'backup');
  assert.throws(() => applyMigration({ ...f, backupRoot }), /daemon is running/);
  assert.equal(fs.existsSync(backupRoot), false);
  fs.rmSync(f.root, { recursive: true, force: true });
});
