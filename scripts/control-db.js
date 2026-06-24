'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_CONTROL_DB_PATH = path.join(os.homedir(), '.metame', 'task_board.db');
const CONTROL_SCHEMA_VERSION = 2;

function isSqliteBusyError(err) {
  const msg = err && (err.code || err.message || String(err));
  return /SQLITE_(BUSY|LOCKED)|database is locked/i.test(String(msg || ''));
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
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

function createTaskTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id             TEXT PRIMARY KEY,
      scope_id            TEXT NOT NULL DEFAULT '',
      parent_task_id      TEXT,
      from_agent          TEXT NOT NULL,
      to_agent            TEXT NOT NULL,
      goal                TEXT NOT NULL,
      task_kind           TEXT NOT NULL DEFAULT 'team',
      participants        TEXT NOT NULL DEFAULT '[]',
      definition_of_done  TEXT NOT NULL DEFAULT '[]',
      inputs              TEXT NOT NULL DEFAULT '{}',
      artifacts           TEXT NOT NULL DEFAULT '[]',
      owned_paths         TEXT NOT NULL DEFAULT '[]',
      status              TEXT NOT NULL DEFAULT 'queued',
      priority            TEXT NOT NULL DEFAULT 'normal',
      summary             TEXT NOT NULL DEFAULT '',
      last_error          TEXT NOT NULL DEFAULT '',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    )
  `);
}

function migrateLegacyTaskColumns(db) {
  for (const col of [
    "ALTER TABLE tasks ADD COLUMN scope_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'team'",
    "ALTER TABLE tasks ADD COLUMN participants TEXT NOT NULL DEFAULT '[]'",
  ]) {
    try { db.exec(col); } catch (e) {
      if (!e.message.includes('duplicate column name')) throw e;
    }
  }
}

function createTaskRelations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS handoffs (
      handoff_id          TEXT PRIMARY KEY,
      task_id             TEXT NOT NULL,
      from_agent          TEXT NOT NULL,
      to_agent            TEXT NOT NULL,
      payload             TEXT NOT NULL DEFAULT '{}',
      status              TEXT NOT NULL DEFAULT 'sent',
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(task_id)
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id             TEXT NOT NULL,
      event_type          TEXT NOT NULL,
      actor               TEXT NOT NULL,
      body                TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL,
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
    BEGIN
      SELECT RAISE(ABORT, 'handoff task does not exist');
    END;

    CREATE TRIGGER IF NOT EXISTS fk_handoffs_task_update
    BEFORE UPDATE OF task_id ON handoffs
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN
      SELECT RAISE(ABORT, 'handoff task does not exist');
    END;

    CREATE TRIGGER IF NOT EXISTS fk_task_events_task_insert
    BEFORE INSERT ON task_events
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN
      SELECT RAISE(ABORT, 'event task does not exist');
    END;

    CREATE TRIGGER IF NOT EXISTS fk_task_events_task_update
    BEFORE UPDATE OF task_id ON task_events
    WHEN NOT EXISTS (SELECT 1 FROM tasks WHERE task_id = NEW.task_id)
    BEGIN
      SELECT RAISE(ABORT, 'event task does not exist');
    END;
  `);
}

function migrateTaskBoardSchema(db) {
  createTaskTable(db);
  migrateLegacyTaskColumns(db);
  createTaskRelations(db);
}

function createLoopCoreTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      goal_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('once','recurring','continuous')),
      status TEXT NOT NULL CHECK(status IN ('active','paused','completed','cancelled','archived')),
      project_key TEXT,
      cwd TEXT,
      execution_spec TEXT NOT NULL DEFAULT '{}',
      verification_spec TEXT NOT NULL DEFAULT '{}',
      policy_spec TEXT NOT NULL DEFAULT '{}',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automations (
      automation_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('clock','interval','manual','event','recovery')),
      trigger_spec TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      next_fire_at TEXT,
      last_fire_at TEXT,
      FOREIGN KEY(goal_id) REFERENCES goals(goal_id)
    );

    CREATE TABLE IF NOT EXISTS wake_events (
      wake_id TEXT PRIMARY KEY,
      automation_id TEXT,
      goal_id TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK(trigger_type IN ('clock','interval','manual','event','recovery')),
      scheduled_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      coalesce INTEGER NOT NULL DEFAULT 1 CHECK(coalesce IN (0,1)),
      attached_run_id TEXT,
      disposition TEXT NOT NULL DEFAULT 'pending'
        CHECK(disposition IN ('pending','created','coalesced','rejected_active')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
      FOREIGN KEY(automation_id) REFERENCES automations(automation_id),
      FOREIGN KEY(attached_run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL,
      primary_wake_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (
        'queued','planning','awaiting_approval','executing','verifying',
        'awaiting_review','retry_wait','succeeded','failed','blocked','cancelled','skipped'
      )),
      attempt_no INTEGER NOT NULL DEFAULT 0,
      execution_boot_id TEXT,
      execution_pid INTEGER,
      execution_started_at TEXT,
      execution_heartbeat_at TEXT,
      workspace_id TEXT,
      base_revision TEXT,
      result TEXT NOT NULL DEFAULT '{}',
      last_error TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
      FOREIGN KEY(primary_wake_id) REFERENCES wake_events(wake_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_run_per_goal
    ON runs(goal_id)
    WHERE status IN ('queued','planning','awaiting_approval','executing','verifying','awaiting_review','retry_wait');
  `);
}

function createLoopExecutionTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_attempts (
      attempt_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN (
        'running','candidate_complete','verifying','succeeded','failed','interrupted'
      )),
      runtime_engine TEXT NOT NULL,
      runtime_session_id TEXT,
      input_summary TEXT NOT NULL DEFAULT '{}',
      maker_result TEXT NOT NULL DEFAULT '{}',
      verifier_result TEXT NOT NULL DEFAULT '{}',
      verification_spec_hash TEXT NOT NULL DEFAULT '',
      workspace_revision TEXT NOT NULL DEFAULT '',
      error_class TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE(run_id, attempt_no),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS run_plans (
      plan_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      plan_body TEXT NOT NULL,
      risk_level TEXT NOT NULL CHECK(risk_level IN ('R0','R1','R2','R3')),
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      UNIQUE(run_id, plan_hash),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS approvals (
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
      FOREIGN KEY(run_id, plan_hash) REFERENCES run_plans(run_id, plan_hash)
    );

    CREATE TABLE IF NOT EXISTS usage_ledger (
      usage_id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      run_id TEXT,
      attempt_id TEXT,
      engine TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id),
      FOREIGN KEY(attempt_id) REFERENCES run_attempts(attempt_id)
    );
  `);
}

function createLoopEventTables(db, createIndexes = true) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loop_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT NOT NULL,
      run_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

    CREATE TABLE IF NOT EXISTS outbox (
      outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id TEXT,
      run_id TEXT,
      topic TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      available_at TEXT NOT NULL,
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      FOREIGN KEY(goal_id) REFERENCES goals(goal_id),
      FOREIGN KEY(run_id) REFERENCES runs(run_id)
    );

  `);
  if (!createIndexes) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_wake_events_goal ON wake_events(goal_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_goal ON runs(goal_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_loop_events_run ON loop_events(run_id, event_id);
    CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(delivered_at, available_at);
    CREATE INDEX IF NOT EXISTS idx_usage_goal_time ON usage_ledger(goal_id, recorded_at);
  `);
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some(row => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const LOOP_REPAIR_COLUMNS = {
  goals: {
    title: "TEXT NOT NULL DEFAULT ''", objective: "TEXT NOT NULL DEFAULT ''",
    mode: "TEXT NOT NULL DEFAULT 'once'", status: "TEXT NOT NULL DEFAULT 'active'",
    project_key: 'TEXT', cwd: 'TEXT', execution_spec: "TEXT NOT NULL DEFAULT '{}'",
    verification_spec: "TEXT NOT NULL DEFAULT '{}'", policy_spec: "TEXT NOT NULL DEFAULT '{}'",
    version: 'INTEGER NOT NULL DEFAULT 1', created_at: "TEXT NOT NULL DEFAULT ''",
    updated_at: "TEXT NOT NULL DEFAULT ''",
  },
  automations: {
    goal_id: 'TEXT', trigger_type: "TEXT NOT NULL DEFAULT 'manual'",
    trigger_spec: "TEXT NOT NULL DEFAULT '{}'", enabled: 'INTEGER NOT NULL DEFAULT 1',
    next_fire_at: 'TEXT', last_fire_at: 'TEXT',
  },
  wake_events: {
    automation_id: 'TEXT', goal_id: 'TEXT', trigger_type: "TEXT NOT NULL DEFAULT 'manual'",
    scheduled_at: "TEXT NOT NULL DEFAULT ''", observed_at: "TEXT NOT NULL DEFAULT ''",
    payload: "TEXT NOT NULL DEFAULT '{}'", coalesce: 'INTEGER NOT NULL DEFAULT 1',
    attached_run_id: 'TEXT', disposition: "TEXT NOT NULL DEFAULT 'pending'",
    created_at: "TEXT NOT NULL DEFAULT ''",
  },
  runs: {
    goal_id: 'TEXT', primary_wake_id: 'TEXT', status: "TEXT NOT NULL DEFAULT 'queued'",
    attempt_no: 'INTEGER NOT NULL DEFAULT 0', execution_boot_id: 'TEXT', execution_pid: 'INTEGER',
    execution_started_at: 'TEXT', execution_heartbeat_at: 'TEXT', workspace_id: 'TEXT',
    base_revision: 'TEXT', result: "TEXT NOT NULL DEFAULT '{}'", last_error: "TEXT NOT NULL DEFAULT ''",
    version: 'INTEGER NOT NULL DEFAULT 1', created_at: "TEXT NOT NULL DEFAULT ''",
    started_at: 'TEXT', finished_at: 'TEXT',
  },
  run_attempts: {
    run_id: 'TEXT', attempt_no: 'INTEGER NOT NULL DEFAULT 0',
    status: "TEXT NOT NULL DEFAULT 'interrupted'", runtime_engine: "TEXT NOT NULL DEFAULT 'unknown'",
    runtime_session_id: 'TEXT', input_summary: "TEXT NOT NULL DEFAULT '{}'",
    maker_result: "TEXT NOT NULL DEFAULT '{}'", verifier_result: "TEXT NOT NULL DEFAULT '{}'",
    verification_spec_hash: "TEXT NOT NULL DEFAULT ''", workspace_revision: "TEXT NOT NULL DEFAULT ''",
    error_class: "TEXT NOT NULL DEFAULT ''", started_at: "TEXT NOT NULL DEFAULT ''", finished_at: 'TEXT',
  },
  run_plans: {
    run_id: 'TEXT', plan_hash: "TEXT NOT NULL DEFAULT ''", plan_body: "TEXT NOT NULL DEFAULT '{}'",
    risk_level: "TEXT NOT NULL DEFAULT 'R0'", created_at: "TEXT NOT NULL DEFAULT ''", superseded_at: 'TEXT',
  },
  approvals: {
    run_id: 'TEXT', plan_hash: "TEXT NOT NULL DEFAULT ''", risk_level: "TEXT NOT NULL DEFAULT 'R0'",
    action_scope: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT 'pending'",
    decided_by: 'TEXT', decided_at: 'TEXT', created_at: "TEXT NOT NULL DEFAULT ''",
  },
  usage_ledger: {
    goal_id: 'TEXT', run_id: 'TEXT', attempt_id: 'TEXT', engine: "TEXT NOT NULL DEFAULT 'unknown'",
    input_tokens: 'INTEGER NOT NULL DEFAULT 0', output_tokens: 'INTEGER NOT NULL DEFAULT 0',
    cost_micros: 'INTEGER NOT NULL DEFAULT 0', recorded_at: "TEXT NOT NULL DEFAULT ''",
  },
  loop_events: {
    goal_id: 'TEXT', run_id: 'TEXT', event_type: "TEXT NOT NULL DEFAULT ''",
    payload: "TEXT NOT NULL DEFAULT '{}'", created_at: "TEXT NOT NULL DEFAULT ''",
  },
  outbox: {
    goal_id: 'TEXT', run_id: 'TEXT', topic: "TEXT NOT NULL DEFAULT ''",
    dedupe_key: "TEXT NOT NULL DEFAULT ''", payload: "TEXT NOT NULL DEFAULT '{}'",
    available_at: "TEXT NOT NULL DEFAULT ''", delivered_at: 'TEXT',
    attempts: 'INTEGER NOT NULL DEFAULT 0', last_error: "TEXT NOT NULL DEFAULT ''",
  },
};

function repairLoopColumns(db) {
  for (const [table, columns] of Object.entries(LOOP_REPAIR_COLUMNS)) {
    for (const [column, definition] of Object.entries(columns)) {
      addColumnIfMissing(db, table, column, definition);
    }
  }
}

function migrateLoopSchema(db) {
  createLoopCoreTables(db);
  createLoopExecutionTables(db);
  createLoopEventTables(db, false);
  addColumnIfMissing(db, 'tasks', 'goal_id', 'TEXT REFERENCES goals(goal_id)');
  addColumnIfMissing(db, 'tasks', 'run_id', 'TEXT REFERENCES runs(run_id)');
  repairLoopColumns(db);
  createLoopEventTables(db);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)');
}

