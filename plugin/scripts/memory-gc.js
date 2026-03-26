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

    const dbSizeBefore = getDbSizeBytes();

    const memoryModel = require('./core/memory-model');

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
          db.prepare(
            `UPDATE memory_items SET state = 'active', updated_at = datetime('now') WHERE id = ?`
          ).run(item.id);
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
          db.prepare(
            `UPDATE memory_items SET state = 'archived', updated_at = datetime('now') WHERE id = ?`
          ).run(item.id);
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

    // Run VACUUM to reclaim space (only if we archived something) — outside transaction
    if (archivedCount > 0) {
      try {
        db.exec('VACUUM');
      } catch { /* non-fatal — WAL mode makes VACUUM occasionally slow */ }
    }

    const dbSizeAfter = getDbSizeBytes();

    // ── Write audit log ──
    writeGcLog({
      promoted,
      archived: archivedCount,
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
