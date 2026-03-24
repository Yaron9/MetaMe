'use strict';

/**
 * daemon-message-pipeline.js
 *
 * Per-chatId message pipeline with interrupt-collect-flush semantics.
 *
 * Behavior:
 *   1. First message → process immediately
 *   2. Follow-up within merge window (15s) → SIGINT pause, start collecting
 *   3. Follow-up outside merge window → queue for independent processing
 *   4. More follow-ups while collecting → keep collecting (no timer yet)
 *   5. Paused task dies → start debounce timer (5s)
 *   6. Each new message resets the 5s debounce
 *   7. Debounce fires → flush ALL collected messages as ONE prompt → ONE reply
 *   8. Messages during flush → queue individually (each gets own card)
 *
 * Priority messages (/stop, /quit) bypass everything and execute immediately.
 *
 * Public API:
 *   processMessage(chatId, text, ctx)  — enqueue & serialize
 *   isActive(chatId)                   — check if a message is being processed
 *   interruptActive(chatId)            — abort the active process
 *   clearQueue(chatId)                 — drop ALL pending state
 *   getQueueLength(chatId)             — number of pending messages (all queues)
 */

function createMessagePipeline(deps) {
  const {
    activeProcesses,
    handleCommand,
    resetCooldown,
    log,
  } = deps;

  // Per-chatId Promise chain tail — ensures serial execution
  const chains = new Map();    // chatId -> Promise

  // Track the original message text and start time (for merge window)
  const activeTexts = new Map();      // chatId -> string
  const activeStartTimes = new Map(); // chatId -> timestamp (ms)

  // Per-chatId burst collection state (first-round merge only)
  const collecting = new Map(); // chatId -> { messages: string[], ctx, timer, chainDead: boolean }

  // chatIds where flush is processing — new messages go to pendingQueue
  const resumed = new Set();

  // Individual message queue — each item processed independently with its own card.
  // Used for: post-resume messages, messages outside merge window.
  const pendingQueue = new Map(); // chatId -> [{text, ctx}]

  // chatIds currently being drained — prevents new messages from interrupting drain items
  const draining = new Set();

  const DEBOUNCE_MS = 5000;
  const MERGE_WINDOW_MS = 15000;
  const SIGINT_ESCALATE_MS = 2000;

  // Messages that must bypass everything and execute immediately
  const STOP_RE = /^\/stop(\s|$)/i;
  const QUIT_RE = /^\/quit$/i;

  function _isPriorityMessage(text) {
    const trimmed = (text || '').trim();
    return STOP_RE.test(trimmed) || QUIT_RE.test(trimmed);
  }

  // ── Helpers ────────────────────────────────────────────────────

  function _enqueue(chatId, text, ctx) {
    if (!pendingQueue.has(chatId)) pendingQueue.set(chatId, []);
    pendingQueue.get(chatId).push({ text, ctx });
  }

  function _clearAll(chatId) {
    _cancelCollecting(chatId);
    resumed.delete(chatId);
    pendingQueue.delete(chatId);
    draining.delete(chatId);
  }

  // ── Core: process / collect / flush ──────────────────────────────

  function processMessage(chatId, text, ctx) {
    // Priority messages bypass everything
    if ((chains.has(chatId) || collecting.has(chatId)) && _isPriorityMessage(text)) {
      log('INFO', `Pipeline: priority bypass "${text.trim()}" for ${chatId}`);
      _clearAll(chatId);
      return _processOne(chatId, text, ctx);
    }

    // Currently collecting (first-round merge) → accumulate
    if (collecting.has(chatId)) {
      const c = collecting.get(chatId);
      c.messages.push(text);
      if (c.chainDead) _resetDebounce(chatId, c);
      log('INFO', `Pipeline: collecting follow-up for ${chatId} (${c.messages.length} pending)`);
      return Promise.resolve();
    }

    // Pipeline idle → start processing
    if (!chains.has(chatId)) {
      activeTexts.set(chatId, text);
      activeStartTimes.set(chatId, Date.now());
      const p = _processOne(chatId, text, ctx)
        .finally(() => {
          activeTexts.delete(chatId);
          activeStartTimes.delete(chatId);
          chains.delete(chatId);
          resumed.delete(chatId);
          // First-round merge: collected messages → debounce → flush
          if (collecting.has(chatId)) {
            const c = collecting.get(chatId);
            c.chainDead = true;
            _resetDebounce(chatId, c);
            log('INFO', `Pipeline: chain ended, starting debounce for ${chatId} (${c.messages.length} collected)`);
            return; // let debounce handle the rest; don't drain yet
          }
          // Drain individually queued messages
          _drainNext(chatId);
        });
      chains.set(chatId, p);
      return p;
    }

    // Pipeline busy + post-flush or draining → queue individually
    if (resumed.has(chatId) || draining.has(chatId)) {
      _enqueue(chatId, text, ctx);
      log('INFO', `Pipeline: queued independently for ${chatId} (${pendingQueue.get(chatId).length} queued)`);
      return Promise.resolve();
    }

    // Pipeline busy, first follow-up — check merge window
    const elapsed = Date.now() - (activeStartTimes.get(chatId) || 0);
    if (elapsed > MERGE_WINDOW_MS) {
      _enqueue(chatId, text, ctx);
      log('INFO', `Pipeline: outside merge window (${Math.round(elapsed / 1000)}s) for ${chatId}, queued independently`);
      return Promise.resolve();
    }

    // Within merge window → interrupt and start collecting
    return _startCollecting(chatId, text, ctx);
  }

  // ── Interrupt-Collect-Flush ────────────────────────────────────

  /**
   * Send SIGINT with escalation: SIGINT → SIGTERM → SIGKILL.
   * Works cross-platform — on macOS SIGINT is enough; on Windows claude
   * ignores SIGINT so we escalate after SIGINT_ESCALATE_MS.
   */
  function _killWithEscalation(child, chatId) {
    try { process.kill(-child.pid, 'SIGINT'); } catch { try { child.kill('SIGINT'); } catch { /* */ } }
    let sigkillTimer = null;
    const escalateTimer = setTimeout(() => {
      if (child.exitCode !== null || child.killed) return;
      log('WARN', `Pipeline: SIGINT ineffective for ${chatId}, escalating to SIGTERM`);
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* */ } }
      sigkillTimer = setTimeout(() => {
        if (child.exitCode !== null || child.killed) return;
        log('WARN', `Pipeline: SIGTERM ineffective for ${chatId}, escalating to SIGKILL`);
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* */ } }
      }, SIGINT_ESCALATE_MS);
    }, SIGINT_ESCALATE_MS);
    child.once('close', () => {
      clearTimeout(escalateTimer);
      if (sigkillTimer) clearTimeout(sigkillTimer);
    });
  }

  /**
   * Gracefully pause the running task (SIGINT = ESC equivalent).
   * Escalates to SIGTERM/SIGKILL if SIGINT is ineffective (e.g. claude on Windows).
   */
  function _pauseActive(chatId) {
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      proc.abortReason = 'merge-pause';
      _killWithEscalation(proc.child, chatId);
      return true;
    }
    if (proc && proc.child === null) {
      proc.aborted = true;
      proc.abortReason = 'merge-pause';
      return true;
    }
    return false;
  }

  /**
   * Pause the running task and start collecting.
   */
  function _startCollecting(chatId, text, ctx) {
    _pauseActive(chatId);
    const originalText = activeTexts.get(chatId);
    const msgs = originalText ? [originalText, text] : [text];
    const c = { messages: msgs, ctx, timer: null, chainDead: false };
    collecting.set(chatId, c);
    log('INFO', `Pipeline: paused & collecting for ${chatId} (original: "${(originalText || '').slice(0, 30)}")`);
    ctx.bot.sendMessage(chatId, '⏸ 已暂停，继续连发，我会合并后继续').catch(() => {});
    return Promise.resolve();
  }

  /**
   * Reset the debounce timer for burst collection.
   */
  function _resetDebounce(chatId, c) {
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => _flushCollected(chatId), DEBOUNCE_MS);
  }

  /**
   * Debounce fired — merge ALL collected messages and process as ONE call.
   */
  function _flushCollected(chatId) {
    const c = collecting.get(chatId);
    if (!c || c.messages.length === 0) {
      collecting.delete(chatId);
      return;
    }
    const merged = _buildMergedPrompt(c.messages);
    const ctx = c.ctx;
    const count = c.messages.length;
    collecting.delete(chatId);

    resumed.add(chatId);
    log('INFO', `Pipeline: flushing ${count} collected messages for ${chatId}`);
    const p = processMessage(chatId, merged, ctx);
    if (p && typeof p.catch === 'function') {
      p.catch(err => log('ERROR', `Pipeline: flush error for ${chatId}: ${err.message}`));
    }
  }

  /**
   * Build the merged prompt from collected messages.
   */
  function _buildMergedPrompt(messages) {
    if (messages.length === 1) return messages[0];
    return messages.join('\n');
  }

  /**
   * Cancel any active collecting state (clear timer + delete).
   */
  function _cancelCollecting(chatId) {
    const c = collecting.get(chatId);
    if (c) {
      if (c.timer) clearTimeout(c.timer);
      collecting.delete(chatId);
    }
  }

  /**
   * Drain the next queued message for chatId. Each gets its own card.
   * Uses the normal pipeline path — serialization is guaranteed because
   * we only call this from .finally() when the chain is already cleared.
   */
  function _drainNext(chatId) {
    const queue = pendingQueue.get(chatId);
    if (!queue || queue.length === 0) {
      pendingQueue.delete(chatId);
      draining.delete(chatId);
      return;
    }
    draining.add(chatId);
    const { text, ctx } = queue.shift();
    if (queue.length === 0) pendingQueue.delete(chatId);
    log('INFO', `Pipeline: draining queued message for ${chatId} (${queue.length} remaining)`);
    // processMessage will take the "idle" path and set up a new chain.
    // That chain's .finally() will call _drainNext again for the next item.
    const p = processMessage(chatId, text, ctx);
    if (p && typeof p.catch === 'function') {
      p.catch(err => log('ERROR', `Pipeline: drain error for ${chatId}: ${err.message}`));
    }
  }

  // ── Process one message ────────────────────────────────────────

  /**
   * Process a single message by delegating to handleCommand.
   */
  async function _processOne(chatId, text, ctx) {
    if (resetCooldown) resetCooldown(chatId);
    const { bot, config, executeTaskByName, senderId, readOnly, meta } = ctx;
    try {
      return await handleCommand(bot, chatId, text, config, executeTaskByName, senderId, readOnly, meta || {});
    } catch (err) {
      log('ERROR', `Pipeline: error processing message for ${chatId}: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  // ── Query / Control API ────────────────────────────────────────

  function isActive(chatId) {
    return chains.has(chatId) || collecting.has(chatId);
  }

  function interruptActive(chatId) {
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      _killWithEscalation(proc.child, chatId);
      return true;
    }
    if (proc && proc.child === null) {
      proc.aborted = true;
      return true;
    }
    return false;
  }

  function clearQueue(chatId) {
    _clearAll(chatId);
  }

  function getQueueLength(chatId) {
    const c = collecting.get(chatId);
    const q = pendingQueue.get(chatId);
    return (c ? c.messages.length : 0) + (q ? q.length : 0);
  }

  return {
    processMessage,
    isActive,
    interruptActive,
    clearQueue,
    getQueueLength,
    // Expose internals for testing
    _chains: chains,
    _collecting: collecting,
  };
}

module.exports = { createMessagePipeline };
