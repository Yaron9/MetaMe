'use strict';

const crypto = require('crypto');
const path = require('path');

/**
 * file-map-quarantine.js — computes move/restore/purge PLANS; the server
 * executes them. Quarantine uses an opaque digest plus a sanitized basename;
 * the manifest is the authoritative restore mapping:
 *
 *   /Users/u/Downloads/x.dmg → <quarantine>/<batch>/<sha256>--x.dmg
 */

function quarantinePathFor(quarantineRoot, batchId, originalPath) {
  const batchRoot = path.join(quarantineRoot, batchId);
  const digest = crypto.createHash('sha256').update(String(originalPath)).digest('hex');
  const basename = path.basename(originalPath).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'item';
  const destination = path.join(batchRoot, `${digest}--${basename}`);
  const prefix = batchRoot.endsWith(path.sep) ? batchRoot : batchRoot + path.sep;
  if (!destination.startsWith(prefix)) throw new Error('quarantine path escaped batch root');
  return destination;
}

function planQuarantineMoves(items, quarantineRoot, batchId) {
  return items.map(it => ({
    path: it.path,
    from: it.path,
    to: quarantinePathFor(quarantineRoot, batchId, it.path),
  }));
}

/** Restore moved items (optionally a subset) back to their original paths. */
function planRestore(manifest, { paths } = {}) {
  const wanted = Array.isArray(paths) && paths.length ? new Set(paths) : null;
  return manifest.items
    .filter(it => it.result === 'moved' && it.quarantine_path && (!wanted || wanted.has(it.path)))
    .map(it => ({ path: it.path, from: it.quarantine_path, to: it.path }));
}

/** Executed batches whose retention window has fully elapsed. */
function planPurge(manifests, { quarantineDays, nowMs }) {
  const cutoff = nowMs - quarantineDays * 24 * 3600 * 1000;
  return manifests.filter(m => {
    if (m.status !== 'executed' || !m.executed_at) return false;
    if (!Array.isArray(m.items) || !m.items.some(item => item.result === 'moved' && item.quarantine_path)) return false;
    const t = Date.parse(m.executed_at);
    return Number.isFinite(t) && t < cutoff;
  });
}

module.exports = { quarantinePathFor, planQuarantineMoves, planRestore, planPurge };
