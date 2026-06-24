'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceBroker } = require('./daemon-workspace-broker');

test('workspace broker creates a run-scoped worktree with base revision evidence', () => {
  const calls = [];
  const broker = createWorkspaceBroker({
    worktreeUtils: {
      getOrCreateWorktree(cwd, key) { calls.push({ cwd, key }); return `/tmp/${key}`; },
    },
    execFileSync: () => 'abc123\n',
  });
  const workspace = broker.prepare({ mode: 'worktree', runId: 'run-1', cwd: '/repo' });
  assert.deepEqual(calls, [{ cwd: '/repo', key: 'run_run-1' }]);
  assert.equal(workspace.cwd, '/tmp/run_run-1');
  assert.equal(workspace.workspaceId, '/tmp/run_run-1');
  assert.equal(workspace.baseRevision, 'abc123');
  assert.equal(workspace.cleanup, 'retain_until_reconciled');
});

test('workspace broker keeps non-code goals in their directory', () => {
  const broker = createWorkspaceBroker({
    worktreeUtils: { getOrCreateWorktree() { throw new Error('unused'); } },
    execFileSync: () => { throw new Error('not git'); },
  });
  const workspace = broker.prepare({ mode: 'directory', cwd: '/notes' });
  assert.equal(workspace.strategy, 'directory');
  assert.equal(workspace.baseRevision, 'none');
});
