'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeGoal, normalizeWakeEvent, normalizeAutomation } = require('./loop-contract');

test('normalizes a minimal finite goal', () => {
  const goal = normalizeGoal({ goal_id: 'repo-health', objective: 'Keep checks green' });
  assert.equal(goal.mode, 'once');
  assert.equal(goal.status, 'active');
  assert.equal(goal.title, 'Keep checks green');
  assert.deepEqual(goal.policy_spec, {});
});

test('rejects invalid goal identity and mode', () => {
  assert.throws(() => normalizeGoal({ goal_id: '../bad', objective: 'x' }), /goal_id_invalid/);
  assert.throws(() => normalizeGoal({ goal_id: 'ok', objective: 'x', mode: 'forever' }), /goal_mode_invalid/);
});

test('normalizes a wake event without inventing schedule semantics', () => {
  const wake = normalizeWakeEvent({ wake_id: 'wake-1', goal_id: 'goal-1', payload: { force: true } }, '2026-06-23T00:00:00.000Z');
  assert.equal(wake.trigger_type, 'manual');
  assert.equal(wake.scheduled_at, '2026-06-23T00:00:00.000Z');
  assert.deepEqual(wake.payload, { force: true });
});

test('normalizes automation trigger specs without scheduling side effects', () => {
  const automation = normalizeAutomation({
    automation_id: 'auto-1', goal_id: 'goal-1', trigger_type: 'interval',
    trigger_spec: { interval_sec: 60 },
  });
  assert.equal(automation.enabled, true);
  assert.deepEqual(automation.trigger_spec, { interval_sec: 60 });
  assert.throws(() => normalizeAutomation({
    automation_id: 'auto-2', goal_id: 'goal-1', trigger_type: 'webhook',
  }), /automation_trigger_type_invalid/);
});
