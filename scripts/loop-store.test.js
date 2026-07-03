'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createControlDb } = require('./control-db');
const { createLoopStore } = require('./loop-store');

function createFixture() {
  const dbPath = path.join(os.tmpdir(), `metame-loop-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const controlDb = createControlDb({ dbPath });
  let id = 0;
  const store = createLoopStore({
    controlDb,
    now: () => new Date('2026-06-23T00:00:00.000Z'),
    newId: prefix => `${prefix}_${++id}`,
  });
  const close = () => {
    controlDb.close();
    for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  };
  return { controlDb, store, close };
}

function createGoal(store, overrides = {}) {
  return store.createGoal({
    goal_id: 'repo-health',
    objective: 'Keep repository checks green',
    mode: 'continuous',
    ...overrides,
  });
}

test('loop store persists typed goal specs', () => {
  const { store, close } = createFixture();
  createGoal(store, { policy_spec: { max_attempts_per_run: 3 } });

  const goal = store.getGoal('repo-health');
  assert.equal(goal.version, 1);
  assert.equal(goal.mode, 'continuous');
  assert.deepEqual(goal.policy_spec, { max_attempts_per_run: 3 });
  close();
});

test('goal spec updates and lifecycle transitions require optimistic version', () => {
  const { store, close } = createFixture();
  const created = createGoal(store);
  const updated = store.updateGoalSpec({
    ...created,
    objective: 'Keep every required check green',
    status: 'archived',
  }, 1);
  assert.equal(updated.status, 'active');
  assert.equal(updated.version, 2);
  assert.throws(() => store.updateGoalSpec(updated, 1), /goal_version_conflict/);

  const paused = store.transitionGoal('repo-health', 'paused', 2);
  assert.equal(paused.status, 'paused');
  assert.throws(() => store.transitionGoal('repo-health', 'paused', 2), /goal_version_conflict/);
  assert.throws(() => store.transitionGoal('repo-health', 'archived', 2), /goal_version_conflict/);
  close();
});

test('wake event creates one finite run and duplicate wake is idempotent', () => {
  const { store, close } = createFixture();
  createGoal(store);

  const first = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });
  const duplicate = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });
  assert.equal(first.disposition, 'created');
  assert.equal(first.run.status, 'queued');
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.run.run_id, first.run.run_id);
  close();
});

test('automation upsert preserves goal ownership and fire cursor', () => {
  const { store, close } = createFixture();
  createGoal(store);
  const automation = store.upsertAutomation({
    automation_id: 'auto-health', goal_id: 'repo-health', trigger_type: 'interval',
    trigger_spec: { interval_sec: 60 }, next_fire_at: '2026-06-23T00:01:00.000Z',
  });
  assert.equal(automation.enabled, true);
  assert.deepEqual(automation.trigger_spec, { interval_sec: 60 });
  store.markAutomationFired('auto-health', '2026-06-23T00:01:00.000Z', '2026-06-23T00:02:00.000Z');
  assert.equal(store.listAutomations('repo-health')[0].last_fire_at, '2026-06-23T00:01:00.000Z');

  store.createGoal({ goal_id: 'other', objective: 'other' });
  assert.throws(() => store.upsertAutomation({
    automation_id: 'auto-health', goal_id: 'other', trigger_type: 'manual',
  }), /automation_goal_conflict/);
  close();
});

test('new wake coalesces into the active run', () => {
  const { store, close } = createFixture();
  createGoal(store);

  const first = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });
  const second = store.enqueueWake({ wake_id: 'wake-2', goal_id: 'repo-health' });
  assert.equal(second.disposition, 'coalesced');
  assert.equal(second.run.run_id, first.run.run_id);
  assert.deepEqual(
    store.listRunEvents(first.run.run_id).map(event => event.event_type),
    ['RUN_QUEUED', 'WAKE_COALESCED']
  );
  close();
});

test('wake id reuse with different content is rejected', () => {
  const { store, close } = createFixture();
  createGoal(store);
  store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health', payload: { source: 'a' } });
  assert.throws(() => store.enqueueWake({
    wake_id: 'wake-1',
    goal_id: 'repo-health',
    payload: { source: 'b' },
  }), /wake_id_conflict/);
  close();
});

test('automation wake must belong to the same goal', () => {
  const { controlDb, store, close } = createFixture();
  createGoal(store);
  store.createGoal({ goal_id: 'goal-2', objective: 'other goal' });
  controlDb.run(db => db.prepare(`
    INSERT INTO automations (automation_id, goal_id, trigger_type)
    VALUES ('auto-1', 'goal-2', 'interval')
  `).run());
  assert.throws(() => store.enqueueWake({
    wake_id: 'wake-1',
    goal_id: 'repo-health',
    automation_id: 'auto-1',
    trigger_type: 'interval',
  }), /automation_goal_mismatch/);
  close();
});

test('non-coalescing wake records an explicit active-run rejection', () => {
  const { store, close } = createFixture();
  createGoal(store);
  const first = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });
  const second = store.enqueueWake({ wake_id: 'wake-2', goal_id: 'repo-health', coalesce: false });
  assert.equal(second.disposition, 'rejected_active');
  assert.equal(second.run, null);
  assert.equal(second.active_run_id, first.run.run_id);
  close();
});

test('terminal run permits a later wake to create a new run', () => {
  const { store, close } = createFixture();
  createGoal(store);

  const first = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });
  store.transitionRun(first.run.run_id, 'cancelled', { expectedVersion: first.run.version });
  const second = store.enqueueWake({ wake_id: 'wake-2', goal_id: 'repo-health' });
  assert.equal(second.disposition, 'created');
  assert.notEqual(second.run.run_id, first.run.run_id);
  close();
});

test('run transition enforces state and optimistic version', () => {
  const { store, close } = createFixture();
  createGoal(store);
  const { run } = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });

  const planning = store.transitionRun(run.run_id, 'planning', { expectedVersion: 1 });
  assert.equal(planning.version, 2);
  assert.throws(() => store.transitionRun(run.run_id, 'planning', { expectedVersion: 1 }), /run_version_conflict/);
  assert.throws(() => store.transitionRun(run.run_id, 'planning'), /run_expected_version_required/);
  assert.throws(() => store.transitionRun(run.run_id, 'executing', { expectedVersion: 1 }), /run_version_conflict/);
  assert.throws(() => store.transitionRun(run.run_id, 'succeeded', { expectedVersion: planning.version }), /execution_command_required/);
  close();
});

test('paused goal rejects wake events without creating a run', () => {
  const { store, close } = createFixture();
  createGoal(store, { status: 'paused' });
  assert.throws(() => store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' }), /goal_not_active:paused/);
  close();
});

test('generic transition cannot mutate execution-owned states', () => {
  const { store, close } = createFixture();
  createGoal(store);
  const { run } = store.enqueueWake({ wake_id: 'wake-1', goal_id: 'repo-health' });
  const planning = store.transitionRun(run.run_id, 'planning', { expectedVersion: run.version });
  assert.throws(() => store.transitionRun(run.run_id, 'executing', { expectedVersion: planning.version }), /execution_command_required/);
  assert.throws(() => store.transitionRun(run.run_id, 'retry_wait', { expectedVersion: planning.version }), /execution_command_required/);
  close();
});
