'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createControlDb } = require('./control-db');
const { createLoopStore } = require('./loop-store');
const { createLoopExecutionStore } = require('./loop-execution-store');
const { createLoopGovernanceStore } = require('./loop-governance-store');

function fixture() {
  const dbPath = path.join(os.tmpdir(), `metame-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const controlDb = createControlDb({ dbPath });
  let id = 0;
  const common = {
    controlDb,
    now: () => new Date('2026-06-23T00:00:00.000Z'),
    newId: prefix => `${prefix}_${++id}`,
  };
  const loop = createLoopStore(common);
  const execution = createLoopExecutionStore(common);
  const governance = createLoopGovernanceStore(common);
  loop.createGoal({
    goal_id: 'goal-1',
    objective: 'finish with evidence',
    verification_spec: { command: 'node --test' },
  });
  const queued = loop.enqueueWake({ wake_id: 'wake-1', goal_id: 'goal-1' }).run;
  const planning = loop.transitionRun(queued.run_id, 'planning', { expectedVersion: queued.version });
  const close = () => {
    controlDb.close();
    for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  };
  return {
    controlDb,
    loop,
    execution,
    governance,
    planning,
    owner: { bootId: 'boot-a', pid: 123 },
    close,
  };
}

test('execution ownership and heartbeat require the same boot and pid', () => {
  const { execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  assert.equal(running.status, 'executing');
  assert.equal(running.execution_boot_id, 'boot-a');
  assert.doesNotThrow(() => execution.heartbeatExecution(running.run_id, { bootId: 'boot-a', pid: 123 }));
  assert.throws(() => execution.heartbeatExecution(running.run_id, { bootId: 'boot-b', pid: 123 }), /execution_owner_mismatch/);
  assert.throws(() => execution.startExecution(
    running.run_id,
    { owner: { bootId: 'intruder', pid: 456 }, expectedVersion: running.version }
  ), /run_not_startable:executing/);
  close();
});

test('execution stop requires the current owner', () => {
  const { execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  assert.throws(() => execution.stopExecution(running.run_id, 'cancelled', {
    expectedVersion: running.version,
    owner: { bootId: 'old', pid: 999 },
  }), /execution_owner_mismatch/);
  const stopped = execution.stopExecution(running.run_id, 'cancelled', {
    expectedVersion: running.version,
    owner,
  });
  assert.equal(stopped.status, 'cancelled');
  close();
});

test('stopping a run interrupts its attempt and rejects late maker output', () => {
  const { controlDb, loop, execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  const attempt = execution.startAttempt(running.run_id, { engine: 'codex' }, {
    owner,
    expectedVersion: running.version,
  });
  const stopped = execution.stopExecution(running.run_id, 'cancelled', {
    owner,
    expectedVersion: loop.getRun(running.run_id).version,
  });
  assert.equal(stopped.status, 'cancelled');
  assert.throws(() => execution.markCandidateComplete(attempt.attempt_id, { late: true }, owner),
    /attempt_not_running:interrupted/);
  const stored = controlDb.run(db => db.prepare(
    'SELECT * FROM run_attempts WHERE attempt_id = ?'
  ).get(attempt.attempt_id));
  assert.equal(stored.status, 'interrupted');
  close();
});

test('attempt and verifier result are bound atomically to the current attempt', () => {
  const { loop, execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  const attempt = execution.startAttempt(running.run_id, {
    engine: 'codex',
    verificationSpecHash: 'spec-1',
    workspaceRevision: 'abc123',
  }, { expectedVersion: running.version, owner });
  execution.markCandidateComplete(attempt.attempt_id, { status: 'candidate_complete' }, owner);
  const beforeVerify = loop.getRun(running.run_id);
  const verifying = execution.beginVerification(running.run_id, attempt.attempt_id, {
    expectedVersion: beforeVerify.version,
    owner,
  });
  const completed = execution.completeVerification(running.run_id, attempt.attempt_id, {
    passed: true,
    checks: ['test'],
    evidence: [{ command: 'node --test', exit_code: 0 }],
  }, { expectedVersion: verifying.version, owner });

  assert.equal(completed.run.status, 'succeeded');
  assert.equal(completed.passed, true);
  const evidence = loop.listRunEvents(running.run_id).find(event => event.event_type === 'VERIFIER_PASSED');
  assert.equal(evidence.payload.attempt_id, attempt.attempt_id);
  assert.match(evidence.payload.verification_spec_hash, /^[a-f0-9]{64}$/);
  assert.equal(evidence.payload.workspace_revision, 'none');
  close();
});

test('failed verification enters retry wait and cannot reuse stale attempt', () => {
  const { loop, execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  const attempt = execution.startAttempt(running.run_id, {
    engine: 'claude',
    verificationSpecHash: 'spec-1',
    workspaceRevision: 'none',
  }, { expectedVersion: running.version, owner });
  execution.markCandidateComplete(attempt.attempt_id, {}, owner);
  const verifying = execution.beginVerification(running.run_id, attempt.attempt_id, {
    expectedVersion: loop.getRun(running.run_id).version,
    owner,
  });
  const failed = execution.completeVerification(running.run_id, attempt.attempt_id, {
    passed: false,
    failures: ['test failed'],
  }, { expectedVersion: verifying.version, owner });
  assert.equal(failed.run.status, 'retry_wait');
  assert.throws(() => execution.completeVerification(
    running.run_id,
    attempt.attempt_id,
    { passed: true, checks: ['test'], evidence: ['ok'] },
    { expectedVersion: failed.run.version, owner }
  ), /invalid_run_transition|attempt_not_verifying/);
  assert.throws(() => loop.transitionRun(failed.run.run_id, 'cancelled', {
    expectedVersion: failed.run.version,
  }), /execution_command_required/);
  assert.throws(() => execution.startExecution(failed.run.run_id, {
    owner: { bootId: 'intruder', pid: 456 },
    expectedVersion: failed.run.version,
  }), /execution_owner_mismatch/);
  const resumed = execution.startExecution(failed.run.run_id, {
    owner,
    expectedVersion: failed.run.version,
  });
  assert.equal(resumed.status, 'executing');
  close();
});

test('awaiting approval starts only with a current approved action scope', () => {
  const { loop, execution, governance, planning, owner, close } = fixture();
  const awaiting = loop.transitionRun(planning.run_id, 'awaiting_approval', {
    expectedVersion: planning.version,
  });
  const plan = governance.submitPlan(awaiting.run_id, { action: 'push' }, 'R3', 'git:push');
  governance.decideApproval(plan.approval_id, 'approved', 'user-1');

  assert.throws(() => execution.startExecution(awaiting.run_id, {
    owner,
    expectedVersion: awaiting.version,
  }), /approval_scope_required/);
  assert.throws(() => execution.startExecution(awaiting.run_id, {
    owner,
    expectedVersion: awaiting.version,
    approvalScope: 'shell:root',
  }), /valid_approval_required/);
  const replacement = governance.submitPlan(awaiting.run_id, { action: 'push safely' }, 'R3', 'git:push');
  assert.throws(() => execution.startExecution(awaiting.run_id, {
    owner,
    expectedVersion: awaiting.version,
    approvalScope: 'git:push',
  }), /valid_approval_required/);
  governance.decideApproval(replacement.approval_id, 'approved', 'user-1');
  const running = execution.startExecution(awaiting.run_id, {
    owner,
    expectedVersion: awaiting.version,
    approvalScope: 'git:push',
  });
  assert.equal(running.status, 'executing');
  close();
});

test('stale execution owner cannot mutate an attempt', () => {
  const { execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  const staleOwner = { bootId: 'old-boot', pid: 999 };
  assert.throws(() => execution.startAttempt(running.run_id, {
    engine: 'codex',
    verificationSpecHash: 'spec-1',
    workspaceRevision: 'none',
  }, { expectedVersion: running.version, owner: staleOwner }), /execution_owner_mismatch/);

  const attempt = execution.startAttempt(running.run_id, {
    engine: 'codex',
    verificationSpecHash: 'spec-1',
    workspaceRevision: 'none',
  }, { expectedVersion: running.version, owner });
  assert.throws(() => execution.markCandidateComplete(attempt.attempt_id, {}, staleOwner), /execution_owner_mismatch/);
  close();
});

test('daemon restart interrupts stale attempt and makes retry claimable by the new boot', () => {
  const { loop, execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, { owner, expectedVersion: planning.version });
  const attempt = execution.startAttempt(running.run_id, { engine: 'codex' }, {
    owner,
    expectedVersion: running.version,
  });
  assert.deepEqual(execution.recoverInterruptedExecutions('boot-b'), [running.run_id]);
  const recovered = loop.getRun(running.run_id);
  assert.equal(recovered.status, 'retry_wait');
  assert.equal(recovered.execution_boot_id, null);
  const resumed = execution.startExecution(running.run_id, {
    owner: { bootId: 'boot-b', pid: 456 },
    expectedVersion: recovered.version,
  });
  assert.equal(resumed.execution_boot_id, 'boot-b');
  assert.throws(() => execution.markCandidateComplete(attempt.attempt_id, {}, owner), /attempt_not_running:interrupted/);
  close();
});

test('verifier success requires checks, evidence, spec hash and workspace revision', () => {
  const { loop, execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  const attempt = execution.startAttempt(running.run_id, {
    engine: 'codex',
    verificationSpecHash: 'spec-1',
    workspaceRevision: 'none',
  }, { expectedVersion: running.version, owner });
  execution.markCandidateComplete(attempt.attempt_id, {}, owner);
  const verifying = execution.beginVerification(running.run_id, attempt.attempt_id, {
    expectedVersion: loop.getRun(running.run_id).version,
    owner,
  });
  assert.throws(() => execution.completeVerification(
    running.run_id,
    attempt.attempt_id,
    { passed: true },
    { expectedVersion: verifying.version, owner }
  ), /verifier_checks_required/);
  assert.equal(loop.getRun(running.run_id).status, 'verifying');
  close();
});

test('modified verifier evidence blocks the Run instead of retrying', () => {
  const { loop, execution, planning, owner, close } = fixture();
  const running = execution.startExecution(planning.run_id, { owner, expectedVersion: planning.version });
  const attempt = execution.startAttempt(running.run_id, { engine: 'codex' }, {
    expectedVersion: running.version, owner,
  });
  execution.markCandidateComplete(attempt.attempt_id, {}, owner);
  const verifying = execution.beginVerification(running.run_id, attempt.attempt_id, {
    expectedVersion: loop.getRun(running.run_id).version, owner,
  });
  const completed = execution.completeVerification(running.run_id, attempt.attempt_id, {
    passed: false,
    failures: ['verifier_modified:scripts/verifier.js'],
    evidence: [{ modified_paths: ['scripts/verifier.js'] }],
    verifier_modified: true,
  }, { expectedVersion: verifying.version, owner });
  assert.equal(completed.run.status, 'blocked');
  close();
});

test('worktree attempt requires the Run base revision', () => {
  const { loop, execution, planning, owner, close } = fixture();
  const goal = loop.getGoal('goal-1');
  loop.updateGoalSpec({
    ...goal,
    execution_spec: { workspace: 'worktree' },
  }, goal.version);
  let running = execution.startExecution(planning.run_id, {
    owner,
    expectedVersion: planning.version,
  });
  assert.throws(() => execution.startAttempt(running.run_id, { engine: 'codex' }, {
    expectedVersion: running.version,
    owner,
  }), /workspace_revision_required/);

  execution.stopExecution(running.run_id, 'cancelled', {
    owner,
    expectedVersion: running.version,
  });
  const next = loop.enqueueWake({ wake_id: 'wake-next', goal_id: 'goal-1' }).run;
  const nextPlanning = loop.transitionRun(next.run_id, 'planning', { expectedVersion: next.version });
  const assigned = execution.recordWorkspace(nextPlanning.run_id, {
    workspaceId: 'run-worktree', baseRevision: 'abc123', strategy: 'external_worktree',
  }, nextPlanning.version);
  running = execution.startExecution(assigned.run_id, {
    owner,
    expectedVersion: assigned.version,
  });
  const attempt = execution.startAttempt(running.run_id, { engine: 'codex' }, {
    expectedVersion: running.version,
    owner,
  });
  assert.equal(attempt.workspace_revision, 'abc123');
  close();
});
