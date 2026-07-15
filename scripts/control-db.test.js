'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createControlDb, CONTROL_SCHEMA_VERSION, _internal } = require('./control-db');

function newTmpDbPath() {
  return path.join(os.tmpdir(), `metame-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

function cleanup(dbPath) {
  for (const suffix of ['', '-wal', '-shm', `.pre-control-v${CONTROL_SCHEMA_VERSION}.bak`]) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
}

test('control DB owns pragmas and creates only the generic task-board schema', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });
  const state = controlDb.run(db => ({
    foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name),
  }));
  assert.equal(state.foreignKeys, 1);
  assert.equal(state.journalMode, 'wal');
  for (const table of ['tasks', 'handoffs', 'task_events', 'control_migrations']) assert.ok(state.tables.includes(table));
  for (const legacy of ['goals', 'runs', 'approvals', 'loop_events', 'outbox']) assert.equal(state.tables.includes(legacy), false);
  controlDb.close();
  cleanup(dbPath);
});

test('control DB transaction rolls back all writes on failure', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });
  assert.throws(() => controlDb.transaction(db => {
    db.prepare('INSERT INTO tasks (task_id, from_agent, to_agent, goal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('t_rollback', 'a', 'b', 'rollback', '2026-01-01', '2026-01-01');
    throw new Error('stop');
  }), /stop/);
  assert.equal(controlDb.run(db => db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get('t_rollback')), undefined);
  controlDb.close();
  cleanup(dbPath);
});

test('control DB rejects async transaction callbacks before execution', () => {
  const controlDb = createControlDb({ dbPath: newTmpDbPath() });
  assert.throws(() => controlDb.transaction(async () => 'nope'), /must be synchronous/);
  const dbPath = controlDb.dbPath;
  controlDb.close();
  cleanup(dbPath);
});

test('control DB versions and backs up an existing schema before migration', () => {
  const dbPath = newTmpDbPath();
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(dbPath);
  _internal.migrateTaskBoardSchema(legacy);
  legacy.close();
  const controlDb = createControlDb({ dbPath });
  assert.equal(controlDb.run(db => db.prepare('PRAGMA user_version').get().user_version), CONTROL_SCHEMA_VERSION);
  assert.equal(fs.existsSync(`${dbPath}.pre-control-v${CONTROL_SCHEMA_VERSION}.bak`), true);
  controlDb.close();
  cleanup(dbPath);
});

test('control DB rejects orphan task relations', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });
  assert.throws(() => controlDb.run(db => db.prepare(`
    INSERT INTO task_events (task_id, event_type, actor, created_at) VALUES (?, ?, ?, ?)
  `).run('missing', 'bad', 'test', '2026-01-01')), /event task does not exist|FOREIGN KEY/);
  controlDb.close();
  cleanup(dbPath);
});

test('control migrations do not trust an unrelated high user_version', () => {
  const dbPath = newTmpDbPath();
  const { DatabaseSync } = require('node:sqlite');
  const foreign = new DatabaseSync(dbPath);
  foreign.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY); PRAGMA user_version = 99');
  foreign.close();
  const controlDb = createControlDb({ dbPath });
  const state = controlDb.run(db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    tasks: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get(),
    migrations: db.prepare('SELECT version FROM control_migrations ORDER BY version').all(),
  }));
  assert.equal(state.version, 99);
  assert.ok(state.tasks);
  assert.deepEqual(state.migrations.map(row => row.version), [CONTROL_SCHEMA_VERSION]);
  controlDb.close();
  cleanup(dbPath);
});

test('migration ledger does not hide a missing task-board object', () => {
  const dbPath = newTmpDbPath();
  const first = createControlDb({ dbPath });
  first.run(db => db.exec('DROP INDEX idx_tasks_scope_id'));
  first.close();
  const repaired = createControlDb({ dbPath });
  assert.ok(repaired.run(db => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_tasks_scope_id'").get()));
  repaired.close();
  cleanup(dbPath);
});

test('control DB retries transient busy errors', () => {
  let attempts = 0;
  const result = _internal.runSqliteWithRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      const err = new Error('database is locked');
      err.code = 'SQLITE_BUSY';
      throw err;
    }
    return 'ok';
  }, { maxRetries: 3, baseDelayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});
