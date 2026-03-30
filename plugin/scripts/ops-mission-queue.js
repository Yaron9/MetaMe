'use strict';

/**
 * MetaMe Ops mission queue.
 * Same CLI interface as AgentScientist's topic-pool.js:
 *   next | activate <id> | complete <id> | list | scan
 *
 * The 'scan' command is unique to ops: it reads daemon logs + event logs
 * and generates fix missions automatically.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const MISSIONS_FILE = 'workspace/missions.md';
const SECTIONS = ['pending', 'active', 'completed', 'abandoned'];
const RECENT_LOG_LINES = 500;
const ERROR_THRESHOLD = 3;
const BOOTSTRAP_MISSION_ID = 'bootstrap-001';

function getMetameDir() {
  return process.env.METAME_DIR || path.join(os.homedir(), '.metame');
}

// ── Mission file parser (same format as topic-pool) ──────────

function getMissionsPath(cwd) {
  return path.join(cwd, MISSIONS_FILE);
}

function parseMission(line) {
  const m = line.match(/^-\s*\[([^\]]+)\]\s*(.+)$/);
  if (!m) return null;
  const id = m[1].trim();
  let rest = m[2].trim();
  let priority = 999;
  const pm = rest.match(/\(priority:\s*(\d+)\)\s*$/);
  if (pm) {
    priority = parseInt(pm[1], 10);
    rest = rest.slice(0, pm.index).trim();
  }
  return { id, title: rest, priority };
}

function parseMissionsFile(content) {
  const sections = { pending: [], active: [], completed: [], abandoned: [] };
  let current = null;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const secMatch = trimmed.match(/^##\s+(pending|active|completed|abandoned)\s*$/);
    if (secMatch) { current = secMatch[1]; continue; }
    if (current && trimmed.startsWith('- [')) {
      const mission = parseMission(trimmed);
      if (mission) { mission.status = current; sections[current].push(mission); }
    }
  }
  return sections;
}

function formatMissions(sections) {
  const lines = ['# MetaMe Ops Missions', ''];
  for (const sec of SECTIONS) {
    lines.push(`## ${sec}`);
    for (const t of (sections[sec] || [])) {
      lines.push(t.priority !== 999
        ? `- [${t.id}] ${t.title} (priority: ${t.priority})`
        : `- [${t.id}] ${t.title}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function readSections(cwd) {
  const fp = getMissionsPath(cwd);
  if (!fs.existsSync(fp)) return { pending: [], active: [], completed: [], abandoned: [] };
  return parseMissionsFile(fs.readFileSync(fp, 'utf-8'));
}

function writeSections(cwd, sections) {
  const fp = getMissionsPath(cwd);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, formatMissions(sections), 'utf-8');
}

function findMission(sections, id) {
  for (const sec of SECTIONS) {
    const idx = (sections[sec] || []).findIndex(t => t.id === id);
    if (idx !== -1) return { section: sec, index: idx, topic: sections[sec][idx] };
  }
  return null;
}

function normalizeLogLine(line) {
  return String(line || '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<TS>')
    .replace(/\d{10,}/g, '<ID>')
    .replace(/\/tmp\/[^\s]+/g, '<TMP>')
    .trim();
}

function collectRecurringErrors() {
  const counts = {};
  const logPath = path.join(getMetameDir(), 'daemon.log');
  if (!fs.existsSync(logPath)) return counts;

  try {
    const content = fs.readFileSync(logPath, 'utf8');
    const recent = content.split('\n').slice(-RECENT_LOG_LINES);
    for (const line of recent) {
      if (!/\bERR\b|\bWARN\b|\bError\b|\bfailed\b/i.test(line)) continue;
      const normalized = normalizeLogLine(line);
      if (normalized.length < 20) continue;
      const key = normalized.slice(0, 120);
      counts[key] = (counts[key] || 0) + 1;
    }
  } catch { /* ignore unreadable log */ }

  return counts;
}

function parseRecurringErrorTitle(title) {
  const m = String(title || '').match(/^Fix recurring error(?:\s*\(\d+x\))?:\s*(.+)$/i);
  return m ? m[1].trim() : '';
}

