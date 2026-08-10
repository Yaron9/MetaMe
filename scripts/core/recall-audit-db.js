'use strict';

/**
 * scripts/core/recall-audit-db.js — observe-only telemetry writer.
 *
 * Per v4.1 §P1.13:
 *   - Owns its own DB handle (lazy, opened on first write).
 *   - Failure swallowed — recall audit must never raise into user-visible code path.
 *   - Does NOT require('../memory') and does NOT call applyWikiSchema(), to avoid
 *     triggering memory.js's full schema init on the hot path. Self-contained
 *     CREATE TABLE IF NOT EXISTS recall_audit ensures the row target exists
 *     even if we hit a fresh DB before memory.js had a chance to init.
 *
 * Public API: recordAudit(row), getDroppedCount().
 * Test hooks: _resetForTesting() closes and forgets the cached handle so a fresh
 * DB_PATH (e.g. via METAME_RECALL_AUDIT_DB env) can be picked up next call;
 * _getDbForTesting() returns the cached handle for failure-injection tests.
 *
 * Drop accounting: any prepare().run() exception (lock contention, CHECK
 * violation, etc.) is swallowed but counted in _droppedCount, and the count
 * is persisted to recall_audit_state on every drop so daemon restart resumes
 * cleanly. Every 100 drops we additionally write a marker row (phase='observe',
 * outcome='harmful', error_message='audit_dropped:N') in recall_audit so
 * dashboards see data gaps without scanning the state table.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { RECALL_AUDIT_DDL, RECALL_AUDIT_INDEXES, RECALL_AUDIT_STATE_DDL } = require('./recall-audit-ddl');
const { aggregateRecall } = require('./cognitive-effectiveness');

let _db = null;
let _droppedCount = 0;
const DROP_MARKER_INTERVAL = 100;

function _resolveDbPath() {
  return process.env.METAME_RECALL_AUDIT_DB || path.join(os.homedir(), '.metame', 'memory.db');
}

function _openDb() {
  if (_db) return _db;
  try {
    const dbPath = _resolveDbPath();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec(RECALL_AUDIT_DDL);
    try { db.exec('ALTER TABLE recall_audit ADD COLUMN external_shadow_hits INTEGER DEFAULT 0'); } catch { }
    for (const [name, type] of [
      ['consumer_stage', 'TEXT'], ['consumer_type', 'TEXT'], ['trace_id', 'TEXT'],
      ['latency_ms', 'INTEGER DEFAULT 0'], ['token_count', 'INTEGER DEFAULT 0'],
      ['evidence_class', 'TEXT'],
    ]) {
      try { db.exec(`ALTER TABLE recall_audit ADD COLUMN ${name} ${type}`); } catch { }
    }
    for (const index of RECALL_AUDIT_INDEXES) db.exec(index);
    db.exec(RECALL_AUDIT_STATE_DDL);
    db.prepare(
      `INSERT OR IGNORE INTO recall_audit_state (key, value) VALUES ('dropped_count', 0)`
    ).run();
    _db = db;
    _seedDroppedCountFromDb(db);
    return _db;
  } catch {
    return null;
  }
}

// Seed _droppedCount from recall_audit_state — the single source of truth,
// updated on every drop (not just at 100-drop boundaries). Marker rows in
// recall_audit remain dashboard signals only.
function _seedDroppedCountFromDb(db) {
  try {
    const row = db.prepare(
      `SELECT value FROM recall_audit_state WHERE key = 'dropped_count'`
    ).get();
    if (row && Number.isFinite(row.value) && row.value > _droppedCount) {
      _droppedCount = row.value;
    }
  } catch {
    // Best-effort: missing schema, locked DB, etc. Counter just stays at 0.
  }
}

function _persistDroppedCount(db, total) {
  try {
    db.prepare(
      `UPDATE recall_audit_state SET value = ? WHERE key = 'dropped_count'`
    ).run(total);
  } catch {
    // Sustained contention can drop the UPDATE too. Swallow — next drop
    // retries with the latest value, so persistence catches up automatically.
    // BOUNDED LOSS: drops between the last successful UPDATE and a daemon
    // restart are lost forever (state row lags in-memory counter). Acceptable
    // for best-effort audit telemetry; see test "bounded loss: drops between
    // last successful UPDATE and restart are lost" for the regression pin.
  }
}

function _writeDroppedMarker(db, total) {
  try {
    const id = `audit_dropped_${Date.now()}_${total}`;
    db.prepare(
      `INSERT INTO recall_audit (id, phase, outcome, error_message, should_recall)
       VALUES (?, 'observe', 'harmful', ?, 0)`
    ).run(id, `audit_dropped:${total}`);
  } catch {
    // Sustained contention can drop the marker too. Swallow — the next
    // 100-drop boundary will retry. The counter still records every drop.
  }
}

function recordAudit(row) {
  let db = null;
  try {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id.length === 0) return;
    db = _openDb();
    if (!db) return;
    const phase = ['inject', 'consume'].includes(row.phase) ? row.phase : 'observe';
    db.prepare(
      `INSERT INTO recall_audit
         (id, phase, chat_id, project, scope, agent_key, engine, session_started,
          should_recall, router_reason, query_hashes, anchor_labels, modes,
          source_refs, injected_chars, truncated, wiki_dropped, external_shadow_hits, outcome,
          consumer_stage, consumer_type, trace_id, latency_ms, token_count, evidence_class, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.id,
      phase,
      row.chat_id || null,
      row.project || null,
      row.scope || null,
      row.agent_key || null,
      row.engine || null,
      row.session_started ? 1 : 0,
      row.should_recall ? 1 : 0,
      row.router_reason || null,
      JSON.stringify(Array.isArray(row.query_hashes) ? row.query_hashes : []),
      JSON.stringify(Array.isArray(row.anchor_labels) ? row.anchor_labels : []),
      JSON.stringify(Array.isArray(row.modes) ? row.modes : []),
      JSON.stringify(Array.isArray(row.source_refs) ? row.source_refs : []),
      Number.isFinite(row.injected_chars) ? row.injected_chars : 0,
      row.truncated ? 1 : 0,
      row.wiki_dropped ? 1 : 0,
      Number.isFinite(row.external_shadow_hits) ? row.external_shadow_hits : 0,
      row.outcome || 'unknown',
      row.consumer_stage || null,
      row.consumer_type || null,
      row.trace_id || null,
      Number.isFinite(row.latency_ms) ? row.latency_ms : 0,
      Number.isFinite(row.token_count) ? row.token_count : 0,
      row.evidence_class || null,
      row.error_message || null,
    );
  } catch {
    // Best-effort: audit must never surface failure into user reply path.
    // Count the drop, persist to state row (so daemon restart preserves the
    // count), and emit a marker every DROP_MARKER_INTERVAL so dashboards see
    // data gaps. db is null only if _openDb() failed — in that case both
    // writes would also fail, so skip them.
    _droppedCount += 1;
    if (db) {
      _persistDroppedCount(db, _droppedCount);
      if (_droppedCount % DROP_MARKER_INTERVAL === 0) {
        _writeDroppedMarker(db, _droppedCount);
      }
    }
  }
}

function getDroppedCount() {
  return _droppedCount;
}

/**
 * Aggregate the audit trail for diagnostics (recall-report CLI).
 * Read-only; returns null when the DB is unavailable.
 */