function hasUserSchema(db) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get();
  return Number(row && row.count) > 0;
}

function backupBeforeMigration(db, dbPath, targetVersion) {
  if (dbPath === ':memory:' || !hasUserSchema(db)) return null;
  const backupPath = `${dbPath}.pre-control-v${targetVersion}.bak`;
  if (!fs.existsSync(backupPath)) {
    const literal = `'${backupPath.replace(/'/g, "''")}'`;
    db.exec(`VACUUM INTO ${literal}`);
  }
  return backupPath;
}

function schemaObjectExists(db, type, name) {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
}

function hasAllTables(db, names) {
  return names.every(name => schemaObjectExists(db, 'table', name));
}

function hasColumns(db, table, names) {
  if (!schemaObjectExists(db, 'table', table)) return false;
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  return names.every(name => existing.has(name));
}

function hasAllIndexes(db, names) {
  return names.every(name => schemaObjectExists(db, 'index', name));
}

function hasLoopColumns(db) {
  return Object.entries(LOOP_REPAIR_COLUMNS)
    .every(([table, columns]) => hasColumns(db, table, Object.keys(columns)));
}

const LOOP_PRIMARY_KEYS = {
  goals: ['goal_id'], automations: ['automation_id'], wake_events: ['wake_id'],
  runs: ['run_id'], run_attempts: ['attempt_id'], run_plans: ['plan_id'],
  approvals: ['approval_id'], usage_ledger: ['usage_id'], loop_events: ['event_id'],
  outbox: ['outbox_id'],
};

