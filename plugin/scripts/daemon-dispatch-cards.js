'use strict';

/**
 * daemon-dispatch-cards.js — Dispatch presentation layer
 *
 * Pure functions for resolving dispatch targets and building cards/receipts.
 * No daemon state; everything is derived from config passed as arguments.
 *
 * Counterpart to daemon-team-dispatch.js (context enrichment / actor resolution).
 * Used by: daemon.js, daemon-command-router.js
 */

const { resolveDispatchActor } = require('./daemon-team-dispatch');

// ─────────────────────────────────────────────────────────────────────────────
// Target resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a project key (or team member key) to a rich target descriptor.
 * Returns null when the key is unknown.
 */
function resolveDispatchTarget(targetKey, config) {
  const rawKey = String(targetKey || '').trim();
  const projects = (config && config.projects) || {};
  if (!rawKey) return null;

  if (projects[rawKey]) {
    const proj = projects[rawKey];
    return {
      key: rawKey,
      name: proj.name || rawKey,
      icon: proj.icon || '🤖',
      color: proj.color || 'blue',
      parentKey: rawKey,
      parentProject: proj,
      member: null,
      isTeamMember: false,
    };
  }

  for (const [parentKey, parent] of Object.entries(projects)) {
    if (!Array.isArray(parent && parent.team)) continue;
    const member = parent.team.find(m => m && m.key === rawKey);
    if (!member) continue;
    return {
      key: rawKey,
      name: member.name || rawKey,
      icon: member.icon || parent.icon || '🤖',
      color: member.color || parent.color || 'blue',
      parentKey,
      parentProject: parent,
      member,
      isTeamMember: true,
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TeamTask resume hint
// ─────────────────────────────────────────────────────────────────────────────

function buildTeamTaskResumeHint(taskId, scopeId) {
  const safeTaskId = String(taskId || '').trim();
  if (!safeTaskId) return '';
  const safeScopeId = String(scopeId || '').trim();
  const lines = [
    '',
    `TeamTask: ${safeTaskId}`,
  ];
  if (safeScopeId && safeScopeId !== safeTaskId) lines.push(`Scope: ${safeScopeId}`);
  lines.push(`如需复工，请使用: /TeamTask resume ${safeTaskId}`);
  return lines.join('\n');
}

function appendTeamTaskResumeHint(text, taskId, scopeId) {
  const base = String(text || '').trim();
  const hint = buildTeamTaskResumeHint(taskId, scopeId);
  if (!hint) return base;
  return `${base}${hint}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Card builders
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal card header for streaming response windows. */
function buildDispatchResponseCard(targetKey, config) {
  const target = resolveDispatchTarget(targetKey, config);
  if (!target) return null;
  return {
    title: `${target.icon} ${target.name}`,
    color: target.color || 'blue',
  };
}

/** Full task card shown in the source's channel when a dispatch is sent. */
function buildDispatchTaskCard(fullMsg, targetProject, config) {
  const projects = (config && config.projects) || {};
  const actor = resolveDispatchActor(
    (fullMsg && fullMsg.source_sender_key) || (fullMsg && fullMsg.from),
    projects
  );
  const target = resolveDispatchTarget(targetProject, config) || {
    icon: '🤖',
    name: targetProject,
    color: 'blue',
  };
  const prompt = String(fullMsg && fullMsg.payload && (fullMsg.payload.prompt || fullMsg.payload.title) || '').trim();
  const preview = prompt ? `${prompt.slice(0, 300)}${prompt.length > 300 ? '…' : ''}` : '(empty)';
  const lines = [
    `发起: ${actor.icon} ${actor.name}`,
    `目标: ${target.icon} ${target.name}`,
    `编号: ${fullMsg.id}`,
  ];
  if (fullMsg.task_id) lines.push(`TeamTask: ${fullMsg.task_id}`);
  if (fullMsg.scope_id && fullMsg.scope_id !== fullMsg.task_id) lines.push(`Scope: ${fullMsg.scope_id}`);
  lines.push('', preview);
  return {
    title: '📬 新任务',
    body: lines.join('\n'),
    color: target.color || 'blue',
    markdown: `## 📬 新任务\n\n${lines.join('\n')}\n\n---\n${preview}`,
    text: `📬 新任务\n\n${lines.join('\n')}\n\n${preview}`,
  };
}

/** Receipt card sent back to the dispatcher after the target agent accepts or rejects. */
function buildDispatchReceipt(item, config, result, opts = {}) {
  const targetKey = String(opts.targetKey || item.target || '').trim() || 'unknown';
  const target = resolveDispatchTarget(targetKey, config) || {
    icon: '🤖',
    name: targetKey,
  };
  const actor = resolveDispatchActor(
    String(item && (item.source_sender_key || item.from) || 'user').trim() || 'user',
    (config && config.projects) || {}
  );
  const prompt = String(item && item.prompt || '').trim();
  const preview = prompt ? `${prompt.slice(0, 120)}${prompt.length > 120 ? '...' : ''}` : '(empty)';
  const isFailed = !result || !result.success;
  const title = isFailed ? '❌ Dispatch 回执' : '📮 Dispatch 回执';
  const statusLine = isFailed
    ? `状态: 入队失败 (${String(result && result.error || 'unknown_error').slice(0, 120)})`
    : '状态: 目标端已接收并入队';
  const lines = [
    title,
    '',
    statusLine,
    `发起: ${actor.icon} ${actor.name}`,
    `目标: ${target.icon} ${target.name}`,
  ];
  if (result && result.id) lines.push(`编号: ${result.id}`);
  lines.push(`摘要: ${preview}`);
  if (result && result.task_id) lines.push(buildTeamTaskResumeHint(result.task_id, result.scope_id));
  return {
    status: isFailed ? 'failed' : 'accepted',
    dispatchId: result && result.id ? result.id : '',
    targetKey,
    text: lines.join('\n'),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot delivery helper
// ─────────────────────────────────────────────────────────────────────────────

/** Send a dispatch card via whichever method the bot supports. */
async function sendDispatchTaskCard(bot, chatId, card) {
  if (!bot || !chatId || !card) return null;
  if (bot.sendCard) return bot.sendCard(chatId, { title: card.title, body: card.body, color: card.color || 'blue' });
  if (bot.sendMarkdown) return bot.sendMarkdown(chatId, card.markdown);
  return bot.sendMessage(chatId, card.text);
}

module.exports = {
  resolveDispatchTarget,
  buildTeamTaskResumeHint,
  appendTeamTaskResumeHint,
  buildDispatchResponseCard,
  buildDispatchTaskCard,
  buildDispatchReceipt,
  sendDispatchTaskCard,
};
