'use strict';

/**
 * daemon-reflection.js — Session Reflection Manager
 *
 * After a Claude session ends, waits PROMPT_DELAY_MS then sends:
 *   "🪞 一个词形容这次session的感受？"
 * directly to the user via Feishu. User replies with 1-4 chars → stored in session_log.yaml.
 *
 * Controlled by: growth.reflection_enabled in ~/.claude_profile.yaml
 *   false → fully disabled
 *   true (default) → active, but only fires when shouldTrigger() is true
 */

const PROMPT_DELAY_MS   = 10 * 60 * 1000; // wait 10 min after session ends
const CAPTURE_WINDOW_MS = 15 * 60 * 1000; // user has 15 min to reply
const MAX_WORD_LEN      = 20;              // longer replies = regular commands

function createReflectionManager(deps) {
  const { fs, path, yaml, log, METAME_DIR, BRAIN_FILE, sendToChat } = deps;

  const SESSION_LOG_FILE = path.join(METAME_DIR, 'session_log.yaml');

  const pendingTimers = new Map(); // chatId → setTimeout handle
  const pendingState  = new Map(); // chatId → { asked_at }

  function isEnabled() {
    try {
      const brain = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      return brain.growth?.reflection_enabled !== false;
    } catch {
      return false;
    }
  }

  function shouldTrigger() {
    try {
      const brain        = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      const distillCount = brain.evolution?.distill_count || 0;
      const zoneHistory  = brain.growth?.zone_history || [];

      if (distillCount > 0 && distillCount % 7 === 0) return true;

      const lastThree = zoneHistory.slice(-3);
      if (lastThree.length === 3 && lastThree.every(z => z === 'C')) return true;

      if (fs.existsSync(SESSION_LOG_FILE)) {
        const sessionLog = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8')) || {};
        const recent     = (sessionLog.sessions || []).slice(-3);
        const driftCount = recent.filter(s => s.goal_alignment === 'drifted' || s.goal_alignment === 'partial').length;
        if (driftCount >= 2 && recent.length >= 2) return true;
      }
    } catch { /* non-fatal */ }
    return false;
  }

  function cancelTimer(chatId) {
    if (pendingTimers.has(chatId)) {
      clearTimeout(pendingTimers.get(chatId));
      pendingTimers.delete(chatId);
    }
  }

  function writeReflectionWord(word) {
    try {
      const sessionLog = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8')) || { sessions: [] };
      if (Array.isArray(sessionLog.sessions) && sessionLog.sessions.length > 0) {
        sessionLog.sessions[sessionLog.sessions.length - 1].reflection_word = word;
        fs.writeFileSync(SESSION_LOG_FILE, yaml.dump(sessionLog, { lineWidth: -1 }), 'utf8');
      }
    } catch (e) {
      log('WARN', `[REFLECT] Failed to write word: ${e.message}`);
    }
  }

  /** Called when a Claude session ends. Schedules reflection prompt after idle delay. */
  function onSessionEnd(chatId) {
    if (!isEnabled()) return;
    // Skip virtual chatIds (team members) — only ask the user directly
    if (String(chatId).startsWith('_agent_')) return;
    cancelTimer(chatId);

    const timer = setTimeout(async () => {
      pendingTimers.delete(chatId);
      if (!isEnabled() || !shouldTrigger()) return;
      try {
        await sendToChat(chatId, '🪞 一个词形容这次session的感受？');
        pendingState.set(chatId, { asked_at: Date.now() });
        log('INFO', `[REFLECT] Prompt sent to ${String(chatId).slice(-8)}`);
      } catch (e) {
        log('WARN', `[REFLECT] Failed to send prompt: ${e.message}`);
      }
    }, PROMPT_DELAY_MS);

    pendingTimers.set(chatId, timer);
  }

  /** Called on every incoming message before command handling. Returns true if captured. */
  function tryCapture(chatId, text) {
    if (!pendingState.has(chatId)) return false;

    const { asked_at } = pendingState.get(chatId);
    if (Date.now() - asked_at > CAPTURE_WINDOW_MS) {
      pendingState.delete(chatId);
      return false;
    }

    const trimmed = (text || '').trim();
    if (trimmed.startsWith('/') || trimmed.length > MAX_WORD_LEN) return false;

    pendingState.delete(chatId);
    cancelTimer(chatId);
    writeReflectionWord(trimmed);
    sendToChat(chatId, '✓').catch(() => {});
    log('INFO', `[REFLECT] Captured "${trimmed}" from ${String(chatId).slice(-8)}`);
    return true;
  }

  return { onSessionEnd, tryCapture };
}

module.exports = { createReflectionManager };
