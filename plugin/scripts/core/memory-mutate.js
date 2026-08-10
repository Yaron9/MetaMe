'use strict';

/**
 * scripts/core/memory-mutate.js — centralized memory_items mutation API.
 *
 * Caller passes the open `db` (no implicit getDb here — keeps this module
 * a pure data-layer helper, free of side effects from heavy schema init).
 *
 * Two functions only, both with PR1 callers (§0.5 "no dead code"):
 *   - archiveMemoryItem(db, id, opts) — archive with supersedes/reason
 *   - setItemState(db, id, newState)  — generic state transition (e.g. promote)
 *
 * §P1.8 acceptance: `rg "UPDATE memory_items SET state ?= ?'(archived|active)'"
 * scripts` must hit only this file and its test.
 */

const VALID_STATES = new Set(['candidate', 'active', 'conflict', 'archived']);

function _validateDb(db, fn) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError(`${fn}: db must be a node:sqlite DatabaseSync handle`);
  }
}

function _validateId(id, fn) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError(`${fn}: id must be a non-empty string`);
  }
}

function _tableExists(db, table) {
  return !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?"
  ).get(table);
}

function _columns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function _claimRow(db, id) {
  const columns = _columns(db, 'memory_items');
  const selected = ['id', 'kind', 'state', 'content', 'project', 'scope', 'task_key', 'canonical_key']
    .filter(column => columns.has(column));
  return db.prepare(`SELECT ${selected.join(',')} FROM memory_items WHERE id=?`).get(id) || null;
}

function archiveMemoryItem(db, id, { supersededBy = null, reason = null } = {}) {
  _validateDb(db, 'archiveMemoryItem');
  _validateId(id, 'archiveMemoryItem');
  db.prepare(
    `UPDATE memory_items
        SET state = 'archived',
            supersedes_id = COALESCE(?, supersedes_id),
            archive_reason = COALESCE(?, archive_reason),
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(supersededBy, reason, id);
}

function setItemState(db, id, newState) {
  _validateDb(db, 'setItemState');
  _validateId(id, 'setItemState');
  if (!VALID_STATES.has(newState)) {
    throw new TypeError(`setItemState: newState must be one of ${[...VALID_STATES].join('|')}, got: ${newState}`);
  }
  const row = _claimRow(db, id);
  if (newState === 'active') {
    if (row && (String(row.kind || '').toLowerCase() === 'episode' || String(row.task_key || '').trim())) {
      throw new Error('setItemState: task-local claims cannot be promoted');
    }
  }
  if (row && _isCanonicalClaim(row) && String(row.state) !== String(newState)
    && !_isLegalClaimTransition(row.state, newState)) {
    throw new Error(`setItemState: illegal claim transition ${row.state} -> ${newState}`);
  }
  db.prepare(
    `UPDATE memory_items SET state = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newState, id);
}

function _isCanonicalClaim(row) {
  return require('./claim-contract').isCanonicalClaim(row);
}

function _isLegalClaimTransition(from, to) {
  const transitions = {
    candidate: new Set(['active', 'conflict', 'archived']),
    active: new Set(['archived']),
    conflict: new Set(['active', 'archived']),
    archived: new Set(),
  };
  return Boolean(transitions[String(from)] && transitions[String(from)].has(String(to)));
}

