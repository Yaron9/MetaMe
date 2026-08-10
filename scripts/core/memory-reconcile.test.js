'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReconcilePlan,
  computePlanDigest,
  validatePlan,
} = require('./memory-reconcile');

function claim(id, overrides = {}) {
  return {
    id,
    kind: 'convention',
    state: 'active',
    title: 'Display title',
    content: 'The bounded claim content is preserved with its provenance.',
    canonical_key: 'MetaMe.Memory.Policy',
    project: 'metame',
    scope: 'core',
    created_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

test('reconcile plan archives only exact normalized duplicates and preserves reports', () => {
  const plan = buildReconcilePlan([
    claim('winner', { content: '  The bounded claim content is preserved with its provenance.\r\n' }),
    claim('duplicate', { state: 'candidate', content: 'The bounded claim content is preserved with its provenance.' }),
    claim('conflict', { content: 'A different value for the same canonical identity requires review.' }),
    claim('title-only', { canonical_key: 'metame.other.policy', content: 'A related claim with a different identity stays separate.' }),
    claim('legacy', { canonical_key: null, title: 'Display title' }),
  ], { now: '2026-08-10T12:00:00.000Z' });

  assert.equal(plan.schema_version, 1);
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].survivor.id, 'winner');
  assert.equal(plan.actions[0].duplicate.id, 'duplicate');
  assert.equal(plan.summary.semantic_conflict_groups, 1);
  assert.equal(plan.summary.title_duplicate_groups, 1);
  assert.equal(plan.summary.unkeyed_rows, 1);
  assert.equal(plan.actions[0].reason, 'exact_normalized_duplicate');
  assert.equal(validatePlan(plan), plan);
});

test('plan digest rejects tampering and does not use generation timestamp', () => {
  const first = buildReconcilePlan([claim('one')], { now: '2026-08-10T00:00:00.000Z' });
  const second = buildReconcilePlan([claim('one')], { now: '2026-08-10T01:00:00.000Z' });
  assert.equal(first.plan_digest, second.plan_digest);
  assert.equal(computePlanDigest(first), first.plan_digest);
  assert.throws(() => validatePlan({ ...first, summary: { ...first.summary, scanned_rows: 99 } }), /digest mismatch/);
});

test('same title with different identity is report-only', () => {
  const plan = buildReconcilePlan([
    claim('one'),
    claim('two', { canonical_key: 'metame.other.policy', content: 'A different identity and content remains complementary.' }),
  ]);
  assert.equal(plan.actions.length, 0);
  assert.equal(plan.reports.title_duplicates.entries.length, 1);
});
