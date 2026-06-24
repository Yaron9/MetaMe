'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateVerifierVerdict } = require('./loop-verdict');

const attempt = { verification_spec_hash: 'spec-1', workspace_revision: 'none' };

test('accepts deterministic verifier evidence', () => {
  assert.doesNotThrow(() => validateVerifierVerdict({
    passed: true,
    checks: ['node --test'],
    evidence: [{ command: 'node --test', exit_code: 0 }],
  }, attempt));
});

test('rejects unsupported success claims', () => {
  assert.throws(() => validateVerifierVerdict({ passed: true }, attempt), /verifier_checks_required/);
  assert.throws(() => validateVerifierVerdict({ passed: true, checks: ['test'] }, attempt), /verifier_evidence_required/);
  assert.throws(() => validateVerifierVerdict({
    passed: true,
    checks: ['test'],
    evidence: [{}],
  }, { ...attempt, verification_spec_hash: '' }), /verification_spec_hash_required/);
});

test('accepts explicit failure and infrastructure failure', () => {
  assert.doesNotThrow(() => validateVerifierVerdict({ passed: false, failures: ['lint'] }, attempt));
  assert.doesNotThrow(() => validateVerifierVerdict({ passed: false, infra_failure: true }, attempt));
});
