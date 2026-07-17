'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyEvolutionTier, evolutionFingerprint, initialEvolutionStage, isStalePending,
} = require('./skill-evolution-policy');

test('fingerprint merges superficial skill/skills variants', () => {
  assert.equal(
    evolutionFingerprint({ type: 'skill_gap', search_hint: 'Skills  docs' }),
    evolutionFingerprint({ type: 'skill_gap', search_hint: 'skill-docs' }),
  );
});

test('evolution tiers isolate risky changes', () => {
  assert.equal(classifyEvolutionTier({ category: 'context', insight: 'add usage example' }), 1);
  assert.equal(classifyEvolutionTier({ category: 'fix', insight: 'improve routing prompt' }), 2);
  assert.equal(classifyEvolutionTier({ type: 'policy_change', insight: 'enable shell permission' }), 3);
  assert.equal(initialEvolutionStage(2), 'proposal');
});

test('stale pending detection ages out low-evidence items only', () => {
  const now = Date.parse('2026-07-17T00:00:00Z');
  const old = '2026-03-18T09:10:40.497Z';
  const fresh = '2026-07-10T00:00:00Z';
  assert.equal(isStalePending({ status: 'pending', evidence_count: 1, last_seen: old }, 3, 45, now), true);
  assert.equal(isStalePending({ status: 'pending', evidence_count: 3, last_seen: old }, 3, 45, now), false);
  assert.equal(isStalePending({ status: 'pending', evidence_count: 1, last_seen: fresh }, 3, 45, now), false);
  assert.equal(isStalePending({ status: 'notified', evidence_count: 1, last_seen: old }, 3, 45, now), false);
  assert.equal(isStalePending({ status: 'pending', evidence_count: 1 }, 3, 45, now), false);
});
