'use strict';

const crypto = require('crypto');
const { _internal: triggerInternal } = require('./daemon-loop-triggers');

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24)}`;
}

function rawTaskSchedule(task) {
  if (task.at) return { mode: 'clock', at: task.at, days: task.days || task.weekdays || null };
  return { mode: 'interval', interval: task.interval || '1h' };
}

function planLegacyMigration(config = {}, options = {}) {
  const goals = [];
  const automations = [];
  const conflicts = [];
  const unmapped = [];
  const legacyFiles = [];
  const seen = new Set();

  const addTask = task => {
    const rawSchedule = rawTaskSchedule(task);
    const compiled = triggerInternal.compileLegacyTask(task, {
      mode: rawSchedule.mode,
      intervalSec: rawSchedule.mode === 'interval' ? 3600 : undefined,
      hour: rawSchedule.mode === 'clock' ? Number(String(rawSchedule.at).split(':')[0]) : undefined,
      minute: rawSchedule.mode === 'clock' ? Number(String(rawSchedule.at).split(':')[1]) : undefined,
      days: null,
    });
    compiled.automation.trigger_spec = rawSchedule;
    if (seen.has(compiled.goal.goal_id)) {
      conflicts.push({ type: 'duplicate_goal', goal_id: compiled.goal.goal_id, task: task.name });
      return;
    }
    seen.add(compiled.goal.goal_id);
    goals.push(compiled.goal);
    automations.push(compiled.automation);
  };
  for (const task of config.heartbeat && config.heartbeat.tasks || []) addTask(task);
  for (const [projectKey, project] of Object.entries(config.projects || {})) {
    for (const task of project.heartbeat_tasks || []) {
      addTask({ ...task, _project: { key: projectKey } });
    }
    if (!project.reactive) continue;
    const cwd = String(project.cwd || '');
    const perpetual = typeof options.readPerpetual === 'function'
      ? (options.readPerpetual(cwd, projectKey) || {})
      : {};
    if (perpetual._path) legacyFiles.push(perpetual._path);
    const goalId = stableId('legacy_reactive', projectKey);
    const verification = perpetual.verifier
      ? { command: `node ${perpetual.verifier}`, protected_paths: [perpetual.verifier] }
      : {};
    if (!perpetual.verifier) unmapped.push({ project: projectKey, field: 'verifier', reason: 'manual_review' });
    goals.push({
      goal_id: goalId,
      title: project.name || projectKey,
      objective: project.objective || `Continue legacy reactive project ${projectKey}`,
      mode: 'continuous',
      project_key: projectKey,
      cwd,
      execution_spec: {
        adapter: 'legacy_reactive_signal',
        engine: project.engine || 'claude',
        completion_signal: perpetual.completion_signal || 'MISSION_COMPLETE',
      },
      verification_spec: verification,
      policy_spec: {
        max_turns_per_run: Number(perpetual.max_depth) || 50,
        no_signal_max_retries: Number(perpetual.no_signal_max_retries) || 3,
      },
    });
  }
  return { dry_run: true, goals, automations, conflicts, unmapped, legacy_files: legacyFiles };
}

function applyLegacyMigration(plan, loopStore) {
  if (!plan || plan.dry_run !== true) throw new Error('migration_plan_required');
  if (!loopStore) throw new Error('loop_store_required');
  if (Array.isArray(plan.conflicts) && plan.conflicts.length > 0) {
    throw new Error('migration_conflicts_require_resolution');
  }
  const result = { goals_created: 0, goals_existing: 0, automations_upserted: 0 };
  for (const goal of plan.goals || []) {
    if (loopStore.getGoal(goal.goal_id)) result.goals_existing += 1;
    else {
      loopStore.createGoal(goal);
      result.goals_created += 1;
    }
  }
  for (const automation of plan.automations || []) {
    loopStore.upsertAutomation(automation);
    result.automations_upserted += 1;
  }
  return result;
}

module.exports = { planLegacyMigration, applyLegacyMigration, _internal: { rawTaskSchedule, stableId } };
