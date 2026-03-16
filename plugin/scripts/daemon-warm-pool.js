'use strict';

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
  const { log } = deps;

  // Pool: sessionKey -> { child, sessionId, cwd, idleTimer }
  const pool = new Map();
  const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

    // Set idle timeout
    const idleTimer = setTimeout(() => {
      const e = pool.get(sessionKey);
      if (e && e.child === child) {
        log('INFO', `[WarmPool] Idle timeout, killing warm process pid=${child.pid} for ${sessionKey}`);
        _killEntry(e);
        pool.delete(sessionKey);
      }
    }, IDLE_TIMEOUT_MS);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();

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
      idleTimer,
    });
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
    _pool: pool,
  };
}

module.exports = { createWarmPool };
