'use strict';

/**
 * file-map-audit.js — append-only JSONL audit trail for the cleanup pipeline.
 * fs is injected. Every propose/execute/skip/restore/purge/expire lands here;
 * a torn line never breaks readers (bad lines are skipped on read).
 */

const MAX_BYTES = 10 * 1024 * 1024;

function appendAudit({ fsx }, file, record) {
  try {
    rotateIfNeeded({ fsx }, file, MAX_BYTES);
    fsx.appendFileSync(file, JSON.stringify(record) + '\n');
    return true;
  } catch {
    return false; // audit must never block the operation it describes
  }
}

function rotateIfNeeded({ fsx }, file, maxBytes) {
  try {
    if (fsx.statSync(file).size > maxBytes) fsx.renameSync(file, `${file}.1`);
  } catch { /* no file yet */ }
}

function readAuditTail({ fsx }, file, n) {
  let text;
  try { text = fsx.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = text.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-Math.max(1, n))) {
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return out;
}

module.exports = { appendAudit, rotateIfNeeded, readAuditTail, _internal: { MAX_BYTES } };
