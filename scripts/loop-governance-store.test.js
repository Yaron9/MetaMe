'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createControlDb } = require('./control-db');
const { createLoopStore } = require('./loop-store');
const { createLoopGovernanceStore, _internal } = require('./loop-governance-store');

function fixture() {
  const dbPath = path.join(os.tmpdir(), `metame-govern-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const controlDb = createControlDb({ dbPath });
  let id = 0;
  const common = {
    controlDb,
    now: () => new Date('2026-06-23T00:00:00.000Z'),
    newId: prefix => `${prefix}_${++id}`,
  };
  const loop = createLoopStore(common);
  const governance = createLoopGovernanceStore(common);
  loop.createGoal({ goal_id: 'goal-1', objective: 'govern safely' });
  const run = loop.enqueueWake({ wake_id: 'wake-1', goal_id: 'goal-1' }).run;
  const close = () => {
    controlDb.close();
    for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  };
  return { controlDb, loop, governance, run, close };
}

test('plan hash is stable and approval is bound to that plan', () => {
  const { governance, run, close } = fixture();
  assert.equal(_internal.hashPlan({ b: 2, a: 1 }), _internal.hashPlan({ a: 1, b: 2 }));

  const submitted = governance.submitPlan(run.run_id, { action: 'push' }, 'R3', 'git:push');
  assert.ok(submitted.approval_id);
  const decided = governance.decideApproval(submitted.approval_id, 'approved', 'user-1');
  assert.equal(decided.status, 'approved');
  assert.equal(decided.plan_hash, submitted.plan_hash);
  assert.equal(governance.hasValidApproval(run.run_id, submitted.plan_hash, 'git:push'), true);
  assert.throws(() => governance.decideApproval(submitted.approval_id, 'approved', 'user-1'), /approval_already_decided/);
  close();
});

test('approval cannot authorize a superseded plan', () => {
  const { governance, run, close } = fixture();
  const old = governance.submitPlan(run.run_id, { action: 'old' }, 'R3', 'git:push');
  governance.decideApproval(old.approval_id, 'approved', 'user-1');
  assert.equal(governance.hasValidApproval(run.run_id, old.plan_hash, 'git:push'), true);
  governance.submitPlan(run.run_id, { action: 'new' }, 'R3', 'git:push');
  assert.equal(governance.hasValidApproval(run.run_id, old.plan_hash, 'git:push'), false);
  assert.throws(() => governance.decideApproval(old.approval_id, 'approved', 'user-1'), /approval_already_decided:revoked/);
  close();
});

test('usage ledger enforces goal and run references', () => {
  const { loop, governance, run, close } = fixture();
  const usage = governance.recordUsage({
    goalId: 'goal-1',
    runId: run.run_id,
    engine: 'codex',
    inputTokens: 100,
    outputTokens: 20,
  });
  assert.ok(usage.usage_id > 0);
  assert.deepEqual(governance.getRunUsage(run.run_id), {
    input_tokens: 100,
    output_tokens: 20,
    cost_micros: 0,
  });
  assert.throws(() => governance.recordUsage({ goalId: 'missing', engine: 'codex' }), /goal_not_found/);
  loop.createGoal({ goal_id: 'goal-2', objective: 'other' });
  const otherRun = loop.enqueueWake({ wake_id: 'wake-2', goal_id: 'goal-2' }).run;
  assert.throws(() => governance.recordUsage({
    goalId: 'goal-1',
    runId: otherRun.run_id,
    engine: 'codex',
  }), /usage_goal_run_mismatch/);
  close();
});

test('outbox deduplicates identical messages and rejects key reuse', () => {
  const { governance, close } = fixture();
  const first = governance.enqueueOutbox('notify', 'run-1:done', { ok: true });
  const duplicate = governance.enqueueOutbox('notify', 'run-1:done', { ok: true });
  assert.equal(duplicate.outbox_id, first.outbox_id);
  assert.throws(() => governance.enqueueOutbox('notify', 'run-1:done', { ok: false }), /outbox_dedupe_conflict/);

  assert.equal(governance.listPendingOutbox().length, 1);
  governance.markOutboxDelivered(first.outbox_id);
  assert.equal(governance.listPendingOutbox().length, 0);
  close();
});

test('run transition and outbox write commit or roll back together', () => {
  const { loop, governance, run, close } = fixture();
  const cancelled = loop.transitionRun(run.run_id, 'cancelled', {
    expectedVersion: run.version,
    outbox: { topic: 'notify', dedupeKey: `${run.run_id}:cancelled`, payload: { status: 'cancelled' } },
  });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(governance.listPendingOutbox()[0].payload.status, 'cancelled');
  close();
});

test('run projection rebuilds human-facing state from control tables', () => {
  const { loop, governance, run, close } = fixture();
  governance.submitPlan(run.run_id, { action: 'inspect' }, 'R0');
  governance.recordUsage({ goalId: 'goal-1', runId: run.run_id, engine: 'codex', inputTokens: 5 });
  loop.transitionRun(run.run_id, 'cancelled', {
    expectedVersion: run.version,
    outbox: { topic: 'notify', dedupeKey: `${run.run_id}:cancelled`, payload: { status: 'cancelled' } },
  });
  const projection = loop.getRunProjection(run.run_id);
  assert.equal(projection.run.run_id, run.run_id);
  assert.equal(projection.wakes.length, 1);
  assert.equal(projection.plans.length, 1);
  assert.equal(projection.usage.length, 1);
  assert.equal(projection.outbox.length, 1);
  assert.equal(projection.outbox[0].payload.status, 'cancelled');
  assert.ok(projection.events.length >= 1);
  close();
});

test('outbox conflict rolls back the associated run transition', () => {
  const { loop, governance, run, close } = fixture();
  governance.enqueueOutbox('notify', 'shared-key', { status: 'old' });
  assert.throws(() => loop.transitionRun(run.run_id, 'cancelled', {
    expectedVersion: run.version,
    outbox: { topic: 'notify', dedupeKey: 'shared-key', payload: { status: 'new' } },
  }), /UNIQUE/);
  assert.equal(loop.getRun(run.run_id).status, 'queued');
  close();
});
