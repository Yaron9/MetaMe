'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const LEGACY_TABLES = [
  'goals', 'automations', 'wake_events', 'runs', 'run_attempts', 'run_plans',
  'approvals', 'usage_ledger', 'loop_events', 'outbox',
];
const ACTIVE_RUN_STATES = ['queued', 'planning', 'awaiting_approval', 'executing', 'verifying', 'retry_wait'];
const TASK_COLUMNS = [
  'task_id', 'scope_id', 'parent_task_id', 'from_agent', 'to_agent', 'goal', 'task_kind',
  'participants', 'definition_of_done', 'inputs', 'artifacts', 'owned_paths', 'status',
  'priority', 'summary', 'last_error', 'created_at', 'updated_at',
];

function defaultPaths(home = os.homedir()) {
  const root = path.join(home, '.metame');
  return {
    root,
    config: path.join(root, 'daemon.yaml'),
    state: path.join(root, 'daemon_state.json'),
    pid: path.join(root, 'daemon.pid'),
    taskDb: path.join(root, 'task_board.db'),
    memoryDb: path.join(root, 'memory.db'),
    reactive: path.join(root, 'reactive'),
    missions: path.join(root, 'workspace', 'missions.md'),
    sharedNow: path.join(root, 'memory', 'now', 'shared.md'),
    sharedTasks: path.join(root, 'memory', 'shared', 'tasks.md'),
    backups: path.join(root, 'backups'),
  };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function assertDaemonStopped(paths) {
  if (!fs.existsSync(paths.pid)) return;
  const pid = Number(fs.readFileSync(paths.pid, 'utf8').trim());
  if (isPidAlive(pid)) throw new Error(`daemon_is_running:${pid}`);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function queryCount(db, sql, params = []) {
  try { return Number(db.prepare(sql).get(...params).count) || 0; } catch { return 0; }
}

function inspectDatabases(paths) {
  const { DatabaseSync } = require('node:sqlite');
  const result = { activeRuns: 0, pendingOutbox: 0, perpetualTasks: 0, reactiveMemoryRows: 0, legacyTables: [] };
  if (fs.existsSync(paths.taskDb)) {
    const db = new DatabaseSync(paths.taskDb, { readOnly: true });
    try {
      result.legacyTables = LEGACY_TABLES.filter(name => tableExists(db, name));
      if (tableExists(db, 'runs')) {
        const marks = ACTIVE_RUN_STATES.map(() => '?').join(',');
        result.activeRuns = queryCount(db, `SELECT COUNT(*) count FROM runs WHERE status IN (${marks})`, ACTIVE_RUN_STATES);
      }
      if (tableExists(db, 'outbox')) result.pendingOutbox = queryCount(db, "SELECT COUNT(*) count FROM outbox WHERE status='pending'");
      if (tableExists(db, 'tasks')) result.perpetualTasks = queryCount(db, "SELECT COUNT(*) count FROM tasks WHERE task_kind='perpetual'");
    } finally { db.close(); }
  }
  if (fs.existsSync(paths.memoryDb)) {
    const db = new DatabaseSync(paths.memoryDb, { readOnly: true });
    try {
      for (const table of ['wiki_external_sources', 'wiki_pages', 'facts', 'memories']) {
        if (!tableExists(db, table)) continue;
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
        for (const col of ['source_id', 'source_key', 'source_type', 'provenance']) {
          if (cols.includes(col)) result.reactiveMemoryRows += queryCount(db, `SELECT COUNT(*) count FROM ${table} WHERE ${col} LIKE ?`, ['%reactive%']);
        }
      }
    } finally { db.close(); }
  }
  return result;
}

function planRetirement(paths = defaultPaths()) {
  const database = inspectDatabases(paths);
  let config = {};
  if (fs.existsSync(paths.config)) config = yaml.load(fs.readFileSync(paths.config, 'utf8')) || {};
  const projects = Object.entries(config.projects || {});
  return {
    paths,
    database,
    config: {
      hasLoop: Object.hasOwn(config, 'loop'),
      reactiveProjects: projects.filter(([, value]) => value && Object.hasOwn(value, 'reactive')).map(([key]) => key),
      opsScanProjects: projects.filter(([, value]) => [
        ...(Array.isArray(value?.heartbeat_tasks) ? value.heartbeat_tasks : []),
        ...(Array.isArray(value?.heartbeat?.tasks) ? value.heartbeat.tasks : []),
      ].some(task => task?.name === 'ops-scan')).map(([key]) => key),
    },
    runtime: {
      reactiveDir: fs.existsSync(paths.reactive),
      missions: fs.existsSync(paths.missions),
      sharedNow: fs.existsSync(paths.sharedNow),
      sharedTasks: fs.existsSync(paths.sharedTasks),
    },
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function copyIntoBackup(source, backupRoot, relative, manifest) {
  if (!fs.existsSync(source)) return;
  const target = path.join(backupRoot, 'files', relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, preserveTimestamps: true });
  manifest.restorable.push({ source, relative });
}

function replaceFileAtomically(staged, target) {
  const previous = `${target}.retire.previous`;
  fs.rmSync(previous, { force: true });
  if (fs.existsSync(target)) fs.renameSync(target, previous);
  try {
    fs.renameSync(staged, target);
    fs.rmSync(previous, { force: true });
  } catch (err) {
    if (fs.existsSync(previous) && !fs.existsSync(target)) fs.renameSync(previous, target);
    throw err;
  }
}

function exportLegacyTables(dbPath, backupRoot, manifest) {
  if (!fs.existsSync(dbPath)) return;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const exportDir = path.join(backupRoot, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });
  try {
    for (const table of [...LEGACY_TABLES, 'tasks', 'task_events']) {
      if (!tableExists(db, table)) continue;
      let rows;
      if (table === 'tasks') rows = db.prepare("SELECT * FROM tasks WHERE task_kind='perpetual'").all();
      else if (table === 'task_events') rows = tableExists(db, 'tasks')
        ? db.prepare("SELECT e.* FROM task_events e JOIN tasks t ON t.task_id=e.task_id WHERE t.task_kind='perpetual'").all() : [];
      else rows = db.prepare(`SELECT * FROM ${table}`).all();
      const file = path.join(exportDir, `${table}.jsonl`);
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      manifest.exports.push({ table, rows: rows.length, file: path.relative(backupRoot, file), sha256: sha256(file) });
    }
  } finally { db.close(); }
}

function createBackup(paths, plan, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const backupRoot = path.join(paths.backups, `perpetual-retirement-${stamp}`);
  fs.mkdirSync(paths.backups, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: false });
  const manifest = { version: 1, created_at: now.toISOString(), plan, restorable: [], exports: [] };
  if (fs.existsSync(paths.taskDb)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(paths.taskDb);
    try { db.exec('PRAGMA wal_checkpoint(FULL)'); } finally { db.close(); }
  }
  copyIntoBackup(paths.config, backupRoot, 'daemon.yaml', manifest);
  copyIntoBackup(paths.state, backupRoot, 'daemon_state.json', manifest);
  copyIntoBackup(paths.taskDb, backupRoot, 'task_board.db', manifest);
  copyIntoBackup(paths.reactive, backupRoot, 'reactive', manifest);
  copyIntoBackup(paths.missions, backupRoot, 'workspace/missions.md', manifest);
  copyIntoBackup(paths.sharedNow, backupRoot, 'memory/now/shared.md', manifest);
  copyIntoBackup(paths.sharedTasks, backupRoot, 'memory/shared/tasks.md', manifest);
  exportLegacyTables(paths.taskDb, backupRoot, manifest);
  fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return backupRoot;
}

function rewriteConfig(paths) {
  if (!fs.existsSync(paths.config)) return;
  const config = yaml.load(fs.readFileSync(paths.config, 'utf8')) || {};
  delete config.loop;
  for (const project of Object.values(config.projects || {})) {
    if (!project || typeof project !== 'object') continue;
    delete project.reactive;
    delete project.reactive_project_key;
    if (Array.isArray(project.heartbeat?.tasks)) {
      project.heartbeat.tasks = project.heartbeat.tasks.filter(task => task?.name !== 'ops-scan');
    }
    if (Array.isArray(project.heartbeat_tasks)) {
      project.heartbeat_tasks = project.heartbeat_tasks.filter(task => task?.name !== 'ops-scan');
    }
  }
  const tmp = `${paths.config}.retire.tmp`;
  fs.writeFileSync(tmp, yaml.dump(config, { lineWidth: -1, noRefs: true }), { mode: 0o600 });
  replaceFileAtomically(tmp, paths.config);
}

function rewriteState(paths) {
  if (!fs.existsSync(paths.state)) return;
  const state = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  delete state.reactive;
  if (state.tasks && typeof state.tasks === 'object') delete state.tasks['ops-scan'];
  const tmp = `${paths.state}.retire.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  replaceFileAtomically(tmp, paths.state);
}

function rebuildTaskDb(paths) {
  if (!fs.existsSync(paths.taskDb)) return;
  const { DatabaseSync } = require('node:sqlite');
  const { createControlDb } = require('./control-db');
  const source = new DatabaseSync(paths.taskDb, { readOnly: true });
  const stage = `${paths.taskDb}.retire.tmp`;
  try { fs.unlinkSync(stage); } catch {}
  const targetOwner = createControlDb({ dbPath: stage });
  try {
    const tasks = tableExists(source, 'tasks') ? source.prepare("SELECT * FROM tasks WHERE task_kind <> 'perpetual'").all() : [];
    const taskIds = new Set(tasks.map(row => row.task_id));
    const handoffs = tableExists(source, 'handoffs') ? source.prepare('SELECT * FROM handoffs').all().filter(row => taskIds.has(row.task_id)) : [];
    const events = tableExists(source, 'task_events') ? source.prepare('SELECT * FROM task_events').all().filter(row => taskIds.has(row.task_id)) : [];
    targetOwner.transaction(db => {
      if (tasks.length) {
        const marks = TASK_COLUMNS.map(() => '?').join(',');
        const insert = db.prepare(`INSERT INTO tasks (${TASK_COLUMNS.join(',')}) VALUES (${marks})`);
        for (const row of tasks) insert.run(...TASK_COLUMNS.map(column => row[column] ?? null));
      }
      const insertHandoff = db.prepare('INSERT INTO handoffs (handoff_id,task_id,from_agent,to_agent,payload,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)');
      for (const row of handoffs) insertHandoff.run(row.handoff_id, row.task_id, row.from_agent, row.to_agent, row.payload, row.status, row.created_at, row.updated_at);
      const insertEvent = db.prepare('INSERT INTO task_events (id,task_id,event_type,actor,body,created_at) VALUES (?,?,?,?,?,?)');
      for (const row of events) insertEvent.run(row.id, row.task_id, row.event_type, row.actor, row.body, row.created_at);
    });
  } finally {
    source.close();
    targetOwner.close();
  }
  for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(`${paths.taskDb}${suffix}`); } catch {} }
  replaceFileAtomically(stage, paths.taskDb);
  for (const suffix of ['-wal', '-shm']) { try { fs.unlinkSync(`${stage}${suffix}`); } catch {} }
}

function applyRetirement(paths = defaultPaths()) {
  assertDaemonStopped(paths);
  const plan = planRetirement(paths);
  if (plan.database.activeRuns) throw new Error(`active_loop_runs:${plan.database.activeRuns}`);
  if (plan.database.pendingOutbox) throw new Error(`pending_loop_outbox:${plan.database.pendingOutbox}`);
  if (plan.database.reactiveMemoryRows) throw new Error(`reactive_memory_lineage_requires_review:${plan.database.reactiveMemoryRows}`);
  const backupRoot = createBackup(paths, plan);
  rewriteConfig(paths);
  rewriteState(paths);
  rebuildTaskDb(paths);
  for (const target of [paths.reactive, paths.missions, paths.sharedNow, paths.sharedTasks]) fs.rmSync(target, { recursive: true, force: true });
  return { ok: true, backupRoot, before: plan, after: planRetirement(paths) };
}

function restoreRetirement(backupRoot, paths = defaultPaths()) {
  assertDaemonStopped(paths);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
  for (const item of manifest.restorable) {
    const source = path.join(backupRoot, 'files', item.relative);
    fs.mkdirSync(path.dirname(item.source), { recursive: true });
    fs.rmSync(item.source, { recursive: true, force: true });
    if (item.relative === 'task_board.db') {
      fs.rmSync(`${item.source}-wal`, { force: true });
      fs.rmSync(`${item.source}-shm`, { force: true });
    }
    fs.cpSync(source, item.source, { recursive: true, preserveTimestamps: true });
  }
  return { ok: true, restored: manifest.restorable.length };
}

function main(argv = process.argv.slice(2)) {
  const paths = defaultPaths();
  if (argv.includes('--dry-run')) return console.log(JSON.stringify(planRetirement(paths), null, 2));
  const restoreAt = argv.indexOf('--restore');
  if (restoreAt >= 0 && argv[restoreAt + 1]) return console.log(JSON.stringify(restoreRetirement(path.resolve(argv[restoreAt + 1]), paths), null, 2));
  if (argv.includes('--apply') && argv.includes('--yes')) return console.log(JSON.stringify(applyRetirement(paths), null, 2));
  throw new Error('Usage: metame migrate perpetual --dry-run | --apply --yes | --restore <backup-dir>');
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}

module.exports = { defaultPaths, planRetirement, applyRetirement, restoreRetirement, main, _internal: { inspectDatabases, rewriteConfig, rewriteState, rebuildTaskDb, assertDaemonStopped, replaceFileAtomically } };
