'use strict';

/**
 * Team Dispatch Intent Module
 *
 * Detects communication intent towards team members in the prompt.
 * Extracted from team-context.js — same logic, pure function interface.
 *
 * @param {string} prompt        - sanitized user prompt
 * @param {object} config        - daemon.yaml config
 * @param {string} projectKey    - METAME_PROJECT env value
 * @returns {string|null}        - hint string or null if no intent detected
 */

const path = require('path');
const os = require('os');

// ── Communication intent patterns ─────────────────────────────────────────────
// Three structural patterns:
//   A) verb → name:  告诉工匠 / 发给builder / 通知乙
//   B) name → verb:  工匠你来 / builder帮我 / 乙去做
//   C) prep + name:  和工匠讨论 / 跟builder说 / 与乙沟通

const BEFORE_NAME_ZH = ['告诉', '通知', '让', '叫', '派', '交给', '转给', '发给', '联系', '找', '请', '问', '发消息给'];
const BEFORE_NAME_EN = ['tell', 'ask', 'notify', 'send to', 'assign to', 'delegate to', 'message', 'ping', 'contact'];
const AFTER_NAME_ZH  = ['你来', '来做', '去做', '帮我', '帮忙', '负责', '处理', '跟进'];
const AFTER_NAME_EN  = ['help', 'do this', 'handle', 'take care', 'follow up'];
const PREP_ZH = ['和', '跟', '与'];
const DISC_EN = ['discuss with', 'talk to', 'chat with', 'coordinate with', 'sync with', 'work with'];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasCommIntent(text, nickname) {
  const t = text.toLowerCase();
  const n = escapeRe(nickname.toLowerCase());

  // A) verb → name (within 15 chars)
  for (const v of BEFORE_NAME_ZH) {
    if (new RegExp(`${v}.{0,15}${n}`, 'u').test(t)) return true;
  }
  for (const v of BEFORE_NAME_EN) {
    if (new RegExp(`${v}.{0,20}${n}`, 'i').test(t)) return true;
  }

  // B) name → verb (within 8 chars)
  for (const v of AFTER_NAME_ZH) {
    if (new RegExp(`${n}.{0,8}${v}`, 'u').test(t)) return true;
  }
  for (const v of AFTER_NAME_EN) {
    if (new RegExp(`${n}.{0,10}${v}`, 'i').test(t)) return true;
  }

  // C) prep + name (和工匠/跟builder — prep within 3 chars before name)
  for (const p of PREP_ZH) {
    if (new RegExp(`${p}.{0,3}${n}`, 'u').test(t)) return true;
  }
  for (const v of DISC_EN) {
    if (new RegExp(`${v}.{0,20}${n}`, 'i').test(t)) return true;
  }

  return false;
}

module.exports = function detectTeamDispatch(prompt, config, projectKey) {
  if (!config || !config.projects || !projectKey) return null;

  const dispatchBin = path.join(os.homedir(), '.metame', 'bin', 'dispatch_to');

  // Collect all reachable team members (siblings + parent)
  const allMembers = [];
  for (const [parentKey, parent] of Object.entries(config.projects)) {
    if (!Array.isArray(parent.team)) continue;
    for (const member of parent.team) {
      if (member.key === projectKey) continue; // skip self
      allMembers.push({ member, isParent: false });
    }
    // Allow dispatching to parent project itself (escalation)
    if (parent.team.some(m => m.key === projectKey)) {
      allMembers.push({
        member: { key: parentKey, name: parent.name, nicknames: parent.nicknames },
        isParent: true,
      });
    }
  }

  if (allMembers.length === 0) return null;

  // Match only members with communication intent in this prompt
  const hits = allMembers.filter(({ member }) => {
    const nicks = [member.key, member.name, ...(Array.isArray(member.nicknames) ? member.nicknames : [])].filter(Boolean);
    return nicks.some(n => hasCommIntent(prompt, n));
  });

  if (hits.length === 0) return null;

  const lines = hits.map(({ member, isParent }) => {
    const label = isParent
      ? `${member.key}（${member.name || member.key}, 向上汇报）`
      : `${member.key}（${member.name || member.key}）`;
    return `- ${label}: \`${dispatchBin} --from ${projectKey} ${member.key} "消息"\``;
  });

  return ['[团队联络提示]', '以下成员可通过 dispatch_to 联络:', ...lines].join('\n');
};
