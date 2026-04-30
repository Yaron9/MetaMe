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
 * Public API (single function): recordAudit(row).
 * Test hook: _resetForTesting() closes and forgets the cached handle so a fresh
 * DB_PATH (e.g. via METAME_RECALL_AUDIT_DB env) can be picked up next call.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { RECALL_AUDIT_DDL } = require('./recall-audit-ddl');

let _db = null;

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
    _db = db;
    return _db;
  } catch {
    return null;
  }
}

function recordAudit(row) {
  try {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || row.id.length === 0) return;
    const db = _openDb();
    if (!db) return;
    const phase = row.phase === 'inject' ? 'inject' : 'observe';
    db.prepare(
      `INSERT INTO recall_audit
         (id, phase, chat_id, project, scope, agent_key, engine, session_started,
          should_recall, router_reason, query_hashes, anchor_labels, modes,
          source_refs, injected_chars, truncated, wiki_dropped, outcome, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      row.outcome || 'unknown',
      row.error_message || null,
    );
  } catch {
    // Best-effort: audit must never surface failure into user reply path.
  }
}

function _resetForTesting() {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

module.exports = { recordAudit, _resetForTesting };
