'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidBatchId, createManifest, checkBatchLimits, isExpired, verifyToken, verifyItemUnchanged, manifestPaths, summarizeForUser,
} = require('./file-map-manifest');

const NOW = Date.parse('2026-07-18T00:00:00Z');
const randomHex = (n) => 'ab'.repeat(n);

function sampleManifest(over = {}) {
  return {
    ...createManifest({
      items: [{ path: '/home/u/Downloads/x.dmg', size: 100, mtimeMs: 5000.7, inode: 42, isDirectory: false }],
      reason: 'stale installers',
      source: 'scan_stale',
      method: 'quarantine',
      nowMs: NOW,
      ttlMinutes: 60,
      randomHex,
    }),
    ...over,
  };
}

describe('file-map-manifest lifecycle', () => {
  it('creates a well-formed proposed manifest with deterministic shape', () => {
    const m = sampleManifest();
    assert.equal(m.batch_id, 'b-20260718-abab');
    assert.ok(isValidBatchId(m.batch_id));
    assert.equal(m.token, 'abababab');
    assert.equal(m.status, 'proposed');
    assert.equal(m.expires_at, new Date(NOW + 3600 * 1000).toISOString());
    assert.equal(m.items[0].mtime_ms, 5000.7);
    assert.equal(m.items[0].quarantine_path, null);
    assert.deepEqual(m.totals, { count: 1, bytes: 100 });
  });

  it('batch id validation rejects traversal-shaped ids', () => {
    for (const bad of ['../etc', 'b-20260718-ZZZZ', 'b-2026-ab', '', null, 'b-20260718-abab/x']) {
      assert.equal(isValidBatchId(bad), false, `${bad} must be invalid`);
    }
  });

  it('TTL expiry and token verification', () => {
    const m = sampleManifest();
    assert.equal(isExpired(m, NOW + 59 * 60 * 1000), false);
    assert.equal(isExpired(m, NOW + 60 * 60 * 1000), true);
    assert.equal(isExpired({ expires_at: 'garbage' }, NOW), true, 'unparseable expiry counts as expired');
    assert.equal(verifyToken(m, 'abababab'), true);
    assert.equal(verifyToken(m, 'wrongtok'), false);
    assert.equal(verifyToken(m, ''), false);
    assert.equal(verifyToken(m, 'ab'), false, 'short tokens rejected outright');
  });

  it('batch limits reject oversize batches', () => {
    const cfg = { maxBatchFiles: 2, maxBatchBytes: 150 };
    assert.equal(checkBatchLimits([{ size: 10 }, { size: 10 }], cfg).ok, true);
    assert.match(checkBatchLimits([{ size: 1 }, { size: 1 }, { size: 1 }], cfg).error, /files/);
    assert.match(checkBatchLimits([{ size: 100 }, { size: 100 }], cfg).error, /bytes/);
  });

  it('verifyItemUnchanged detects each drift dimension', () => {
    const item = sampleManifest().items[0];
    const good = { size: 100, mtimeMs: 5000.9, inode: 42 }; // sub-ms jitter tolerated via floor
    assert.equal(verifyItemUnchanged(item, good).ok, true);
    assert.equal(verifyItemUnchanged(item, null).reason, 'missing');
    assert.equal(verifyItemUnchanged(item, { ...good, size: 99 }).reason, 'size-changed');
    assert.equal(verifyItemUnchanged(item, { ...good, mtimeMs: 9999 }).reason, 'mtime-changed');
    assert.equal(verifyItemUnchanged(item, { ...good, inode: 7 }).reason, 'inode-changed');
  });

  it('manifestPaths and user summary', () => {
    const p = manifestPaths('/base');
    assert.equal(p.proposals, '/base/proposals');
    assert.equal(p.audit, '/base/audit.jsonl');
    const s = summarizeForUser(sampleManifest());
    assert.match(s, /explicit consent/);
    assert.match(s, /cleanup_restore/);
  });
});
