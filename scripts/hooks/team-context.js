#!/usr/bin/env node
/**
 * MetaMe Team Context Hook — UserPromptSubmit
 *
 * Detects communication intent towards team members in the prompt.
 * If found, injects targeted dispatch_to hint(s) for only those members.
 * Zero injection when no communication intent detected → zero wasted tokens.
 *
 * Triggers when the prompt contains:
 *   - A communication verb (告诉/让/发给/和...讨论/...) near a member nickname
 *   - Or a member nickname in a communication context
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const METAME_DIR = path.join(os.homedir(), '.metame');

// ── Communication intent patterns ────────────────────────────────────────────
// Three structural patterns:
//   A) verb → name:   告诉工匠 / 发给builder / 通知乙
//   B) name → verb:   工匠你来 / builder帮我 / 乙去做
//   C) prep + name:   和工匠讨论 / 跟builder说 / 与乙沟通 (name between prep and verb)

const BEFORE_NAME_ZH = ['告诉', '通知', '让', '叫', '派', '交给', '转给', '发给', '联系', '找', '请', '问', '发消息给'];
const BEFORE_NAME_EN = ['tell', 'ask', 'notify', 'send to', 'assign to', 'delegate to', 'message', 'ping', 'contact'];
const AFTER_NAME_ZH  = ['你来', '来做', '去做', '帮我', '帮忙', '负责', '处理', '跟进'];
const AFTER_NAME_EN  = ['help', 'do this', 'handle', 'take care', 'follow up'];
// Prepositions that introduce a discussion partner (name follows immediately)
const PREP_ZH = ['和', '跟', '与'];
const DISC_EN = ['discuss with', 'talk to', 'chat with', 'coordinate with', 'sync with', 'work with'];

function hasCommIntent(text, nickname) {
  const t = text.toLowerCase();
  const n = nickname.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

// ── Main ──────────────────────────────────────────────────────────────────────
function exit() { process.exit(0); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  try { run(JSON.parse(raw)); } catch { exit(); }
});

function run(data) {
  const projectKey = process.env.METAME_PROJECT;
  if (!projectKey || process.env.METAME_INTERNAL_PROMPT === '1') return exit();

  const prompt = (data.prompt || data.user_prompt || '').trim();
  if (!prompt) return exit();

  // Load config
  let config;
  try {
    const yaml = require('../resolve-yaml');
    config = yaml.load(fs.readFileSync(path.join(METAME_DIR, 'daemon.yaml'), 'utf8'));
  } catch { return exit(); }

  if (!config || !config.projects) return exit();

  // Collect all team members across all projects (caller may be top-level or member)
  const allMembers = [];
  for (const [parentKey, parent] of Object.entries(config.projects)) {
    if (!Array.isArray(parent.team)) continue;
    for (const member of parent.team) {
      if (member.key === projectKey) continue; // skip self
      allMembers.push({ member, parentKey, parent });
    }
    // Also allow dispatching to parent project itself (escalation)
    if (parent.team.some(m => m.key === projectKey)) {
      allMembers.push({
        member: { key: parentKey, name: parent.name, nicknames: parent.nicknames },
        parentKey,
        parent,
        isParent: true,
      });
    }
  }

  if (allMembers.length === 0) return exit();

  const dispatchBin = path.join(METAME_DIR, 'bin', 'dispatch_to');

  // Find members with communication intent in this prompt
  const hits = [];
  for (const { member, isParent } of allMembers) {
    const nicks = [member.key, member.name, ...(Array.isArray(member.nicknames) ? member.nicknames : [])].filter(Boolean);
    const matched = nicks.some(n => hasCommIntent(prompt, n));
    if (matched) hits.push({ member, isParent });
  }

  if (hits.length === 0) return exit();

  // Build targeted hint for matched members only
  const lines = hits.map(({ member, isParent }) => {
    const target = member.peer ? `${member.peer}:${member.key}` : member.key;
    const location = member.peer ? ` [远端:${member.peer}]` : '';
    const label = isParent ? `${member.key}（${member.name || member.key}, 向上汇报）` : `${member.key}（${member.name || member.key}${location}）`;
    return `- ${label}: \`${dispatchBin} --from ${projectKey} ${target} "消息"\``;
  });

  const hint = [
    `[团队联络提示]`,
    `以下成员可通过 dispatch_to 联络:`,
    ...lines,
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { additionalSystemPrompt: hint },
  }));
  exit();
}
