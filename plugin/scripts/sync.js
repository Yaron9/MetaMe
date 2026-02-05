#!/usr/bin/env node
/**
 * sync.js — "!metame continue" handler
 * Runs inside Claude Code. Finds current session ID, sets sync flag,
 * then kills the Claude process. The metame wrapper (index.js) detects
 * the flag and relaunches Claude with --resume <session-id>.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const PID_FILE = path.join(METAME_DIR, '.claude_pid');
const SYNC_FLAG = path.join(METAME_DIR, '.sync_pending');

// Find most recent session .jsonl in a project directory
function findLatestSession(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        id: f.replace('.jsonl', ''),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime)[0] || null;
  } catch { return null; }
}

// 1. Try current project dir first
const cwd = process.cwd();
const projDirName = cwd.replace(/\//g, '-');
const projectDir = path.join(HOME, '.claude', 'projects', projDirName);

let session = findLatestSession(projectDir);

// 2. Fallback: scan all project dirs for the globally most recent session
if (!session) {
  const projectsRoot = path.join(HOME, '.claude', 'projects');
  try {
    const dirs = fs.readdirSync(projectsRoot).filter(d =>
      fs.statSync(path.join(projectsRoot, d)).isDirectory()
    );
    let best = null;
    for (const dir of dirs) {
      const s = findLatestSession(path.join(projectsRoot, dir));
      if (s && (!best || s.mtime > best.mtime)) best = s;
    }
    session = best;
  } catch {}
}

if (!session) {
  console.error('No session found.');
  process.exit(1);
}

// 3. Write sync flag with session ID
fs.writeFileSync(SYNC_FLAG, session.id);

// 4. Kill Claude process
try {
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (pid && !isNaN(pid)) {
    process.kill(pid, 'SIGTERM');
    console.log(`🔄 Syncing session ${session.id.slice(0, 8)}...`);
  }
} catch {
  console.error('Cannot find Claude process. Are you running via metame?');
  try { fs.unlinkSync(SYNC_FLAG); } catch {}
  process.exit(1);
}
