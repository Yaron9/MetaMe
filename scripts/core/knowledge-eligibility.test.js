'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyOrigin,
  deriveProvenanceRootId,
  eligibleFor,
  claimSqlForDb,
  primarySql,
  primarySqlForDb,
} = require('./knowledge-eligibility');
const { DatabaseSync } = require('node:sqlite');

test('classifyOrigin fails closed for known derived generator fingerprints', () => {
  assert.equal(classifyOrigin({ origin_class: 'primary', relation: 'synthesized_insight' }), 'derived');
  assert.equal(classifyOrigin({ origin_class: 'derived' }), 'derived');
});

test('classifyOrigin recognizes current and legacy derived records', () => {
  assert.equal(classifyOrigin({ relation: 'knowledge_capsule' }), 'derived');
  assert.equal(classifyOrigin({ source_id: 'nightly-reflect-2026-03-05', relation: null }), 'derived');
  assert.equal(classifyOrigin({ source_id: 'capsule-2026-07-12-step3' }), 'derived');
  assert.equal(classifyOrigin({ source_id: 'session-1' }), 'primary');
});

test('eligibleFor rejects derived records on every evidence channel', () => {
  for (const channel of ['reflect', 'wiki_evidence', 'profile_distill', 'fact_recall', 'graph_claim', 'skill_evidence']) {
    assert.equal(eligibleFor(channel, { source_id: 'nightly-reflect-old', state: 'active' }), false);
    assert.equal(eligibleFor(channel, { origin_class: 'primary', state: 'active' }), true);
  }
  assert.equal(eligibleFor('fact_recall', { kind: 'episode', state: 'active', origin_class: 'primary' }), false);
  assert.equal(eligibleFor('fact_recall', { kind: 'insight', state: 'active', task_key: 'task-1' }), false);
});

test('deriveProvenanceRootId uses stable source hierarchy', () => {
  assert.equal(deriveProvenanceRootId({ provenance_root_id: 'manual:1', source_id: 'x' }), 'manual:1');
  assert.equal(deriveProvenanceRootId({ source_id: 'doc-1', session_id: 's-1' }), 'source:doc-1');
  assert.equal(deriveProvenanceRootId({ session_id: 's-1' }), 'session:s-1');
});

test('primarySql includes legacy derived fingerprints before migration', () => {
  const predicate = primarySql('mi');
  assert.deepEqual(predicate.args, []);
  assert.match(predicate.sql, /origin_class/);
  assert.match(predicate.sql, /nightly-reflect/);
  assert.match(predicate.sql, /knowledge_capsule/);
  assert.match(predicate.sql, /claim_conflict_peer/);
  assert.match(predicate.sql, /task_key/);
  assert.match(predicate.sql, /kind IN/);
});

test('database eligibility isolates active incumbents with unresolved conflict peers', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT, state TEXT, content TEXT,
      canonical_key TEXT, project TEXT, scope TEXT,
      origin_class TEXT, relation TEXT, source_id TEXT
    );
    INSERT INTO memory_items VALUES
      ('incumbent','convention','active','old value','metame.policy','metame','core','primary',NULL,'source-old'),
      ('peer','convention','conflict','new value','metame.policy','metame','core','primary',NULL,'source-new'),
      ('safe','convention','active','safe value','metame.safe','metame','core','primary',NULL,'source-safe'),
      ('legacy','convention','active','legacy value',NULL,'metame','core','primary',NULL,'source-legacy');
  `);
  const eligibility = primarySqlForDb(db, 'mi');
  const rows = db.prepare(`
    SELECT mi.id FROM memory_items mi
     WHERE mi.state='active' AND ${eligibility.sql}
     ORDER BY mi.id
  `).all();
  assert.deepEqual(rows.map(row => row.id), ['legacy', 'safe']);
  db.close();
});

test('claim SQL requires canonical non-task claims and supports draft candidates', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT, state TEXT, content TEXT,
      canonical_key TEXT, project TEXT, scope TEXT, task_key TEXT,
      origin_class TEXT, relation TEXT, source_id TEXT
    );
    INSERT INTO memory_items VALUES
      ('active','convention','active','active value','metame.active','metame','core',NULL,'primary',NULL,'source-active'),
      ('candidate','insight','candidate','candidate value','metame.candidate','metame','core',NULL,'primary',NULL,'source-candidate'),
      ('legacy','insight','active','legacy value',NULL,'metame','core',NULL,'primary',NULL,'source-legacy'),
      ('task','episode','active','task value',NULL,'metame','core','task-1','primary',NULL,'source-task');
  `);
  const eligibility = claimSqlForDb(db, 'mi', { draft: true });
  const rows = db.prepare(`
    SELECT mi.id FROM memory_items mi
     WHERE ${eligibility.sql}
     ORDER BY mi.id
  `).all();
  assert.deepEqual(rows.map(row => row.id), ['active', 'candidate']);
  db.close();
});
