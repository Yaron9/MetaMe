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
});
