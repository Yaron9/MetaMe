'use strict';

const crypto = require('crypto');
const {
  encodeJson: encode,
  parseJson: parse,
  canonicalJson: canonical,
  appendLoopEvent,
} = require('./loop-persistence');

function hashPlan(plan) {
  return crypto.createHash('sha256').update(canonical(plan)).digest('hex');
}

function createLoopGovernanceStore(opts = {}) {
  if (!opts.controlDb || typeof opts.controlDb.transaction !== 'function') {
    throw new TypeError('createLoopGovernanceStore requires an injected controlDb');
  }
  const controlDb = opts.controlDb;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const newId = typeof opts.newId === 'function' ? opts.newId : prefix => `${prefix}_${crypto.randomUUID()}`;

  function submitPlan(runId, plan, riskLevel = 'R1', approvalScope = '') {
    const planHash = hashPlan(plan);
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const run = db.prepare('SELECT goal_id FROM runs WHERE run_id = ?').get(runId);
      if (!run) throw new Error('run_not_found');
      db.prepare(`
        UPDATE approvals SET status = 'revoked', decided_by = 'system:plan-superseded', decided_at = ?
        WHERE run_id = ? AND status IN ('pending','approved')
      `).run(nowIso, runId);
      db.prepare('UPDATE run_plans SET superseded_at = ? WHERE run_id = ? AND superseded_at IS NULL')
        .run(nowIso, runId);
      const planId = newId('plan');
      db.prepare(`
        INSERT INTO run_plans (plan_id, run_id, plan_hash, plan_body, risk_level, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(planId, runId, planHash, encode(plan), riskLevel, nowIso);

      let approvalId = null;
      if (approvalScope) {
        approvalId = newId('approval');
        db.prepare(`
          INSERT INTO approvals (
            approval_id, run_id, plan_hash, risk_level, action_scope, status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        `).run(approvalId, runId, planHash, riskLevel, approvalScope, nowIso);
      }
      appendLoopEvent(db, {
        goalId: run.goal_id,
        runId,
        type: 'PLAN_SUBMITTED',
        payload: { plan_id: planId, plan_hash: planHash, risk_level: riskLevel },
        createdAt: nowIso,
      });
      return { plan_id: planId, plan_hash: planHash, approval_id: approvalId };
    });
  }

  function decideApproval(approvalId, decision, decidedBy) {
    if (!['approved', 'rejected'].includes(decision)) throw new Error('approval_decision_invalid');
    const actor = String(decidedBy || '').trim();
    if (!actor) throw new Error('approval_actor_required');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const approval = db.prepare(`
        SELECT approvals.*, run_plans.superseded_at
        FROM approvals
        JOIN run_plans
          ON run_plans.run_id = approvals.run_id AND run_plans.plan_hash = approvals.plan_hash
        WHERE approvals.approval_id = ?
      `).get(approvalId);
      if (!approval) throw new Error('approval_not_found');
      if (approval.status !== 'pending') throw new Error(`approval_already_decided:${approval.status}`);
      if (approval.superseded_at) throw new Error('approval_plan_superseded');
      db.prepare(`
        UPDATE approvals SET status = ?, decided_by = ?, decided_at = ? WHERE approval_id = ?
      `).run(decision, actor, nowIso, approvalId);
      const run = db.prepare('SELECT goal_id FROM runs WHERE run_id = ?').get(approval.run_id);
      appendLoopEvent(db, {
        goalId: run.goal_id,
        runId: approval.run_id,
        type: 'APPROVAL_DECIDED',
        payload: { approval_id: approvalId, decision, actor },
        createdAt: nowIso,
      });
      return { ...approval, status: decision, decided_by: actor, decided_at: nowIso };
    });
  }

  function hasValidApproval(runId, planHash, actionScope) {
    return controlDb.run(db => !!db.prepare(`
      SELECT 1
      FROM approvals
      JOIN run_plans
        ON run_plans.run_id = approvals.run_id AND run_plans.plan_hash = approvals.plan_hash
      WHERE approvals.run_id = ? AND approvals.plan_hash = ? AND approvals.action_scope = ?
        AND approvals.status = 'approved' AND run_plans.superseded_at IS NULL
      LIMIT 1
    `).get(runId, planHash, actionScope));
  }

  function recordUsage(entry) {
    const engine = String(entry && entry.engine || '').trim();
    if (!engine) throw new Error('usage_engine_required');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const goal = db.prepare('SELECT goal_id FROM goals WHERE goal_id = ?').get(entry.goalId);
      if (!goal) throw new Error('goal_not_found');
      if (entry.runId) {
        const run = db.prepare('SELECT goal_id FROM runs WHERE run_id = ?').get(entry.runId);
        if (!run) throw new Error('run_not_found');
        if (run.goal_id !== entry.goalId) throw new Error('usage_goal_run_mismatch');
      }
      if (entry.attemptId) {
        if (!entry.runId) throw new Error('usage_attempt_requires_run');
        const attempt = db.prepare('SELECT run_id, runtime_engine FROM run_attempts WHERE attempt_id = ?')
          .get(entry.attemptId);
        if (!attempt) throw new Error('attempt_not_found');
        if (attempt.run_id !== entry.runId) throw new Error('usage_run_attempt_mismatch');
        if (attempt.runtime_engine !== engine) throw new Error('usage_attempt_engine_mismatch');
      }
      const result = db.prepare(`
        INSERT INTO usage_ledger (
          goal_id, run_id, attempt_id, engine, input_tokens, output_tokens, cost_micros, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.goalId, entry.runId || null, entry.attemptId || null, engine,
        Math.max(0, Number(entry.inputTokens) || 0), Math.max(0, Number(entry.outputTokens) || 0),
        Math.max(0, Number(entry.costMicros) || 0), nowIso
      );
      return { usage_id: Number(result.lastInsertRowid), recorded_at: nowIso };
    });
  }

  function getRunUsage(runId) {
    return controlDb.run(db => {
      const row = db.prepare(`
        SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
          COALESCE(SUM(output_tokens), 0) AS output_tokens,
          COALESCE(SUM(cost_micros), 0) AS cost_micros
        FROM usage_ledger WHERE run_id = ?
      `).get(runId);
      return {
        input_tokens: Number(row.input_tokens),
        output_tokens: Number(row.output_tokens),
        cost_micros: Number(row.cost_micros),
      };
    });
  }

  function enqueueOutbox(topic, dedupeKey, payload, availableAt, context = {}) {
    const nowIso = now().toISOString();
    return controlDb.run(db => {
      const safeTopic = String(topic || '').trim();
      const safeKey = String(dedupeKey || '').trim();
      if (!safeTopic || !safeKey) throw new Error('outbox_identity_required');
      const existing = db.prepare('SELECT * FROM outbox WHERE dedupe_key = ?').get(safeKey);
      if (existing) {
        if (
          existing.topic !== safeTopic
          || canonical(parse(existing.payload)) !== canonical(payload)
          || (existing.goal_id || null) !== (context.goalId || null)
          || (existing.run_id || null) !== (context.runId || null)
        ) {
          throw new Error('outbox_dedupe_conflict');
        }
        return { ...existing, payload: parse(existing.payload) };
      }
      if (context.runId) {
        const run = db.prepare('SELECT goal_id FROM runs WHERE run_id = ?').get(context.runId);
        if (!run) throw new Error('run_not_found');
        if (context.goalId && run.goal_id !== context.goalId) throw new Error('outbox_goal_run_mismatch');
      }
      db.prepare(`
        INSERT OR IGNORE INTO outbox (goal_id, run_id, topic, dedupe_key, payload, available_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        context.goalId || null, context.runId || null, safeTopic, safeKey,
        encode(payload), availableAt || nowIso
      );
      const row = db.prepare('SELECT * FROM outbox WHERE dedupe_key = ?').get(safeKey);
      return { ...row, payload: parse(row.payload) };
    });
  }

  function listPendingOutbox(limit = 50) {
    const nowIso = now().toISOString();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    return controlDb.run(db => db.prepare(`
      SELECT * FROM outbox
      WHERE delivered_at IS NULL AND available_at <= ?
      ORDER BY outbox_id ASC LIMIT ?
    `).all(nowIso, safeLimit).map(row => ({ ...row, payload: parse(row.payload) })));
  }

  function markOutboxDelivered(outboxId) {
    const nowIso = now().toISOString();
    return controlDb.run(db => db.prepare(`
      UPDATE outbox SET delivered_at = ?, attempts = attempts + 1, last_error = ''
      WHERE outbox_id = ? AND delivered_at IS NULL
    `).run(nowIso, outboxId));
  }

  function markOutboxFailed(outboxId, error, retryAt) {
    return controlDb.run(db => db.prepare(`
      UPDATE outbox SET attempts = attempts + 1, last_error = ?, available_at = ?
      WHERE outbox_id = ? AND delivered_at IS NULL
    `).run(String(error || '').slice(0, 2000), retryAt || now().toISOString(), outboxId));
  }

  return {
    submitPlan,
    decideApproval,
    hasValidApproval,
    recordUsage,
    getRunUsage,
    enqueueOutbox,
    listPendingOutbox,
    markOutboxDelivered,
    markOutboxFailed,
  };
}

module.exports = { createLoopGovernanceStore, _internal: { hashPlan } };
