'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * utils.js — Pure utility functions extracted for testability.
 */

// ---------------------------------------------------------
// BRAIN FILE SAFE WRITE
// Atomic write with exclusive file lock.
// Prevents race condition between distill.js and daemon.js /quiet command.
// ---------------------------------------------------------
const BRAIN_LOCK_FILE = path.join(os.homedir(), '.metame', 'brain.lock');
const BRAIN_FILE_DEFAULT = path.join(os.homedir(), '.claude_profile.yaml');

/**
 * Write content to the brain profile file atomically and exclusively.
 * Uses a .lock file to prevent concurrent writes, and write-then-rename
 * for atomicity (process crash leaves .tmp, not a partial BRAIN_FILE).
 *
 * @param {string} content - YAML string to write
 * @param {string} [brainFile] - Target path (defaults to ~/.claude_profile.yaml)
 * @returns {Promise<void>}
 */
async function writeBrainFileSafe(content, brainFile = BRAIN_FILE_DEFAULT) {
  const maxRetries = 10;
  const retryDelay = 150; // ms between retries
  const staleTimeout = 30000; // 30s: lock older than this is stale

  let acquired = false;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const fd = fs.openSync(BRAIN_LOCK_FILE, 'wx');
      fs.writeSync(fd, process.pid.toString());
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Check for stale lock
      try {
        const age = Date.now() - fs.statSync(BRAIN_LOCK_FILE).mtimeMs;
        if (age > staleTimeout) { fs.unlinkSync(BRAIN_LOCK_FILE); continue; }
      } catch { /* lock removed by another process */ }
      await new Promise(r => setTimeout(r, retryDelay));
    }
  }

  const tmp = brainFile + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, brainFile); // atomic on POSIX
  } finally {
    try { fs.unlinkSync(tmp); } catch { } // clean up tmp if rename failed
    if (acquired) try { fs.unlinkSync(BRAIN_LOCK_FILE); } catch { }
  }
}

// ---------------------------------------------------------
// INTERVAL PARSING
// ---------------------------------------------------------
function parseInterval(str) {
  const match = String(str).match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 3600; // default 1h
  const val = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return val;
    case 'm': return val * 60;
    case 'h': return val * 3600;
    case 'd': return val * 86400;
    default: return 3600;
  }
}

// ---------------------------------------------------------
// RELATIVE TIME FORMATTING
// ---------------------------------------------------------
function formatRelativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay === 1) return '昨天';
  if (diffDay < 7) return `${diffDay}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

// ---------------------------------------------------------
// PATH SHORTENER (Telegram callback_data 64-byte limit)
// ---------------------------------------------------------
function createPathMap() {
  const map = new Map();
  let counter = 0;

  function shortenPath(fullPath) {
    for (const [k, v] of map) {
      if (v === fullPath) return k;
    }
    const id = 'p' + (++counter);
    map.set(id, fullPath);
    return id;
  }

  function expandPath(idOrPath) {
    return map.get(idOrPath) || idOrPath;
  }

  return { shortenPath, expandPath };
}

module.exports = {
  parseInterval,
  formatRelativeTime,
  createPathMap,
  writeBrainFileSafe,
  BRAIN_LOCK_FILE,
};
