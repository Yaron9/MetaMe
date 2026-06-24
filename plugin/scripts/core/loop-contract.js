'use strict';

const GOAL_MODES = new Set(['once', 'recurring', 'continuous']);
const GOAL_STATUSES = new Set(['active', 'paused', 'completed', 'cancelled', 'archived']);
const TRIGGER_TYPES = new Set(['clock', 'interval', 'manual', 'event', 'recovery']);

function cleanText(value, maxLen) {
  return String(value || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, maxLen);
}

function cleanId(value, field) {
  const id = cleanText(value, 120);
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error(`${field}_invalid`);
  return id;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeGoal(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = cleanText(src.mode || 'once', 20).toLowerCase();
  const status = cleanText(src.status || 'active', 20).toLowerCase();
  if (!GOAL_MODES.has(mode)) throw new Error('goal_mode_invalid');
  if (!GOAL_STATUSES.has(status)) throw new Error('goal_status_invalid');

  const objective = cleanText(src.objective, 4000);
  if (!objective) throw new Error('goal_objective_required');
  return {
    goal_id: cleanId(src.goal_id, 'goal_id'),
    title: cleanText(src.title, 300) || objective.slice(0, 80),
    objective,
    mode,
    status,
    project_key: cleanText(src.project_key, 120) || null,
    cwd: cleanText(src.cwd, 1000) || null,
    execution_spec: plainObject(src.execution_spec),
    verification_spec: plainObject(src.verification_spec),
    policy_spec: plainObject(src.policy_spec),
  };
}

function normalizeWakeEvent(raw, nowIso) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const triggerType = cleanText(src.trigger_type || 'manual', 20).toLowerCase();
  if (!TRIGGER_TYPES.has(triggerType)) throw new Error('wake_trigger_type_invalid');
  return {
    wake_id: cleanId(src.wake_id, 'wake_id'),
    automation_id: src.automation_id ? cleanId(src.automation_id, 'automation_id') : null,
    goal_id: cleanId(src.goal_id, 'goal_id'),
    trigger_type: triggerType,
    scheduled_at: cleanText(src.scheduled_at, 64) || nowIso,
    observed_at: cleanText(src.observed_at, 64) || nowIso,
    payload: plainObject(src.payload),
    coalesce: src.coalesce !== false,
  };
}

function normalizeAutomation(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const triggerType = cleanText(src.trigger_type, 20).toLowerCase();
  if (!TRIGGER_TYPES.has(triggerType)) throw new Error('automation_trigger_type_invalid');
  return {
    automation_id: cleanId(src.automation_id, 'automation_id'),
    goal_id: cleanId(src.goal_id, 'goal_id'),
    trigger_type: triggerType,
    trigger_spec: plainObject(src.trigger_spec),
    enabled: src.enabled !== false,
    next_fire_at: cleanText(src.next_fire_at, 64) || null,
    last_fire_at: cleanText(src.last_fire_at, 64) || null,
  };
}

module.exports = {
  GOAL_MODES,
  GOAL_STATUSES,
  TRIGGER_TYPES,
  normalizeGoal,
  normalizeWakeEvent,
  normalizeAutomation,
};