function shouldKeepMission(title, cwd, recurringErrors, now) {
  const recurringPattern = parseRecurringErrorTitle(title);
  if (recurringPattern) {
    return (recurringErrors[recurringPattern] || 0) >= ERROR_THRESHOLD;
  }

  const testMatch = String(title || '').match(/^Fix failing tests in (.+)$/i);
  if (testMatch) {
    const testName = testMatch[1].trim();
    const testPath = path.join(cwd, 'scripts', testName);
    if (!fs.existsSync(testPath)) return false;
    try {
      execSyncSafe(`node --test scripts/${testName}`, cwd, 30000);
      return false;
    } catch {
      return true;
    }
  }

  const staleMatch = String(title || '').match(/^Investigate stale project:\s*(.+)$/i);
  if (staleMatch) {
    const projectKey = staleMatch[1].trim();
    const fp = path.join(getMetameDir(), 'events', `${projectKey}.jsonl`);
    if (!fs.existsSync(fp)) return false;
    try {
      const staleHours = (now - fs.statSync(fp).mtimeMs) / (60 * 60 * 1000);
      return staleHours > 48;
    } catch {
      return true;
    }
  }

  return true;
}

function pruneObsoleteMissions(cwd) {
  const sections = readSections(cwd);
  const recurringErrors = collectRecurringErrors();
  const now = Date.now();
  const pruned = [];

  sections.pending = sections.pending.filter((mission) => {
    const keep = shouldKeepMission(mission.title, cwd, recurringErrors, now);
    if (!keep) pruned.push(mission);
    return keep;
  });

  if (pruned.length > 0) writeSections(cwd, sections);
  return { success: true, pruned: pruned.length, pruned_ids: pruned.map(m => m.id) };
}

// ── Standard queue commands ──────────────────────────────────

function nextMission(cwd) {
  const sections = readSections(cwd);
  if (sections.active.length > 0) {
    return { success: false, message: `already active: ${sections.active[0].id}` };
  }
  if (sections.pending.length === 0) return { success: false, message: 'no pending missions' };
  const sorted = [...sections.pending].sort((a, b) => a.priority - b.priority);
  return { success: true, topic: { id: sorted[0].id, title: sorted[0].title, status: 'pending', priority: sorted[0].priority } };
}

function activateMission(cwd, id) {
  const sections = readSections(cwd);
  const found = findMission(sections, id);
  if (!found) return { success: false, message: `not found: ${id}` };
  if (found.section !== 'pending') return { success: false, message: `${id} is ${found.section}` };
  const mission = sections.pending.splice(found.index, 1)[0];
  mission.status = 'active';
  sections.active.push(mission);
  writeSections(cwd, sections);
  return { success: true, topic: { id: mission.id, title: mission.title, status: 'active' } };
}

function completeMission(cwd, id) {
  const sections = readSections(cwd);
  const found = findMission(sections, id);
  if (!found) return { success: false, message: `not found: ${id}` };
  if (found.section !== 'active') return { success: false, message: `${id} is ${found.section}` };
  const mission = sections.active.splice(found.index, 1)[0];
  mission.status = 'completed';
  sections.completed.push(mission);
  writeSections(cwd, sections);
  return { success: true, topic: { id: mission.id, title: mission.title, status: 'completed' } };
}

function completeBootstrapMission(cwd) {
  const sections = readSections(cwd);
  const found = findMission(sections, BOOTSTRAP_MISSION_ID);
  if (!found || found.section !== 'active') {
    return { success: false, completed: false, reason: found ? `bootstrap_${found.section}` : 'bootstrap_missing' };
  }

  const mission = sections.active.splice(found.index, 1)[0];
  mission.status = 'completed';
  sections.completed.push(mission);
  writeSections(cwd, sections);
  return { success: true, completed: true, topic: { id: mission.id, title: mission.title, status: 'completed' } };
}

