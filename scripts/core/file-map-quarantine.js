'use strict';

/**
 * file-map-quarantine.js — computes move/restore/purge PLANS; the server
 * executes them. Quarantine layout mirrors the absolute original path under
 * quarantine/<batch_id>/, so restore mapping is unambiguous:
 *
 *   /Users/u/Downloads/x.dmg → <quarantine>/b-20260718-a1f2/Users/u/Downloads/x.dmg
 */

function quarantinePathFor(quarantineRoot, batchId, originalPath) {
  return `${quarantineRoot}/${batchId}${originalPath}`;
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
    const t = Date.parse(m.executed_at);
    return Number.isFinite(t) && t < cutoff;
  });
}

module.exports = { quarantinePathFor, planQuarantineMoves, planRestore, planPurge };
