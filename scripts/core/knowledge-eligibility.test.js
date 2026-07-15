'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyOrigin,
  deriveProvenanceRootId,
  eligibleFor,
  primarySql,
} = require('./knowledge-eligibility');

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
});
