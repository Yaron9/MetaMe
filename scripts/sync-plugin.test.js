'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  syncPluginManifest,
  syncPluginScripts,
  syncProjectSkillEntrypoints,
} = require('./sync-plugin');
const { mkdtempForTest } = require('./test-support/test-utils');

const ROOT = path.join(__dirname, '..');

function makeProjectTree() {
  const root = mkdtempForTest('metame-sync-plugin-');
  const scriptsDir = path.join(root, 'scripts');
  const pluginDir = path.join(root, 'plugin', 'scripts');

  fs.mkdirSync(path.join(scriptsDir, 'core', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(scriptsDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(scriptsDir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugin', '.claude-plugin'), { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });

  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    version: '9.8.7',
    description: 'Package description',
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'metame',
    version: '0.0.1',
    description: 'Old plugin description',
    hooks: './hooks/hooks.json',
    keywords: ['profile'],
  }, null, 2), 'utf8');

  fs.writeFileSync(path.join(scriptsDir, 'daemon.js'), 'console.log("daemon");\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'daemon.test.js'), 'nope\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'core', 'audit.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'core', 'nested', 'child.js'), 'module.exports = 2;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'bin', 'agy-adapter.js'), 'module.exports = 4;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'hooks', 'intent.js'), 'module.exports = 3;\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'hooks', 'intent.test.js'), 'nope\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'hooks', 'test-stop-hook.js'), 'nope\n', 'utf8');

  return root;
}

describe('syncPluginScripts', () => {
  it('commits the project skill compatibility entry as a real directory', () => {
    const claudeSkill = path.join(ROOT, '.claude', 'skills', 'metame-release', 'SKILL.md');
    const agentsSkillDir = path.join(ROOT, '.agents', 'skills', 'metame-release');
    const agentsSkill = path.join(agentsSkillDir, 'SKILL.md');

    assert.equal(fs.lstatSync(agentsSkillDir).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(agentsSkill, 'utf8'), fs.readFileSync(claudeSkill, 'utf8'));
  });

  it('materializes project skill entrypoints as Windows-safe directories', () => {
    const root = makeProjectTree();
    const claudeSkill = path.join(root, '.claude', 'skills', 'metame-release');
    const agentsSkill = path.join(root, '.agents', 'skills', 'metame-release');
    fs.mkdirSync(claudeSkill, { recursive: true });
    fs.mkdirSync(path.dirname(agentsSkill), { recursive: true });
    fs.writeFileSync(path.join(claudeSkill, 'SKILL.md'), 'release instructions\n', 'utf8');
    // Git with core.symlinks=false materializes a committed symlink as this
    // plain text file. The sync must replace it with a discoverable directory.
    fs.writeFileSync(agentsSkill, '../../.claude/skills/metame-release', 'utf8');

    assert.equal(syncProjectSkillEntrypoints(root), true);
    assert.equal(fs.lstatSync(agentsSkill).isSymbolicLink(), false);
    assert.equal(
      fs.readFileSync(path.join(agentsSkill, 'SKILL.md'), 'utf8'),
      'release instructions\n',
    );
    assert.equal(syncProjectSkillEntrypoints(root), false);
  });

  it('syncs top-level, nested core/bin files, and hooks into plugin/scripts', () => {
    const root = makeProjectTree();
    const updated = syncPluginScripts(root);

    assert.equal(updated, true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'daemon.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'core', 'audit.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'core', 'nested', 'child.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'bin', 'agy-adapter.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'hooks', 'intent.js')), true);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'hooks', 'intent.test.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'hooks', 'test-stop-hook.js')), false);
    assert.equal(fs.existsSync(path.join(root, 'plugin', 'scripts', 'daemon.test.js')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(manifest.version, '9.8.7');
    assert.equal(manifest.description, 'Package description');
    assert.equal(manifest.name, 'metame');
    assert.deepEqual(manifest.keywords, ['profile']);
  });

  it('syncPluginManifest updates package-owned metadata only', () => {
    const root = makeProjectTree();

    const updated = syncPluginManifest(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));

    assert.equal(updated, true);
    assert.equal(manifest.version, '9.8.7');
    assert.equal(manifest.description, 'Package description');
    assert.equal(manifest.hooks, './hooks/hooks.json');
    assert.equal(syncPluginManifest(root), false);
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
    fs.writeFileSync(path.join(pluginDir, 'zombie.test.js'), '// stale test\n', 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'core', 'zombie-core.js'), '// stale\n', 'utf8');
    fs.writeFileSync(path.join(pluginDir, 'core', 'zombie-core.test.js'), '// stale test\n', 'utf8');
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'hooks', 'test-stop-hook.js'), '// stale test hook\n', 'utf8');

    syncPluginScripts(root);

    assert.equal(
      fs.existsSync(path.join(pluginDir, 'zombie-top.js')), false,
      'top-level zombie removed',
    );
    assert.equal(
      fs.existsSync(path.join(pluginDir, 'zombie.test.js')), false,
      'top-level stale test removed',
    );
    assert.equal(
      fs.existsSync(path.join(pluginDir, 'core', 'zombie-core.js')), false,
      'nested core zombie removed',
    );
    assert.equal(
      fs.existsSync(path.join(pluginDir, 'core', 'zombie-core.test.js')), false,
      'nested stale test removed',
    );
    assert.equal(
      fs.existsSync(path.join(pluginDir, 'hooks', 'test-stop-hook.js')), false,
      'stale test hook removed',
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
