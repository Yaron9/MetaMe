'use strict';

/**
 * team-dispatch.js — Shared team/dispatch utilities
 *
 * Single source of truth for:
 *   - Project/team member resolution by name or nickname
 *   - Team roster hint generation (injected into member sessions)
 *   - Prompt enrichment with scoped context (private now / shared now / inbox / _latest.md)
 *   - Dispatch context file writes for target-only and team-shared tasks
 *
 * Used by: dispatch_to binary, daemon-admin-commands, daemon-bridges, daemon.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const METAME_DIR = path.join(os.homedir(), '.metame');

function _escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─────────────────────────────────────────────────────────────────────────────
// Resolution helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a target name (key or nickname) to a project key.
 * For top-level projects: returns the project key.
 * For team members: returns 'parentKey/memberKey'.
 */
function resolveProjectKey(targetName, projects) {
  if (!targetName || !projects) return null;
  for (const [key, proj] of Object.entries(projects)) {
    const nicks = Array.isArray(proj.nicknames)
      ? proj.nicknames
      : (proj.nicknames ? [proj.nicknames] : []);
    if (key === targetName || nicks.some(n => n === targetName)) return key;

    if (Array.isArray(proj.team)) {
      for (const member of proj.team) {
        const memberNicks = Array.isArray(member.nicknames) ? member.nicknames : [];
        if (member.key === targetName || memberNicks.some(n => n === targetName)) {
          return `${key}/${member.key}`;
        }
      }
    }
  }
  return null;
}

/**
 * Find a team member by nickname prefix in a text string.
 * Returns { member, rest } where rest is the text after stripping the nickname,
 * or null if no match.
 */
