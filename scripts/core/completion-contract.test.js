'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMPLETION_SCHEMA, normalizeCompletionResult } = require('./completion-contract');

const candidate = {
  status: 'candidate_complete',
  summary: 'implemented',
  artifacts: ['scripts/a.js'],
  claims: ['tests passed'],
  next: null,
};

test('completion schema is the shared strict native output contract', () => {
  assert.deepEqual(COMPLETION_SCHEMA.required, ['status', 'summary', 'artifacts', 'claims', 'next']);
  assert.equal(COMPLETION_SCHEMA.additionalProperties, false);
});

test('completion result normalizes direct, Claude envelope and JSON text forms', () => {
  assert.deepEqual(normalizeCompletionResult(candidate), candidate);
  assert.deepEqual(normalizeCompletionResult(JSON.stringify(candidate)), candidate);
  assert.deepEqual(normalizeCompletionResult({ structured_output: candidate }), candidate);
  assert.deepEqual(normalizeCompletionResult({ result: JSON.stringify(candidate) }), candidate);
});

test('completion result rejects incomplete or invalid claims', () => {
  assert.throws(() => normalizeCompletionResult({ ...candidate, status: 'succeeded' }), /completion_status_invalid/);
  assert.throws(() => normalizeCompletionResult({ ...candidate, claims: 'tests passed' }), /completion_claims_invalid/);
  assert.throws(() => normalizeCompletionResult('not-json'), /completion_result_not_json/);
});
