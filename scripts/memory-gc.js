#!/usr/bin/env node

/**
 * memory-gc.js — Nightly Fact Garbage Collection
 *
 * Archives stale, low-frequency facts from memory.db by marking them
 * with conflict_status = 'ARCHIVED' (soft delete, fully auditable).
 *
 * GC criteria (ALL must be true):
 *   1. last_searched_at < 30 days ago, OR last_searched_at IS NULL and created_at < 30 days ago
 *   2. search_count < 3
 *   3. superseded_by IS NULL          (already-superseded facts excluded)
 *   4. conflict_status IS NULL OR conflict_status = 'OK'  (skip CONFLICT/ARCHIVED)
 *   5. relation NOT IN protected set  (user_pref, workflow_rule, arch_convention never archived)
 *
 * Protected relations are permanently excluded — they are high-value guardrails
 * that must survive regardless of search frequency.
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

// Relations that are permanently protected from archival
const PROTECTED_RELATIONS = ['user_pref', 'workflow_rule', 'arch_convention'];

// GC threshold: facts older than this many days are candidates
const STALE_DAYS = 30;
// GC threshold: facts with fewer searches than this are candidates
const MIN_SEARCH_COUNT = 3;
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

    // ── Ensure ARCHIVED status column accepts the new value ──
    // conflict_status was created with NOT NULL DEFAULT 'OK'; ARCHIVED is a new valid state.
    // No schema change needed — we just write the string value directly.

    const protectedPlaceholders = PROTECTED_RELATIONS.map(() => '?').join(', ');

    // ── DRY RUN: count candidates and protected exclusions ──
    console.log(`[MEMORY-GC] Scanning facts older than ${STALE_DAYS} days with search_count < ${MIN_SEARCH_COUNT}...`);

    const countCandidatesStmt = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM facts
      WHERE (
        (last_searched_at IS NOT NULL AND last_searched_at < datetime('now', '-${STALE_DAYS} days'))
        OR
        (last_searched_at IS NULL AND created_at < datetime('now', '-${STALE_DAYS} days'))
      )
      AND search_count < ${MIN_SEARCH_COUNT}
      AND superseded_by IS NULL
      AND (conflict_status IS NULL OR conflict_status = 'OK')
      AND relation NOT IN (${protectedPlaceholders})
    `);
    const candidateCount = countCandidatesStmt.get(...PROTECTED_RELATIONS).cnt;

    // Count how many facts would be skipped due to the protected-relation guard
    const countProtectedStmt = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM facts
      WHERE (
        (last_searched_at IS NOT NULL AND last_searched_at < datetime('now', '-${STALE_DAYS} days'))
        OR
        (last_searched_at IS NULL AND created_at < datetime('now', '-${STALE_DAYS} days'))
      )
      AND search_count < ${MIN_SEARCH_COUNT}
      AND superseded_by IS NULL
      AND (conflict_status IS NULL OR conflict_status = 'OK')
      AND relation IN (${protectedPlaceholders})
    `);
    const protectedCount = countProtectedStmt.get(...PROTECTED_RELATIONS).cnt;

    console.log(`[MEMORY-GC] Found ${candidateCount} candidates (excluded ${protectedCount} protected facts)`);

    let archivedCount = 0;

    if (candidateCount > 0) {
      // ── EXECUTE: archive the candidates ──
      const updateStmt = db.prepare(`
        UPDATE facts
        SET conflict_status = 'ARCHIVED',
            updated_at = datetime('now')
        WHERE (
          (last_searched_at IS NOT NULL AND last_searched_at < datetime('now', '-${STALE_DAYS} days'))
          OR
          (last_searched_at IS NULL AND created_at < datetime('now', '-${STALE_DAYS} days'))
        )
        AND search_count < ${MIN_SEARCH_COUNT}
        AND superseded_by IS NULL
        AND (conflict_status IS NULL OR conflict_status = 'OK')
        AND relation NOT IN (${protectedPlaceholders})
      `);

      const result = updateStmt.run(...PROTECTED_RELATIONS);
      archivedCount = result.changes;

      console.log(`[MEMORY-GC] Archived ${archivedCount} facts → conflict_status = 'ARCHIVED'`);
    } else {
      console.log('[MEMORY-GC] No candidates to archive.');
    }

    // Run VACUUM to reclaim space (only if we archived something)
    if (archivedCount > 0) {
      try {
        db.exec('VACUUM');
      } catch { /* non-fatal — WAL mode makes VACUUM occasionally slow */ }
    }

    const dbSizeAfter = getDbSizeBytes();

    // ── Write audit log ──
    writeGcLog({
      archived: archivedCount,
      skipped_protected: protectedCount,
      candidates_found: candidateCount,
      stale_days_threshold: STALE_DAYS,
      min_search_count_threshold: MIN_SEARCH_COUNT,
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
