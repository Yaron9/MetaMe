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
const { createLoopCoordinator } = require('./daemon-loop-coordinator');

test('coordinator alone can promote verifier evidence to succeeded', async () => {
  const dbPath = path.join(os.tmpdir(), `metame-coordinate-${Date.now()}-${Math.random()}.db`);
  const controlDb = createControlDb({ dbPath });
  let id = 0;
  const common = { controlDb, newId: prefix => `${prefix}_${++id}` };
  const loopStore = createLoopStore(common);
  const executionStore = createLoopExecutionStore(common);
  const governanceStore = createLoopGovernanceStore(common);
  loopStore.createGoal({
    goal_id: 'goal-1', objective: 'make it pass', cwd: '/repo',
    execution_spec: { engine: 'codex', workspace: 'directory' },
    verification_spec: { command: 'node --test' },
  });
  const run = loopStore.enqueueWake({ wake_id: 'wake-1', goal_id: 'goal-1' }).run;
  let makerOptions = null;
  const coordinator = createLoopCoordinator({
    loopStore, executionStore, governanceStore,
    bootId: 'boot-1', pid: 123,
    workspaceBroker: {
      prepare: () => ({ strategy: 'directory', workspaceId: '/repo', cwd: '/repo', baseRevision: 'abc123' }),
    },
    backgroundRunner: {
      startTurn: async options => {
        makerOptions = options;
        return ({
        ok: true,
        result: { status: 'candidate_complete', summary: 'done', artifacts: [], claims: ['tests'], next: null },
        usage: { input_tokens: 10, output_tokens: 5 },
        });
      },
    },
    verifier: {
      verify: async () => ({
        passed: true, checks: ['test'], failures: [],
        evidence: [{ command: 'node --test', passed: true }], retryable: false, infra_failure: false,
      }),
    },
  });
  const completed = await coordinator.runOnce(run.run_id);
  assert.equal(completed.run.status, 'succeeded');
  const projection = loopStore.getRunProjection(run.run_id);
  assert.equal(projection.attempts[0].status, 'succeeded');
  assert.equal(projection.usage[0].engine, 'codex');
  assert.equal(projection.outbox[0].topic, 'loop.completed');
  assert.equal(makerOptions.readOnly, true);
  assert.equal(makerOptions.permissions.sandboxMode, 'read-only');
  controlDb.close();
  for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
});
