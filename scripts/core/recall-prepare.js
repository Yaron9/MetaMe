'use strict';

/**
 * scripts/core/recall-prepare.js — daemon-side recall hook (v4.1 §P1.6 wiring).
 *
 * Replaces PR1's observeRecall by extending it: in addition to writing a
 * phase='observe' row every turn (preserving the 4-week observation window),
 * when `enabled && plan.shouldRecall` is true it also calls
 * memory-recall's assembleRecallContext, writes a phase='inject' row, and
 * returns the recallHint string + recallMeta for the daemon to thread into
 * composePrompt and the marker pipeline.
 *
 * Failure is fully swallowed at every layer — recall must NEVER raise into
 * the user reply path. plan errors fall through to empty result; audit/
 * assemble errors fall back to observe-only.
 */

const crypto = require('crypto');
const { planRecall } = require('./recall-plan');
const { recordAudit } = require('./recall-audit-db');

function _hashAnchor(label) {
  return 'sha256:' + crypto.createHash('sha256').update(String(label || '')).digest('hex').slice(0, 16);
}

function _newAuditId(prefix = 'ra') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function _emptyPlan() {
  return { shouldRecall: false, reason: '', anchors: [], modes: [], hintBudget: 0 };
}

function _emptyResult(plan) {
  return { plan: plan || _emptyPlan(), recallActive: false, recallHint: '', recallMeta: null };
}

function _errMessage(e) {
  // Defensive: throws can be null/undefined/string in addition to Error.
  if (e == null) return 'unknown';
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;
  try { return String(e); } catch { return 'unknown'; }
}

function _safeLog(log, level, msg) {
  if (typeof log !== 'function') return;
  try { log(level, msg); } catch { /* never raise */ }
}

function _writeAudit(row) {
  try { recordAudit(row); } catch { /* swallow */ }
}

function _commonAuditFields({ chatId, scope, runtime, plan, queryHashes }) {
  return {
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
  };
}

function _toSourceRef(s) {
  if (!s || typeof s !== 'object') return null;
  if (s.id) return `id:${s.id}`;
  if (s.slug) return `wiki:${s.slug}`;
  if (s.sessionId) return `session:${s.sessionId}`;
  if (s.kind) return `kind:${s.kind}`;
  return null;
}

// Sentinel resolved by the timeout side of Promise.race so the caller can
// distinguish a genuine empty-context result from a budget-exceeded fall-through.
const ASSEMBLE_TIMEOUT_SENTINEL = Symbol('recall-assemble-timeout');
const DEFAULT_ASSEMBLE_TIMEOUT_MS = 80;

function _withTimeout(promise, ms) {
  let cancel;
  const timer = new Promise((resolve) => {
    const t = setTimeout(() => resolve(ASSEMBLE_TIMEOUT_SENTINEL), ms);
    cancel = () => clearTimeout(t);
  });
  return Promise.race([
    promise.then((v) => { cancel(); return v; }, (e) => { cancel(); throw e; }),
    timer,
  ]);
}

async function prepareRecall({
  prompt,
  runtime,
  scope,
  chatId = null,
  enabled = false,
  budget,
  log,
  assembleTimeoutMs,
} = {}) {
  // Normalize possibly-null inputs so downstream property access never throws.
  runtime = runtime && typeof runtime === 'object' ? runtime : {};
  scope = scope && typeof scope === 'object' ? scope : {};
  budget = budget && typeof budget === 'object' ? budget : {};
  const timeoutMs = Number.isFinite(assembleTimeoutMs) && assembleTimeoutMs > 0
    ? assembleTimeoutMs
    : DEFAULT_ASSEMBLE_TIMEOUT_MS;
  // Phase 0: plan (sync, pure). Never throws normally; defensive try/catch.
  let plan;
  try {
    plan = planRecall({ text: prompt, runtime, scope });
  } catch (e) {
    _safeLog(log, 'WARN', `planRecall failed: ${_errMessage(e)}`);
    return _emptyResult();
  }

  const queryHashes = Array.isArray(plan.anchors) ? plan.anchors.map(_hashAnchor) : [];
  const common = _commonAuditFields({ chatId, scope, runtime, plan, queryHashes });

  // Phase 1: always write observe row (preserves PR1 behaviour).
  _writeAudit({ id: _newAuditId('ra'), phase: 'observe', ...common });

  // Phase 2: only enter inject path when both flag is on AND plan triggered.
  if (!enabled || !plan.shouldRecall) return _emptyResult(plan);

  // Phase 3: assemble context. Heavyweight (DB queries via memory.js).
  // Wrapped in Promise.race so it never blocks the user reply for more than
  // `timeoutMs`. On timeout we write an inject-side audit row tagged with
  // outcome='harmful' + error_message='assemble timeout:Nms' so the
  // observation pipeline records the cost. recallActive stays false; the
  // daemon proceeds with the existing prompt.
  let ctx;
  try {
    const { assembleRecallContext } = require('../memory-recall');
    const result = await _withTimeout(
      assembleRecallContext({
        plan,
        scope,
        budget: {
          totalChars: Number.isFinite(budget.totalChars) ? budget.totalChars : 4000,
          perItem: budget.perItem || undefined,
        },
        search: { ftsOnly: !!budget.ftsOnly },
      }),
      timeoutMs,
    );
    if (result === ASSEMBLE_TIMEOUT_SENTINEL) {
      _safeLog(log, 'WARN', `assembleRecallContext timed out after ${timeoutMs}ms`);
      _writeAudit({
        id: _newAuditId('ri'),
        phase: 'inject',
        ...common,
        injected_chars: 0,
        outcome: 'harmful',
        error_message: `assemble timeout:${timeoutMs}ms`,
      });
      return _emptyResult(plan);
    }
    ctx = result;
  } catch (e) {
    _safeLog(log, 'WARN', `assembleRecallContext failed: ${_errMessage(e)}`);
    return _emptyResult(plan);
  }

  // No usable text → no inject row, recallActive stays false.
  if (!ctx || typeof ctx.text !== 'string' || ctx.text.length === 0) {
    return _emptyResult(plan);
  }

  // Phase 4: write inject row with breakdown + sources.
  const sourceRefs = Array.isArray(ctx.sources)
    ? ctx.sources.map(_toSourceRef).filter(Boolean)
    : [];
  const injectedChars = ctx.recallMeta && Number.isFinite(ctx.recallMeta.chars)
    ? ctx.recallMeta.chars
    : ctx.text.length;

  _writeAudit({
    id: _newAuditId('ri'),
    phase: 'inject',
    ...common,
    source_refs: sourceRefs,
    injected_chars: injectedChars,
    truncated: ctx.truncated ? 1 : 0,
    wiki_dropped: ctx.wikiDropped ? 1 : 0,
  });

  return {
    plan,
    recallActive: true,
    recallHint: ctx.text,
    recallMeta: ctx.recallMeta,
  };
}

module.exports = { prepareRecall };
