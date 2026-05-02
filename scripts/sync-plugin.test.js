'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { syncPluginScripts } = require('./sync-plugin');

function makeProjectTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-sync-plugin-'));
  const scriptsDir = path.join(root, 'scripts');
  const pluginDir = path.join(root, 'plugin', 'scripts');

  fs.mkdirSync(path.join(scriptsDir, 'core', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(scriptsDir, 'hooks'), { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });

  fs.writeFileSync(path.join(scriptsDir, 'daemon.js'), 'console.log("daemon");\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'daemon.test.js'), 'nope\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'core', 'audit.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'core', 'nested', 'child.js'), 'module.exports = 2;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'hooks', 'intent.js'), 'module.exports = 3;\n', 'utf8');

  return root;
}

describe('syncPluginScripts', () => {
  it('syncs top-level, nested core files, and hooks into plugin/scripts', () => {
    const root = makeProjectTree();
    const updated = syncPluginScripts(root);

    assert.equal(updated, true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'daemon.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'core', 'audit.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'core', 'nested', 'child.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'hooks', 'intent.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'daemon.test.js')), false);
  });

  it('cleans up stale dest files whose source has been deleted', () => {
    // Codex final-audit ship blocker: deleting a source file leaves the
    // distribution copy as a zombie, because copy-only sync never enumerates
    // dest. This test pins the cleanup behaviour so the regression cannot
    // come back.
    const root = makeProjectTree();
    // Pre-seed plugin/scripts/ with files that have NO src counterpart —
    // simulating a previous sync that copied something later deleted.
    const pluginDir = path.join(root, 'plugin', 'scripts');
    fs.mkdirSync(path.join(pluginDir, 'core'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'zombie-top.js'), '// stale\n', 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'core', 'zombie-core.js'), '// stale\n', 'utf8');

    syncPluginScripts(root);

    assert.equal(
      fs.existsSync(path.join(pluginDir, 'zombie-top.js')), false,
      'top-level zombie removed',
    );
    assert.equal(
      fs.existsSync(path.join(pluginDir, 'core', 'zombie-core.js')), false,
      'nested core zombie removed',
    );
    // Sanity: legitimate synced files are still present.
    assert.equal(fs.existsSync(path.join(pluginDir, 'daemon.js')), true);
    assert.equal(fs.existsSync(path.join(pluginDir, 'core', 'audit.js')), true);
  });

  it('preserves dest files outside the managed extension set', () => {
    // README, package.json, etc. have no src counterpart but must NOT be
    // deleted — they are not managed by the sync script.
    const root = makeProjectTree();
    const pluginDir = path.join(root, 'plugin', 'scripts');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'README.md'), '# keep me\n', 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'package.json'), '{}\n', 'utf8');

    syncPluginScripts(root);

    assert.equal(fs.existsSync(path.join(pluginDir, 'README.md')), true);
    assert.equal(fs.existsSync(path.join(pluginDir, 'package.json')), true);
  });

  it('preserves explicitly excluded files (e.g. daemon.yaml)', () => {
    // daemon.yaml is in PLUGIN_EXCLUDED_SCRIPTS — sync NEVER copies it from
    // src, but a developer might have left a local one in plugin/scripts/.
    // Stale-cleanup must not delete it just because it has no src match.
    const root = makeProjectTree();
    const pluginDir = path.join(root, 'plugin', 'scripts');
    fs.writeFileSync(path.join(pluginDir, 'daemon.yaml'), 'placeholder: true\n', 'utf8');

    syncPluginScripts(root);

    assert.equal(fs.existsSync(path.join(pluginDir, 'daemon.yaml')), true);
  });
});
