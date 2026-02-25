'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeTaskEnvelope,
  validateTaskEnvelope,
  newTaskId,
  newHandoffId,
} = require('./daemon-task-envelope');

test('normalizeTaskEnvelope sets defaults for team task', () => {
  const env = normalizeTaskEnvelope({
    from_agent: 'assistant',
    to_agent: 'coder',
    goal: 'run tests',
  });
  assert.ok(env.task_id.startsWith('t_'));
  assert.equal(env.task_kind, 'team');
  assert.equal(env.status, 'queued');
  assert.equal(env.priority, 'normal');
  assert.equal(env.from_agent, 'assistant');
  assert.equal(env.to_agent, 'coder');
  assert.equal(env.goal, 'run tests');
});

test('validateTaskEnvelope rejects missing goal', () => {
  const env = normalizeTaskEnvelope({
    from_agent: 'assistant',
    to_agent: 'coder',
    goal: '',
  });
  const v = validateTaskEnvelope(env);
  assert.equal(v.ok, false);
  assert.equal(v.error, 'goal_required');
});

test('id generators return expected prefixes', () => {
  const taskId = newTaskId(new Date('2026-02-25T00:00:00.000Z'));
  const handoffId = newHandoffId();
  assert.ok(taskId.startsWith('t_20260225_'));
  assert.ok(handoffId.startsWith('h_'));
});
