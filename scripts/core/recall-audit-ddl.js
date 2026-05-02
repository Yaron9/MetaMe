'use strict';

/**
 * scripts/core/recall-audit-ddl.js — single source of truth for recall_audit table.
 *
 * Imported by both:
 *   - memory-wiki-schema.js (applied during memory.js getDb())
 *   - core/recall-audit-db.js (applied lazily in standalone audit handle)
 *
 * Per v4.1 §0.5 "no redundancy" / §P1.17 schema spec.
 */

const RECALL_AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS recall_audit (
    id              TEXT PRIMARY KEY,
    ts              TEXT DEFAULT (datetime('now')),
    phase           TEXT NOT NULL DEFAULT 'observe',
    chat_id         TEXT,
    project         TEXT,
    scope           TEXT,
    agent_key       TEXT,
    engine          TEXT,
    session_started INTEGER DEFAULT 0,
    should_recall   INTEGER DEFAULT 0,
    router_reason   TEXT,
    query_hashes    TEXT DEFAULT '[]',
    anchor_labels   TEXT DEFAULT '[]',
    modes           TEXT DEFAULT '[]',
    source_refs     TEXT DEFAULT '[]',
    injected_chars  INTEGER DEFAULT 0,
    truncated       INTEGER DEFAULT 0,
    wiki_dropped    INTEGER DEFAULT 0,
    outcome         TEXT DEFAULT 'unknown'
                    CHECK (outcome IN ('unknown','planned','injected','used','ignored','corrected','harmful')),
    error_message  TEXT
  )
`;

const RECALL_AUDIT_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_recall_audit_ts      ON recall_audit(ts)',
  'CREATE INDEX IF NOT EXISTS idx_recall_audit_phase   ON recall_audit(phase, ts)',
  'CREATE INDEX IF NOT EXISTS idx_recall_audit_project ON recall_audit(project, scope, ts)',
];

// Single-row state table for monotonic counters that must survive daemon
// restart at sub-marker granularity (e.g. dropped audit-row count). Co-located
// with recall_audit so a single DB handle maintains both.
const RECALL_AUDIT_STATE_DDL = `
  CREATE TABLE IF NOT EXISTS recall_audit_state (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  )
`;

module.exports = { RECALL_AUDIT_DDL, RECALL_AUDIT_INDEXES, RECALL_AUDIT_STATE_DDL };
