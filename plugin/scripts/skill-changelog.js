#!/usr/bin/env node

/**
 * MetaMe Skill Changelog
 *
 * Structured log of all skill lifecycle events:
 *   installed, evolved, hot_detected, queue_resolved, sunset
 *
 * Data: ~/.metame/skill_changelog.jsonl (append-only, one JSON per line)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const METAME_DIR = path.join(os.homedir(), '.metame');
const CHANGELOG_FILE = path.join(METAME_DIR, 'skill_changelog.jsonl');
const LAST_SESSION_FILE = path.join(METAME_DIR, 'last_session_start.txt');

// Skill directories (same as skill-evolution.js)
const SKILL_DIRS = [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.opencode', 'skills'),
];

/** Map action name to display icon. */
function getActionIcon(action) {
  const iconMap = { evolved: '↑', installed: '+', hot_detected: '!' };
  return iconMap[action] || '·';
}

/**
 * Scan all SKILL_DIRS and return installed skills as [{name, skillDir}].
 * Deduplicates by skill name across dirs.
 */
function _scanSkillDirs() {
  const result = [];
  const seen = new Set();
  for (const dir of SKILL_DIRS) {
    try {
      for (const name of fs.readdirSync(dir)) {
        if (seen.has(name)) continue;
        const skillDir = path.join(dir, name);
        try { fs.statSync(path.join(skillDir, 'SKILL.md')); } catch { continue; }
        seen.add(name);
        result.push({ name, skillDir });
      }
    } catch { /* dir doesn't exist or not readable */ }
  }
  return result;
}

/**
 * Append a changelog entry.
 * @param {string} action - installed|evolved|hot_detected|queue_resolved|sunset
 * @param {string} skill - skill name
 * @param {string} summary - one-line human summary
 * @param {string} [detail] - optional extra detail
 */
function appendChange(action, skill, summary, detail) {
  try {
    fs.mkdirSync(METAME_DIR, { mode: 0o700, recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      action,
      skill: skill || null,
      summary: summary || '',
    };
    if (detail) entry.detail = detail;
    fs.appendFileSync(CHANGELOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

/**
 * Read changelog entries since a given ISO timestamp.
 * @param {string} [since] - ISO timestamp; if omitted returns all
 * @returns {Array<object>}
 */
function getRecentChanges(since) {
  try {
    const lines = fs.readFileSync(CHANGELOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!since) return entries;
    const sinceMs = new Date(since).getTime();
    return entries.filter(e => new Date(e.ts).getTime() > sinceMs);
  } catch {
    return [];
  }
}

/**
 * Get the last session start timestamp.
 * @returns {string|null} ISO timestamp or null
 */
function getLastSessionStart() {
  try {
    const ts = fs.readFileSync(LAST_SESSION_FILE, 'utf8').trim();
    return ts || null;
  } catch {
    return null;
  }
}

/**
 * Write current timestamp as last session start.
 */
function writeSessionStart() {
  try {
    fs.mkdirSync(METAME_DIR, { mode: 0o700, recursive: true });
    fs.writeFileSync(LAST_SESSION_FILE, new Date().toISOString(), 'utf8');
  } catch { /* non-fatal */ }
}

/**
 * Count installed skills across all skill dirs.
 * @returns {number}
 */
function countInstalledSkills() {
  return _scanSkillDirs().length;
}

/**
 * Build a stats object for all skills (for dashboard).
 * @returns {object} { installed: [{name, hasEvolution, evolutionCount, lastEvolved}], queuePending: [], recentChanges: [] }
 */
function getSkillStats() {
  const installed = [];
  for (const { name, skillDir } of _scanSkillDirs()) {
    const info = { name, hasEvolution: false, evolutionCount: 0, lastEvolved: null };
    try {
      const evo = JSON.parse(fs.readFileSync(path.join(skillDir, 'evolution.json'), 'utf8'));
      const fixes = (evo.fixes || []).length;
      const prefs = (evo.preferences || []).length;
      const ctxs = (evo.contexts || []).length;
      info.evolutionCount = fixes + prefs + ctxs;
      info.hasEvolution = info.evolutionCount > 0;
      info.lastEvolved = evo.last_updated || null;
    } catch { /* no evolution data */ }
    installed.push(info);
  }

  // Queue pending items
  let queuePending = [];
  try {
    const queueFile = path.join(METAME_DIR, 'evolution_queue.yaml');
    const data = yaml.load(fs.readFileSync(queueFile, 'utf8'));
    if (data && Array.isArray(data.items)) {
      queuePending = data.items.filter(i => i.status === 'pending' || i.status === 'notified');
    }
  } catch { /* no queue */ }

  // Recent changes (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentChanges = getRecentChanges(weekAgo);

  return { installed, queuePending, recentChanges };
}

/**
 * Format a human-readable dashboard string.
 * @returns {string}
 */
function formatDashboard() {
  const stats = getSkillStats();
  const lines = [];

  lines.push(`技能面板 (${stats.installed.length} installed)`);
  lines.push('━'.repeat(42));

  // Sort: has evolution first, then alphabetical
  const sorted = stats.installed.slice().sort((a, b) => {
    if (a.hasEvolution !== b.hasEvolution) return b.hasEvolution ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const s of sorted) {
    const status = s.hasEvolution ? '活跃' : '待定';
    const evoInfo = s.hasEvolution
      ? `经验: ${s.evolutionCount} 条 | 最近演化: ${formatRelativeTime(s.lastEvolved)}`
      : `经验: 0 条`;
    lines.push(`[${status}] ${s.name.padEnd(28)} | ${evoInfo}`);
  }

  // Signal count
  try {
    const sigFile = path.join(METAME_DIR, 'skill_signals.jsonl');
    const sigCount = fs.readFileSync(sigFile, 'utf8').trim().split('\n').filter(Boolean).length;
    if (sigCount > 0) {
      lines.push('');
      lines.push(`信号缓冲: ${sigCount} 条待蒸馏`);
    }
  } catch { /* skip */ }

  // Recent changes
  if (stats.recentChanges.length > 0) {
    lines.push('');
    lines.push('最近变更 (7天内):');
    for (const c of stats.recentChanges.slice(-10)) {
      const date = c.ts.substring(5, 10); // MM-DD
      lines.push(`  ${date} ${(c.skill || 'system').padEnd(28)} ${getActionIcon(c.action)} ${c.summary}`);
    }
  }

  // Queue
  if (stats.queuePending.length > 0) {
    lines.push('');
    lines.push('待处理队列:');
    for (let i = 0; i < stats.queuePending.length; i++) {
      const q = stats.queuePending[i];
      const evidenceStr = q.evidence_count ? `${q.evidence_count}条证据` : '';
      lines.push(`  ${i + 1}. [${q.type}] ${q.reason || q.search_hint || '未知'} (${evidenceStr})`);
    }
  }

  return lines.join('\n');
}

/**
 * Format relative time from ISO string.
 */
function formatRelativeTime(isoStr) {
  if (!isoStr) return '从未';
  const diffMs = Date.now() - new Date(isoStr).getTime();
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 1) return '刚才';
  if (diffH < 24) return `${diffH}h 前`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 0) return '今天';
  if (diffD === 1) return '昨天';
  return `${diffD}天前`;
}

module.exports = {
  appendChange,
  getRecentChanges,
  getLastSessionStart,
  writeSessionStart,
  countInstalledSkills,
  getSkillStats,
  formatDashboard,
  getActionIcon,
};