const LOOP_FOREIGN_KEYS = {
  automations: [[['goal_id', 'goals', 'goal_id']]],
  wake_events: [
    [['goal_id', 'goals', 'goal_id']], [['automation_id', 'automations', 'automation_id']],
    [['attached_run_id', 'runs', 'run_id']],
  ],
  runs: [[['goal_id', 'goals', 'goal_id']], [['primary_wake_id', 'wake_events', 'wake_id']]],
  run_attempts: [[['run_id', 'runs', 'run_id']]],
  run_plans: [[['run_id', 'runs', 'run_id']]],
  approvals: [[['run_id', 'run_plans', 'run_id'], ['plan_hash', 'run_plans', 'plan_hash']]],
  usage_ledger: [
    [['goal_id', 'goals', 'goal_id']], [['run_id', 'runs', 'run_id']],
    [['attempt_id', 'run_attempts', 'attempt_id']],
  ],
  loop_events: [[['goal_id', 'goals', 'goal_id']], [['run_id', 'runs', 'run_id']]],
  outbox: [[['goal_id', 'goals', 'goal_id']], [['run_id', 'runs', 'run_id']]],
};

const LOOP_UNIQUE_COLUMNS = {
  runs: [['primary_wake_id']],
  run_attempts: [['run_id', 'attempt_no']],
  run_plans: [['run_id', 'plan_hash']],
  approvals: [['run_id', 'plan_hash', 'action_scope']],
  outbox: [['dedupe_key']],
};

const LOOP_CHECK_FRAGMENTS = {
  goals: ["modein('once','recurring','continuous')", "statusin('active','paused','completed','cancelled','archived')"],
  automations: ["trigger_typein('clock','interval','manual','event','recovery')", 'enabledin(0,1)'],
  wake_events: ["trigger_typein('clock','interval','manual','event','recovery')", 'coalescein(0,1)', "dispositionin('pending','created','coalesced','rejected_active')"],
  runs: ["statusin('queued','planning','awaiting_approval','executing','verifying','awaiting_review','retry_wait','succeeded','failed','blocked','cancelled','skipped')"],
  run_attempts: ["statusin('running','candidate_complete','verifying','succeeded','failed','interrupted')"],
  run_plans: ["risk_levelin('r0','r1','r2','r3')"],
  approvals: ["risk_levelin('r0','r1','r2','r3')", "statusin('pending','approved','rejected','revoked')"],
};

