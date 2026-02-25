'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

  const lockDir = path.dirname(BRAIN_LOCK_FILE);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });

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

  if (!acquired) {
    throw new Error('Failed to acquire brain.lock for profile write');
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

// ---------------------------------------------------------
// PROJECT SCOPE (stable workspace identity)
// ---------------------------------------------------------
function normalizeProjectPath(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const trimmed = cwd.trim();
  if (!trimmed) return null;

  const expanded = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;

  const resolved = path.resolve(expanded);
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function projectScopeFromCwd(cwd) {
  const normalized = normalizeProjectPath(cwd);
  if (!normalized) return null;
  const digest = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
  return `proj_${digest}`;
}

function deriveProjectInfo(cwd) {
  const projectPath = normalizeProjectPath(cwd);
  if (!projectPath) return { project: null, project_id: null, project_path: null };
  return {
    project: path.basename(projectPath),
    project_id: projectScopeFromCwd(projectPath),
    project_path: projectPath,
  };
}

// ---------------------------------------------------------
// TOPIC DRIFT HELPERS
// ---------------------------------------------------------
function buildTopicSignature(text, maxTokens = 16) {
  const input = String(text || '').toLowerCase();
  if (!input) return [];

  const stop = new Set(['help', 'please', 'this', 'that', 'with', 'from', 'into', 'have', 'been', 'will', 'just']);
  const seen = new Set();
  const tokens = [];
  const push = (token) => {
    const t = String(token || '').trim();
    if (!t || seen.has(t) || stop.has(t)) return;
    seen.add(t);
    tokens.push(t);
  };

  // ASCII-like identifiers, commands, paths
  const ascii = input.match(/[a-z0-9_./-]{2,}/g) || [];
  for (const t of ascii) {
    push(t);
    if (tokens.length >= maxTokens) return tokens;
  }

  // Chinese: use 2-char shingles so short prompts still produce enough features.
  const hanRuns = input.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of hanRuns) {
    if (run.length === 2) {
      push(run);
    } else {
      for (let i = 0; i < run.length - 1; i++) {
        push(run.slice(i, i + 2));
        if (tokens.length >= maxTokens) return tokens;
      }
    }
    if (tokens.length >= maxTokens) return tokens;
  }

  return tokens;
}

function hasTopicDrift(prevSig, currSig, minTokens = 3, threshold = 0.25) {
  if (!Array.isArray(prevSig) || !Array.isArray(currSig)) return false;
  if (prevSig.length < minTokens || currSig.length < minTokens) return false;
  const a = new Set(prevSig);
  const b = new Set(currSig);
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  const minBase = Math.min(a.size, b.size) || 1;
  const overlapByMin = common / minBase;
  if (overlapByMin >= 0.34) return false;
  const union = a.size + b.size - common;
  if (union <= 0) return false;
  const jaccard = common / union;
  return jaccard < threshold;
}

module.exports = {
  parseInterval,
  formatRelativeTime,
  createPathMap,
  normalizeProjectPath,
  projectScopeFromCwd,
  deriveProjectInfo,
  buildTopicSignature,
  hasTopicDrift,
  writeBrainFileSafe,
  BRAIN_LOCK_FILE,
};
