'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempForTest } = require('./test-support/test-utils');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { serializeArtifact } = require('./core/knowledge-artifact');
const { projectArtifacts, scanArtifacts } = require('./memory-artifact-projector');

function fixture() {
  const root = mkdtempForTest('artifact-projector-');
  const decisionsDir = path.join(root, 'decisions');
  const capsulesDir = path.join(root, 'capsules');
  fs.mkdirSync(decisionsDir);
  fs.mkdirSync(capsulesDir);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE memory_items (
    id TEXT PRIMARY KEY, kind TEXT, state TEXT, title TEXT, content TEXT, relation TEXT,
    source_id TEXT, session_id TEXT, task_key TEXT, canonical_key TEXT, project TEXT, scope TEXT,
    origin_class TEXT DEFAULT 'primary',
    provenance_root_id TEXT, tags TEXT DEFAULT '[]', created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  db.prepare("INSERT INTO memory_items (id,kind,state,content,canonical_key,project,scope,origin_class) VALUES ('mi_1','insight','active','observed','metame.observed','metame','core','primary')").run();
  db.prepare("INSERT INTO memory_items (id,kind,state,content,canonical_key,project,scope,origin_class,provenance_root_id) VALUES ('mi_2','insight','active','confirmed','metame.confirmed','metame','core','primary','source:independent')").run();
  applyWikiSchema(db);
  return { root, decisionsDir, capsulesDir, db };
}

function artifact(kind, overrides = {}) {
  const body = overrides.body || '# Body\n\n- verify';
  const metaOverrides = { ...overrides };
  delete metaOverrides.body;
  return serializeArtifact({
    kind,
    title: kind === 'decision' ? 'Use WAL' : 'Deploy safely',
    canonical_key: kind === 'decision' ? 'metame/use-wal' : 'metame/deploy',
    project_key: 'metame',
    status: 'active',
    revision: 1,
    evidence_ids: ['mi_1', 'mi_2'],
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    generator_version: 'artifact-v1',
    ...metaOverrides,
  }, body);
}

test('projector validates all files then atomically indexes active artifacts', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.capsulesDir, 'deploy.md'), artifact('playbook'));
  const scan = scanArtifacts(f);
  const result = projectArtifacts(f.db, scan);
  assert.equal(result.ok, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_artifact_registry').get().n, 1);
  const page = f.db.prepare("SELECT page_kind,project_key,artifact_status,source_path FROM wiki_pages WHERE page_kind='playbook'").get();
  assert.deepEqual({ ...page }, { page_kind: 'playbook', project_key: 'metame', artifact_status: 'active', source_path: 'capsules/deploy.md' });
  assert.equal(f.db.prepare('SELECT count(*) n FROM wiki_page_evidence').get().n, 2);
  assert.deepEqual({ ...f.db.prepare('SELECT child_kind,parent_kind,parent_id FROM knowledge_lineage').get() }, {
    child_kind: 'knowledge_artifact', parent_kind: 'memory_item', parent_id: 'mi_1',
  });
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('invalid sibling prevents partial publish and preserves live index', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.decisionsDir, 'wal.md'), artifact('decision'));
  assert.equal(projectArtifacts(f.db, scanArtifacts(f)).ok, true);
  fs.writeFileSync(path.join(f.capsulesDir, 'broken.md'), artifact('playbook').replace('content_hash:', 'content_hash: bad #'));
  const result = projectArtifacts(f.db, scanArtifacts(f));
  assert.equal(result.ok, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_artifact_registry').get().n, 1);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('dry-run validates without writing projection state', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.capsulesDir, 'deploy.md'), artifact('playbook'));
  const result = projectArtifacts(f.db, scanArtifacts(f), { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(f.db.prepare('SELECT count(*) n FROM knowledge_artifact_registry').get().n, 0);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('projector fails closed when an authority root disappears', () => {
  const f = fixture();
  fs.rmSync(f.decisionsDir, { recursive: true });
  const result = projectArtifacts(f.db, scanArtifacts(f));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /root missing/);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('active artifact requires two live independent evidence roots', () => {
  const f = fixture();
  f.db.prepare("UPDATE memory_items SET state='archived' WHERE id='mi_2'").run();
  fs.writeFileSync(path.join(f.capsulesDir, 'deploy.md'), artifact('playbook'));
  const result = projectArtifacts(f.db, scanArtifacts(f));
  assert.equal(result.ok, false);
  assert.match(result.errors.map(error => error.error).join(' '), /inactive|two independent/);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('active projection fails closed for candidate, task-local, conflict, and legacy-null evidence; drafts admit candidates', () => {
  const f = fixture();
  const file = path.join(f.capsulesDir, 'deploy.md');
  fs.writeFileSync(file, artifact('playbook'));
  for (const update of [
    "UPDATE memory_items SET state='candidate' WHERE id='mi_1'",
    "UPDATE memory_items SET kind='episode', state='active', task_key='task-1', canonical_key=NULL WHERE id='mi_1'",
    "UPDATE memory_items SET kind='insight', state='conflict', task_key=NULL WHERE id='mi_1'",
    "UPDATE memory_items SET kind='insight', state='active', task_key=NULL, canonical_key=NULL WHERE id='mi_1'",
  ]) {
    f.db.exec(update);
    assert.equal(projectArtifacts(f.db, scanArtifacts(f)).ok, false);
    f.db.exec("UPDATE memory_items SET kind='insight', state='active', task_key=NULL, canonical_key='metame.observed' WHERE id='mi_1'");
  }
  fs.writeFileSync(file, artifact('playbook', { status: 'draft' }));
  f.db.exec("UPDATE memory_items SET state='candidate' WHERE id='mi_1'");
  assert.equal(projectArtifacts(f.db, scanArtifacts(f)).ok, true);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('active projection excludes an incumbent with an unresolved conflict peer', () => {
  const f = fixture();
  f.db.prepare(`
    INSERT INTO memory_items
      (id,kind,state,content,canonical_key,project,scope,origin_class)
    VALUES ('mi_conflict_peer','insight','conflict','peer value','metame.observed','metame','core','primary')
  `).run();
  fs.writeFileSync(path.join(f.capsulesDir, 'deploy.md'), artifact('playbook'));
  const result = projectArtifacts(f.db, scanArtifacts(f));
  assert.equal(result.ok, false);
  assert.match(result.errors.map(error => error.error).join(' '), /ineligible/);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});

test('content changes require a monotonic revision chain', () => {
  const f = fixture();
  const file = path.join(f.capsulesDir, 'deploy.md');
  fs.writeFileSync(file, artifact('playbook'));
  assert.equal(projectArtifacts(f.db, scanArtifacts(f)).ok, true);
  fs.writeFileSync(file, artifact('playbook', { body: '# Body\n\n- changed' }));
  const result = projectArtifacts(f.db, scanArtifacts(f));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].error, /revision chain/);
  assert.equal(f.db.prepare('SELECT revision FROM knowledge_artifact_registry').get().revision, 1);
  f.db.close();
  fs.rmSync(f.root, { recursive: true, force: true });
});
