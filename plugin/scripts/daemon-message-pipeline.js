'use strict';

/**
 * daemon-message-pipeline.js
 *
 * Per-chatId message pipeline with interrupt-collect-flush semantics.
 *
 * Behavior:
 *   1. First message → process immediately
 *   2. Follow-up while busy → SIGINT pause, start collecting
 *   3. More follow-ups → keep collecting (no timer yet)
 *   4. Paused task dies → start debounce timer (3s)
 *   5. Each new message resets the 3s debounce
 *   6. Debounce fires → flush ALL collected messages as ONE prompt → ONE reply
 *   7. Messages during flush processing → collect again, repeat cycle
 *
 * Priority messages (/stop, /quit, 停) bypass everything and execute immediately.
 *
 * Public API:
 *   processMessage(chatId, text, ctx)  — enqueue & serialize
 *   isActive(chatId)                   — check if a message is being processed
 *   interruptActive(chatId)            — abort the active process
 *   clearQueue(chatId)                 — drop pending messages + cancel collecting
 *   getQueueLength(chatId)             — number of pending messages
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

  // Track the original message text being processed (for merge context)
  const activeTexts = new Map(); // chatId -> string

  // Per-chatId burst collection state
  const collecting = new Map(); // chatId -> { messages: string[], ctx, timer, chainDead: boolean }

  // chatIds where flush is processing — new messages go to collecting, not interrupt
  const resumed = new Set();

  const DEBOUNCE_MS = 5000;
  const MAX_COLLECT_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes — flush if collecting state lives too long

  // Messages that must bypass everything and execute immediately
  const STOP_RE = /^\/stop(\s|$)/i;
  const QUIT_RE = /^\/quit$/i;

  function _isPriorityMessage(text) {
    const trimmed = (text || '').trim();
    // Only hard-stop commands bypass. Natural language interrupts (等一下/hold on)
    // are handled by command-router and should NOT bypass collecting — they would
    // silently drop collected messages.
    return STOP_RE.test(trimmed) || QUIT_RE.test(trimmed);
  }

  // ── Core: process / collect / flush ──────────────────────────────

  function processMessage(chatId, text, ctx) {
    // Priority messages bypass everything
    if ((chains.has(chatId) || collecting.has(chatId)) && _isPriorityMessage(text)) {
      log('INFO', `Pipeline: priority bypass "${text.trim()}" for ${chatId}`);
      _cancelCollecting(chatId);
      return _processOne(chatId, text, ctx);
    }

    // Currently collecting → accumulate
    if (collecting.has(chatId)) {
      const c = collecting.get(chatId);
      c.messages.push(text);
      // Only reset debounce if chain is already dead (timer active)
      if (c.chainDead) _resetDebounce(chatId, c);
      log('INFO', `Pipeline: collecting follow-up for ${chatId} (${c.messages.length} pending)`);
      return Promise.resolve();
    }

    // Pipeline idle → start processing
    if (!chains.has(chatId)) {
      activeTexts.set(chatId, text);
      const p = _processOne(chatId, text, ctx)
        .finally(() => {
          activeTexts.delete(chatId);
          chains.delete(chatId);
          resumed.delete(chatId);
          // If messages were collected during processing, start debounce now
          if (collecting.has(chatId)) {
            const c = collecting.get(chatId);
            c.chainDead = true;
            _resetDebounce(chatId, c);
            log('INFO', `Pipeline: chain ended, starting debounce for ${chatId} (${c.messages.length} collected)`);
          }
        });
      chains.set(chatId, p);
      return p;
    }

    // Pipeline busy + already flushed once → keep collecting (don't interrupt again)
    if (resumed.has(chatId)) {
      _addToCollecting(chatId, text, ctx);
      log('INFO', `Pipeline: collecting (post-resume) for ${chatId}`);
      return Promise.resolve();
    }

    // Pipeline busy, first follow-up → interrupt and start collecting
    return _startCollecting(chatId, text, ctx);
  }

  // ── Interrupt-Collect-Flush ────────────────────────────────────

  /**
   * Gracefully pause the running task (SIGINT = ESC equivalent).
   */
  function _pauseActive(chatId) {
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      proc.abortReason = 'merge-pause';
      try { process.kill(-proc.child.pid, 'SIGINT'); } catch { try { proc.child.kill('SIGINT'); } catch { /* */ } }
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
   * No debounce timer — timer starts only after chain dies (.finally).
   */
  function _startCollecting(chatId, text, ctx) {
    _pauseActive(chatId);
    const originalText = activeTexts.get(chatId);
    const msgs = originalText ? [originalText, text] : [text];
    const c = { messages: msgs, ctx, timer: null, chainDead: false, createdAt: Date.now() };
    collecting.set(chatId, c);
    // NO timer here — wait for chain to die
    log('INFO', `Pipeline: paused & collecting for ${chatId} (original: "${(originalText || '').slice(0, 30)}")`);
    ctx.bot.sendMessage(chatId, '⏸ 已暂停，继续连发，我会合并后继续').catch(e => log('WARN', 'Failed to send pause notice: ' + e.message));
    return Promise.resolve();
  }

  /**
   * Add a message to collecting (create if needed).
   */
  function _addToCollecting(chatId, text, ctx) {
    if (!collecting.has(chatId)) {
      collecting.set(chatId, { messages: [text], ctx, timer: null, chainDead: false, createdAt: Date.now() });
    } else {
      collecting.get(chatId).messages.push(text);
    }
  }

  /**
   * Reset the debounce timer for burst collection.
   */
  function _resetDebounce(chatId, c) {
    if (c.timer) clearTimeout(c.timer);
    // If collecting state has been alive longer than MAX_COLLECT_LIFETIME, flush immediately
    if (c.createdAt && (Date.now() - c.createdAt) >= MAX_COLLECT_LIFETIME_MS) {
      log('INFO', `Pipeline: max collect lifetime reached for ${chatId}, flushing immediately`);
      c.timer = setTimeout(() => _flushCollected(chatId), 0);
      return;
    }
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

  // ── Process one message ────────────────────────────────────────

  /**
   * Process a single message by delegating to handleCommand.
   */
  async function _processOne(chatId, text, ctx) {
    if (resetCooldown) resetCooldown(chatId);
    const { bot, config, executeTaskByName, senderId, readOnly } = ctx;
    try {
      return await handleCommand(bot, chatId, text, config, executeTaskByName, senderId, readOnly);
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
      // SIGINT = graceful stop (like ESC), preserves session context for --resume
      try { process.kill(-proc.child.pid, 'SIGINT'); } catch { try { proc.child.kill('SIGINT'); } catch { /* */ } }
      return true;
    }
    if (proc && proc.child === null) {
      proc.aborted = true;
      return true;
    }
    return false;
  }

  function clearQueue(chatId) {
    _cancelCollecting(chatId);
    resumed.delete(chatId);
  }

  function getQueueLength(chatId) {
    const c = collecting.get(chatId);
    return c ? c.messages.length : 0;
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