function listMissions(cwd) {
  const sections = readSections(cwd);
  const topics = [];
  for (const sec of SECTIONS) {
    for (const t of (sections[sec] || [])) topics.push({ id: t.id, title: t.title, status: sec, priority: t.priority });
  }
  return { success: true, topics };
}

// ── Log scanner: generates missions from error patterns ──────

function scanLogs(cwd) {
  const pruneResult = pruneObsoleteMissions(cwd);
  const sections = readSections(cwd);
  const existingTitles = new Set(
    [...sections.pending, ...sections.active, ...sections.completed, ...sections.abandoned].map(t => t.title)
  );

  const newMissions = [];
  const now = Date.now();
  const recurringErrors = collectRecurringErrors();

  // 1. Scan daemon log for repeated errors
  for (const [pattern, count] of Object.entries(recurringErrors)) {
    if (count < ERROR_THRESHOLD) continue;
    const dedupKey = `Fix recurring error: ${pattern.slice(0, 80)}`;
    if (existingTitles.has(dedupKey)) continue;
    newMissions.push({ title: dedupKey, priority: Math.max(1, 10 - count) });
  }

  // 2. Scan event logs for stuck/stale projects
  const eventsDir = path.join(getMetameDir(), 'events');
  if (fs.existsSync(eventsDir)) {
    try {
      const evFiles = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
      for (const f of evFiles) {
        const fp = path.join(eventsDir, f);
        const projectKey = path.basename(f, '.jsonl');
        try {
          const stat = fs.statSync(fp);
          const staleHours = (now - stat.mtimeMs) / (60 * 60 * 1000);
          // If event log wasn't updated in 48h but project is supposed to be active
          if (staleHours > 48) {
            // Stable dedup key: project name only (not hours, which changes every scan)
            const title = `Investigate stale project: ${projectKey}`;
            if (!existingTitles.has(title)) {
              newMissions.push({ title, priority: 5 });
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // 3. Check test health
  try {
    const testFiles = fs.readdirSync(path.join(cwd, 'scripts'))
      .filter(f => f.endsWith('.test.js'));
    for (const tf of testFiles) {
      try {
        execSyncSafe(`node --test scripts/${tf}`, cwd, 30000);
      } catch (e) {
        const title = `Fix failing tests in ${tf}`;
        if (!existingTitles.has(title)) {
          newMissions.push({ title, priority: 1 });
        }
      }
    }
  } catch { /* skip */ }

  // Add new missions to pending
  if (newMissions.length > 0) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let counter = sections.pending.length + sections.active.length + sections.completed.length + sections.abandoned.length + 1;
    for (const m of newMissions) {
      const id = `ops-${date}-${String(counter++).padStart(3, '0')}`;
      sections.pending.push({ id, title: m.title, priority: m.priority, status: 'pending' });
    }
    writeSections(cwd, sections);
  }

  return { success: true, scanned: true, new_missions: newMissions.length, total_pending: sections.pending.length };
}

function execSyncSafe(cmd, cwd, timeout) {
  const { execSync } = require('child_process');
  return execSync(cmd, { cwd, timeout, encoding: 'utf8', stdio: 'pipe' });
}

// ── CLI ──────────────────────────────────────────────────────

if (require.main === module) {
  const cwd = process.env.MISSION_CWD || process.cwd();
  const [,, command, ...args] = process.argv;

  let result;
  switch (command) {
    case 'next':     result = nextMission(cwd); break;
    case 'activate': result = args[0] ? activateMission(cwd, args[0]) : { success: false, message: 'usage: activate <id>' }; break;
    case 'complete': result = args[0] ? completeMission(cwd, args[0]) : { success: false, message: 'usage: complete <id>' }; break;
    case 'list':     result = listMissions(cwd); break;
    case 'prune':    result = pruneObsoleteMissions(cwd); break;
    case 'scan':     result = scanLogs(cwd); break;
    default:         result = { success: false, message: `unknown: ${command}. Available: next, activate, complete, list, prune, scan` };
  }

  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = {
  nextMission,
  activateMission,
  completeMission,
  completeBootstrapMission,
  listMissions,
  pruneObsoleteMissions,
  scanLogs,
};
