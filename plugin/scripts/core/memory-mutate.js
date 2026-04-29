'use strict';

/**
 * scripts/core/memory-mutate.js — centralized memory_items mutation API.
 *
 * Caller passes the open `db` (no implicit getDb here — keeps this module
 * a pure data-layer helper, free of side effects from heavy schema init).
 *
 * Phase-3 candidate review will add `promoteMemoryItem` / `setItemState`
 * here; PR1 only needs `archiveMemoryItem` (used by Step 3 migration of
 * memory.js / memory-gc.js / memory-nightly-reflect.js).
 */

function archiveMemoryItem(db, id, { supersededBy = null, reason = null } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('archiveMemoryItem: db must be a node:sqlite DatabaseSync handle');
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('archiveMemoryItem: id must be a non-empty string');
  }
  db.prepare(
    `UPDATE memory_items
        SET state = 'archived',
            supersedes_id = COALESCE(?, supersedes_id),
            archive_reason = COALESCE(?, archive_reason),
            updated_at = datetime('now')
      WHERE id = ?`
  ).run(supersededBy, reason, id);
}

module.exports = { archiveMemoryItem };
