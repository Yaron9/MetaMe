'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rules = require('./file-map-maintenance-rules');

describe('file-map maintenance rules', () => {
  it('requires project evidence before classifying generic directory names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-rules-'));
    fs.mkdirSync(path.join(root, 'target'));
    assert.equal(rules.artifactRuleFor(fs, path, path.join(root, 'target')), null);
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]');
    assert.equal(rules.artifactRuleFor(fs, path, path.join(root, 'target')).id, 'rust-target');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('recognizes only a valid standard CACHEDIR.TAG signature', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-cachedir-'));
    const cache = path.join(root, 'opaque-cache');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(cache, 'CACHEDIR.TAG'), 'invalid');
    assert.equal(rules.artifactRuleFor(fs, path, cache), null);
    fs.writeFileSync(path.join(cache, 'CACHEDIR.TAG'), `${rules.CACHEDIR_SIGNATURE}\n# cache directory tag`);
    assert.equal(rules.artifactRuleFor(fs, path, cache).id, 'cachedir-tag');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts strong installer types and only installation-shaped ZIPs', () => {
    assert.equal(rules.installerRuleFor(path, '/x/App.dmg', null).executionMode, 'quarantine_file');
    assert.equal(rules.installerRuleFor(path, '/x/source.zip', ['src/index.js']), null);
    assert.equal(rules.installerRuleFor(path, '/x/app.zip', ['Product.app/Contents/Info.plist']).id, 'installer-zip');
    assert.equal(rules.isInstallerZip(Array.from({ length: 51 }, (_, i) => `App.app/${i}`)), false, 'bounded ZIP evidence');
  });

  it('derives cache actions from the existing storage catalog', () => {
    const out = rules.cacheRulesFromCatalog([
      { id: 'developer_tools', paths: ['/u/Library/Caches/Homebrew', '/u/.npm'], processes: [], risk: 'medium' },
      { id: 'cloud_storage', paths: ['/u/cloud'], processes: [], risk: 'high' },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].adapterId, 'brew_cleanup');
    assert.equal(out[1].executionMode, 'report_only');
  });
});
