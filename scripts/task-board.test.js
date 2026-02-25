'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createTaskBoard } = require('./task-board');

function newTmpDbPath() {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `metame-task-board-${Date.now()}-${rand}.db`);
}

test('task board upsert/get/list/status flow', () => {
  const dbPath = newTmpDbPath();
  const board = createTaskBoard({ dbPath });
  const taskId = 't_test_001';

  const up = board.upsertTask({
    task_id: taskId,
    scope_id: 'scope_alpha',
    from_agent: 'assistant',
    to_agent: 'coder',
    goal: 'run tests',
    task_kind: 'team',
    participants: ['assistant', 'coder'],
    definition_of_done: ['all tests pass'],
    inputs: { cwd: '/tmp/project' },
    priority: 'high',
    status: 'queued',
    created_at: '2026-02-25T00:00:00.000Z',
    updated_at: '2026-02-25T00:00:00.000Z',
  });
  assert.equal(up.ok, true);

  const got = board.getTask(taskId);
  assert.ok(got);
  assert.equal(got.task_kind, 'team');
  assert.equal(got.scope_id, 'scope_alpha');
  assert.equal(got.goal, 'run tests');
  assert.deepEqual(got.definition_of_done, ['all tests pass']);
  assert.deepEqual(got.participants, ['assistant', 'coder']);

  const ev = board.appendTaskEvent(taskId, 'dispatch_enqueued', 'assistant', { x: 1 });
  assert.equal(ev.ok, true);
  const events = board.listTaskEvents(taskId, 5);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, 'dispatch_enqueued');

  const st = board.markTaskStatus(taskId, 'done', { summary: 'ok', artifacts: ['/tmp/log.txt'] });
  assert.equal(st.ok, true);
  const done = board.getTask(taskId);
  assert.equal(done.status, 'done');
  assert.equal(done.summary, 'ok');
  assert.deepEqual(done.artifacts, ['/tmp/log.txt']);

  const recent = board.listRecentTasks(5, null, 'team');
  assert.ok(recent.some(t => t.task_id === taskId));

  const up2 = board.upsertTask({
    task_id: 't_test_002',
    scope_id: 'scope_alpha',
    from_agent: 'coder',
    to_agent: 'reviewer',
    goal: 'review test results',
    task_kind: 'team',
    participants: ['coder', 'reviewer'],
    status: 'queued',
    priority: 'normal',
    created_at: '2026-02-25T00:01:00.000Z',
    updated_at: '2026-02-25T00:01:00.000Z',
  });
  assert.equal(up2.ok, true);
  const scoped = board.listScopeTasks('scope_alpha', 10);
  assert.equal(scoped.length >= 2, true);
  const participants = board.listScopeParticipants('scope_alpha');
  assert.deepEqual(participants.sort(), ['assistant', 'coder', 'reviewer'].sort());

  board.close();
  try { fs.unlinkSync(dbPath); } catch {}
});
