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

const VALID_STATES = new Set(['candidate', 'active', 'archived']);

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
  db.prepare(
    `UPDATE memory_items SET state = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(newState, id);
}

module.exports = { archiveMemoryItem, setItemState };
