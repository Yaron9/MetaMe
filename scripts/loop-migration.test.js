'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { planLegacyMigration, applyLegacyMigration } = require('./loop-migration');

test('legacy migration plans heartbeat and reactive mappings without writes', () => {
  const plan = planLegacyMigration({
    heartbeat: { tasks: [{ name: 'daily', prompt: 'report', at: '09:00' }] },
    projects: { research: { name: 'Research', cwd: '/repo', reactive: true } },
  }, {
    readPerpetual: () => ({
      _path: '/repo/perpetual.yaml', verifier: 'scripts/verifier.js',
      completion_signal: 'RESEARCH_COMPLETE', max_depth: 12,
    }),
  });
  assert.equal(plan.dry_run, true);
  assert.equal(plan.goals.length, 2);
  const reactive = plan.goals.find(goal => goal.mode === 'continuous');
  assert.equal(reactive.policy_spec.max_turns_per_run, 12);
  assert.equal(reactive.execution_spec.completion_signal, 'RESEARCH_COMPLETE');
  assert.deepEqual(plan.legacy_files, ['/repo/perpetual.yaml']);
});

test('migration apply is idempotent over an existing Goal set', () => {
  const created = new Set();
  const automations = [];
  const store = {
    getGoal: id => created.has(id) ? { goal_id: id } : null,
    createGoal: goal => created.add(goal.goal_id),
    upsertAutomation: automation => automations.push(automation.automation_id),
  };
  const plan = {
    dry_run: true,
    goals: [{ goal_id: 'g1' }],
    automations: [{ automation_id: 'a1' }],
  };
  assert.equal(applyLegacyMigration(plan, store).goals_created, 1);
  assert.equal(applyLegacyMigration(plan, store).goals_existing, 1);
  assert.deepEqual(automations, ['a1', 'a1']);
});
