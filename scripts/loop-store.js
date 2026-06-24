'use strict';

const crypto = require('crypto');
const { normalizeGoal, normalizeWakeEvent, normalizeAutomation } = require('./core/loop-contract');
const { assertGoalTransition, assertRunTransition, isActiveRunStatus } = require('./core/loop-state');
const {
  encodeJson,
  parseJson,
  canonicalJson,
  appendLoopEvent,
  appendOutbox,
} = require('./loop-persistence');

const EXECUTION_STATUSES = new Set(['executing', 'verifying', 'retry_wait']);
const EXECUTION_TARGETS = new Set(['executing', 'verifying', 'retry_wait', 'succeeded']);

function hydrateGoal(row) {
  if (!row) return null;
  return {
    ...row,
    execution_spec: parseJson(row.execution_spec),
    verification_spec: parseJson(row.verification_spec),
    policy_spec: parseJson(row.policy_spec),
  };
}

function hydrateRun(row) {
  if (!row) return null;
  return { ...row, result: parseJson(row.result) };
}

function createLoopStore(opts = {}) {
  if (!opts.controlDb || typeof opts.controlDb.transaction !== 'function') {
    throw new TypeError('createLoopStore requires an injected controlDb');
  }
  const controlDb = opts.controlDb;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const newId = typeof opts.newId === 'function' ? opts.newId : prefix => `${prefix}_${crypto.randomUUID()}`;

  function emit(db, goalId, runId, type, payload, createdAt) {
    appendLoopEvent(db, { goalId, runId, type, payload, createdAt });
  }

  function createGoal(raw) {
    const goal = normalizeGoal(raw);
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      db.prepare(`
        INSERT INTO goals (
          goal_id, title, objective, mode, status, project_key, cwd,
          execution_spec, verification_spec, policy_spec, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        goal.goal_id, goal.title, goal.objective, goal.mode, goal.status,
        goal.project_key, goal.cwd, encodeJson(goal.execution_spec),
        encodeJson(goal.verification_spec), encodeJson(goal.policy_spec),
        1, nowIso, nowIso
      );
      emit(db, goal.goal_id, null, 'GOAL_CREATED', {}, nowIso);
      return hydrateGoal(db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goal.goal_id));
    });
  }

  function updateGoalSpec(raw, expectedVersion) {
    const goal = normalizeGoal(raw);
    if (!Number.isInteger(expectedVersion)) throw new Error('goal_expected_version_required');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const update = db.prepare(`
        UPDATE goals SET
          title = ?, objective = ?, mode = ?, project_key = ?, cwd = ?,
          execution_spec = ?, verification_spec = ?, policy_spec = ?,
          version = version + 1, updated_at = ?
        WHERE goal_id = ? AND version = ?
      `).run(
        goal.title, goal.objective, goal.mode, goal.project_key, goal.cwd,
        encodeJson(goal.execution_spec), encodeJson(goal.verification_spec),
        encodeJson(goal.policy_spec), nowIso, goal.goal_id, expectedVersion
      );
      if (Number(update.changes) !== 1) throw new Error('goal_version_conflict');
      emit(db, goal.goal_id, null, 'GOAL_UPDATED', {}, nowIso);
      return hydrateGoal(db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goal.goal_id));
    });
  }

  function transitionGoal(goalId, nextStatus, expectedVersion) {
    if (!Number.isInteger(expectedVersion)) throw new Error('goal_expected_version_required');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const current = db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId);
      if (!current) throw new Error('goal_not_found');
      if (current.version !== expectedVersion) throw new Error('goal_version_conflict');
      if (current.status === nextStatus) return hydrateGoal(current);
      assertGoalTransition(current.status, nextStatus);
      const update = db.prepare(`
        UPDATE goals SET status = ?, version = version + 1, updated_at = ?
        WHERE goal_id = ? AND version = ?
      `).run(nextStatus, nowIso, goalId, expectedVersion);
      if (Number(update.changes) !== 1) throw new Error('goal_version_conflict');
      emit(db, goalId, null, 'GOAL_STATUS_CHANGED', { from: current.status, to: nextStatus }, nowIso);
      return hydrateGoal(db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId));
    });
  }

  function getGoal(goalId) {
    return controlDb.run(db => hydrateGoal(db.prepare('SELECT * FROM goals WHERE goal_id = ?').get(goalId)));
  }

  function getRun(runId) {
    return controlDb.run(db => hydrateRun(db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)));
  }

  function upsertAutomation(raw) {
    const automation = normalizeAutomation(raw);
    return controlDb.transaction(db => {
      const goal = db.prepare('SELECT goal_id FROM goals WHERE goal_id = ?').get(automation.goal_id);
      if (!goal) throw new Error('goal_not_found');
      const existing = db.prepare('SELECT goal_id FROM automations WHERE automation_id = ?')
        .get(automation.automation_id);
      if (existing && existing.goal_id !== automation.goal_id) throw new Error('automation_goal_conflict');
      db.prepare(`
        INSERT INTO automations (
          automation_id, goal_id, trigger_type, trigger_spec, enabled, next_fire_at, last_fire_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(automation_id) DO UPDATE SET
          trigger_type = excluded.trigger_type,
          trigger_spec = excluded.trigger_spec,
          enabled = excluded.enabled,
          next_fire_at = excluded.next_fire_at
      `).run(
        automation.automation_id, automation.goal_id, automation.trigger_type,
        encodeJson(automation.trigger_spec), automation.enabled ? 1 : 0,
        automation.next_fire_at, automation.last_fire_at
      );
      const row = db.prepare('SELECT * FROM automations WHERE automation_id = ?')
        .get(automation.automation_id);
      return { ...row, trigger_spec: parseJson(row.trigger_spec), enabled: !!row.enabled };
    });
  }

  function markAutomationFired(automationId, scheduledAt, nextFireAt = null) {
    return controlDb.run(db => {
      const updated = db.prepare(`
        UPDATE automations SET last_fire_at = ?, next_fire_at = ? WHERE automation_id = ?
      `).run(String(scheduledAt || ''), nextFireAt || null, automationId);
      if (Number(updated.changes) !== 1) throw new Error('automation_not_found');
      return db.prepare('SELECT * FROM automations WHERE automation_id = ?').get(automationId);
    });
  }

  function listAutomations(goalId) {
    return controlDb.run(db => db.prepare(
      'SELECT * FROM automations WHERE goal_id = ? ORDER BY automation_id'
    ).all(goalId).map(row => ({
      ...row,
      trigger_spec: parseJson(row.trigger_spec),
      enabled: !!row.enabled,
    })));
  }

  function attachToActiveRun(db, wake, active, nowIso) {
    db.prepare(`UPDATE wake_events SET attached_run_id = ?, disposition = 'coalesced' WHERE wake_id = ?`)
      .run(active.run_id, wake.wake_id);
    emit(db, wake.goal_id, active.run_id, 'WAKE_COALESCED', { wake_id: wake.wake_id }, nowIso);
    return { wake_id: wake.wake_id, run: hydrateRun(active), disposition: 'coalesced', duplicate: false };
  }

  function rejectWhileActive(db, wake, active, nowIso) {
    db.prepare(`UPDATE wake_events SET disposition = 'rejected_active' WHERE wake_id = ?`).run(wake.wake_id);
    emit(db, wake.goal_id, active.run_id, 'WAKE_REJECTED_ACTIVE', { wake_id: wake.wake_id }, nowIso);
    return {
      wake_id: wake.wake_id,
      run: null,
      active_run_id: active.run_id,
      disposition: 'rejected_active',
      duplicate: false,
    };
  }

  function sameWake(existing, wake) {
    return (
      existing.goal_id === wake.goal_id
      && (existing.automation_id || null) === wake.automation_id
      && existing.trigger_type === wake.trigger_type
      && existing.scheduled_at === wake.scheduled_at
      && Number(existing.coalesce) === Number(wake.coalesce)
      && canonicalJson(parseJson(existing.payload)) === canonicalJson(wake.payload)
    );
  }

  function createRunForWake(db, wake, nowIso) {
    const runId = newId('run');
    db.prepare(`
      INSERT INTO runs (run_id, goal_id, primary_wake_id, status, created_at)
      VALUES (?, ?, ?, 'queued', ?)
    `).run(runId, wake.goal_id, wake.wake_id, nowIso);
    db.prepare(`UPDATE wake_events SET attached_run_id = ?, disposition = 'created' WHERE wake_id = ?`)
      .run(runId, wake.wake_id);
    emit(db, wake.goal_id, runId, 'RUN_QUEUED', { wake_id: wake.wake_id }, nowIso);
    return { wake_id: wake.wake_id, run: getRunFromDb(db, runId), disposition: 'created', duplicate: false };
  }

  function getRunFromDb(db, runId) {
    return hydrateRun(db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId));
  }

  function enqueueWake(raw) {
    const nowIso = now().toISOString();
    const wake = normalizeWakeEvent(raw, nowIso);
    return controlDb.transaction(db => {
      const duplicate = db.prepare('SELECT * FROM wake_events WHERE wake_id = ?').get(wake.wake_id);
      if (duplicate) {
        if (!sameWake(duplicate, wake)) throw new Error('wake_id_conflict');
        return {
          wake_id: wake.wake_id,
          run: duplicate.attached_run_id ? getRunFromDb(db, duplicate.attached_run_id) : null,
          disposition: duplicate.disposition,
          duplicate: true,
        };
      }

      const goal = db.prepare('SELECT status FROM goals WHERE goal_id = ?').get(wake.goal_id);
      if (!goal) throw new Error('goal_not_found');
      if (goal.status !== 'active') throw new Error(`goal_not_active:${goal.status}`);
      if (wake.automation_id) {
        const automation = db.prepare('SELECT goal_id FROM automations WHERE automation_id = ?')
          .get(wake.automation_id);
        if (!automation) throw new Error('automation_not_found');
        if (automation.goal_id !== wake.goal_id) throw new Error('automation_goal_mismatch');
      }

      db.prepare(`
        INSERT INTO wake_events (
          wake_id, automation_id, goal_id, trigger_type, scheduled_at,
          observed_at, payload, coalesce, disposition, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        wake.wake_id, wake.automation_id, wake.goal_id, wake.trigger_type,
        wake.scheduled_at, wake.observed_at, encodeJson(wake.payload), wake.coalesce ? 1 : 0, nowIso
      );

      const active = db.prepare(`
        SELECT * FROM runs
        WHERE goal_id = ? AND status IN (
          'queued','planning','awaiting_approval','executing','verifying','awaiting_review','retry_wait'
        )
        ORDER BY created_at DESC LIMIT 1
      `).get(wake.goal_id);
      if (!active) return createRunForWake(db, wake, nowIso);
      return wake.coalesce
        ? attachToActiveRun(db, wake, active, nowIso)
        : rejectWhileActive(db, wake, active, nowIso);
    });
  }

  function transitionRun(runId, nextStatus, opts = {}) {
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const current = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
      if (!current) throw new Error('run_not_found');
      if (!Number.isInteger(opts.expectedVersion)) throw new Error('run_expected_version_required');
      if (current.version !== opts.expectedVersion) throw new Error('run_version_conflict');
      if (current.status === nextStatus) return hydrateRun(current);
      if (EXECUTION_STATUSES.has(current.status) || EXECUTION_TARGETS.has(nextStatus)) {
        throw new Error('execution_command_required');
      }
      assertRunTransition(current.status, nextStatus);
      if (nextStatus === 'succeeded') throw new Error('verified_completion_command_required');
      const expectedVersion = opts.expectedVersion;
      const finishedAt = isActiveRunStatus(nextStatus) ? null : nowIso;
      const startedAt = current.started_at || (['planning', 'executing'].includes(nextStatus) ? nowIso : null);
      const result = opts.result === undefined ? current.result : encodeJson(opts.result);
      const lastError = opts.lastError === undefined ? current.last_error : String(opts.lastError || '');
      const update = db.prepare(`
        UPDATE runs
        SET status = ?, result = ?, last_error = ?, version = version + 1,
            started_at = ?, finished_at = ?
        WHERE run_id = ? AND version = ?
      `).run(nextStatus, result, lastError, startedAt, finishedAt, runId, expectedVersion);
      if (Number(update.changes) !== 1) throw new Error('run_version_conflict');
      emit(db, current.goal_id, runId, 'RUN_STATUS_CHANGED', {
        from: current.status,
        to: nextStatus,
      }, nowIso);
      appendOutbox(db, opts.outbox ? {
        ...opts.outbox,
        goalId: current.goal_id,
        runId,
      } : null, nowIso);
      return getRunFromDb(db, runId);
    });
  }

  function completeCompatibilityRun(runId, outcome = {}) {
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const current = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
      if (!current) throw new Error('run_not_found');
      if (current.status !== 'queued') return hydrateRun(current);
      const nextStatus = outcome.success ? 'skipped' : 'blocked';
      const update = db.prepare(`
        UPDATE runs SET status = ?, result = ?, last_error = ?,
          version = version + 1, finished_at = ?
        WHERE run_id = ? AND version = ? AND status = 'queued'
      `).run(
        nextStatus, encodeJson(outcome), String(outcome.error || ''),
        nowIso, runId, current.version
      );
      if (Number(update.changes) !== 1) throw new Error('run_version_conflict');
      emit(db, current.goal_id, runId, 'RUN_STATUS_CHANGED', {
        from: 'queued', to: nextStatus, compatibility: true,
      }, nowIso);
      return getRunFromDb(db, runId);
    });
  }

  function listRunEvents(runId, limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return controlDb.run(db => db.prepare(`
      SELECT * FROM loop_events WHERE run_id = ? ORDER BY event_id ASC LIMIT ?
    `).all(runId, safeLimit).map(row => ({ ...row, payload: parseJson(row.payload) })));
  }

  function listRunnableRuns(limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return controlDb.run(db => db.prepare(`
      SELECT runs.* FROM runs
      JOIN goals ON goals.goal_id = runs.goal_id
      WHERE goals.status = 'active' AND runs.status IN ('queued','retry_wait')
      ORDER BY runs.created_at ASC LIMIT ?
    `).all(safeLimit).map(hydrateRun));
  }

  function getRunProjection(runId) {
    return controlDb.transaction(db => {
      const run = getRunFromDb(db, runId);
      if (!run) return null;
      const attempts = db.prepare('SELECT * FROM run_attempts WHERE run_id = ? ORDER BY attempt_no').all(runId)
        .map(row => ({
          ...row,
          input_summary: parseJson(row.input_summary),
          maker_result: parseJson(row.maker_result),
          verifier_result: parseJson(row.verifier_result),
        }));
      const plans = db.prepare('SELECT * FROM run_plans WHERE run_id = ? ORDER BY created_at').all(runId)
        .map(row => ({ ...row, plan_body: parseJson(row.plan_body) }));
      const approvals = db.prepare('SELECT * FROM approvals WHERE run_id = ? ORDER BY created_at').all(runId);
      const wakes = db.prepare('SELECT * FROM wake_events WHERE attached_run_id = ? ORDER BY created_at').all(runId)
        .map(row => ({ ...row, payload: parseJson(row.payload) }));
      const usage = db.prepare('SELECT * FROM usage_ledger WHERE run_id = ? ORDER BY usage_id').all(runId);
      const events = db.prepare('SELECT * FROM loop_events WHERE run_id = ? ORDER BY event_id').all(runId)
        .map(row => ({ ...row, payload: parseJson(row.payload) }));
      const outbox = db.prepare('SELECT * FROM outbox WHERE run_id = ? ORDER BY outbox_id').all(runId)
        .map(row => ({ ...row, payload: parseJson(row.payload) }));
      return { run, wakes, attempts, plans, approvals, usage, events, outbox };
    });
  }

  return {
    createGoal,
    updateGoalSpec,
    transitionGoal,
    getGoal,
    getRun,
    upsertAutomation,
    markAutomationFired,
    listAutomations,
    enqueueWake,
    transitionRun,
    completeCompatibilityRun,
    listRunEvents,
    listRunnableRuns,
    getRunProjection,
  };
}

module.exports = { createLoopStore };