function recordKnowledgeLineage(db, {
  childKind = 'memory_item', childId, parentKind = 'memory_item', parentId,
  runId = null, transform = 'claim-contract-v1', role = 'evidence',
} = {}) {
  _validateDb(db, 'recordKnowledgeLineage');
  _validateId(childId, 'recordKnowledgeLineage');
  _validateId(parentId, 'recordKnowledgeLineage');
  if (!_tableExists(db, 'knowledge_lineage')) return { recorded: false, reason: 'lineage_table_missing' };
  db.prepare(`
    INSERT OR IGNORE INTO knowledge_lineage
      (child_kind, child_id, parent_kind, parent_id, run_id, transform, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(childKind, childId, parentKind, parentId, runId, transform, role);
  return { recorded: true };
}

function mergeClaimLineage(db, canonicalId, parent) {
  const parentKind = parent.parent_kind || parent.parentKind || 'memory_item';
  const parentId = parent.parent_id || parent.parentId || parent.id;
  return recordKnowledgeLineage(db, {
    childKind: 'memory_item',
    childId: canonicalId,
    parentKind,
    parentId,
    runId: parent.run_id || parent.runId || null,
    transform: parent.transform || 'claim-contract-v1',
    role: parent.role || 'evidence',
  });
}

function _markClaimDependentsStale(db, parentIds) {
  if (!Array.isArray(parentIds) || parentIds.length === 0) return [];
  if (!_tableExists(db, 'knowledge_lineage') || !_tableExists(db, 'knowledge_artifact_registry')) return [];
  const placeholders = parentIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT child_id AS artifact_id
      FROM knowledge_lineage
     WHERE child_kind='knowledge_artifact'
       AND parent_kind='memory_item'
       AND parent_id IN (${placeholders})
  `).all(...parentIds);
  for (const row of rows) {
    db.prepare(`UPDATE knowledge_artifact_registry SET status='stale', projected_at=datetime('now') WHERE artifact_id=?`)
      .run(row.artifact_id);
    if (_tableExists(db, 'wiki_pages')) {
      db.prepare(`UPDATE wiki_pages SET artifact_status='stale', staleness=MAX(COALESCE(staleness, 0), 1.0), updated_at=datetime('now') WHERE artifact_id=?`)
        .run(row.artifact_id);
    }
  }
  return rows.map(row => row.artifact_id);
}

/**
 * Resolve one canonical identity's conflict in one transaction. The caller
 * chooses the winner; no confidence, title, or recency heuristic is involved.
 */
function resolveClaimConflict(db, { winnerId, reason = 'conflict_resolution' } = {}) {
  _validateDb(db, 'resolveClaimConflict');
  _validateId(winnerId, 'resolveClaimConflict');
  const { isCanonicalClaim, isTaskLocalClaim } = require('./claim-contract');
  const winner = _claimRow(db, winnerId);
  if (!winner) throw new Error(`resolveClaimConflict: unknown claim ${winnerId}`);
  if (!isCanonicalClaim(winner) || isTaskLocalClaim(winner)) {
    throw new Error('resolveClaimConflict: winner must be a canonical non-task claim');
  }
  if (!_tableExists(db, 'knowledge_lineage')) {
    throw new Error('resolveClaimConflict: knowledge_lineage table is required');
  }
  const identityArgs = [winner.canonical_key, winner.project, winner.scope];
  const identityRows = db.prepare(`
    SELECT id, kind, state, content, project, scope, task_key, canonical_key
      FROM memory_items
     WHERE canonical_key=? AND project IS ? AND scope IS ?
       AND state IN ('candidate','active','conflict')
  `).all(...identityArgs);
  if (!identityRows.some(row => row.id === winnerId)) {
    throw new Error('resolveClaimConflict: winner is not in a live identity group');
  }
  const archivedIds = identityRows.filter(row => row.id !== winnerId).map(row => row.id);
  const started = true;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const id of archivedIds) {
      archiveMemoryItem(db, id, { supersededBy: winnerId, reason });
      recordKnowledgeLineage(db, {
        childId: id,
        parentId: winnerId,
        transform: 'claim-conflict-resolution-v1',
        role: 'superseded',
      });
    }
    setItemState(db, winnerId, 'active');
    const staleArtifactIds = _markClaimDependentsStale(db, archivedIds);
    db.exec('COMMIT');
    return { ok: true, winnerId, archivedIds, staleArtifactIds };
  } catch (error) {
    if (started) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    }
    throw error;
  }
}

function promoteClaim(db, id) {
  _validateDb(db, 'promoteClaim');
  _validateId(id, 'promoteClaim');
  setItemState(db, id, 'active');
  return { ok: true, id };
}

module.exports = {
  archiveMemoryItem,
  mergeClaimLineage,
  promoteClaim,
  recordKnowledgeLineage,
  resolveClaimConflict,
  resolveConflict: resolveClaimConflict,
  setItemState,
  VALID_STATES,
};
