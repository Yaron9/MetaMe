'use strict';

const crypto = require('crypto');

/**
 * file-map-manifest.js — batch lifecycle for the cleanup pipeline. Pure.
 *
 * A manifest file on disk IS the pending state: the MCP server process is
 * short-lived and possibly multi-instance, so no in-memory map may ever be
 * authoritative (contrast daemon's pendingActivations, which lives in one
 * long-running process). The one-time token printed by cleanup_propose is
 * the only way to address a batch destructively — an agent cannot invent it.
 */

const BATCH_ID_RE = /^b-\d{8}-(?:[0-9a-f]{4}|[0-9a-f]{32})$/;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function isValidBatchId(id) {
  return typeof id === 'string' && BATCH_ID_RE.test(id);
}

/**
 * items come from file-map-protect's validateCandidates accepted list:
 * { path, size, mtimeMs, inode, isDirectory }.
 * randomHex(nBytes) is injected (crypto in the server, fixed values in tests).
 */
function createManifest({ items, reason, source, method, nowMs, ttlMinutes, randomHex }) {
  const ymd = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '');
  const token = randomHex(16);
  const manifest = {
    version: 2,
    batch_id: `b-${ymd}-${randomHex(16)}`,
    token_hash: sha256(token),
    status: 'proposed',
    created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + ttlMinutes * 60 * 1000).toISOString(),
    reason: String(reason),
    source: source || 'manual',
    method,
    items: items.map(it => ({
      item_id: sha256(it.path),
      path: it.path,
      display_path: it.displayPath || it.path,
      size: it.size,
      mtime_ms: it.mtimeMs,
      inode: it.inode,
      device: it.device,
      is_directory: !!it.isDirectory,
      quarantine_path: null,
      result: null,
    })),
    totals: { count: items.length, bytes: items.reduce((s, it) => s + (it.size || 0), 0) },
    executed_at: null,
  };
  return { manifest, token };
}

function checkBatchLimits(items, cleanupCfg) {
  if (items.length > cleanupCfg.maxBatchFiles) {
    return { ok: false, error: `batch too large: ${items.length} files > max ${cleanupCfg.maxBatchFiles} — split into smaller batches` };
  }
  const bytes = items.reduce((s, it) => s + (it.size || 0), 0);
  if (bytes > cleanupCfg.maxBatchBytes) {
    return { ok: false, error: `batch too large: ${bytes} bytes > max ${cleanupCfg.maxBatchBytes} — split into smaller batches` };
  }
  return { ok: true };
}

function isExpired(manifest, nowMs) {
  const t = Date.parse(manifest.expires_at);
  return !Number.isFinite(t) || t <= nowMs;
}

function verifyToken(manifest, token) {
  if (!manifest || manifest.version !== 2 || typeof token !== 'string' || token.length !== 32) return false;
  const expected = Buffer.from(String(manifest.token_hash || ''), 'hex');
  const actual = Buffer.from(sha256(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Snapshot re-verification right before the move — any drift skips the item. */
function verifyItemUnchanged(item, statNow) {
  if (!statNow) return { ok: false, reason: 'missing' };
  if (statNow.size !== item.size) return { ok: false, reason: 'size-changed' };
  if (Math.floor(statNow.mtimeMs) !== Math.floor(item.mtime_ms)) return { ok: false, reason: 'mtime-changed' };
  if (statNow.inode !== item.inode) return { ok: false, reason: 'inode-changed' };
  if (item.device != null && statNow.device !== item.device) return { ok: false, reason: 'device-changed' };
  return { ok: true };
}

function manifestPaths(baseDir) {
  return {
    proposals: `${baseDir}/proposals`,
    inflight: `${baseDir}/inflight`,
    executed: `${baseDir}/executed`,
    quarantine: `${baseDir}/quarantine`,
    audit: `${baseDir}/audit.jsonl`,
  };
}

function redactManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return manifest;
  const copy = JSON.parse(JSON.stringify(manifest));
  delete copy.token;
  delete copy.token_hash;
  return copy;
}

/** The text the agent must relay to the user before cleanup_execute. */
function summarizeForUser(manifest) {
  const mb = (manifest.totals.bytes / 1024 / 1024).toFixed(1);
  const action = manifest.method === 'trash' ? 'move to the macOS Trash' : 'move to the recoverable quarantine area';
  const recovery = manifest.method === 'trash'
    ? 'Items can only be recovered through Finder Trash.'
    : 'Nothing is deleted permanently — cleanup_restore can undo.';
  return `Proposal ${manifest.batch_id}: ${action} ${manifest.totals.count} item(s), ${mb} MB total. `
    + `Reason: ${manifest.reason}. `
    + `Present this list to the user and obtain their explicit consent BEFORE calling cleanup_execute (expires ${manifest.expires_at}). ${recovery}`;
}

module.exports = {
  isValidBatchId,
  createManifest,
  checkBatchLimits,
  isExpired,
  verifyToken,
  verifyItemUnchanged,
  manifestPaths,
  redactManifest,
  summarizeForUser,
  _internal: { BATCH_ID_RE, sha256 },
};
