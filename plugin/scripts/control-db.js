'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONTROL_DB_PATH = path.join(os.homedir(), '.metame', 'task_board.db');
const CONTROL_SCHEMA_VERSION = 3;

function isSqliteBusyError(err) {
  const msg = err && (err.code || err.message || String(err));
  return /SQLITE_(BUSY|LOCKED)|database is locked/i.test(String(msg || ''));
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runSqliteWithRetry(operation, opts = {}) {
  const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : 3;
  const baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 100;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return operation();
    } catch (err) {
      lastErr = err;
      if (!isSqliteBusyError(err) || attempt >= maxRetries) throw err;
      sleepSync(baseDelayMs * (2 ** attempt));
    }
  }
  throw lastErr;
}

function hasUserSchema(db) {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'trigger')
    LIMIT 1
  `).get();
}

function schemaObjectExists(db, type, name) {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
}

function backupBeforeMigration(db, dbPath, version) {
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath) || !hasUserSchema(db)) return null;
  const backupPath = `${dbPath}.pre-control-v${version}.bak`;
  if (fs.existsSync(backupPath)) return backupPath;
  db.exec('PRAGMA wal_checkpoint(FULL)');
  fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function createTaskTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT '',
      parent_task_id TEXT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      goal TEXT NOT NULL,
      task_kind TEXT NOT NULL DEFAULT 'team',
      participants TEXT NOT NULL DEFAULT '[]',
      definition_of_done TEXT NOT NULL DEFAULT '[]',
      inputs TEXT NOT NULL DEFAULT '{}',
      artifacts TEXT NOT NULL DEFAULT '[]',
      owned_paths TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'queued',
      priority TEXT NOT NULL DEFAULT 'normal',
      summary TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateLegacyTaskColumns(db) {
  addColumnIfMissing(db, 'tasks', 'scope_id', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'tasks', 'task_kind', "TEXT NOT NULL DEFAULT 'team'");
  addColumnIfMissing(db, 'tasks', 'participants', "TEXT NOT NULL DEFAULT '[]'");
}

function createTaskRelations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      handoff_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'sent',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id)
    );
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_scope_id ON tasks(scope_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);
    CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_handoffs_task_id ON handoffs(task_id);
    CREATE TRIGGER IF NOT EXISTS fk_handoffs_task_insert
    BEFORE INSERT ON handoffs
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN SELECT RAISE(ABORT, 'handoff task does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS fk_handoffs_task_update
    BEFORE UPDATE OF task_id ON handoffs
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN SELECT RAISE(ABORT, 'handoff task does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS fk_task_events_task_insert
    BEFORE INSERT ON task_events
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN SELECT RAISE(ABORT, 'event task does not exist'); END;
    CREATE TRIGGER IF NOT EXISTS fk_task_events_task_update
    BEFORE UPDATE OF task_id ON task_events
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN SELECT RAISE(ABORT, 'event task does not exist'); END;
  `);
}

function migrateTaskBoardSchema(db) {
  createTaskTable(db);
  migrateLegacyTaskColumns(db);
  createTaskRelations(db);
}

function hasTaskSchema(db) {
  const requiredTables = ['tasks', 'handoffs', 'task_events'];
  const requiredIndexes = ['idx_tasks_status', 'idx_tasks_scope_id', 'idx_tasks_updated_at', 'idx_events_task_id', 'idx_handoffs_task_id'];
  const requiredTriggers = ['fk_handoffs_task_insert', 'fk_handoffs_task_update', 'fk_task_events_task_insert', 'fk_task_events_task_update'];
  return requiredTables.every(name => schemaObjectExists(db, 'table', name))
    && requiredIndexes.every(name => schemaObjectExists(db, 'index', name))
    && requiredTriggers.every(name => schemaObjectExists(db, 'trigger', name));
}

function migrateControlSchema(db, opts = {}) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  const hasLedger = schemaObjectExists(db, 'table', 'control_migrations');
  const applied = hasLedger
    ? new Set(db.prepare('SELECT version FROM control_migrations').all().map(row => Number(row.version)))
    : new Set();
  const needsMigration = !applied.has(CONTROL_SCHEMA_VERSION) || !hasTaskSchema(db);
  if (!needsMigration) {
    const target = Math.max(current, CONTROL_SCHEMA_VERSION);
    if (target !== current) db.exec(`PRAGMA user_version = ${target}`);
    return { from: current, to: target, backupPath: null };
  }

  const backupPath = backupBeforeMigration(db, opts.dbPath || ':memory:', CONTROL_SCHEMA_VERSION);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('CREATE TABLE IF NOT EXISTS control_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    migrateTaskBoardSchema(db);
    db.prepare('INSERT OR IGNORE INTO control_migrations (version, applied_at) VALUES (?, ?)')
      .run(CONTROL_SCHEMA_VERSION, new Date().toISOString());
    db.exec(`PRAGMA user_version = ${Math.max(current, CONTROL_SCHEMA_VERSION)}`);
    if (!hasTaskSchema(db)) throw new Error('control_schema_invariant_failed:v3');
    const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
    if (fkErrors.length) throw new Error('control_schema_foreign_key_failed:v3');
    db.exec('COMMIT');
    return { from: current, to: Math.max(current, CONTROL_SCHEMA_VERSION), backupPath };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

function createControlDb(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_CONTROL_DB_PATH;
  const logger = typeof opts.logger === 'function' ? opts.logger : null;
  let db = null;
  function open() {
    if (db) return db;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 5000');
      migrateControlSchema(db, { dbPath });
    } catch (err) {
      try { db.close(); } catch {}
      db = null;
      throw err;
    }
    return db;
  }
  function run(operation, retryOpts) {
    return runSqliteWithRetry(() => operation(open()), retryOpts);
  }
  function transaction(operation, retryOpts) {
    if (operation?.constructor?.name === 'AsyncFunction') throw new TypeError('ControlDB transactions must be synchronous');
    return runSqliteWithRetry(() => {
      const conn = open();
      conn.exec('BEGIN IMMEDIATE');
      try {
        const result = operation(conn);
        if (result && typeof result.then === 'function') throw new TypeError('ControlDB transactions must be synchronous');
        conn.exec('COMMIT');
        return result;
      } catch (err) {
        try { conn.exec('ROLLBACK'); } catch (rollbackErr) {
          if (logger) logger(`ControlDB rollback failed: ${rollbackErr.message}`);
        }
        throw err;
      }
    }, retryOpts);
  }
  function close() {
    if (!db) return;
    try { db.close(); } catch (err) { if (logger) logger(`ControlDB close failed: ${err.message}`); }
    db = null;
  }
  return { dbPath, run, transaction, close };
}

module.exports = {
  createControlDb,
  DEFAULT_CONTROL_DB_PATH,
  CONTROL_SCHEMA_VERSION,
  _internal: { isSqliteBusyError, runSqliteWithRetry, migrateTaskBoardSchema, migrateControlSchema, hasUserSchema },
};
