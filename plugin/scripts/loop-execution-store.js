'use strict';

const crypto = require('crypto');
const { assertRunTransition } = require('./core/loop-state');
const { validateVerifierVerdict } = require('./core/loop-verdict');
const {
  encodeJson: encode,
  parseJson: parse,
  canonicalJson: canonical,
  appendLoopEvent,
  appendOutbox,
} = require('./loop-persistence');

function hashSpec(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function createLoopExecutionStore(opts = {}) {
  if (!opts.controlDb || typeof opts.controlDb.transaction !== 'function') {
    throw new TypeError('createLoopExecutionStore requires an injected controlDb');
  }
  const controlDb = opts.controlDb;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();
  const newId = typeof opts.newId === 'function' ? opts.newId : prefix => `${prefix}_${crypto.randomUUID()}`;

  function emit(db, run, type, payload, nowIso) {
    appendLoopEvent(db, {
      goalId: run.goal_id,
      runId: run.run_id,
      type,
      payload,
      createdAt: nowIso,
    });
  }

  function loadRun(db, runId) {
    const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
    if (!run) throw new Error('run_not_found');
    return run;
  }

  function loadRunContext(db, runId) {
    const row = db.prepare(`
      SELECT runs.*, goals.execution_spec AS goal_execution_spec,
        goals.verification_spec AS goal_verification_spec
      FROM runs JOIN goals ON goals.goal_id = runs.goal_id
      WHERE runs.run_id = ?
    `).get(runId);
    if (!row) throw new Error('run_not_found');
    return row;
  }

  function resolveEvidenceAnchor(run) {
    const verificationSpec = parse(run.goal_verification_spec);
    if (Object.keys(verificationSpec).length === 0) throw new Error('verification_spec_required');
    const executionSpec = parse(run.goal_execution_spec);
    const workspaceMode = String(executionSpec.workspace || 'none');
    let workspaceRevision = 'none';
    if (workspaceMode === 'worktree' || workspaceMode === 'auto') {
      workspaceRevision = String(run.base_revision || '').trim();
      if (!workspaceRevision) throw new Error('workspace_revision_required');
    } else if (workspaceMode === 'directory') {
      workspaceRevision = String(run.base_revision || run.workspace_id || '').trim();
      if (!workspaceRevision) throw new Error('workspace_revision_required');
    }
    return { verificationSpecHash: hashSpec(verificationSpec), workspaceRevision };
  }

  function assertVersion(row, expectedVersion, entity) {
    if (!Number.isInteger(expectedVersion)) throw new Error(`${entity}_expected_version_required`);
    if (row.version !== expectedVersion) throw new Error(`${entity}_version_conflict`);
  }

  function assertOwner(run, owner) {
    const bootId = String(owner && owner.bootId || '').trim();
    const pid = Number(owner && owner.pid);
    if (!bootId || !Number.isInteger(pid) || pid <= 0) throw new Error('execution_owner_invalid');
    if (run.execution_boot_id !== bootId || run.execution_pid !== pid) {
      throw new Error('execution_owner_mismatch');
    }
    return { bootId, pid };
  }

  function startExecution(runId, command = {}) {
    const owner = command.owner;
    const expectedVersion = command.expectedVersion;
    const bootId = String(owner && owner.bootId || '').trim();
    const pid = Number(owner && owner.pid);
    if (!bootId || !Number.isInteger(pid) || pid <= 0) throw new Error('execution_owner_invalid');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const run = loadRun(db, runId);
      assertVersion(run, expectedVersion, 'run');
      if (!['planning', 'retry_wait'].includes(run.status)) {
        if (run.status !== 'awaiting_approval') throw new Error(`run_not_startable:${run.status}`);
      }
      if (run.status === 'retry_wait') {
        if (run.execution_boot_id || run.execution_pid) assertOwner(run, owner);
      }
      if (run.status === 'awaiting_approval') {
        const scope = String(command.approvalScope || '').trim();
        if (!scope) throw new Error('approval_scope_required');
        const approved = db.prepare(`
          SELECT 1 FROM approvals
          JOIN run_plans
            ON run_plans.run_id = approvals.run_id AND run_plans.plan_hash = approvals.plan_hash
          WHERE approvals.run_id = ? AND approvals.action_scope = ?
            AND approvals.status = 'approved' AND run_plans.superseded_at IS NULL
          LIMIT 1
        `).get(runId, scope);
        if (!approved) throw new Error('valid_approval_required');
      }
      assertRunTransition(run.status, 'executing');
      const update = db.prepare(`
        UPDATE runs SET status = 'executing', execution_boot_id = ?, execution_pid = ?,
          execution_started_at = ?, execution_heartbeat_at = ?,
          started_at = COALESCE(started_at, ?), version = version + 1
        WHERE run_id = ? AND version = ?
      `).run(bootId, pid, nowIso, nowIso, nowIso, runId, expectedVersion);
      if (Number(update.changes) !== 1) throw new Error('run_version_conflict');
      emit(db, run, 'EXECUTION_STARTED', { boot_id: bootId, pid }, nowIso);
      return { ...loadRun(db, runId), result: parse(run.result) };
    });
  }

  function heartbeatExecution(runId, owner) {
    const bootId = String(owner && owner.bootId || '').trim();
    const pid = Number(owner && owner.pid);
    const nowIso = now().toISOString();
    return controlDb.run(db => {
      const update = db.prepare(`
        UPDATE runs SET execution_heartbeat_at = ?
        WHERE run_id = ? AND execution_boot_id = ? AND execution_pid = ?
          AND status IN ('executing','verifying')
      `).run(nowIso, runId, bootId, pid);
      if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
      return { run_id: runId, heartbeat_at: nowIso };
    });
  }

  function recordWorkspace(runId, workspace, expectedVersion) {
    const workspaceId = String(workspace && workspace.workspaceId || '').trim();
    const baseRevision = String(workspace && workspace.baseRevision || '').trim();
    if (!workspaceId || !baseRevision) throw new Error('workspace_evidence_required');
    return controlDb.transaction(db => {
      const run = loadRun(db, runId);
      assertVersion(run, expectedVersion, 'run');
      if (!['queued', 'planning'].includes(run.status)) throw new Error(`workspace_not_assignable:${run.status}`);
      const update = db.prepare(`
        UPDATE runs SET workspace_id = ?, base_revision = ?, version = version + 1
        WHERE run_id = ? AND version = ?
      `).run(workspaceId, baseRevision, runId, expectedVersion);
      if (Number(update.changes) !== 1) throw new Error('run_version_conflict');
      emit(db, run, 'WORKSPACE_ASSIGNED', {
        workspace_id: workspaceId,
        base_revision: baseRevision,
        strategy: workspace.strategy || 'directory',
      }, now().toISOString());
      return loadRun(db, runId);
    });
  }

  function recoverInterruptedExecutions(currentBootId) {
    const bootId = String(currentBootId || '').trim();
    if (!bootId) throw new Error('recovery_boot_id_required');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const stale = db.prepare(`
        SELECT * FROM runs
        WHERE status IN ('executing','verifying','retry_wait')
          AND execution_boot_id IS NOT NULL AND execution_boot_id <> ?
      `).all(bootId);
      for (const run of stale) {
        db.prepare(`
          UPDATE run_attempts SET status = 'interrupted', error_class = 'daemon_restart', finished_at = ?
          WHERE run_id = ? AND status IN ('running','candidate_complete','verifying')
        `).run(nowIso, run.run_id);
        const update = db.prepare(`
          UPDATE runs SET status = 'retry_wait', execution_boot_id = NULL, execution_pid = NULL,
            execution_heartbeat_at = NULL, version = version + 1
          WHERE run_id = ? AND version = ?
        `).run(run.run_id, run.version);
        if (Number(update.changes) !== 1) throw new Error(`recovery_version_conflict:${run.run_id}`);
        emit(db, run, 'EXECUTION_INTERRUPTED', { reason: 'daemon_restart' }, nowIso);
      }
      return stale.map(run => run.run_id);
    });
  }

  function listActiveWorkspaceIds() {
    return controlDb.run(db => db.prepare(`
      SELECT workspace_id FROM runs
      WHERE workspace_id IS NOT NULL AND status IN (
        'queued','planning','awaiting_approval','executing','verifying','awaiting_review','retry_wait'
      )
    `).all().map(row => row.workspace_id));
  }

  function stopExecution(runId, nextStatus, command = {}) {
    if (!['failed', 'blocked', 'cancelled'].includes(nextStatus)) {
      throw new Error('execution_stop_status_invalid');
    }
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const run = loadRun(db, runId);
      assertVersion(run, command.expectedVersion, 'run');
      const owner = assertOwner(run, command.owner);
      assertRunTransition(run.status, nextStatus);
      db.prepare(`
        UPDATE run_attempts
        SET status = 'interrupted', error_class = ?, finished_at = ?
        WHERE run_id = ? AND attempt_no = ? AND status IN ('running','candidate_complete','verifying')
      `).run(`run_${nextStatus}`, nowIso, runId, run.attempt_no);
      const update = db.prepare(`
        UPDATE runs SET status = ?, last_error = ?, finished_at = ?, version = version + 1
        WHERE run_id = ? AND version = ? AND execution_boot_id = ? AND execution_pid = ?
      `).run(
        nextStatus, String(command.lastError || ''), nowIso,
        runId, command.expectedVersion, owner.bootId, owner.pid
      );
      if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
      emit(db, run, 'RUN_STATUS_CHANGED', { from: run.status, to: nextStatus }, nowIso);
      appendOutbox(db, command.outbox ? {
        ...command.outbox,
        goalId: run.goal_id,
        runId,
      } : null, nowIso);
      return loadRun(db, runId);
    });
  }

  function startAttempt(runId, spec, command = {}) {
    const engine = String(spec && spec.engine || '').trim();
    if (!engine) throw new Error('attempt_engine_required');
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const run = loadRunContext(db, runId);
      assertVersion(run, command.expectedVersion, 'run');
      const owner = assertOwner(run, command.owner);
      if (run.status !== 'executing') throw new Error(`run_not_executing:${run.status}`);
      const anchor = resolveEvidenceAnchor(run);
      const attemptNo = Number(run.attempt_no) + 1;
      const attemptId = newId('attempt');
      db.prepare(`
        INSERT INTO run_attempts (
          attempt_id, run_id, attempt_no, status, runtime_engine, runtime_session_id,
          input_summary, verification_spec_hash, workspace_revision, started_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)
      `).run(
        attemptId, runId, attemptNo, engine, spec.sessionId || null,
        encode(spec.inputSummary), anchor.verificationSpecHash,
        anchor.workspaceRevision, nowIso
      );
      const update = db.prepare(`
        UPDATE runs SET attempt_no = ?, version = version + 1
        WHERE run_id = ? AND version = ? AND execution_boot_id = ? AND execution_pid = ?
      `).run(attemptNo, runId, command.expectedVersion, owner.bootId, owner.pid);
      if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
      emit(db, run, 'ATTEMPT_STARTED', { attempt_id: attemptId, attempt_no: attemptNo, engine }, nowIso);
      return db.prepare('SELECT * FROM run_attempts WHERE attempt_id = ?').get(attemptId);
    });
  }

  function markCandidateComplete(attemptId, makerResult, ownerInput) {
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const attempt = db.prepare('SELECT * FROM run_attempts WHERE attempt_id = ?').get(attemptId);
      if (!attempt) throw new Error('attempt_not_found');
      if (attempt.status !== 'running') throw new Error(`attempt_not_running:${attempt.status}`);
      const run = loadRun(db, attempt.run_id);
      const owner = assertOwner(run, ownerInput);
      if (run.status !== 'executing') throw new Error(`run_not_executing:${run.status}`);
      if (attempt.attempt_no !== run.attempt_no) throw new Error('attempt_not_current');
      const update = db.prepare(`
        UPDATE run_attempts SET status = 'candidate_complete', maker_result = ?
        WHERE attempt_id = ? AND EXISTS (
          SELECT 1 FROM runs WHERE run_id = ? AND status = 'executing'
            AND execution_boot_id = ? AND execution_pid = ?
        )
      `).run(encode(makerResult), attemptId, run.run_id, owner.bootId, owner.pid);
      if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
      emit(db, run, 'CANDIDATE_COMPLETE', { attempt_id: attemptId }, nowIso);
      return { ...attempt, status: 'candidate_complete', maker_result: makerResult };
    });
  }

  function beginVerification(runId, attemptId, command = {}) {
    const nowIso = now().toISOString();
    return controlDb.transaction(db => {
      const run = loadRun(db, runId);
      assertVersion(run, command.expectedVersion, 'run');
      const owner = assertOwner(run, command.owner);
      assertRunTransition(run.status, 'verifying');
      const attempt = db.prepare('SELECT * FROM run_attempts WHERE attempt_id = ? AND run_id = ?').get(attemptId, runId);
      if (!attempt || attempt.attempt_no !== run.attempt_no) throw new Error('attempt_not_current');
      if (attempt.status !== 'candidate_complete') throw new Error(`attempt_not_candidate:${attempt.status}`);
      db.prepare("UPDATE run_attempts SET status = 'verifying' WHERE attempt_id = ?").run(attemptId);
      const update = db.prepare(`
        UPDATE runs SET status = 'verifying', version = version + 1
        WHERE run_id = ? AND version = ? AND execution_boot_id = ? AND execution_pid = ?
      `).run(runId, command.expectedVersion, owner.bootId, owner.pid);
      if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
      emit(db, run, 'VERIFICATION_STARTED', { attempt_id: attemptId }, nowIso);
      return loadRun(db, runId);
    });
  }

  function completeVerification(runId, attemptId, verdict, command = {}) {
    const nowIso = now().toISOString();
    const passed = verdict && verdict.passed === true;
    const nextStatus = passed ? 'succeeded' : (verdict && verdict.verifier_modified ? 'blocked' : 'retry_wait');
    return controlDb.transaction(db => {
      const run = loadRun(db, runId);
      assertVersion(run, command.expectedVersion, 'run');
      const owner = assertOwner(run, command.owner);
      assertRunTransition(run.status, nextStatus);
      const attempt = db.prepare('SELECT * FROM run_attempts WHERE attempt_id = ? AND run_id = ?').get(attemptId, runId);
      if (!attempt || attempt.attempt_no !== run.attempt_no) throw new Error('attempt_not_current');
      if (attempt.status !== 'verifying') throw new Error(`attempt_not_verifying:${attempt.status}`);
      validateVerifierVerdict(verdict, attempt);
      db.prepare(`
        UPDATE run_attempts SET status = ?, verifier_result = ?, finished_at = ? WHERE attempt_id = ?
      `).run(passed ? 'succeeded' : 'failed', encode(verdict), nowIso, attemptId);
      const update = db.prepare(`
        UPDATE runs SET status = ?, result = ?, version = version + 1, finished_at = ?
        WHERE run_id = ? AND version = ? AND execution_boot_id = ? AND execution_pid = ?
      `).run(
        nextStatus, passed ? encode(verdict) : run.result,
        (passed || nextStatus === 'blocked') ? nowIso : null,
        runId, command.expectedVersion, owner.bootId, owner.pid
      );
      if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
      emit(db, run, passed ? 'VERIFIER_PASSED' : 'VERIFIER_FAILED', {
        attempt_id: attemptId,
        verification_spec_hash: attempt.verification_spec_hash,
        workspace_revision: attempt.workspace_revision,
        verdict,
      }, nowIso);
      emit(db, run, 'RUN_STATUS_CHANGED', { from: run.status, to: nextStatus }, nowIso);
      appendOutbox(db, command.outbox ? {
        ...command.outbox,
        goalId: run.goal_id,
        runId,
      } : null, nowIso);
      return { run: loadRun(db, runId), attempt_id: attemptId, passed };
    });
  }

  return {
    startExecution,
    heartbeatExecution,
    recordWorkspace,
    recoverInterruptedExecutions,
    listActiveWorkspaceIds,
    stopExecution,
    startAttempt,
    markCandidateComplete,
    beginVerification,
    completeVerification,
  };
}

module.exports = { createLoopExecutionStore };
