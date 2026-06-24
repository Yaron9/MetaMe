'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const { buildInstalledMcpConfig, ensureAgyPlugin } = require('./agy-plugin-installer');

describe('agy plugin installer', () => {
  it('uses absolute wrapper paths and the current Node binary', () => {
    const root = path.join('/tmp', 'plugins', 'metame-tools');
    const cfg = buildInstalledMcpConfig(root, '/usr/bin/node', { trendRadarAvailable: true });
    assert.equal(cfg.mcpServers.playwright.command, '/usr/bin/node');
    assert.equal(cfg.mcpServers.playwright.args[0], path.join(root, 'bin', 'playwright-mcp.js'));
    assert.equal(cfg.mcpServers['akshare-stock'].args[0], path.join(root, 'bin', 'akshare-stock-mcp.js'));
    assert.equal(cfg.mcpServers.trendradar.args[0], path.join(root, 'bin', 'trendradar-mcp.js'));
  });

  it('restores the previous plugin and manifests when install fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agy-plugin-'));
    const home = path.join(root, 'home');
    const metameDir = path.join(home, '.metame');
    const configRoot = path.join(home, '.gemini', 'config');
    const installedRoot = path.join(configRoot, 'plugins', 'metame-tools');
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.mkdirSync(metameDir, { recursive: true });
    fs.writeFileSync(path.join(installedRoot, 'old.txt'), 'working');
    fs.writeFileSync(path.join(configRoot, 'import_manifest.json'), '{"old":true}');
    fs.writeFileSync(path.join(configRoot, 'mcp_config.json'), '{"old":true}');
    let calls = 0;
    assert.throws(() => ensureAgyPlugin({
      fs, path, crypto,
      pluginSource: path.join(__dirname, 'agy-plugin'),
      home, metameDir, nodeBinary: process.execPath, platform: 'darwin',
      execFileSync: (_cmd, args) => {
        if (args[0] === 'agy') return '/tmp/agy\n';
        calls += 1;
        if (args[1] === 'uninstall') {
          fs.rmSync(installedRoot, { recursive: true, force: true });
          fs.writeFileSync(path.join(configRoot, 'import_manifest.json'), '{"old":false}');
          return '';
        }
        throw new Error('install failed');
      },
    }), /install failed/);
    assert.equal(calls, 2);
    assert.equal(fs.readFileSync(path.join(installedRoot, 'old.txt'), 'utf8'), 'working');
    assert.equal(fs.readFileSync(path.join(configRoot, 'import_manifest.json'), 'utf8'), '{"old":true}');
  });
});
