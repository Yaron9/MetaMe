'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { defaultPaths, planRetirement, applyRetirement, restoreRetirement } = require('./retire-perpetual');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-retire-'));
  const paths = defaultPaths(home);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.config, yaml.dump({
    loop: { enabled: true },
    projects: {
      scientist: { reactive: true },
      metame_ops: { reactive: true, heartbeat_tasks: [{ name: 'ops-scan' }, { name: 'keep-me' }] },
    },
  }));
  fs.writeFileSync(paths.state, JSON.stringify({ reactive: { scientist: { status: 'active' } }, tasks: { 'ops-scan': { status: 'success' }, keep: { status: 'success' } }, sessions: { keep: true } }));
  fs.mkdirSync(paths.reactive, { recursive: true });
  fs.writeFileSync(path.join(paths.reactive, 'events.jsonl'), '{}\n');
  fs.mkdirSync(path.dirname(paths.missions), { recursive: true });
  fs.writeFileSync(paths.missions, '# stale mission\n');

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(paths.taskDb);
  db.exec(`
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL DEFAULT '', parent_task_id TEXT,
      goal_id TEXT, run_id TEXT, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      goal TEXT NOT NULL, task_kind TEXT NOT NULL DEFAULT 'team', participants TEXT NOT NULL DEFAULT '[]',
      definition_of_done TEXT NOT NULL DEFAULT '[]', inputs TEXT NOT NULL DEFAULT '{}', artifacts TEXT NOT NULL DEFAULT '[]',
      owned_paths TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'queued', priority TEXT NOT NULL DEFAULT 'normal',
      summary TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE handoffs (handoff_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'sent', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, event_type TEXT NOT NULL, actor TEXT NOT NULL, body TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE goals (goal_id TEXT PRIMARY KEY);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE outbox (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
  `);
  const insertTask = db.prepare(`INSERT INTO tasks
    (task_id,scope_id,from_agent,to_agent,goal,task_kind,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  insertTask.run('keep', 'keep', 'a', 'b', 'normal work', 'team', '2026-01-01', '2026-01-01');
  insertTask.run('drop', 'drop', 'a', 'b', 'old forever work', 'perpetual', '2026-01-01', '2026-01-01');
  db.prepare('INSERT INTO task_events (task_id,event_type,actor,created_at) VALUES (?,?,?,?)').run('keep', 'created', 'a', '2026-01-01');
  db.prepare('INSERT INTO task_events (task_id,event_type,actor,created_at) VALUES (?,?,?,?)').run('drop', 'created', 'a', '2026-01-01');
  db.prepare('INSERT INTO runs (run_id,status) VALUES (?,?)').run('old-run', 'completed');
  db.close();
  return { home, paths };
}

test('retirement plan distinguishes removable control records from knowledge assets', () => {
  const f = fixture();
  const plan = planRetirement(f.paths);
  assert.equal(plan.database.perpetualTasks, 1);
  assert.equal(plan.database.reactiveMemoryRows, 0);
  assert.deepEqual(plan.config.reactiveProjects.sort(), ['metame_ops', 'scientist']);
  assert.equal(Object.hasOwn(plan.paths, 'memoryDb'), true);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('retirement backs up, removes legacy state, and preserves generic task-board data', () => {
  const f = fixture();
  const result = applyRetirement(f.paths);
  assert.ok(fs.existsSync(path.join(result.backupRoot, 'manifest.json')));
  assert.ok(fs.existsSync(path.join(result.backupRoot, 'exports', 'goals.jsonl')));
  const config = yaml.load(fs.readFileSync(f.paths.config, 'utf8'));
  assert.equal(Object.hasOwn(config, 'loop'), false);
  assert.equal(Object.hasOwn(config.projects.scientist, 'reactive'), false);
  assert.deepEqual(config.projects.metame_ops.heartbeat_tasks.map(task => task.name), ['keep-me']);
  assert.equal(fs.existsSync(f.paths.reactive), false);
  assert.equal(fs.existsSync(f.paths.missions), false);
  const state = JSON.parse(fs.readFileSync(f.paths.state, 'utf8'));
  assert.equal(Object.hasOwn(state.tasks, 'ops-scan'), false);
  assert.equal(state.tasks.keep.status, 'success');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.paths.taskDb, { readOnly: true });
  assert.deepEqual(db.prepare('SELECT task_id FROM tasks ORDER BY task_id').all().map(row => row.task_id), ['keep']);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'").get(), undefined);
  assert.equal(db.prepare('PRAGMA table_info(tasks)').all().some(row => row.name === 'run_id'), false);
  db.close();

  fs.writeFileSync(`${f.paths.taskDb}-wal`, 'stale');
  fs.writeFileSync(`${f.paths.taskDb}-shm`, 'stale');
  restoreRetirement(result.backupRoot, f.paths);
  assert.equal(fs.existsSync(`${f.paths.taskDb}-wal`), false);
  assert.equal(fs.existsSync(`${f.paths.taskDb}-shm`), false);
  const restored = new DatabaseSync(f.paths.taskDb, { readOnly: true });
  assert.ok(restored.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'").get());
  restored.close();
  assert.equal(yaml.load(fs.readFileSync(f.paths.config, 'utf8')).loop.enabled, true);
  fs.rmSync(f.home, { recursive: true, force: true });
});

test('retirement refuses live daemon and unfinished loop work', () => {
  const f = fixture();
  fs.writeFileSync(f.paths.pid, String(process.pid));
  assert.throws(() => applyRetirement(f.paths), /daemon_is_running/);
  fs.unlinkSync(f.paths.pid);
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f.paths.taskDb);
  db.prepare('INSERT INTO runs (run_id,status) VALUES (?,?)').run('active', 'executing');
  db.close();
  assert.throws(() => applyRetirement(f.paths), /active_loop_runs:1/);
  fs.rmSync(f.home, { recursive: true, force: true });
});
