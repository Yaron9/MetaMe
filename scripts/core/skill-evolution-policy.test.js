'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyEvolutionTier, evolutionFingerprint, initialEvolutionStage,
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
