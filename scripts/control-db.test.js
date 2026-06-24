'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createControlDb, _internal } = require('./control-db');

function newTmpDbPath() {
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(os.tmpdir(), `metame-control-${Date.now()}-${rand}.db`);
}

test('control DB owns pragmas and task board schema', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });

  const state = controlDb.run(db => ({
    foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
    journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name),
  }));

  assert.equal(state.foreignKeys, 1);
  assert.equal(state.journalMode, 'wal');
  assert.ok(state.tables.includes('tasks'));
  assert.ok(state.tables.includes('handoffs'));
  assert.ok(state.tables.includes('task_events'));
  assert.ok(state.tables.includes('goals'));
  assert.ok(state.tables.includes('runs'));
  assert.ok(state.tables.includes('run_attempts'));
  assert.ok(state.tables.includes('outbox'));

  controlDb.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
});

test('control DB transaction rolls back all writes on failure', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });

  assert.throws(() => controlDb.transaction(db => {
    db.prepare(`
      INSERT INTO tasks (
        task_id, from_agent, to_agent, goal, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('t_rollback', 'a', 'b', 'rollback', '2026-01-01', '2026-01-01');
    throw new Error('stop');
  }), /stop/);

  const row = controlDb.run(db => db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get('t_rollback'));
  assert.equal(row, undefined);

  controlDb.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
});

test('control DB rejects async transaction callbacks before execution', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });

  assert.throws(() => controlDb.transaction(async () => 'nope'), /must be synchronous/);

  controlDb.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
});

test('control DB versions and backs up an existing schema before migration', () => {
  const dbPath = newTmpDbPath();
  const { DatabaseSync } = require('node:sqlite');
  const legacy = new DatabaseSync(dbPath);
  _internal.migrateTaskBoardSchema(legacy);
  legacy.exec('PRAGMA user_version = 0');
  legacy.close();

  const controlDb = createControlDb({ dbPath });
  const version = controlDb.run(db => db.prepare('PRAGMA user_version').get().user_version);
  const backupPath = `${dbPath}.pre-control-v2.bak`;
  assert.equal(version, 2);
  assert.equal(fs.existsSync(backupPath), true);

  controlDb.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
  try { fs.unlinkSync(backupPath); } catch {}
});

test('control DB rejects new orphan task events', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });

  assert.throws(() => controlDb.run(db => db.prepare(`
    INSERT INTO task_events (task_id, event_type, actor, created_at)
    VALUES (?, ?, ?, ?)
  `).run('missing', 'bad', 'test', '2026-01-01')), /event task does not exist|FOREIGN KEY/);

  controlDb.close();
  try { fs.unlinkSync(dbPath); } catch {}
  try { fs.unlinkSync(`${dbPath}-wal`); } catch {}
  try { fs.unlinkSync(`${dbPath}-shm`); } catch {}
});

test('control migrations do not trust an unrelated high user_version', () => {
  const dbPath = newTmpDbPath();
  const { DatabaseSync } = require('node:sqlite');
  const foreign = new DatabaseSync(dbPath);
  foreign.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
  foreign.exec('PRAGMA user_version = 99');
  foreign.close();

  const controlDb = createControlDb({ dbPath });
  const state = controlDb.run(db => ({
    version: db.prepare('PRAGMA user_version').get().user_version,
    goals: db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'goals'").get(),
    migrations: db.prepare('SELECT version FROM control_migrations ORDER BY version').all(),
  }));
  assert.equal(state.version, 99);
  assert.ok(state.goals);
  assert.deepEqual(state.migrations.map(row => row.version), [1, 2]);

  controlDb.close();
  for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
});

test('database checks reject invalid loop states', () => {
  const dbPath = newTmpDbPath();
  const controlDb = createControlDb({ dbPath });
  assert.throws(() => controlDb.run(db => db.prepare(`
    INSERT INTO goals (goal_id, title, objective, mode, status, created_at, updated_at)
    VALUES ('g1', 'g1', 'g1', 'once', 'invalid', '2026-01-01', '2026-01-01')
  `).run()), /CHECK constraint/);
  controlDb.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
});

test('migration ledger does not hide a missing schema object', () => {
  const dbPath = newTmpDbPath();
  const first = createControlDb({ dbPath });
  first.run(db => db.exec('DROP TABLE outbox'));
  first.run(db => db.exec('DROP INDEX one_active_run_per_goal'));
  first.run(db => db.exec('ALTER TABLE runs DROP COLUMN execution_heartbeat_at'));
  first.run(db => db.exec('ALTER TABLE approvals DROP COLUMN decided_by'));
  first.run(db => db.exec('ALTER TABLE run_attempts DROP COLUMN verifier_result'));
  first.run(db => db.exec('ALTER TABLE usage_ledger DROP COLUMN engine'));
  first.close();

  const repaired = createControlDb({ dbPath });
  const exists = repaired.run(db => db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'outbox'
  `).get());
  const index = repaired.run(db => db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'one_active_run_per_goal'
  `).get());
  const outboxIndex = repaired.run(db => db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_outbox_pending'
  `).get());
  const runColumns = repaired.run(db => db.prepare('PRAGMA table_info(runs)').all().map(row => row.name));
  const approvalColumns = repaired.run(db => db.prepare('PRAGMA table_info(approvals)').all().map(row => row.name));
  const attemptColumns = repaired.run(db => db.prepare('PRAGMA table_info(run_attempts)').all().map(row => row.name));
  const usageColumns = repaired.run(db => db.prepare('PRAGMA table_info(usage_ledger)').all().map(row => row.name));
  assert.ok(exists);
  assert.ok(index);
  assert.ok(outboxIndex);
  assert.ok(runColumns.includes('execution_heartbeat_at'));
  assert.ok(approvalColumns.includes('decided_by'));
  assert.ok(attemptColumns.includes('verifier_result'));
  assert.ok(usageColumns.includes('engine'));
  repaired.close();
  for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
});

test('control DB fails fast when a relational constraint cannot be safely repaired', () => {
  const dbPath = newTmpDbPath();
  const first = createControlDb({ dbPath });
  first.run(db => {
    db.exec('DROP TABLE usage_ledger');
    db.exec(`
      CREATE TABLE usage_ledger (
        usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal_id TEXT NOT NULL,
        run_id TEXT,
        attempt_id TEXT,
        engine TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_micros INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL
      )
    `);
  });
  first.close();

  assert.throws(() => createControlDb({ dbPath }).run(() => true), /control_schema_invariant_failed:v2/);
  assert.equal(fs.existsSync(`${dbPath}.pre-control-v2.bak`), true);
  for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
});

test('control DB rejects split foreign keys in place of one composite relation', () => {
  const dbPath = newTmpDbPath();
  const first = createControlDb({ dbPath });
  first.run(db => {
    db.exec('DROP TABLE approvals');
    db.exec(`
      CREATE TABLE approvals (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_hash TEXT NOT NULL,
        risk_level TEXT NOT NULL CHECK(risk_level IN ('R0','R1','R2','R3')),
        action_scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked')),
        decided_by TEXT,
        decided_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, plan_hash, action_scope),
        FOREIGN KEY(run_id) REFERENCES run_plans(run_id),
        FOREIGN KEY(plan_hash) REFERENCES run_plans(plan_hash)
      )
    `);
  });
  first.close();

  assert.throws(() => createControlDb({ dbPath }).run(() => true), /control_schema_invariant_failed:v2/);
  for (const suffix of ['', '-wal', '-shm', '.pre-control-v2.bak']) {
    try { fs.unlinkSync(`${dbPath}${suffix}`); } catch {}
  }
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
