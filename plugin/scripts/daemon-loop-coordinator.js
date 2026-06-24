'use strict';

const { evaluateRunPolicy } = require('./core/loop-policy');

function createLoopCoordinator(deps = {}) {
  const required = ['loopStore', 'executionStore', 'governanceStore', 'backgroundRunner', 'verifier', 'workspaceBroker'];
  for (const name of required) {
    if (!deps[name]) throw new TypeError(`createLoopCoordinator requires ${name}`);
  }
  const owner = {
    bootId: String(deps.bootId || '').trim(),
    pid: Number(deps.pid || process.pid),
  };
  const retryAt = new Map();
  const active = new Set();
  const controllers = new Map();
  if (!owner.bootId) throw new TypeError('createLoopCoordinator requires bootId');

  async function runOnce(runId, options = {}) {
    const goal = deps.loopStore.getGoal(deps.loopStore.getRun(runId).goal_id);
    let run = deps.loopStore.getRun(runId);
    if (run.status === 'queued') {
      run = deps.loopStore.transitionRun(runId, 'planning', { expectedVersion: run.version });
    }
    let workspace = null;
    if (!run.workspace_id) {
      workspace = deps.workspaceBroker.prepare({
        mode: goal.execution_spec.workspace || 'none',
        runId,
        cwd: goal.cwd || process.cwd(),
      });
      run = deps.executionStore.recordWorkspace(runId, workspace, run.version);
    } else {
      workspace = {
        cwd: run.workspace_id === 'none' ? (goal.cwd || process.cwd()) : run.workspace_id,
        workspaceId: run.workspace_id,
        baseRevision: run.base_revision,
      };
    }

    const workspaceMode = String(goal.execution_spec.workspace || 'none');
    const defaultReadOnly = !['worktree', 'auto'].includes(workspaceMode);
    const readOnly = goal.execution_spec.read_only === undefined
      ? defaultReadOnly
      : !!goal.execution_spec.read_only;
    const defaultPermissions = readOnly
      ? { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' }
      : { sandboxMode: 'workspace-write', approvalPolicy: 'never', permissionMode: 'workspace-write' };
    const permissions = goal.execution_spec.permissions || defaultPermissions;
    const needsFullAccessApproval = permissions.sandboxMode === 'danger-full-access';
    const approvalScope = String(
      goal.policy_spec.approval_scope || (needsFullAccessApproval ? 'runtime:full_access' : '')
    ).trim();
    if (run.status === 'planning' && approvalScope) {
      return {
        run: deps.loopStore.transitionRun(runId, 'awaiting_approval', {
          expectedVersion: run.version,
          outbox: {
            topic: 'loop.approval_required',
            dedupeKey: `${runId}:approval:${approvalScope}`,
            payload: { run_id: runId, action_scope: approvalScope },
          },
        }),
        awaitingApproval: true,
      };
    }
    run = deps.executionStore.startExecution(runId, {
      owner,
      expectedVersion: run.version,
      approvalScope: approvalScope || undefined,
    });
    const policyDecision = evaluateRunPolicy({
      run,
      policy: goal.policy_spec,
      usage: deps.governanceStore.getRunUsage(runId),
    });
    if (!policyDecision.allowed) {
      return {
        run: deps.executionStore.stopExecution(runId, 'blocked', {
          owner,
          expectedVersion: run.version,
          lastError: policyDecision.reason,
          outbox: {
            topic: 'loop.blocked',
            dedupeKey: `${runId}:policy:${policyDecision.reason}`,
            payload: { run_id: runId, status: 'blocked', reason: policyDecision.reason },
          },
        }),
      };
    }
    const engine = String(goal.execution_spec.engine || 'claude');
    const attempt = deps.executionStore.startAttempt(runId, {
      engine,
      inputSummary: { objective: goal.objective },
    }, { owner, expectedVersion: run.version });

    const maker = await deps.backgroundRunner.startTurn({
      engine,
      model: goal.execution_spec.model,
      prompt: goal.execution_spec.prompt || goal.objective,
      cwd: workspace.cwd,
      readOnly,
      permissions,
      timeoutMs: goal.policy_spec.attempt_timeout_ms,
      structured: true,
      signal: options.signal || null,
    });
    if (maker.usage) {
      deps.governanceStore.recordUsage({
        goalId: goal.goal_id,
        runId,
        attemptId: attempt.attempt_id,
        engine,
        inputTokens: maker.usage.input_tokens,
        outputTokens: maker.usage.output_tokens,
      });
    }
    run = deps.loopStore.getRun(runId);
    if (!maker.ok || maker.result.status !== 'candidate_complete') {
      const nextStatus = maker.ok && maker.result.status === 'blocked' ? 'blocked' : 'failed';
      return {
        run: deps.executionStore.stopExecution(runId, nextStatus, {
          owner,
          expectedVersion: run.version,
          lastError: maker.error || maker.result.summary,
          outbox: {
            topic: 'loop.failed',
            dedupeKey: `${runId}:${nextStatus}`,
            payload: { run_id: runId, status: nextStatus },
          },
        }),
        maker,
      };
    }

    deps.executionStore.markCandidateComplete(attempt.attempt_id, maker.result, owner);
    run = deps.executionStore.beginVerification(runId, attempt.attempt_id, {
      owner,
      expectedVersion: deps.loopStore.getRun(runId).version,
    });
    const verdict = await deps.verifier.verify({
      spec: goal.verification_spec,
      cwd: workspace.cwd,
      signal: options.signal || null,
      baseRevision: workspace.baseRevision,
    });
    const completed = deps.executionStore.completeVerification(runId, attempt.attempt_id, verdict, {
      owner,
      expectedVersion: run.version,
      outbox: verdict.passed ? {
        topic: 'loop.completed',
        dedupeKey: `${runId}:succeeded`,
        payload: { run_id: runId, status: 'succeeded' },
      } : {
        topic: 'loop.verification_failed',
        dedupeKey: `${runId}:attempt:${attempt.attempt_no}:verification_failed`,
        payload: { run_id: runId, attempt_no: attempt.attempt_no },
      },
    });
    return { ...completed, maker, verdict };
  }

  function start(options = {}) {
    const intervalMs = Math.max(1000, Number(options.intervalMs) || 5000);
    const log = typeof options.log === 'function' ? options.log : () => {};
    const timer = setInterval(() => {
      for (const run of deps.loopStore.listRunnableRuns()) {
        if (active.has(run.run_id) || Date.now() < (retryAt.get(run.run_id) || 0)) continue;
        const goal = deps.loopStore.getGoal(run.goal_id);
        if (goal.execution_spec.adapter === 'legacy_heartbeat') continue;
        active.add(run.run_id);
        const controller = new AbortController();
        controllers.set(run.run_id, controller);
        Promise.resolve(runOnce(run.run_id, { signal: controller.signal })).then(result => {
          active.delete(run.run_id);
          controllers.delete(run.run_id);
          if (result.run && result.run.status === 'retry_wait') {
            retryAt.set(run.run_id, Date.now() + Math.min(300000, 30000 * (2 ** result.run.attempt_no)));
          } else {
            retryAt.delete(run.run_id);
          }
        }).catch(err => {
          active.delete(run.run_id);
          controllers.delete(run.run_id);
          retryAt.set(run.run_id, Date.now() + 30000);
          log('ERROR', `Loop Run ${run.run_id} failed: ${err.message}`);
        });
      }
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return {
      timer,
      stop() {
        clearInterval(timer);
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
      },
    };
  }

  return { runOnce, start };
}

module.exports = { createLoopCoordinator };
