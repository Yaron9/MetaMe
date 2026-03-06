const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

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

function runStatus(home) {
  return execFileSync(process.execPath, [path.join(ROOT, 'index.js'), 'daemon', 'status'], {
    cwd: ROOT,
    env: { ...process.env, ...homeEnv(home) },
    encoding: 'utf8',
    timeout: 30000,
  });
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

