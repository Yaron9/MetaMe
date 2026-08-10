'use strict';

/**
 * Pure projection safety decisions.
 *
 * A generated Wiki file is safe to replace only when the on-disk file still
 * matches the last projection that MetaMe recorded.  The generated content
 * (Current) is deliberately compared byte-for-byte after LF normalization;
 * there is no semantic or LLM merge in this boundary.
 */

const crypto = require('node:crypto');

function normalizeProjectionText(value) {
  return String(value ?? '').replace(/\r\n?/gu, '\n');
}

function projectionHash(value) {
  return crypto.createHash('sha256')
    .update(normalizeProjectionText(value), 'utf8')
    .digest('hex');
}

/**
 * Classify one generated projection using Base/Current/User hashes.
 *
 * `userExists=false` is distinct from an empty file: deleting a tracked page
 * is a user change and therefore fails closed.  A page with no baseline may
 * be created only when its target file does not exist yet.
 */
function classifyProjectionHashes({
  baseHash = null,
  currentHash,
  userHash = null,
  userExists = true,
} = {}) {
  const base = baseHash || null;
  const current = currentHash || null;
  const user = userHash || null;

  if (!userExists) {
    if (!base) return _result('new', true, 'no_user_file_and_no_baseline', { base, current, user });
    return _result('missing', false, 'tracked_file_missing', { base, current, user });
  }

  if (!base) return _result('untracked', false, 'missing_projection_baseline', { base, current, user });
  if (user === base) {
    return _result(current === base ? 'tracked' : 'drift', true,
      current === base ? 'unchanged' : 'canonical_projection_changed', { base, current, user });
  }
  if (current === base) return _result('modified', false, 'user_modified', { base, current, user });
  return _result('conflict', false, 'user_and_canonical_changed', { base, current, user });
}

function _result(classification, canWrite, reason, hashes) {
  return {
    classification,
    status: classification,
    canWrite,
    write: canWrite,
    reason,
    ...hashes,
  };
}

module.exports = {
  classifyProjection: classifyProjectionHashes,
  classifyProjectionHashes,
  hashProjection: projectionHash,
  normalizeProjectionText,
  projectionHash,
};
