'use strict';

/**
 * scripts/core/recall-observe.js — daemon-side observe-only audit hook
 * (PR1 Step 12, v4.1 §P1.11).
 *
 * Wires planRecall (core/recall-plan.js) + recordAudit (core/recall-audit-db.js)
 * for every daemon turn. Always writes a phase='observe' row when a plan is
 * computed, regardless of shouldRecall. Failure is fully swallowed — recall
 * audit must never raise into user reply path.
 *
 * Per PR1 contract: this helper does NOT touch composePrompt and does NOT
 * change prompt output bytes. PR2 will add a separate inject path for the
 * recallHint slot.
 */

const crypto = require('crypto');
const { planRecall } = require('./recall-plan');
const { recordAudit } = require('./recall-audit-db');

function _hashAnchor(label) {
  return 'sha256:' + crypto.createHash('sha256').update(String(label || '')).digest('hex').slice(0, 16);
}

function _newAuditId() {
  return `ra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * observeRecall({ prompt, runtime, scope, chatId, log }) — best-effort.
 * Returns the plan object (whatever planRecall produced) for the caller to
 * inspect or ignore. Returns null on any failure.
 *
 * runtime: { engine, sessionStarted }
 * scope:   { project, workspaceScope, agentKey }
 */
function observeRecall({ prompt, runtime = {}, scope = {}, chatId = null, log } = {}) {
  try {
    const plan = planRecall({ text: prompt, runtime, scope });
    const queryHashes = Array.isArray(plan.anchors)
      ? plan.anchors.map(_hashAnchor)
      : [];
    recordAudit({
      id: _newAuditId(),
      phase: 'observe',
      chat_id: chatId != null ? String(chatId) : null,
      project: scope.project || null,
      scope: scope.workspaceScope || null,
      agent_key: scope.agentKey || null,
      engine: runtime.engine || null,
      session_started: runtime.sessionStarted ? 1 : 0,
      should_recall: plan.shouldRecall ? 1 : 0,
      router_reason: plan.reason || null,
      query_hashes: queryHashes,
      anchor_labels: Array.isArray(plan.anchors) ? plan.anchors : [],
      modes: Array.isArray(plan.modes) ? plan.modes : [],
    });
    return plan;
  } catch (e) {
    if (typeof log === 'function') {
      try { log('WARN', `recall observe-only failed: ${e.message}`); } catch { /* ignore */ }
    }
    return null;
  }
}

module.exports = { observeRecall };
