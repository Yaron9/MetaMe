#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  buildReconcilePlan,
  validatePlan,
} = require('./core/memory-reconcile');
const {
  archiveMemoryItem,
  recordKnowledgeLineage,
} = require('./core/memory-mutate');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const ARCHIVE_REASON = 'reconcile_exact_duplicate';

function parseArgs(argv = []) {
  const args = { mode: null, path: null, json: false, db: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--db') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--db requires a value');
      args.db = value;
      continue;
    }
    if (['--dry-run', '--stage', '--apply'].includes(arg)) {
      if (args.mode) throw new Error('choose exactly one reconcile mode');
      args.mode = arg.slice(2);
      if (args.mode !== 'dry-run') {
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} requires a plan path`);
        args.path = value;
      }
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  if (!args.mode) throw new Error('usage: memory reconcile --dry-run [--json] | --stage <path> | --apply <path>');
  return args;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function requireMemoryItems(db) {
  if (!tableExists(db, 'memory_items')) throw new Error('memory_items table is required');
}

function readMemoryRows(db) {
  requireMemoryItems(db);
  return db.prepare('SELECT * FROM memory_items').all();
}

function writePlanFile(filePath, plan) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return target;
}

function readPlanFile(filePath) {
  const plan = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return validatePlan(plan);
}

function acquireLock(lockPath) {
  const target = path.resolve(lockPath);
  try {
    const fd = fs.openSync(target, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, 'utf8');
    fs.closeSync(fd);
    return () => { try { fs.unlinkSync(target); } catch { /* already released */ } };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      const age = Date.now() - fs.statSync(target).mtimeMs;
      stale = age >= LOCK_TIMEOUT_MS;
      if (!stale) throw new Error('reconcile lock is held by another process');
    } catch (readError) {
      if (readError.message === 'reconcile lock is held by another process') throw readError;
      throw new Error('reconcile lock is held or unreadable');
    }
    if (!stale) throw new Error('reconcile lock is held by another process');
    try { fs.unlinkSync(target); } catch { throw new Error('reconcile lock is held or unreadable'); }
    return acquireLock(target);
  }
}

function columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function requireApplySchema(db) {
  requireMemoryItems(db);
  const memoryColumns = columns(db, 'memory_items');
  for (const required of ['id', 'kind', 'state', 'content', 'canonical_key', 'project', 'scope', 'task_key']) {
    if (!memoryColumns.has(required)) throw new Error(`memory_items.${required} is required for reconcile apply`);
  }
  if (!memoryColumns.has('archive_reason') || !memoryColumns.has('supersedes_id')) {
    throw new Error('memory_items archive/supersession columns are required for reconcile apply');
  }
  if (!tableExists(db, 'knowledge_lineage')) throw new Error('knowledge_lineage table is required for reconcile apply');
}

function ensureReconcileSchema(db) {
  requireMemoryItems(db);
  const memoryColumns = columns(db, 'memory_items');
  const additions = [
    ['canonical_key', 'TEXT'],
    ['project', "TEXT DEFAULT '*'"],
    ['scope', 'TEXT'],
    ['task_key', 'TEXT'],
    ['supersedes_id', 'TEXT'],
    ['archive_reason', 'TEXT'],
    ['updated_at', "TEXT DEFAULT CURRENT_TIMESTAMP"],
  ];
  for (const [name, definition] of additions) {
    if (!memoryColumns.has(name)) {
      db.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${definition}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_lineage (
      child_kind TEXT NOT NULL,
      child_id TEXT NOT NULL,
      parent_kind TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      run_id TEXT,
      transform TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'evidence',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (child_kind, child_id, parent_kind, parent_id, role)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_reconcile_lineage_parent ON knowledge_lineage(parent_kind, parent_id)');
}

function fetchRow(db, id) {
  return db.prepare('SELECT * FROM memory_items WHERE id=?').get(id) || null;
}

function sameIdentity(left, right) {
  const leftIdentity = left && left.identity ? left.identity : null;
  const rightIdentity = right && right.identity ? right.identity : null;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}

function assertPrecondition(db, expected) {
  const row = fetchRow(db, expected.id);
  if (!row) throw new Error(`stale reconcile precondition: missing row ${expected.id}`);
  const { rowSnapshot } = require('./core/memory-reconcile');
  const current = rowSnapshot(row);
  if (current.state !== expected.state
    || current.kind !== expected.kind
    || current.content_digest !== expected.content_digest
    || !sameIdentity(current, expected)) {
    throw new Error(`stale reconcile precondition: row ${expected.id} changed`);
  }
  return row;
}

function copyDuplicateLineage(db, duplicateId, survivorId) {
  const rows = db.prepare(`
    SELECT parent_kind, parent_id, run_id, transform, role
      FROM knowledge_lineage
     WHERE child_kind='memory_item' AND child_id=?
  `).all(duplicateId);
  for (const row of rows) {
    recordKnowledgeLineage(db, {
      childKind: 'memory_item',
      childId: survivorId,
      parentKind: row.parent_kind,
      parentId: row.parent_id,
      runId: row.run_id,
      transform: row.transform,
      role: row.role,
    });
  }
  recordKnowledgeLineage(db, {
    childKind: 'memory_item',
    childId: duplicateId,
    parentKind: 'memory_item',
    parentId: survivorId,
    transform: 'memory-reconcile-v1',
    role: 'superseded',
  });
}

function markDependentsStale(db, parentId) {
  if (!tableExists(db, 'knowledge_artifact_registry')) return [];
  const artifacts = db.prepare(`
    SELECT DISTINCT child_id AS artifact_id
      FROM knowledge_lineage
     WHERE child_kind='knowledge_artifact'
       AND parent_kind='memory_item'
       AND parent_id=?
  `).all(parentId).map(row => row.artifact_id);
  for (const artifactId of artifacts) {
    db.prepare(`UPDATE knowledge_artifact_registry
                   SET status='stale', projected_at=datetime('now')
                 WHERE artifact_id=?`).run(artifactId);
    if (tableExists(db, 'wiki_pages')) {
      db.prepare(`UPDATE wiki_pages
                     SET artifact_status='stale',
                         staleness=MAX(COALESCE(staleness, 0), 1.0),
                         updated_at=datetime('now')
                   WHERE artifact_id=?`).run(artifactId);
    }
  }
  return artifacts;
}

function applyReconcilePlan(db, plan, { lockPath = null } = {}) {
  validatePlan(plan);
  const release = plan.actions.length
    ? acquireLock(lockPath || `${db.filename || 'memory'}.reconcile.lock`)
    : null;
  try {
    ensureReconcileSchema(db);
    requireApplySchema(db);
    if (!plan.actions.length) return { ok: true, applied: 0, archived_ids: [], stale_artifact_ids: [] };
    const archivedIds = [];
    const staleArtifactIds = new Set();
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const action of plan.actions) {
        for (const expected of action.preconditions) assertPrecondition(db, expected);
        const survivor = fetchRow(db, action.survivor.id);
        const duplicate = fetchRow(db, action.duplicate.id);
        if (!survivor || !duplicate || survivor.id === duplicate.id) throw new Error('invalid reconcile duplicate action');
        copyDuplicateLineage(db, duplicate.id, survivor.id);
        archiveMemoryItem(db, duplicate.id, {
          supersededBy: survivor.id,
          reason: ARCHIVE_REASON,
        });
        archivedIds.push(duplicate.id);
        for (const artifactId of markDependentsStale(db, duplicate.id)) staleArtifactIds.add(artifactId);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      throw error;
    }
    return {
      ok: true,
      applied: archivedIds.length,
      archived_ids: archivedIds,
      stale_artifact_ids: [...staleArtifactIds].sort(),
    };
  } finally {
    if (release) release();
  }
}

function formatPlan(plan) {
  const { summary } = plan;
  return [
    `memory reconcile: ${summary.exact_duplicate_actions} exact duplicate action(s)`,
    `review: conflicts=${summary.semantic_conflict_groups} title_duplicates=${summary.title_duplicate_groups} unkeyed=${summary.unkeyed_rows}`,
    `plan_digest=${plan.plan_digest}`,
  ].join('\n');
}

function formatApply(result) {
  return `memory reconcile applied: archived=${result.applied} stale_artifacts=${result.stale_artifact_ids.length}`;
}

function resolveDbPath(options = {}, args = {}) {
  return path.resolve(options.dbPath || args.db || process.env.METAME_MEMORY_DB_PATH || DEFAULT_DB_PATH);
}

function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv);
  const dbPath = resolveDbPath(options, args);
  if (args.mode === 'apply') {
    const db = new DatabaseSync(dbPath);
    try {
      const plan = readPlanFile(args.path);
      const result = applyReconcilePlan(db, plan, {
        lockPath: options.lockPath || `${dbPath}.reconcile.lock`,
      });
      if (options.print !== false) console.log(args.json ? JSON.stringify(result, null, 2) : formatApply(result));
      return result;
    } finally { db.close(); }
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let plan;
  try {
    plan = buildReconcilePlan(readMemoryRows(db), {
      now: options.now || new Date().toISOString(),
      dbPath,
    });
  } finally { db.close(); }

  if (args.mode === 'stage') writePlanFile(args.path, plan);
  if (options.print !== false) {
    if (args.json) console.log(JSON.stringify(plan, null, 2));
    else console.log(formatPlan(plan));
  }
  return plan;
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ARCHIVE_REASON,
  DEFAULT_DB_PATH,
  acquireLock,
  applyReconcilePlan,
  formatApply,
  formatPlan,
  main,
  parseArgs,
  readPlanFile,
  writePlanFile,
  _internal: {
    assertPrecondition,
    columns,
    copyDuplicateLineage,
    markDependentsStale,
    readMemoryRows,
    requireApplySchema,
    ensureReconcileSchema,
    resolveDbPath,
    sameIdentity,
    tableExists,
  },
};