function findTeamMember(text, team) {
  const t = String(text || '').trim();
  for (const member of team) {
    const nicks = Array.isArray(member.nicknames) ? member.nicknames : [];
    for (const nick of nicks) {
      const n = String(nick || '').trim();
      if (!n) continue;
      if (t.toLowerCase() === n.toLowerCase()) return { member, rest: '' };
      const re = new RegExp(`^${_escapeRe(n)}[\\s,，、:：]+`, 'i');
      const m = t.match(re);
      if (m) return { member, rest: t.slice(m[0].length).trim() };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Team roster hint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a team context block to inject into a team member's session.
 * Tells the member who they are, who their teammates are, and how to reach them.
 *
 * @param {string} parentKey   - project key of the parent (e.g. 'business')
 * @param {string} memberKey   - key of the member receiving the hint (e.g. 'hunter')
 * @param {object} projects    - full projects config
 * @returns {string}           - formatted hint block, or '' if not applicable
 */
function buildTeamRosterHint(parentKey, memberKey, projects) {
  if (!projects || !parentKey || !projects[parentKey]) return '';
  const parent = projects[parentKey];
  if (!Array.isArray(parent.team) || parent.team.length === 0) return '';
  const self = parent.team.find(m => m.key === memberKey);
  if (!self) return '';

  const dispatchBin = path.join(METAME_DIR, 'bin', 'dispatch_to');
  const teammates = parent.team.filter(m => m.key !== memberKey);

  const lines = teammates.map(m => {
    const target = m.peer ? `${m.peer}:${m.key}` : m.key;
    const location = m.peer ? ` [远端:${m.peer}]` : '';
    return `- ${m.key}（${m.name || m.key}${location}）: \`${dispatchBin} --from ${memberKey} ${target} "消息"\``;
  });
  // Parent project as escalation target
  lines.push(
    `- ${parentKey}（${parent.name || parentKey}, 向上汇报）: \`${dispatchBin} --from ${memberKey} ${parentKey} "消息"\``
  );

  return [
    `[你是团队的一员]`,
    `身份: ${self.key}（${self.name || self.key}）`,
    `所属项目: ${parentKey}（${parent.name || parentKey}）`,
    ``,
    `团队成员（通过 dispatch_to 联络）:`,
    ...lines,
  ].join('\n');
}

function resolveDispatchActor(sourceKey, projects) {
  const rawKey = String(sourceKey || '').trim();
  const userSources = new Set(['', 'unknown', 'claude_session', '_claude_session', 'user']);
  if (userSources.has(rawKey)) return { key: 'user', name: '用户', icon: '👤', isUser: true };
  const proj = projects && projects[rawKey];
  if (proj) return { key: rawKey, name: proj.name || rawKey, icon: proj.icon || '🤖', isUser: false };
  return { key: rawKey || 'unknown', name: rawKey || 'unknown', icon: '🤖', isUser: false };
}

function buildPrivateNowContent({ actor, target, title, prompt, timeStr, dispatchId, taskId, scopeId, chain }) {
  const lines = [
    '# 当前任务',
    `**最后更新**: ${timeStr} **更新者**: ${actor.icon} ${actor.name}`,
    '',
    '## 当前派发',
    `- **目标**: ${target.icon} ${target.name} (${target.key})`,
    `- **任务**: ${title || prompt.slice(0, 120) || '(empty)'}`,
    dispatchId ? `- **编号**: ${dispatchId}` : '',
    taskId ? `- **TeamTask**: ${taskId}` : '',
    scopeId && scopeId !== taskId ? `- **Scope**: ${scopeId}` : '',
    '',
    '## 任务链',
    chain && chain.length > 0 ? chain.join(' → ') : `${actor.key} → ${target.key}`,
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

function buildSharedNowContent({ actor, target, title, prompt, timeStr, dispatchId, taskId, scopeId, chain }) {
  const lines = [
    '# 共享当前状态',
    `**最后更新**: ${timeStr} **更新者**: ${actor.icon} ${actor.name}`,
    '',
    '## 当前任务',
    `- **派发给**: ${target.icon} ${target.name} (${target.key})`,
    `- **任务**: ${title || prompt.slice(0, 120) || '(empty)'}`,
    dispatchId ? `- **编号**: ${dispatchId}` : '',
    taskId ? `- **TeamTask**: ${taskId}` : '',
    scopeId && scopeId !== taskId ? `- **Scope**: ${scopeId}` : '',
    `- **时间**: ${timeStr}`,
    '',
    '## 任务链',
    chain && chain.length > 0 ? chain.join(' → ') : `${actor.key} → ${target.key}`,
  ].filter(Boolean);
  return `${lines.join('\n')}\n`;
}

function updateDispatchContextFiles({ fs: fsMod = fs, path: pathMod = path, baseDir = METAME_DIR, fullMsg, targetProject, config, envelope, logger = null }) {
  if (!fullMsg || !targetProject) return { targetNowPath: null, sharedNowPath: null, tasksFilePath: null };

  const logWarn = (msg) => {
    if (typeof logger === 'function') logger(msg);
  };
  const nowDir = pathMod.join(baseDir, 'memory', 'now');
  const sharedDir = pathMod.join(baseDir, 'memory', 'shared');
  const targetNowPath = pathMod.join(nowDir, `${targetProject}.md`);
  const sharedNowPath = pathMod.join(nowDir, 'shared.md');
  const tasksFilePath = pathMod.join(sharedDir, 'tasks.md');
  fsMod.mkdirSync(nowDir, { recursive: true });

  const projects = (config && config.projects) || {};
  const actor = resolveDispatchActor((fullMsg && fullMsg.source_sender_key) || (fullMsg && fullMsg.from), projects);
  const targetProj = projects[targetProject] || {};
  const target = { key: targetProject, name: targetProj.name || targetProject, icon: targetProj.icon || '🤖' };
  const prompt = String(fullMsg && fullMsg.payload && fullMsg.payload.prompt || '').trim();
  const title = String(fullMsg && fullMsg.payload && fullMsg.payload.title || '').trim();
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const dateStr = now.toISOString().slice(0, 10);
  const taskId = String(envelope && envelope.task_id || '').trim();
  const scopeId = String(envelope && envelope.scope_id || '').trim();
  const isSharedTeamTask = !!(envelope && envelope.task_kind === 'team');

  fsMod.writeFileSync(targetNowPath, buildPrivateNowContent({
    actor, target, title, prompt, timeStr,
    dispatchId: fullMsg.id, taskId, scopeId, chain: fullMsg.chain,
  }), 'utf8');

  if (!isSharedTeamTask) return { targetNowPath, sharedNowPath: null, tasksFilePath: null };

  fsMod.writeFileSync(sharedNowPath, buildSharedNowContent({
    actor, target, title, prompt, timeStr,
    dispatchId: fullMsg.id, taskId, scopeId, chain: fullMsg.chain,
  }), 'utf8');

  try {
    if (!fsMod.existsSync(sharedDir)) fsMod.mkdirSync(sharedDir, { recursive: true });
    const taskLine = `- [${dateStr}] ${actor.icon} ${actor.name} → ${target.icon} ${target.name}: ${title || prompt.slice(0, 40)}`;
    let tasksContent = fsMod.existsSync(tasksFilePath)
      ? fsMod.readFileSync(tasksFilePath, 'utf8')
      : '# 任务看板\n\n## 🔄 进行中\n\n## ✅ 已完成\n\n## 📅 待开始\n';
    if (!tasksContent.includes(taskLine)) {
      const lines = tasksContent.split('\n');
      const nextLines = [];
      let inserted = false;
      let inProgress = false;
      for (const line of lines) {
        nextLines.push(line);
        if (line.includes('## 🔄 进行中')) {
          inProgress = true;
          continue;
        }
        if (inProgress && line.startsWith('## ')) {
          nextLines.splice(nextLines.length - 1, 0, taskLine);
          inserted = true;
          inProgress = false;
        }
      }
      if (!inserted) nextLines.push(taskLine);
      tasksContent = nextLines.join('\n');
      fsMod.writeFileSync(tasksFilePath, tasksContent, 'utf8');
    }
  } catch (e) {
    logWarn(`Failed to update shared task board: ${e.message}`);
  }

  return { targetNowPath, sharedNowPath, tasksFilePath };
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt enrichment (shared context injection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich a dispatch prompt with shared context read at send time:
 *   1. now/<target>.md — target private progress handoff
 *   2. now/shared.md   — global team progress whiteboard (only when includeShared=true)
 *   2. agents/<target>_latest.md — target's last output
 *   3. inbox/<target>/ — unread messages (archived to read/ after reading)
 *
 * This is a push-model pull: caller enriches just before sending.
 *
 * @param {string} target    - project/member key of the recipient
 * @param {string} rawPrompt - original prompt
 * @param {string} [metameDir] - override METAME_DIR (for testing)
 * @returns {string}
 */
function buildEnrichedPrompt(target, rawPrompt, metameDir, opts = {}) {
  const base = metameDir || METAME_DIR;
  const includeShared = !!(opts && opts.includeShared);
  let ctx = '';

  // 1. Target private now file
  try {
    const targetNowFile = path.join(base, 'memory', 'now', `${target}.md`);
    if (fs.existsSync(targetNowFile)) {
      const content = fs.readFileSync(targetNowFile, 'utf8').trim();
      if (content) ctx += `[当前进度 now/${target}.md]\n${content}\n\n`;
    }
  } catch { /* non-critical */ }

  // 2. Shared progress whiteboard for real team tasks only
  if (includeShared) {
    try {
      const nowFile = path.join(base, 'memory', 'now', 'shared.md');
      if (fs.existsSync(nowFile)) {
        const content = fs.readFileSync(nowFile, 'utf8').trim();
        if (content) ctx += `[共享进度 now/shared.md]\n${content}\n\n`;
      }
    } catch { /* non-critical */ }
  }

  // 3. Target's last output
  try {
    const latestFile = path.join(base, 'memory', 'agents', `${target}_latest.md`);
    if (fs.existsSync(latestFile)) {
      const content = fs.readFileSync(latestFile, 'utf8').trim();
      if (content) ctx += `[${target} 上次产出]\n${content}\n\n`;
    }
  } catch { /* non-critical */ }

  // 4. Inbox unread messages (archive after reading)
  try {
    const inboxDir = path.join(base, 'memory', 'inbox', target);
    const readDir = path.join(inboxDir, 'read');
    if (fs.existsSync(inboxDir)) {
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md')).sort();
      if (files.length > 0) {
        ctx += `[📬 Agent Inbox — ${files.length} 条未读消息]\n`;
        fs.mkdirSync(readDir, { recursive: true });
        for (const f of files) {
          const fp = path.join(inboxDir, f);
          ctx += fs.readFileSync(fp, 'utf8').trim() + '\n---\n';
          fs.renameSync(fp, path.join(readDir, f));
        }
        ctx += '\n';
      }
    }
  } catch { /* non-critical */ }

  return ctx ? `${ctx}---\n${rawPrompt}` : rawPrompt;
}

module.exports = {
  resolveProjectKey,
  findTeamMember,
  buildTeamRosterHint,
  buildEnrichedPrompt,
  resolveDispatchActor,
  updateDispatchContextFiles,
};
