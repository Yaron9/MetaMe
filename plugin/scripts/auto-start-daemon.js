#!/usr/bin/env node

/**
 * MetaMe Plugin — Auto-start Daemon
 *
 * Called during SessionStart hook.
 * If daemon config exists and daemon is not running, starts it automatically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const DAEMON_CONFIG = path.join(METAME_DIR, 'daemon.yaml');
const DAEMON_PID = path.join(METAME_DIR, 'daemon.pid');
const DAEMON_SCRIPT = path.join(__dirname, 'daemon.js');

// Check if daemon config exists
if (!fs.existsSync(DAEMON_CONFIG)) {
  // No config = user hasn't set up daemon yet, skip silently
  process.exit(0);
}

// Check if daemon is already running
function isDaemonRunning() {
  if (!fs.existsSync(DAEMON_PID)) return false;
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
    process.kill(pid, 0); // Test if process exists
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    try { fs.unlinkSync(DAEMON_PID); } catch {}
    return false;
  }
}

if (isDaemonRunning()) {
  // Daemon already running, nothing to do
  process.exit(0);
}

// Start daemon in background
if (!fs.existsSync(DAEMON_SCRIPT)) {
  console.error('MetaMe: daemon.js not found in plugin');
  process.exit(0);
}

const bg = spawn('node', [DAEMON_SCRIPT], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, HOME, METAME_ROOT: __dirname },
  cwd: METAME_DIR,
});
bg.unref();

console.log('MetaMe: Daemon auto-started');
