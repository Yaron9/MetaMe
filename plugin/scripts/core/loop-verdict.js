'use strict';

function hasEvidence(value) {
  if (Array.isArray(value)) return value.some(item => {
    if (item && typeof item === 'object') return Object.keys(item).length > 0;
    return String(item || '').trim().length > 0;
  });
  return !!(value && typeof value === 'object' && Object.keys(value).length > 0);
}

function validateVerifierVerdict(verdict, attempt) {
  if (!verdict || typeof verdict !== 'object' || typeof verdict.passed !== 'boolean') {
    throw new Error('verifier_verdict_invalid');
  }
  if (!attempt || !String(attempt.verification_spec_hash || '').trim()) {
    throw new Error('verification_spec_hash_required');
  }
  if (!String(attempt.workspace_revision || '').trim()) {
    throw new Error('workspace_revision_required');
  }
  if (verdict.passed) {
    if (!Array.isArray(verdict.checks) || verdict.checks.length === 0) {
      throw new Error('verifier_checks_required');
    }
    if (!hasEvidence(verdict.evidence)) throw new Error('verifier_evidence_required');
  } else if (!verdict.infra_failure && (!Array.isArray(verdict.failures) || verdict.failures.length === 0)) {
    throw new Error('verifier_failures_required');
  }
  return verdict;
}

module.exports = { validateVerifierVerdict };
