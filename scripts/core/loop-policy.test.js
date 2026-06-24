'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRunPolicy } = require('./loop-policy');

test('run policy independently gates attempt, token, cost and wall time', () => {
  const run = { attempt_no: 2, created_at: '2026-06-23T00:00:00Z' };
  assert.equal(evaluateRunPolicy({ run, policy: { max_attempts_per_run: 2 } }).reason, 'attempt_limit_reached');
  assert.equal(evaluateRunPolicy({ run: { ...run, attempt_no: 0 }, usage: { input_tokens: 6, output_tokens: 4 }, policy: { max_tokens_per_run: 10 } }).reason, 'token_budget_reached');
  assert.equal(evaluateRunPolicy({ run: { ...run, attempt_no: 0 }, usage: { cost_micros: 20 }, policy: { max_cost_micros: 20 } }).reason, 'cost_budget_reached');
  assert.equal(evaluateRunPolicy({
    run: { ...run, attempt_no: 0 }, nowMs: Date.parse('2026-06-23T00:01:00Z'), policy: { max_run_ms: 60000 },
  }).reason, 'wall_time_limit_reached');
});
