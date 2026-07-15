'use strict';

/**
 * team-dispatch.js — Shared team/dispatch utilities
 *
 * Single source of truth for:
 *   - Project/team member resolution by name or nickname
 *   - Team roster hint generation (injected into member sessions)
 *   - Prompt enrichment with transient inbox messages
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

// ─────────────────────────────────────────────────────────────────────────────
// Prompt enrichment (shared context injection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enrich a dispatch prompt with transient inbox messages read at send time.
 * Task context comes from the structured Task envelope, never Markdown mirrors.
 *
 * This is a push-model pull: caller enriches just before sending.
 *
 * @param {string} target    - project/member key of the recipient
 * @param {string} rawPrompt - original prompt
 * @param {string} [metameDir] - override METAME_DIR (for testing)
 * @returns {string}
 */
function buildEnrichedPrompt(target, rawPrompt, metameDir) {
  const base = metameDir || METAME_DIR;
  let ctx = '';

  // Inbox is transport, not knowledge: consume and delete after injection.
  try {
    const inboxDir = path.join(base, 'memory', 'inbox', target);
    if (fs.existsSync(inboxDir)) {
      const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.md')).sort();
      if (files.length > 0) {
        ctx += `[📬 Agent Inbox — ${files.length} 条未读消息]\n`;
        for (const f of files) {
          const fp = path.join(inboxDir, f);
          ctx += fs.readFileSync(fp, 'utf8').trim() + '\n---\n';
          fs.unlinkSync(fp);
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
};
