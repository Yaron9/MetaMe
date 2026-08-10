'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('../memory-wiki-schema');
const {
  mergeClaimLineage,
  recordKnowledgeLineage,
  resolveClaimConflict,
  setItemState,
} = require('./memory-mutate');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, confidence REAL DEFAULT 0.5,
      project TEXT DEFAULT '*', scope TEXT, task_key TEXT,
      canonical_key TEXT, supersedes_id TEXT, source_id TEXT,
      source_type TEXT, origin_class TEXT DEFAULT 'primary',
      provenance_root_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  return db;
}

function insert(db, id, state, content) {
  db.prepare(`INSERT INTO memory_items
    (id,kind,state,title,content,project,scope,canonical_key,source_id,provenance_root_id)
    VALUES (?, 'convention', ?, 'display only', ?, 'metame', 'core', 'metame.policy', ?, ?)`)
    .run(id, state, content, `source-${id}`, `root:${id}`);
}

test('task-local claims cannot be promoted and conflict is a supported state', () => {
  const db = fixture();
  db.prepare(`INSERT INTO memory_items (id,kind,state,content,task_key)
    VALUES ('task-1','episode','candidate','temporary instruction','source-1')`).run();
  assert.throws(() => setItemState(db, 'task-1', 'active'), /task-local/);
  insert(db, 'conflict-1', 'conflict', 'bounded conflicting value');
  assert.equal(db.prepare(`SELECT state FROM memory_items WHERE id='conflict-1'`).get().state, 'conflict');
  db.close();
});

test('canonical claims use the contract state transition graph', () => {
  const db = fixture();
  insert(db, 'candidate-1', 'candidate', 'candidate value');
  setItemState(db, 'candidate-1', 'conflict');
  setItemState(db, 'candidate-1', 'active');
  assert.throws(() => setItemState(db, 'candidate-1', 'candidate'), /illegal claim transition/);
  db.close();
});

test('conflict resolution is transactional, explicit, lineage-preserving, and stales dependents', () => {
  const db = fixture();
  insert(db, 'winner', 'conflict', 'selected policy value');
  insert(db, 'loser', 'active', 'old policy value');
  mergeClaimLineage(db, 'winner', { parentKind: 'session_source', parentId: 'source-winner' });
  mergeClaimLineage(db, 'loser', { parentKind: 'session_source', parentId: 'source-loser' });
  db.prepare(`INSERT INTO knowledge_artifact_registry
    (artifact_id,kind,canonical_key,project_key,status,revision,source_path,content_hash,evidence_membership_hash,generator_version)
    VALUES ('artifact-1','playbook','metame.policy','metame','active',1,'capsules/policy.md','h','m','test')`).run();
  recordKnowledgeLineage(db, {
    childKind: 'knowledge_artifact', childId: 'artifact-1',
    parentKind: 'memory_item', parentId: 'loser',
  });
  const result = resolveClaimConflict(db, { winnerId: 'winner', reason: 'operator_selected' });
  assert.deepEqual(result.archivedIds, ['loser']);
  assert.equal(db.prepare(`SELECT state FROM memory_items WHERE id='winner'`).get().state, 'active');
  assert.deepEqual({ ...db.prepare(`SELECT state,supersedes_id,archive_reason FROM memory_items WHERE id='loser'`).get() }, {
    state: 'archived', supersedes_id: 'winner', archive_reason: 'operator_selected',
  });
  assert.equal(db.prepare(`SELECT count(*) AS n FROM knowledge_lineage WHERE parent_id='source-winner'`).get().n, 1);
  assert.equal(db.prepare(`SELECT count(*) AS n FROM knowledge_lineage WHERE role='superseded'`).get().n, 1);
  assert.equal(db.prepare(`SELECT status FROM knowledge_artifact_registry WHERE artifact_id='artifact-1'`).get().status, 'stale');
  db.close();
});
