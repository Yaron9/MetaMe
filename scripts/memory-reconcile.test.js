'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const {
  applyReconcilePlan,
  main,
  parseArgs,
  readPlanFile,
} = require('./memory-reconcile');
const { computePlanDigest } = require('./core/memory-reconcile');

function hash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reconcile-'));
  const dbPath = path.join(root, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, project TEXT DEFAULT '*', scope TEXT,
      task_key TEXT, canonical_key TEXT, supersedes_id TEXT,
      source_id TEXT, source_type TEXT, origin_class TEXT DEFAULT 'primary',
      provenance_root_id TEXT, archive_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  const insert = db.prepare(`INSERT INTO memory_items
    (id,kind,state,title,content,project,scope,canonical_key,source_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run('winner', 'convention', 'active', 'Same title', 'Bounded claim content with stable provenance.', 'metame', 'core', 'metame.memory.policy', 'source-winner', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z');
  insert.run('duplicate', 'convention', 'candidate', 'Same title', '  Bounded claim content with stable provenance.\r\n', 'metame', 'core', 'MetaMe.Memory.Policy', 'source-duplicate', '2026-08-10T01:00:00Z', '2026-08-10T01:00:00Z');
  insert.run('conflict', 'convention', 'active', 'Same title', 'A different policy value requires explicit review.', 'metame', 'core', 'metame.memory.policy', 'source-conflict', '2026-08-10T02:00:00Z', '2026-08-10T02:00:00Z');
  db.prepare(`INSERT INTO knowledge_artifact_registry
    (artifact_id,kind,canonical_key,project_key,status,revision,source_path,content_hash,evidence_membership_hash,generator_version)
    VALUES ('artifact-1','playbook','metame.memory.policy','metame','active',1,'memory/policy.md','hash','membership','test')`).run();
  db.prepare(`INSERT INTO knowledge_lineage
    (child_kind,child_id,parent_kind,parent_id,transform,role)
    VALUES ('memory_item','duplicate','session_source','source-duplicate','test','evidence')`).run();
  db.prepare(`INSERT INTO knowledge_lineage
    (child_kind,child_id,parent_kind,parent_id,transform,role)
    VALUES ('knowledge_artifact','artifact-1','memory_item','duplicate','test','evidence')`).run();
  db.close();
  return { root, dbPath, lockPath: path.join(root, 'reconcile.lock') };
}

test('CLI parser requires one mode and explicit paths', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--json']), { mode: 'dry-run', path: null, json: true, db: null });
  assert.deepEqual(parseArgs(['--stage', '/tmp/plan.json']), { mode: 'stage', path: '/tmp/plan.json', json: false, db: null });
  assert.deepEqual(parseArgs(['--apply', '/tmp/plan.json', '--db', '/tmp/memory.db']), { mode: 'apply', path: '/tmp/plan.json', json: false, db: '/tmp/memory.db' });
  assert.throws(() => parseArgs(['--dry-run', '--apply', '/tmp/plan']), /exactly one/);
  assert.throws(() => parseArgs(['--stage']), /requires a plan path/);
});

test('dry-run and stage are read-only with a versioned bounded plan', () => {
  const f = fixture();
  const before = hash(f.dbPath);
  const plan = main(['--dry-run', '--json'], { dbPath: f.dbPath, print: false, now: '2026-08-10T12:00:00Z' });
  assert.equal(plan.actions.length, 1);
  assert.equal(hash(f.dbPath), before);
  const staged = path.join(f.root, 'plan.json');
  main(['--stage', staged], { dbPath: f.dbPath, print: false, now: '2026-08-10T12:00:00Z' });
  assert.deepEqual(readPlanFile(staged), JSON.parse(fs.readFileSync(staged, 'utf8')));
  assert.equal(hash(f.dbPath), before);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('crafted staged plans cannot detach action snapshots from preconditions', () => {
  const f = fixture();
  const staged = path.join(f.root, 'plan.json');
  main(['--stage', staged], { dbPath: f.dbPath, print: false });
  const forged = readPlanFile(staged);
  const action = forged.actions[0];
  const forgedDigest = 'f'.repeat(64);
  action.survivor = { ...action.survivor, content_digest: forgedDigest };
  action.duplicate = { ...action.duplicate, content_digest: forgedDigest };
  forged.plan_digest = computePlanDigest(forged);
  fs.writeFileSync(staged, `${JSON.stringify(forged)}\n`, 'utf8');
  assert.throws(() => readPlanFile(staged), /preconditions do not match action snapshots/);
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('apply archives exact duplicates transactionally, copies lineage, and marks dependents stale', () => {
  const f = fixture();
  const staged = path.join(f.root, 'plan.json');
  main(['--stage', staged], { dbPath: f.dbPath, print: false, now: '2026-08-10T12:00:00Z' });
  const db = new DatabaseSync(f.dbPath);
  const result = applyReconcilePlan(db, readPlanFile(staged), { lockPath: f.lockPath });
  assert.deepEqual(result.archived_ids, ['duplicate']);
  assert.equal(db.prepare("SELECT state,supersedes_id,archive_reason FROM memory_items WHERE id='duplicate'").get().state, 'archived');
  assert.deepEqual({ ...db.prepare("SELECT state,supersedes_id,archive_reason FROM memory_items WHERE id='duplicate'").get() }, {
    state: 'archived', supersedes_id: 'winner', archive_reason: 'reconcile_exact_duplicate',
  });
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_lineage WHERE child_id='winner' AND parent_id='source-duplicate'").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM knowledge_lineage WHERE child_id='duplicate' AND parent_id='winner' AND role='superseded'").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM knowledge_artifact_registry WHERE artifact_id='artifact-1'").get().status, 'stale');
  db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('apply aborts atomically on a stale precondition and respects the concurrency lock', () => {
  const f = fixture();
  const staged = path.join(f.root, 'plan.json');
  main(['--stage', staged], { dbPath: f.dbPath, print: false });
  const db = new DatabaseSync(f.dbPath);
  db.prepare("UPDATE memory_items SET content='A changed value makes this plan stale.' WHERE id='duplicate'").run();
  db.close();
  const lockFd = fs.openSync(f.lockPath, 'wx');
  fs.writeFileSync(lockFd, 'held\n', 'utf8');
  fs.closeSync(lockFd);
  const staleDb = new DatabaseSync(f.dbPath);
  assert.throws(() => applyReconcilePlan(staleDb, readPlanFile(staged), { lockPath: f.lockPath }), /lock is held/);
  fs.unlinkSync(f.lockPath);
  assert.throws(() => applyReconcilePlan(staleDb, readPlanFile(staged), { lockPath: f.lockPath }), /stale reconcile precondition/);
  assert.equal(staleDb.prepare("SELECT state FROM memory_items WHERE id='duplicate'").get().state, 'candidate');
  assert.equal(staleDb.prepare("SELECT count(*) AS n FROM knowledge_lineage WHERE child_id='duplicate' AND parent_id='winner'").get().n, 0);
  staleDb.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});
