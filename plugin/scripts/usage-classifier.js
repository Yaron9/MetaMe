'use strict';

const path = require('path');

const DEFAULT_USAGE_CATEGORY = 'unknown';
const USAGE_RETENTION_DAYS_DEFAULT = 30;

const USAGE_CATEGORY_ORDER = Object.freeze([
  'memory',
  'cognition',
  'skill_evolution',
  'heartbeat',
  'team_task',
  'chat',
  'chat_project',
  'manual_task',
  'unknown',
]);

const CORE_USAGE_CATEGORIES = Object.freeze([
  'memory',
  'cognition',
  'skill_evolution',
  'heartbeat',
  'team_task',
]);

const USAGE_CATEGORY_LABEL = Object.freeze({
  memory: '记忆',
  cognition: '认知',
  skill_evolution: '技能演化',
  heartbeat: '心跳任务',
  team_task: '团队任务',
  chat: '对话',
  chat_project: '项目对话',
  manual_task: '手动任务',
  unknown: '未分类',
});

const USAGE_CATEGORY_ALIASES = Object.freeze({
  memory: 'memory',
  recall: 'memory',
  facts: 'memory',
  cognition: 'cognition',
  distill: 'cognition',
  reflection: 'cognition',
  skill_evolution: 'skill_evolution',
  skillevolution: 'skill_evolution',
  'skill-evolution': 'skill_evolution',
  skill: 'skill_evolution',
  heartbeat: 'heartbeat',
  scheduled_task: 'heartbeat',
  team_task: 'team_task',
  teamtask: 'team_task',
  team: 'team_task',
  chat: 'chat',
  conversation: 'chat',
  chat_project: 'chat_project',
  project_chat: 'chat_project',
  scoped_chat: 'chat_project',
  manual_task: 'manual_task',
  manual: 'manual_task',
  unknown: 'unknown',
});

const warnedUnknownCategories = new Set();

function normalizeUsageCategory(rawCategory, opts = {}) {
  const key = String(rawCategory || '').trim().toLowerCase();
  if (!key) return DEFAULT_USAGE_CATEGORY;
  const normalized = USAGE_CATEGORY_ALIASES[key];
  if (normalized) return normalized;

  if (typeof opts.logger === 'function' && !warnedUnknownCategories.has(key)) {
    warnedUnknownCategories.add(key);
    opts.logger(`Unknown usage category "${key}", fallback to "${DEFAULT_USAGE_CATEGORY}"`);
  }
  return DEFAULT_USAGE_CATEGORY;
}

function classifyTaskUsage(task, context = {}, opts = {}) {
  const fallbackCategory = normalizeUsageCategory(opts.fallbackCategory || 'heartbeat');
  const kind = String(task && task.task_kind ? task.task_kind : '').toLowerCase();
  if (kind === 'team') return 'team_task';

  const joined = [
    task && task.name,
    task && task.type,
    task && task.prompt,
    task && task._project && task._project.key,
    context && context.skill,
    context && context.prompt,
  ].filter(Boolean).join(' ').toLowerCase();

  if (!joined) return fallbackCategory;
  if (/\bteam[-_\s]?task\b|团队|协作|handoff|dispatch/.test(joined)) return 'team_task';
  if (/\bskill[-_\s]?(?:evo|evolution|manager|scout)\b|技能演化/.test(joined)) return 'skill_evolution';
  if (/\bmemory(?:-extract)?\b|记忆|facts?|recall|retriev|rag/.test(joined)) return 'memory';
  if (/\bdistill\b|\bcognition\b|认知|反思|洞察/.test(joined)) return 'cognition';
  if (/\bheartbeat\b|提醒|定时|cron|every\s+\d/.test(joined)) return 'heartbeat';
  return fallbackCategory;
}

function projectKeyFromCwd(cwd, homeDir = '') {
  const raw = String(cwd || '').trim();
  if (!raw) return '';
  try {
    const abs = path.resolve(raw);
    const homeAbs = String(homeDir || '').trim() ? path.resolve(homeDir) : '';
    if (homeAbs && abs === homeAbs) return '';
    const base = path.basename(abs);
    return base && base !== '.' && base !== path.sep ? base : '';
  } catch {
    return '';
  }
}

function classifyChatUsage(chatId, opts = {}) {
  const cid = String(chatId || '');
  if (cid.startsWith('_scope_') || cid.startsWith('_agent_')) return 'team_task';

  const projectScope = String(opts.projectScope || '').trim();
  const projectKey = String(opts.projectKey || '').trim();
  const derivedKey = projectKeyFromCwd(opts.cwd, opts.homeDir);
  if (projectScope || projectKey || derivedKey) return 'chat_project';
  return 'chat';
}

module.exports = {
  DEFAULT_USAGE_CATEGORY,
  USAGE_RETENTION_DAYS_DEFAULT,
  USAGE_CATEGORY_ORDER,
  CORE_USAGE_CATEGORIES,
  USAGE_CATEGORY_LABEL,
  normalizeUsageCategory,
  classifyTaskUsage,
  classifyChatUsage,
};

