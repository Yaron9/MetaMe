'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { isDaemonStatusCommand } = require('./daemon-status');

const ROOT = path.resolve(__dirname, '..');

function mkHome(prefix = 'metame-daemon-status-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(home, '.metame'), { recursive: true });
  return home;
}

function homeEnv(home) {
  return process.platform === 'win32'
    ? { HOME: home, USERPROFILE: home }
    : { HOME: home };
}

function runStatus(home, args = ['daemon', 'status']) {
  return execFileSync(process.execPath, [path.join(ROOT, 'index.js'), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...homeEnv(home) },
    encoding: 'utf8',
    timeout: 30000,
  });
}

function snapshotTree(root) {
  const entries = [];
  const visit = (absolutePath, relativePath = '') => {
    const stat = fs.lstatSync(absolutePath);
    entries.push({
      content: stat.isFile() ? fs.readFileSync(absolutePath, 'utf8') : null,
      relativePath,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
    });
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(absolutePath).sort()) {
      visit(path.join(absolutePath, entry), path.join(relativePath, entry));
    }
  };
  visit(root);
  return entries;
}

test('daemon status falls back to daemon.lock when daemon.pid is missing', () => {
  const home = mkHome();
  const metame = path.join(home, '.metame');
  fs.writeFileSync(path.join(metame, 'daemon.yaml'), 'daemon:\n  model: sonnet\n', 'utf8');
  fs.writeFileSync(path.join(metame, 'daemon_state.json'), JSON.stringify({
    started_at: new Date().toISOString(),
    pid: null,
    budget: { date: '2026-03-06', tokens_used: 0 },
    tasks: {},
  }), 'utf8');
  fs.writeFileSync(path.join(metame, 'daemon.lock'), JSON.stringify({
    pid: process.pid,
    started_at: new Date().toISOString(),
  }), 'utf8');

  const out = runStatus(home);
  assert.match(out, /MetaMe Daemon: .*Running/);
  assert.match(out, new RegExp(`PID: ${process.pid}`));
});

test('daemon status reports stopped when daemon.lock owner pid is stale', () => {
  const home = mkHome();
  const metame = path.join(home, '.metame');
  fs.writeFileSync(path.join(metame, 'daemon.yaml'), 'daemon:\n  model: sonnet\n', 'utf8');
  fs.writeFileSync(path.join(metame, 'daemon_state.json'), JSON.stringify({
    started_at: new Date().toISOString(),
    pid: null,
    budget: { date: '2026-03-06', tokens_used: 0 },
    tasks: {},
  }), 'utf8');
  fs.writeFileSync(path.join(metame, 'daemon.lock'), JSON.stringify({
    pid: 999999,
    started_at: new Date().toISOString(),
  }), 'utf8');

  const out = runStatus(home);
  assert.match(out, /MetaMe Daemon: .*Stopped/);
});

test('daemon status and its shortcut are read-only before runtime bootstrap', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-daemon-status-readonly-'));
  const before = snapshotTree(home);

  const daemonStatus = runStatus(home);
  assert.match(daemonStatus, /MetaMe Daemon: .*Stopped/);
  assert.deepEqual(snapshotTree(home), before);

  const shortcutStatus = runStatus(home, ['status']);
  assert.equal(shortcutStatus, daemonStatus);
  assert.deepEqual(snapshotTree(home), before);
  assert.equal(fs.existsSync(path.join(home, '.metame')), false);
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(home, '.codex')), false);
});

test('daemon status does not install hooks or touch existing runtime files', () => {
  const home = mkHome('metame-daemon-status-existing-');
  const claudeDir = path.join(home, '.claude');
  const codexDir = path.join(home, '.codex');
  const metame = path.join(home, '.metame');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"hooks": {}}\n', 'utf8');
  fs.writeFileSync(path.join(codexDir, 'hooks.json'), '{"hooks": {}}\n', 'utf8');
  fs.writeFileSync(path.join(metame, 'daemon_state.json'), JSON.stringify({
    budget: { date: '2026-03-06', tokens_used: 3 },
    tasks: {},
  }), 'utf8');
  const before = snapshotTree(home);

  const out = runStatus(home);
  assert.match(out, /MetaMe Daemon: .*Stopped/);
  assert.deepEqual(snapshotTree(home), before);
});

test('status trailing flags stay on the read-only path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-daemon-status-flags-'));
  const variants = [
    ['daemon', 'status', '--help'],
    ['daemon', 'status', '--json'],
    ['daemon', 'status', '--unknown-flag'],
    ['status', '--help'],
    ['status', '--json'],
    ['status', '--unknown-flag'],
  ];

  for (const args of variants) {
    const before = snapshotTree(home);
    const out = runStatus(home, args);
    assert.match(out, /MetaMe Daemon: .*Stopped/);
    assert.deepEqual(snapshotTree(home), before, `status must stay read-only for ${args.join(' ')}`);
  }
});

test('status-like commands are not mistaken for daemon status', () => {
  assert.equal(isDaemonStatusCommand(['node', 'index.js', 'status']), true);
  assert.equal(isDaemonStatusCommand(['node', 'index.js', 'daemon', 'status', '--json']), true);
  assert.equal(isDaemonStatusCommand(['node', 'index.js', 'statusish']), false);
  assert.equal(isDaemonStatusCommand(['node', 'index.js', 'daemon', 'statusish']), false);
  assert.equal(isDaemonStatusCommand(['node', 'index.js', 'daemon']), false);
});
