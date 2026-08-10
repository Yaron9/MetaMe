'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  admitClaim,
  claimContentDigest,
  claimIdentity,
  isSynthesisEvidenceEligible,
  mapClaimStorage,
  normalizeCanonicalKey,
  normalizeClaimContent,
  reconcileClaim,
  validateCanonicalKey,
} = require('./claim-contract');

const CONTENT = 'Use the bounded memory boundary for every durable claim.';

function claim(overrides = {}) {
  return {
    lifecycle: 'project',
    kind: 'convention',
    canonical_key: 'MetaMe.Memory.Policy',
    project: 'MetaMe',
    scope: 'core',
    content: CONTENT,
    state: 'candidate',
    ...overrides,
  };
}

test('canonical keys use NFKC/lowercase dot-segment syntax and fail closed', () => {
  assert.equal(normalizeCanonicalKey(' ＭｅｔａＭｅ.Memory_Policy '), 'metame.memory_policy');
  assert.equal(normalizeCanonicalKey('a.b-c_d'), 'a.b-c_d');
  assert.equal(normalizeCanonicalKey('a/b'), null);
  assert.equal(normalizeCanonicalKey('a..b'), null);
  assert.equal(normalizeCanonicalKey(`a.${'b'.repeat(160)}`), null);
  assert.deepEqual(validateCanonicalKey(''), { valid: true, value: null, reason: 'missing' });
  assert.equal(validateCanonicalKey('a/b').valid, false);
});

test('content normalization is NFC, LF, per-line trailing trim, and outer trim', () => {
  const source = '  cafe\u0301  \r\nclaim text \t\r\n\r\n ';
  assert.equal(normalizeClaimContent(source), 'café\nclaim text');
  assert.equal(claimContentDigest('x\r\n'), claimContentDigest(' x\n'));
});

test('identity is canonical_key + project + scope, never title', () => {
  assert.deepEqual(claimIdentity(claim({ title: 'first' })), {
    canonical_key: 'metame.memory.policy', project: 'MetaMe', scope: 'core',
  });
  assert.notDeepEqual(
    claimIdentity(claim({ title: 'first', project: 'other' })),
    claimIdentity(claim({ title: 'first', project: 'MetaMe' })),
  );
});

test('unknown lifecycle fails closed to an active task Episode', () => {
  assert.deepEqual(mapClaimStorage({ content: CONTENT, source_id: 'source-r1' }), {
    content: CONTENT,
    source_id: 'source-r1',
    lifecycle: 'task',
    kind: 'episode',
    state: 'active',
    canonical_key: null,
    task_key: 'source-r1',
  });
  assert.deepEqual(reconcileClaim({ content: CONTENT, source_id: 'source-r1' }).outcome, 'episode');
});

test('valid project/global claims enter candidate storage', () => {
  const project = mapClaimStorage(claim());
  assert.equal(project.kind, 'convention');
  assert.equal(project.state, 'candidate');
  assert.equal(project.task_key, null);
  assert.equal(project.canonical_key, 'metame.memory.policy');
  const global = mapClaimStorage(claim({ lifecycle: 'global', project: 'other', scope: 'other' }));
  assert.equal(global.project, '*');
  assert.equal(global.scope, '*');
});

test('admission outcomes are exact duplicate, conflict, and complementary', () => {
  const active = claim({ state: 'active', id: 'active-1' });
  assert.equal(admitClaim(claim({ title: 'different' }), [active]).outcome, 'duplicate');
  const conflict = reconcileClaim(claim({ content: 'A different bounded policy value is proposed here.' }), [active]);
  assert.equal(conflict.outcome, 'conflict');
  assert.deepEqual(conflict.existing_ids, ['active-1']);
  assert.equal(reconcileClaim(claim({ canonical_key: 'other.key' }), [active]).outcome, 'complementary');
});

test('candidate/conflict exact content merges lineage without title or confidence heuristics', () => {
  const candidate = claim({ state: 'candidate', id: 'candidate-1', confidence: 0.1, title: 'one' });
  assert.equal(reconcileClaim(claim({ state: 'candidate', title: 'two', confidence: 0.99 }), [candidate]).outcome, 'duplicate');
  const conflicted = claim({ state: 'conflict', id: 'conflict-1' });
  assert.equal(reconcileClaim(claim({ content: 'A different bounded policy value is proposed here.' }), [conflicted]).outcome, 'conflict');
});

test('active synthesis accepts only active canonical non-task claims; drafts may use candidates', () => {
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active' })), true);
  assert.equal(isSynthesisEvidenceEligible(claim()), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active', task_key: 'task-1' })), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'conflict' })), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active', canonical_key: null })), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active' }), { hasUnresolvedConflict: true }), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active', has_unresolved_conflict: true })), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active', kind: 'episode' })), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'active', relation: 'synthesized_insight' })), false);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'candidate' }), { draft: true }), true);
  assert.equal(isSynthesisEvidenceEligible(claim({ state: 'candidate' })), false);
});

test('explicit supersession is opt-in and never inferred from title', () => {
  const existing = claim({ id: 'old', state: 'active' });
  assert.equal(reconcileClaim(claim({ title: 'same', content: 'A different bounded policy value is proposed here.' }), [existing]).outcome, 'conflict');
  assert.equal(reconcileClaim(
    claim({ supersedes_id: 'old', content: 'A different bounded policy value is proposed here.' }),
    [existing],
    { allowExplicitSupersession: true },
  ).outcome, 'supersede');
});
