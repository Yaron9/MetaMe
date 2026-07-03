'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createControlDb } = require('./control-db');
const { createLoopStore } = require('./loop-store');
const { createLoopTriggerAdapter, _internal } = require('./daemon-loop-triggers');

function fixture() {
  const dbPath = path.join(os.tmpdir(), `metame-trigger-${Date.now()}-${Math.random()}.db`);
  const controlDb = createControlDb({ dbPath });
  const loopStore = createLoopStore({ controlDb, now: () => new Date('2026-06-23T09:00:03.000Z') });
  const adapter = createLoopTriggerAdapter({ loopStore, now: () => new Date('2026-06-23T09:00:03.000Z') });
  const close = () => {
    controlDb.close();
    for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
      try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
    }
  };
  return { loopStore, adapter, close };
}

test('legacy task compiles deterministically without writing config', () => {
  const task = { name: 'daily', prompt: 'report', _project: { key: 'meta' } };
  const schedule = { mode: 'clock', hour: 9, minute: 0, days: new Set([1, 2]) };
  assert.deepEqual(_internal.compileLegacyTask(task, schedule), _internal.compileLegacyTask(task, schedule));
});

test('same scheduled tick creates one finite compatibility Run', () => {
  const { loopStore, adapter, close } = fixture();
  const task = { name: 'daily', prompt: 'report' };
  const schedule = { mode: 'interval', intervalSec: 60 };
  const first = adapter.beginScheduledTask(task, schedule, Date.parse('2026-06-23T09:00:00Z'), Date.parse('2026-06-23T09:01:00Z'));
  const duplicate = adapter.beginScheduledTask(task, schedule, Date.parse('2026-06-23T09:00:00Z'), Date.parse('2026-06-23T09:01:00Z'));
  assert.equal(first.shouldExecute, true);
  assert.equal(duplicate.shouldExecute, false);
  const terminal = adapter.completeScheduledTask(first, { success: true });
  assert.equal(terminal.status, 'skipped');
  assert.equal(loopStore.listAutomations(first.goal_id)[0].last_fire_at, '2026-06-23T09:00:00.000Z');
  close();
});

test('manual trigger is idempotent when the caller supplies a key', () => {
  const { loopStore, adapter, close } = fixture();
  loopStore.createGoal({ goal_id: 'manual-goal', objective: 'run manually' });
  const first = adapter.triggerManual('manual-goal', { force: true }, 'request-1');
  const duplicate = adapter.triggerManual('manual-goal', { force: true }, 'request-1');
  assert.equal(first.run.run_id, duplicate.run.run_id);
  assert.equal(duplicate.duplicate, true);
  close();
});
