#!/usr/bin/env node

/**
 * memory-gc.js — Nightly Memory Garbage Collection
 *
 * Promotes hot candidates and archives stale items in memory.db
 * using the memory_items table and core/memory-model.js heuristics.
 *
 * Designed to run nightly at 02:00 via daemon.yaml scheduler.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const DB_PATH = path.join(METAME_DIR, 'memory.db');
const LOCK_FILE = path.join(METAME_DIR, 'memory-gc.lock');
const GC_LOG_FILE = path.join(METAME_DIR, 'memory_gc_log.jsonl');

// Lock timeout: if a lock is older than this, it's stale and safe to break
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Acquire atomic lock using O_EXCL — prevents concurrent GC runs.
 * Returns the lock fd, or throws if lock is held by a live process.
 */
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Check if the lock is stale (crashed process left it behind)
      try {
        const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (lockAge < LOCK_TIMEOUT_MS) {
          console.log('[MEMORY-GC] Already running (lock held), skipping.');
          return false;
        }
        // Stale lock — remove and re-acquire
        fs.unlinkSync(LOCK_FILE);
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, process.pid.toString());
        fs.closeSync(fd);
        return true;
      } catch {
        console.log('[MEMORY-GC] Could not acquire lock, skipping.');
        return false;
      }
    }
    throw e;
  }
}

/**
 * Release the atomic lock.
 */
function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* non-fatal */ }
}

/**
 * Append a GC run record to the audit log.
 */
function writeGcLog(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  try {
    fs.mkdirSync(path.dirname(GC_LOG_FILE), { recursive: true });
    fs.appendFileSync(GC_LOG_FILE, line, 'utf8');
  } catch (e) {
    console.log(`[MEMORY-GC] Warning: could not write GC log: ${e.message}`);
  }
}

/**
 * Get the on-disk size of the database file in bytes.
 */
function getDbSizeBytes() {
  try { return fs.statSync(DB_PATH).size; } catch { return 0; }
}

/**
 * Read memory_recall_audit_retention_days from ~/.metame/daemon.yaml, with
 * defensive fallback. The standalone deploy may not have js-yaml on its
 * direct path; use the same resolver pattern as ~/.metame/daemon.js.
 *
 * Default: 45 days — covers v4.1 §P1.16's 4-week observation window plus
 * a buffer week for analysis before the show_marker flip.
 */
function _readAuditRetentionDays() {
  const DEFAULT_DAYS = 45;
  try {
    const cfgPath = path.join(METAME_DIR, 'daemon.yaml');
    if (!fs.existsSync(cfgPath)) return DEFAULT_DAYS;
    let yaml;
    try { yaml = require('./resolve-yaml'); } catch {
      try { yaml = require('js-yaml'); } catch { return DEFAULT_DAYS; }
    }
    if (!yaml || typeof yaml.load !== 'function') return DEFAULT_DAYS;
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    const v = cfg.daemon && cfg.daemon.memory_recall_audit_retention_days;
    if (Number.isFinite(v) && v > 0) return Math.floor(v);
    return DEFAULT_DAYS;
  } catch {
    return DEFAULT_DAYS;
  }
}

/**
 * Delete recall_audit rows older than `retentionDays` and return the
 * deleted count. Best-effort: missing table, schema drift, or transient
 * SQLITE_BUSY all degrade to 0. Caller (run()) records the count to the
 * existing GC log so the deletion volume is observable.
 */
function cleanupRecallAudit(db, retentionDays) {
  const days = Number.isFinite(retentionDays) && retentionDays > 0
    ? Math.floor(retentionDays)
    : 45;
  try {
    const cutoff = `-${days} days`;
    const result = db.prepare(
      `DELETE FROM recall_audit WHERE ts < datetime('now', ?)`
    ).run(cutoff);
    const deleted = Number.isFinite(result && result.changes) ? result.changes : 0;
    if (deleted > 0) {
      console.log(`[MEMORY-GC] Pruned ${deleted} recall_audit rows older than ${days} days`);
    }
    return deleted;
  } catch (e) {
    if (!/no such table/i.test(e.message || '')) {
      console.log(`[MEMORY-GC] recall_audit cleanup failed (non-fatal): ${e.message}`);
    }
    return 0;
  }
}

/**
 * Main GC run.
 */
function run() {
  console.log('[MEMORY-GC] Starting GC run...');

  if (!fs.existsSync(DB_PATH)) {
    console.log('[MEMORY-GC] memory.db not found, nothing to GC.');
    return;
  }

  if (!acquireLock()) {
    return;
  }

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);

    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');

    // Ensure schema migrations (including memory_items.archive_reason) are applied
    // before any mutate API call. Stand-alone GC may run before memory.js:getDb()
    // touches this DB, so we cannot rely on getDb() to apply schema for us.
    const { applyWikiSchema } = require('./memory-wiki-schema');
    applyWikiSchema(db);

    const dbSizeBefore = getDbSizeBytes();

    const memoryModel = require('./core/memory-model');
    const mutate = require('./core/memory-mutate');

    let promoted = 0;
    let archivedCount = 0;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Phase 1: Promote hot candidates
      const candidates = db.prepare(
        `SELECT * FROM memory_items WHERE state = 'candidate'`
      ).all();
      for (const item of candidates) {
        if (memoryModel.shouldPromote(item)) {
          mutate.setItemState(db, item.id, 'active');
          promoted++;
        }
      }
      if (promoted > 0) console.log(`[MEMORY-GC] Promoted ${promoted} candidates`);

      // Phase 2: Archive stale items
      const allItems = db.prepare(
        `SELECT * FROM memory_items WHERE state IN ('candidate', 'active')`
      ).all();
      for (const item of allItems) {
        if (memoryModel.shouldArchive(item)) {
          mutate.archiveMemoryItem(db, item.id, { reason: 'gc' });
          archivedCount++;
        }
      }
      if (archivedCount > 0) console.log(`[MEMORY-GC] Archived ${archivedCount} stale items`);

      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      throw e;
    }

    console.log(`[MEMORY-GC] Promoted ${promoted}, archived ${archivedCount}`);

    // Phase 3: prune recall_audit rows beyond the retention window. Runs
    // OUTSIDE the memory_items transaction because it's an independent
    // table and we don't want a slow audit DELETE to hold the row lock
    // on memory_items. Best-effort (missing table / drift → 0).
    const auditPruned = cleanupRecallAudit(db, _readAuditRetentionDays());

    // Run VACUUM to reclaim space (only if anything was deleted) — outside transaction
    if (archivedCount > 0 || auditPruned > 0) {
      try {
        db.exec('VACUUM');
      } catch { /* non-fatal — WAL mode makes VACUUM occasionally slow */ }
    }

    const dbSizeAfter = getDbSizeBytes();

    // ── Write audit log ──
    writeGcLog({
      promoted,
      archived: archivedCount,
      audit_pruned: auditPruned,
      db_size_before: dbSizeBefore,
      db_size_after: dbSizeAfter,
    });

    console.log(`[MEMORY-GC] GC complete. Log: ${GC_LOG_FILE}`);

  } catch (e) {
    console.error(`[MEMORY-GC] Fatal error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    try { if (db) db.close(); } catch { /* non-fatal */ }
    releaseLock();
  }
}

run();
