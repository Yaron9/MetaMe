'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanMaintenance } = require('./file-map-maintenance-scan');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-maint-'));
  const write = (rel, data = 'x') => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return file;
  };
  write('rust/Cargo.toml', '[package]');
  write('rust/target/debug/build/nested.bin', 'artifact');
  write('web/package.json', '{}');
  write('web/node_modules/pkg/package.json', '{}');
  write('downloads/App.dmg', 'installer');
  write('downloads/source.zip', 'archive');
  write('downloads/Product.zip', 'archive');
  fs.symlinkSync(path.join(root, 'rust'), path.join(root, 'linked-rust'));
  return root;
}

describe('file-map maintenance scan', () => {
  it('collapses nested artifacts, rejects ordinary ZIPs and never follows symlinks', async () => {
    const root = fixture();
    const nowMs = Date.now() + 30 * 86400000;
    const out = await scanMaintenance({
      fsx: fs,
      now: () => nowMs,
      listZipEntries: async file => file.endsWith('Product.zip') ? ['Product.app/Contents/Info.plist'] : ['src/index.js'],
    }, {
      roots: [root], kinds: ['artifact', 'installer'], recentDays: 14, includeRecent: true,
      minSizeBytes: 0, maxDepth: 8, limit: 100, nowMs,
    });
    assert.deepEqual(out.candidates.map(x => x.rule_id).sort(), [
      'installer-dmg', 'installer-zip', 'javascript-node-modules', 'rust-target',
    ]);
    assert.equal(out.candidates.filter(x => x.rule_id === 'rust-target').length, 1);
    assert.ok(out.candidates.every(x => !x.path.includes('linked-rust')));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('protects recent candidates by default and supports stable pagination', async () => {
    const root = fixture();
    const nowMs = Date.now();
    const base = { roots: [root], kinds: ['artifact', 'installer'], recentDays: 14, minSizeBytes: 0, maxDepth: 8, limit: 1, nowMs };
    const first = await scanMaintenance({ fsx: fs, now: () => nowMs }, base);
    assert.equal(first.total, 0, 'recent candidates are excluded');
    const included = await scanMaintenance({ fsx: fs, now: () => nowMs }, { ...base, includeRecent: true });
    assert.equal(included.candidates.length, 1);
    assert.ok(included.next_cursor);
    const second = await scanMaintenance({ fsx: fs, now: () => nowMs }, { ...base, includeRecent: true, cursor: included.next_cursor });
    assert.notEqual(second.candidates[0].candidate_id, included.candidates[0].candidate_id);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses allocated blocks and deduplicates hardlinked files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-hardlink-'));
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]');
    fs.mkdirSync(path.join(root, 'target'));
    fs.writeFileSync(path.join(root, 'target', 'one.bin'), Buffer.alloc(4096));
    fs.linkSync(path.join(root, 'target', 'one.bin'), path.join(root, 'target', 'two.bin'));
    const nowMs = Date.now() + 30 * 86400000;
    const out = await scanMaintenance({ fsx: fs, now: () => nowMs }, {
      roots: [root], kinds: ['artifact'], recentDays: 14, includeRecent: true, minSizeBytes: 0, nowMs,
    });
    assert.equal(out.candidates.length, 1);
    assert.equal(out.candidates[0].logical_bytes, 4096, 'hardlink is counted once');
    assert.ok(out.candidates[0].allocated_bytes > 0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('downgrades caches guarded by a running application', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-cache-'));
    fs.writeFileSync(path.join(root, 'cache.bin'), 'x');
    const nowMs = Date.now() + 30 * 86400000;
    const out = await scanMaintenance({ fsx: fs, now: () => nowMs }, {
      roots: [], kinds: ['cache'], cacheRules: [{
        id: 'homebrew-cache', path: root, processes: ['brew'], risk: 'low',
        recoverability: 'regenerable', executionMode: 'native_adapter', adapterId: 'brew_cleanup',
      }], runningProcesses: ['brew'], recentDays: 14, includeRecent: true, minSizeBytes: 0, nowMs,
    });
    assert.equal(out.candidates[0].execution_mode, 'report_only');
    assert.deepEqual(out.candidates[0].active_guard.processes, ['brew']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
