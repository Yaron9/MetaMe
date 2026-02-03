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

// Kill any existing daemon (takeover strategy)
function killExistingDaemon() {
  if (!fs.existsSync(DAEMON_PID)) return;
  try {
    const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
    process.kill(pid, 'SIGTERM');
    // Give it a moment to clean up
    require('child_process').execSync('sleep 1', { stdio: 'ignore' });
  } catch {
    // Process doesn't exist or already dead
  }
  try { fs.unlinkSync(DAEMON_PID); } catch {}
}

killExistingDaemon();

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
