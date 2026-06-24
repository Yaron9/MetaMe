'use strict';

const crypto = require('crypto');

function stableId(prefix, value) {
  const hash = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
  return `${prefix}_${hash}`;
}

function serializeSchedule(schedule) {
  if (!schedule || schedule.mode === 'interval') {
    return { interval_sec: Number(schedule && schedule.intervalSec) || 3600 };
  }
  return {
    at: `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`,
    days: schedule.days ? [...schedule.days].sort((a, b) => a - b) : null,
  };
}

function compileLegacyTask(task, schedule) {
  const projectKey = task && task._project && task._project.key || 'global';
  const identity = `${projectKey}:${String(task && task.name || '')}`;
  const triggerType = schedule && schedule.mode === 'clock' ? 'clock' : 'interval';
  return {
    goal: {
      goal_id: stableId('legacy_goal', identity),
      title: String(task.name || 'Legacy heartbeat task'),
      objective: String(task.prompt || task.command || task.name || 'Legacy heartbeat task'),
      mode: 'recurring',
      project_key: projectKey === 'global' ? null : projectKey,
      cwd: task.cwd || null,
      execution_spec: {
        adapter: 'legacy_heartbeat',
        task_name: task.name,
        task_type: task.type || 'prompt',
        engine: task.engine || 'claude',
      },
      policy_spec: { compatibility_mode: true },
    },
    automation: {
      automation_id: stableId('legacy_auto', identity),
      goal_id: stableId('legacy_goal', identity),
      trigger_type: triggerType,
      trigger_spec: serializeSchedule(schedule),
      enabled: task.enabled !== false,
    },
  };
}

function createLoopTriggerAdapter(opts = {}) {
  if (!opts.loopStore) throw new TypeError('createLoopTriggerAdapter requires loopStore');
  const loopStore = opts.loopStore;
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  function ensureLegacyTask(task, schedule) {
    const compiled = compileLegacyTask(task, schedule);
    if (!loopStore.getGoal(compiled.goal.goal_id)) loopStore.createGoal(compiled.goal);
    loopStore.upsertAutomation(compiled.automation);
    return compiled;
  }

  function beginScheduledTask(task, schedule, scheduledAt, nextFireAt = null) {
    const compiled = ensureLegacyTask(task, schedule);
    const scheduledIso = new Date(scheduledAt).toISOString();
    const wakeId = stableId('wake', `${compiled.automation.automation_id}:${scheduledIso}`);
    const wake = loopStore.enqueueWake({
      wake_id: wakeId,
      automation_id: compiled.automation.automation_id,
      goal_id: compiled.goal.goal_id,
      trigger_type: compiled.automation.trigger_type,
      scheduled_at: scheduledIso,
      observed_at: now().toISOString(),
      payload: { legacy_task: task.name },
      coalesce: false,
    });
    loopStore.markAutomationFired(
      compiled.automation.automation_id,
      scheduledIso,
      nextFireAt ? new Date(nextFireAt).toISOString() : null
    );
    return {
      ...wake,
      shouldExecute: !wake.duplicate && wake.disposition === 'created',
      goal_id: compiled.goal.goal_id,
    };
  }

  function completeScheduledTask(context, result) {
    if (!context || !context.run || !context.shouldExecute) return null;
    return loopStore.completeCompatibilityRun(context.run.run_id, {
        legacy_adapter: true,
        success: !!(result && result.success),
        error: result && result.error || null,
    });
  }

  function triggerManual(goalId, payload = {}, idempotencyKey = '') {
    const observedAt = now().toISOString();
    const key = idempotencyKey || crypto.randomUUID();
    return loopStore.enqueueWake({
      wake_id: stableId('wake', `manual:${goalId}:${key}`),
      goal_id: goalId,
      trigger_type: 'manual',
      scheduled_at: observedAt,
      observed_at: observedAt,
      payload,
    });
  }

  return { ensureLegacyTask, beginScheduledTask, completeScheduledTask, triggerManual };
}

module.exports = { createLoopTriggerAdapter, _internal: { stableId, serializeSchedule, compileLegacyTask } };