function summarizeAudit({ days = 30 } = {}) {
  const db = _openDb();
  if (!db) return null;
  const since = `-${Math.max(1, Math.floor(days))} days`;
  const get = (sql) => { try { return db.prepare(sql).get(since) || {}; } catch { return {}; } };
  const all = (sql) => { try { return db.prepare(sql).all(since); } catch { return []; } };
  const rows = all(`SELECT * FROM recall_audit WHERE ts >= datetime('now', ?)`);
  const recall = aggregateRecall(rows);
  const totals = get(
    `SELECT COUNT(*) AS turns,
       COALESCE(SUM(should_recall), 0) AS triggered,
       COALESCE(SUM(CASE WHEN phase = 'inject' THEN 1 ELSE 0 END), 0) AS injected,
       COALESCE(SUM(truncated), 0) AS truncated,
       CAST(COALESCE(AVG(CASE WHEN phase = 'inject' AND injected_chars > 0 THEN injected_chars END), 0) AS INTEGER) AS avg_injected_chars
     FROM recall_audit WHERE ts >= datetime('now', ?) AND phase != 'consume'`
  );
  const reasons = all(
    `SELECT COALESCE(router_reason, '(none)') AS reason, COUNT(*) AS n
     FROM recall_audit WHERE ts >= datetime('now', ?) AND should_recall = 1
     GROUP BY router_reason ORDER BY n DESC`
  );
  const outcomes = all(
    `SELECT outcome, COUNT(*) AS n
     FROM recall_audit WHERE ts >= datetime('now', ?) AND phase = 'inject'
     GROUP BY outcome ORDER BY n DESC`
  );
  const consumption = all(
    `SELECT consumer_stage AS stage, COALESCE(engine, consumer_type, '(unknown)') AS host,
            COUNT(*) AS n, COALESCE(SUM(injected_chars), 0) AS chars,
            CAST(COALESCE(AVG(NULLIF(latency_ms, 0)), 0) AS INTEGER) AS avg_latency_ms
       FROM recall_audit
      WHERE ts >= datetime('now', ?) AND phase = 'consume' AND consumer_stage IS NOT NULL
      GROUP BY consumer_stage, COALESCE(engine, consumer_type, '(unknown)')
      ORDER BY consumer_stage, host`
  );
  return {
    days,
    totals: {
      ...totals,
      // `turns` is retained as a compatibility alias for older consumers;
      // callers should use audit_rows and unique_traces for honest counts.
      audit_rows: recall.audit_rows,
      unique_traces: recall.unique_traces,
      opportunities: recall.opportunities,
      turns: totals.turns,
      injected: recall.injected,
    },
    reasons,
    outcomes,
    consumption,
    dropped: getDroppedCount(),
  };
}

function _resetForTesting() {
  _droppedCount = 0;
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

function _getDbForTesting() {
  return _db;
}

module.exports = { recordAudit, getDroppedCount, summarizeAudit, _resetForTesting, _getDbForTesting };