function hasPrimaryKey(db, table, columns) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all()
    .filter(row => Number(row.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map(row => row.name);
  return JSON.stringify(actual) === JSON.stringify(columns);
}

function hasForeignKeyGroup(db, table, expected) {
  const grouped = new Map();
  for (const row of db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
    if (!grouped.has(row.id)) grouped.set(row.id, []);
    grouped.get(row.id).push(row);
  }
  return [...grouped.values()].some(rows => {
    const actual = rows.sort((a, b) => Number(a.seq) - Number(b.seq))
      .map(row => [row.from, row.table, row.to]);
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

function hasUniqueColumns(db, table, expected) {
  return db.prepare(`PRAGMA index_list(${table})`).all().some(index => {
    if (Number(index.unique) !== 1) return false;
    const columns = db.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all()
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map(row => row.name);
    return JSON.stringify(columns) === JSON.stringify(expected);
  });
}

function hasCheckFragments(db, table, fragments) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const normalized = String(row && row.sql || '').toLowerCase().replace(/\s+/g, '');
  return fragments.every(fragment => normalized.includes(fragment));
}

function hasLoopConstraints(db) {
  const primaryKeys = Object.entries(LOOP_PRIMARY_KEYS)
    .every(([table, columns]) => hasPrimaryKey(db, table, columns));
  const foreignKeys = Object.entries(LOOP_FOREIGN_KEYS)
    .every(([table, groups]) => groups.every(group => hasForeignKeyGroup(db, table, group)));
  const uniqueKeys = Object.entries(LOOP_UNIQUE_COLUMNS)
    .every(([table, indexes]) => indexes.every(columns => hasUniqueColumns(db, table, columns)));
  const checks = Object.entries(LOOP_CHECK_FRAGMENTS)
    .every(([table, fragments]) => hasCheckFragments(db, table, fragments));
  return primaryKeys && foreignKeys && uniqueKeys && checks;
}

function assertLoopSchemaContract(db) {
  if (!hasLoopColumns(db) || !hasLoopConstraints(db)) {
    throw new Error('control_schema_invariant_failed:v2');
  }
}

function migrateControlSchema(db, opts = {}) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  const hasMigrationTable = !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'control_migrations'
  `).get();
  const applied = new Set(hasMigrationTable
    ? db.prepare('SELECT version FROM control_migrations').all().map(row => Number(row.version))
    : []);
  const needsV1 = !applied.has(1)
    || !hasAllTables(db, ['tasks', 'handoffs', 'task_events'])
    || !schemaObjectExists(db, 'trigger', 'fk_task_events_task_insert');
  const needsV2 = !applied.has(2)
    || !hasAllTables(db, [
      'goals', 'automations', 'wake_events', 'runs', 'run_attempts', 'run_plans',
      'approvals', 'usage_ledger', 'loop_events', 'outbox',
    ])
    || !hasAllIndexes(db, [
      'one_active_run_per_goal', 'idx_tasks_run_id', 'idx_wake_events_goal',
      'idx_runs_goal', 'idx_runs_status', 'idx_loop_events_run',
      'idx_outbox_pending', 'idx_usage_goal_time',
    ])
    || !hasColumns(db, 'tasks', ['goal_id', 'run_id'])
    || !hasLoopColumns(db)
    || !hasLoopConstraints(db);
  if (!needsV1 && !needsV2) {
    const target = Math.max(current, CONTROL_SCHEMA_VERSION);
    if (target !== current) db.exec(`PRAGMA user_version = ${target}`);
    return { from: current, to: target, backupPath: null };
  }

  const backupPath = backupBeforeMigration(db, opts.dbPath || ':memory:', CONTROL_SCHEMA_VERSION);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS control_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    if (needsV1) {
      migrateTaskBoardSchema(db);
    }
    if (!applied.has(1)) {
      db.prepare('INSERT OR IGNORE INTO control_migrations (version, applied_at) VALUES (?, ?)')
        .run(1, new Date().toISOString());
    }
    if (needsV2) {
      migrateLoopSchema(db);
      assertLoopSchemaContract(db);
    }
    if (!applied.has(2)) {
      db.prepare('INSERT OR IGNORE INTO control_migrations (version, applied_at) VALUES (?, ?)')
        .run(2, new Date().toISOString());
    }
    db.exec(`PRAGMA user_version = ${Math.max(current, CONTROL_SCHEMA_VERSION)}`);
    db.exec('COMMIT');
    return { from: current, to: CONTROL_SCHEMA_VERSION, backupPath };
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
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
    if (operation && operation.constructor && operation.constructor.name === 'AsyncFunction') {
      throw new TypeError('ControlDB transactions must be synchronous');
    }
    return runSqliteWithRetry(() => {
      const conn = open();
      conn.exec('BEGIN IMMEDIATE');
      try {
        const result = operation(conn);
        if (result && typeof result.then === 'function') {
          throw new TypeError('ControlDB transactions must be synchronous');
        }
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
    try { db.close(); } catch (err) {
      if (logger) logger(`ControlDB close failed: ${err.message}`);
    }
    db = null;
  }

  return { dbPath, run, transaction, close };
}

module.exports = {
  createControlDb,
  DEFAULT_CONTROL_DB_PATH,
  CONTROL_SCHEMA_VERSION,
  _internal: {
    isSqliteBusyError,
    runSqliteWithRetry,
    migrateTaskBoardSchema,
    migrateLoopSchema,
    migrateControlSchema,
    hasUserSchema,
  },
};
