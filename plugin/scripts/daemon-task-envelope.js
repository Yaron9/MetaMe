'use strict';

const ALLOWED_STATUS = new Set(['queued', 'running', 'blocked', 'done', 'failed']);
const ALLOWED_PRIORITY = new Set(['low', 'normal', 'high', 'urgent']);
const ALLOWED_TASK_KIND = new Set(['team', 'heartbeat']);

function sanitizeText(input, maxLen = 800) {
  return String(input || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, maxLen);
}

function sanitizeStringArray(values, maxItems = 20, maxItemLen = 300) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const item of values) {
    const v = sanitizeText(item, maxItemLen);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeInputs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const key = sanitizeText(k, 80);
    if (!key) continue;
    if (typeof v === 'string') out[key] = sanitizeText(v, 500);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
    else if (Array.isArray(v)) out[key] = sanitizeStringArray(v, 12, 240);
    else if (v && typeof v === 'object') out[key] = JSON.parse(JSON.stringify(v));
  }
  return out;
}

function normalizeDefinitionOfDone(raw) {
  if (Array.isArray(raw)) return sanitizeStringArray(raw, 12, 240);
  const text = sanitizeText(raw, 1200);
  if (!text) return [];
  return sanitizeStringArray(
    text.split(/\r?\n|;|；/g).map(s => s.trim()).filter(Boolean),
    12,
    240
  );
}

function newTaskId(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `t_${y}${m}${d}_${rand}`;
}

function newHandoffId() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `h_${Date.now()}_${rand}`;
}

function normalizeTaskEnvelope(raw, overrides = {}) {
  const nowIso = new Date().toISOString();
  const src = (raw && typeof raw === 'object') ? raw : {};
  const merged = { ...src, ...overrides };

  const taskId = sanitizeText(merged.task_id, 80) || newTaskId();
  const parentTaskId = sanitizeText(merged.parent_task_id, 80) || null;
  const fromAgent = sanitizeText(merged.from_agent, 80) || 'unknown';
  const toAgent = sanitizeText(merged.to_agent, 80);
  const goal = sanitizeText(merged.goal, 500);
  const definitionOfDone = normalizeDefinitionOfDone(merged.definition_of_done);
  const artifacts = sanitizeStringArray(merged.artifacts, 30, 500);
  const ownedPaths = sanitizeStringArray(merged.owned_paths, 30, 500);
  const statusRaw = sanitizeText(merged.status, 20).toLowerCase();
  const priorityRaw = sanitizeText(merged.priority, 20).toLowerCase();
  const kindRaw = sanitizeText(merged.task_kind, 20).toLowerCase();
  const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : 'queued';
  const priority = ALLOWED_PRIORITY.has(priorityRaw) ? priorityRaw : 'normal';
  const taskKind = ALLOWED_TASK_KIND.has(kindRaw) ? kindRaw : 'team';
  const createdAt = sanitizeText(merged.created_at, 64) || nowIso;
  const updatedAt = sanitizeText(merged.updated_at, 64) || nowIso;
  const inputs = normalizeInputs(merged.inputs);

  return {
    task_id: taskId,
    parent_task_id: parentTaskId,
    from_agent: fromAgent,
    to_agent: toAgent,
    goal,
    definition_of_done: definitionOfDone,
    inputs,
    artifacts,
    owned_paths: ownedPaths,
    task_kind: taskKind,
    priority,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function validateTaskEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, error: 'envelope_missing' };
  if (!sanitizeText(env.task_id, 80)) return { ok: false, error: 'task_id_required' };
  if (!sanitizeText(env.from_agent, 80)) return { ok: false, error: 'from_agent_required' };
  if (!sanitizeText(env.to_agent, 80)) return { ok: false, error: 'to_agent_required' };
  if (!sanitizeText(env.goal, 500)) return { ok: false, error: 'goal_required' };
  if (!ALLOWED_TASK_KIND.has(String(env.task_kind || '').toLowerCase())) return { ok: false, error: 'invalid_task_kind' };
  if (!ALLOWED_STATUS.has(String(env.status || '').toLowerCase())) return { ok: false, error: 'invalid_status' };
  if (!ALLOWED_PRIORITY.has(String(env.priority || '').toLowerCase())) return { ok: false, error: 'invalid_priority' };
  return { ok: true };
}

module.exports = {
  ALLOWED_STATUS,
  ALLOWED_PRIORITY,
  ALLOWED_TASK_KIND,
  newTaskId,
  newHandoffId,
  normalizeTaskEnvelope,
  validateTaskEnvelope,
};
