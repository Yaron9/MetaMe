#!/usr/bin/env node

/**
 * MetaMe Plugin — Distill on Session Start
 *
 * Lightweight wrapper that checks if there are buffered signals
 * and spawns the distillation process in the background.
 *
 * Uses the schema and pending-traits modules co-located in this
 * plugin's scripts/ directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const BUFFER_FILE = path.join(METAME_DIR, 'raw_signals.jsonl');

// Check if there are signals to distill
function shouldDistill() {
  if (!fs.existsSync(BUFFER_FILE)) return false;
  const content = fs.readFileSync(BUFFER_FILE, 'utf8').trim();
  return content.length > 0;
}

if (!shouldDistill()) {
  process.exit(0);
}

// Count signals for log message
const lines = fs.readFileSync(BUFFER_FILE, 'utf8').trim().split('\n').filter(l => l.trim());

// First check if distill.js exists in ~/.metame/ (deployed by npm CLI)
const npmDistill = path.join(METAME_DIR, 'distill.js');
// Fallback: use the plugin's own bundled distill
const pluginDistill = path.join(__dirname, 'distill.js');

const distillScript = fs.existsSync(npmDistill) ? npmDistill : pluginDistill;

if (!fs.existsSync(distillScript)) {
  // No distill engine available — skip silently
  process.exit(0);
}

// Spawn as detached background process — won't block Claude session start
const bg = spawn('node', [distillScript], {
  detached: true,
  stdio: 'ignore'
});
bg.unref();
