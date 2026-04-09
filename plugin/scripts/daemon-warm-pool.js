'use strict';

const { execSync } = require('child_process');

/**
 * daemon-warm-pool.js
 *
 * Persistent Claude CLI process pool for eliminating cold-start latency.
 *
 * Problem: Each `claude -p --print` spawns a new process → ~11s cold start (CLI init + API first-token).
 * Solution: After a turn completes, keep the process alive. Next message writes to stdin → ~3s response.
 *
 * Architecture:
 *   - Pool keyed by sessionChatId (not raw chatId — same session key used by daemon-session-store)
 *   - Each warm entry holds a live child process spawned with `--input-format stream-json`
 *   - `acquireWarm(key)` → returns child process (removes from pool to prevent double-use)
 *   - `storeWarm(key, child, meta)` → parks process in pool with idle timeout
 *   - Idle timeout kills unused warm processes (default: 5 minutes)
 *   - Process death auto-cleans pool entry
 *
 * Only for Claude engine. Codex does not support `--input-format stream-json`.
 */

function createWarmPool(deps) {
  const {
    log,
    idleTimeoutMs = 5 * 60 * 1000,
    hasBackgroundDescendants = defaultHasBackgroundDescendants,
  } = deps;

  // Pool: sessionKey -> { child, sessionId, cwd, idleTimer }
  const pool = new Map();
  const IDLE_TIMEOUT_MS = idleTimeoutMs;

  /**
   * Acquire a warm process for the given session key.
   * Returns { child, sessionId, cwd } or null.
   * The entry is REMOVED from the pool (caller owns the process now).
   */
  function acquireWarm(sessionKey) {
    const entry = pool.get(sessionKey);
    if (!entry) return null;

    // Check if process is still alive
    if (entry.child.killed || entry.child.exitCode !== null) {
      _cleanup(sessionKey);
      return null;
    }

    // Remove from pool — caller now owns this process
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    pool.delete(sessionKey);
    log('INFO', `[WarmPool] Acquired warm process pid=${entry.child.pid} for ${sessionKey}`);
    return { child: entry.child, sessionId: entry.sessionId, cwd: entry.cwd };
  }

  /**
   * Park a process in the pool for future reuse.
   * The process must have been spawned with --input-format stream-json.
   * Previous entry for the same key is killed.
   */
  function storeWarm(sessionKey, child, meta = {}) {
    // Kill existing warm process for this key (if any)
    const existing = pool.get(sessionKey);
    if (existing) {
      _killEntry(existing);
      pool.delete(sessionKey);
    }

    // Don't store dead processes
    if (child.killed || child.exitCode !== null) {
      log('INFO', `[WarmPool] Not storing dead process for ${sessionKey}`);
      return;
    }

    // Auto-cleanup on unexpected death
    const onExit = () => {
      const e = pool.get(sessionKey);
      if (e && e.child === child) {
        if (e.idleTimer) clearTimeout(e.idleTimer);
        pool.delete(sessionKey);
        log('INFO', `[WarmPool] Process died unexpectedly for ${sessionKey}`);
      }
    };
    child.once('close', onExit);
    child.once('error', onExit);

    pool.set(sessionKey, {
      child,
      sessionId: meta.sessionId || '',
      cwd: meta.cwd || '',
      idleTimer: null,
    });
    _armIdleTimer(sessionKey, child);
    log('INFO', `[WarmPool] Stored warm process pid=${child.pid} for ${sessionKey} (pool size: ${pool.size})`);
  }

  /**
   * Kill and remove a specific warm process.
   */
  function releaseWarm(sessionKey) {
    const entry = pool.get(sessionKey);
    if (!entry) return;
    _killEntry(entry);
    pool.delete(sessionKey);
    log('INFO', `[WarmPool] Released ${sessionKey}`);
  }

  /**
   * Kill all warm processes (used during daemon shutdown).
   */
  function releaseAll() {
    for (const [_key, entry] of pool) {
      _killEntry(entry);
    }
    const count = pool.size;
    pool.clear();
    if (count > 0) log('INFO', `[WarmPool] Released all (${count} processes)`);
  }

  function _killEntry(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      process.kill(-entry.child.pid, 'SIGTERM');
    } catch {
      try { entry.child.kill('SIGTERM'); } catch { /* */ }
    }
  }

  function _cleanup(sessionKey) {
    const entry = pool.get(sessionKey);
    if (entry && entry.idleTimer) clearTimeout(entry.idleTimer);
    pool.delete(sessionKey);
  }

  function _armIdleTimer(sessionKey, child) {
    const entry = pool.get(sessionKey);
    if (!entry || entry.child !== child) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      const current = pool.get(sessionKey);
      if (!current || current.child !== child) return;
      if (_hasLiveBackgroundDescendants(child.pid)) {
        log('INFO', `[WarmPool] Idle timeout skipped for ${sessionKey}: pid=${child.pid} still has background descendants`);
        _armIdleTimer(sessionKey, child);
        return;
      }
      log('INFO', `[WarmPool] Idle timeout, killing warm process pid=${child.pid} for ${sessionKey}`);
      _killEntry(current);
      pool.delete(sessionKey);
    }, IDLE_TIMEOUT_MS);
    if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
  }

  function _hasLiveBackgroundDescendants(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
      return !!hasBackgroundDescendants(pid);
    } catch {
      return false;
    }
  }

  /**
   * Non-destructive validity check. Returns true if a live warm process exists for the key.
   * Mirrors acquireWarm's dead-process checks without consuming the entry.
   */
  function hasWarm(sessionKey) {
    const entry = pool.get(sessionKey);
    if (!entry) return false;
    if (entry.child.killed || entry.child.exitCode !== null) {
      _cleanup(sessionKey);
      return false;
    }
    return true;
  }

  /**
   * Build the stream-json user message for stdin.
   */
  function buildStreamMessage(prompt, sessionId) {
    return JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
      session_id: sessionId || 'default',
      parent_tool_use_id: null,
    }) + '\n';
  }

  return {
    acquireWarm,
    storeWarm,
    releaseWarm,
    releaseAll,
    buildStreamMessage,
    hasWarm,
    _pool: pool,
  };
}

function defaultHasBackgroundDescendants(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  if (process.platform === 'win32') {
    try {
      const output = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ParentProcessId=${pid}\\").Count"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, windowsHide: true }
      ).trim();
      return Number(output) > 0;
    } catch {
      return false;
    }
  }

  try {
    const output = execSync(`pgrep -P ${pid}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

module.exports = { createWarmPool };
