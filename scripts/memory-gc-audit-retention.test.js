'use strict';

/**
 * memory-gc-audit-retention.test.js — verifies cleanupRecallAudit prunes
 * old recall_audit rows past the retention window without touching
 * recent rows or other tables.
 *
 * The function is exported only for testing via require.cache mutation
 * because memory-gc.js auto-runs on require. We use the same trick to
 * read the helper without invoking run().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// memory-gc.js runs `run()` at module load. To unit-test the helper we
// require it via a sandboxed cache key + stub argv so run() short-circuits
// on missing DB. Cleanest approach: just read the source and eval the
// function definitions in isolation so we don't trigger run().
const GC_SRC_PATH = path.join(__dirname, 'memory-gc.js');
const GC_SRC = fs.readFileSync(GC_SRC_PATH, 'utf8');
function _extractFn(name) {
  // Naive but sufficient for our two pure helpers — find `function NAME(`
  // and capture until matching closing brace at depth 0.
  const idx = GC_SRC.indexOf(`function ${name}(`);
  if (idx < 0) throw new Error(`function ${name} not found in memory-gc.js`);
  let depth = 0; let i = idx;
  while (i < GC_SRC.length) {
    const c = GC_SRC[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return GC_SRC.slice(idx, i + 1); }
    i++;
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}
const cleanupRecallAuditSrc = _extractFn('cleanupRecallAudit');
// Wrap in IIFE that returns the function.
const cleanupRecallAudit = new Function(
  `${cleanupRecallAuditSrc}; return cleanupRecallAudit;`,
)();

function freshDbWithAuditSchema() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-retention-'));
  const dbPath = path.join(dir, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  // Apply just the recall_audit DDL to keep the test focused.
  const { RECALL_AUDIT_DDL, RECALL_AUDIT_INDEXES } = require('./core/recall-audit-ddl');
  db.exec(RECALL_AUDIT_DDL);
  for (const idx of RECALL_AUDIT_INDEXES) db.exec(idx);
  return { db, dir };
}

function insertAuditRow(db, id, daysAgo) {
  db.prepare(
    `INSERT INTO recall_audit (id, ts, phase, project, should_recall)
     VALUES (?, datetime('now', ?), 'observe', 'metame', 1)`
  ).run(id, `-${daysAgo} days`);
}

test('cleanupRecallAudit deletes only rows older than retention window', () => {
  const { db, dir } = freshDbWithAuditSchema();
  try {
    insertAuditRow(db, 'recent_1', 1);     // keep
    insertAuditRow(db, 'recent_2', 30);    // keep
    insertAuditRow(db, 'edge_44', 44);     // keep (within 45-day default)
    insertAuditRow(db, 'edge_46', 46);     // delete
    insertAuditRow(db, 'old_1', 60);       // delete
    insertAuditRow(db, 'old_2', 365);      // delete

    const deleted = cleanupRecallAudit(db, 45);
    assert.equal(deleted, 3);

    const remaining = db.prepare(`SELECT id FROM recall_audit ORDER BY id`).all().map(r => r.id);
    assert.deepEqual(remaining, ['edge_44', 'recent_1', 'recent_2']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupRecallAudit honours custom retentionDays', () => {
  const { db, dir } = freshDbWithAuditSchema();
  try {
    insertAuditRow(db, 'r3', 3);
    insertAuditRow(db, 'r10', 10);
    insertAuditRow(db, 'r30', 30);
    // 7-day retention — anything older than 7 days goes.
    const deleted = cleanupRecallAudit(db, 7);
    assert.equal(deleted, 2);
    const remaining = db.prepare(`SELECT id FROM recall_audit`).all().map(r => r.id);
    assert.deepEqual(remaining, ['r3']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupRecallAudit defaults to 45 when retentionDays invalid', () => {
  const { db, dir } = freshDbWithAuditSchema();
  try {
    insertAuditRow(db, 'old_60', 60);  // would survive any retention > 60
    insertAuditRow(db, 'recent_1', 1);
    // Pass garbage — implementation should fall back to 45.
    for (const bad of [undefined, null, NaN, -1, 0, 'forty-five']) {
      // Re-seed for each bad input.
      db.exec('DELETE FROM recall_audit');
      insertAuditRow(db, 'old_60', 60);
      insertAuditRow(db, 'recent_1', 1);
      const deleted = cleanupRecallAudit(db, bad);
      assert.equal(deleted, 1, `bad input ${bad} should fall back to 45 → 1 deleted`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupRecallAudit returns 0 when recall_audit table is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-retention-notbl-'));
  const db = new DatabaseSync(path.join(dir, 'memory.db'));
  // No DDL applied — recall_audit does not exist.
  try {
    const deleted = cleanupRecallAudit(db, 45);
    assert.equal(deleted, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupRecallAudit empty table returns 0', () => {
  const { db, dir } = freshDbWithAuditSchema();
  try {
    const deleted = cleanupRecallAudit(db, 45);
    assert.equal(deleted, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupRecallAudit does not touch other tables (memory_items)', () => {
  const { db, dir } = freshDbWithAuditSchema();
  try {
    // Add memory_items table + a row with old created_at.
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        state TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.prepare(
      `INSERT INTO memory_items (id, kind, state, content, created_at)
       VALUES ('mi_old', 'fact', 'archived', 'x', datetime('now', '-365 days'))`
    ).run();
    insertAuditRow(db, 'a_old', 100);

    cleanupRecallAudit(db, 45);

    const mi = db.prepare(`SELECT id FROM memory_items`).all().map(r => r.id);
    const ra = db.prepare(`SELECT id FROM recall_audit`).all().map(r => r.id);
    assert.deepEqual(mi, ['mi_old'], 'memory_items must be untouched');
    assert.deepEqual(ra, [], 'recall_audit pruned');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
