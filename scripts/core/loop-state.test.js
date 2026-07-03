'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertGoalTransition,
  assertRunTransition,
  isActiveRunStatus,
} = require('./loop-state');

test('loop state accepts valid goal transitions', () => {
  assert.doesNotThrow(() => assertGoalTransition('active', 'paused'));
  assert.doesNotThrow(() => assertGoalTransition('paused', 'active'));
  assert.doesNotThrow(() => assertGoalTransition('completed', 'archived'));
});

test('loop state rejects invalid goal transitions', () => {
  assert.throws(() => assertGoalTransition('archived', 'active'), /invalid_goal_transition/);
  assert.throws(() => assertGoalTransition('cancelled', 'active'), /invalid_goal_transition/);
});

test('loop state accepts the finite run lifecycle', () => {
  for (const [from, to] of [
    ['queued', 'planning'],
    ['planning', 'executing'],
    ['executing', 'verifying'],
    ['verifying', 'retry_wait'],
    ['retry_wait', 'executing'],
    ['verifying', 'succeeded'],
  ]) {
    assert.doesNotThrow(() => assertRunTransition(from, to));
  }
});

test('loop state rejects terminal run resurrection', () => {
  for (const status of ['succeeded', 'failed', 'blocked', 'cancelled', 'skipped']) {
    assert.throws(() => assertRunTransition(status, 'executing'), /invalid_run_transition/);
  }
});

test('loop state classifies active statuses consistently with the database index', () => {
  assert.equal(isActiveRunStatus('awaiting_review'), true);
  assert.equal(isActiveRunStatus('retry_wait'), true);
  assert.equal(isActiveRunStatus('succeeded'), false);
});
