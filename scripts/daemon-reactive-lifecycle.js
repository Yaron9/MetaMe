'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { buildReactivePrompt } = require('./core/reactive-prompt');
const { calculateNextAction } = require('./core/reactive-signal');
const { resolveReactivePaths } = require('./core/reactive-paths');

/**
 * daemon-reactive-lifecycle.js — Reactive Loop Lifecycle Module
 *
 * Generic task chain engine for perpetual projects. Domain-agnostic.
 * Hard gates:
 *   1. Budget gate   — pauses loop when daily budget exhausted
 *   2. Depth gate    — pauses loop when depth counter hits max
 *   3. Fresh session — every reactive dispatch uses new_session: true
 *   4. Completion signal — configurable per project (default: MISSION_COMPLETE)
 *   5. Verifier hook — runs project verifier before waking parent
 *   6. Event sourcing — all state changes logged to ~/.metame/reactive/<key>/
 */

// ── Signal parsing ──────────────────────────────────────────────

// Signal patterns (created per-call to avoid global regex lastIndex state)
// Supports two formats (both common in LLM output):
//   NEXT_DISPATCH: target "prompt here"           (quoted, single-line)
//   NEXT_DISPATCH: target: prompt here             (colon-separated, until next directive or end)
const QUOTED_PATTERN = /NEXT_DISPATCH:\s*(\S+)\s+"([^"]+)"/g;
const COLON_PATTERN = /NEXT_DISPATCH\s*:\s*(\S+)\s*:\s*(.+?)(?=\nNEXT_DISPATCH\s*:|$)/gs;
const RESEARCH_COMPLETE_RE = /RESEARCH_COMPLETE/;

/**
 * Parse reactive signals from agent output.
 * Pure function — no side effects.
 *
 * @param {string} output - Raw agent output text
 * @returns {{ directives: Array<{target: string, prompt: string}>, complete: boolean }}
 */
function parseReactiveSignals(output, completionSignal) {
  const directives = [];
  let match;
  // Try quoted format first (preferred, documented in CLAUDE.md)
  // Create fresh regex each call to avoid global lastIndex state pollution
  const quotedRe = new RegExp(QUOTED_PATTERN.source, QUOTED_PATTERN.flags);
  while ((match = quotedRe.exec(output)) !== null) {
    const target = match[1].trim();
    const prompt = match[2].trim();
    if (target && prompt) directives.push({ target, prompt });
  }
  // Fallback: colon-separated format (tolerant of LLM variation)
  if (directives.length === 0) {
    const colonRe = new RegExp(COLON_PATTERN.source, COLON_PATTERN.flags);
    while ((match = colonRe.exec(output)) !== null) {
      const target = match[1].trim();
      const prompt = match[2].trim();
      if (target && prompt) directives.push({ target, prompt });
    }
  }
  const completionRe = completionSignal
    ? new RegExp(completionSignal)
    : RESEARCH_COMPLETE_RE;
  const complete = completionRe.test(output);
  return { directives, complete };
}

// ── Internal state helpers (not exported) ───────────────────────

function getReactiveState(state, projectKey) {
  if (!state.reactive) state.reactive = {};
  if (!state.reactive[projectKey]) {
    state.reactive[projectKey] = {
      depth: 0,
      max_depth: 50,
      status: 'idle',
      pause_reason: '',
      last_signal: '',
      updated_at: new Date().toISOString(),
    };
  }
  return state.reactive[projectKey];
}

function setReactiveStatus(state, projectKey, status, reason) {
  const rs = getReactiveState(state, projectKey);
  rs.status = status;
  rs.pause_reason = reason || '';
  rs.updated_at = new Date().toISOString();
}

function isReactiveExecutionActive(projectKey, config, deps) {
  const active = deps && deps.activeProcesses;
  if (!active || typeof active.values !== 'function') return false;
  const key = String(projectKey || '').trim();
  if (!key) return false;
  const parent = config && config.projects ? config.projects[key] : null;
  const memberKeys = new Set(
    Array.isArray(parent && parent.team)
      ? parent.team.map(member => String(member && member.key || '').trim()).filter(Boolean)
      : []
  );
  for (const proc of active.values()) {
    if (!proc || proc.aborted) continue;
    const reactiveProjectKey = String(proc.reactiveProjectKey || '').trim();
    if (reactiveProjectKey && reactiveProjectKey === key) return true;
    const procChatId = String(proc.chatId || proc.logicalChatId || '').trim();
    if (!procChatId) continue;
    if (procChatId === `_agent_${key}`) return true;
    if (procChatId.startsWith('_scope_') && procChatId.endsWith(`__${key}`)) return true;
    for (const memberKey of memberKeys) {
      if (procChatId === `_agent_${memberKey}`) return true;
      if (procChatId.startsWith('_scope_') && procChatId.endsWith(`__${memberKey}`)) return true;
    }
  }
  return false;
}

/**
 * Find the reactive parent project key for a given team member.
 * Returns the parent key string, or null if not found.
 */
function findReactiveParent(targetProject, config) {
  if (!config || !config.projects) return null;
  for (const [parentKey, proj] of Object.entries(config.projects)) {
    if (!proj || !Array.isArray(proj.team)) continue;
    if (proj.team.some(m => m.key === targetProject)) {
      return parentKey;
    }
  }
  return null;
}

/**
 * Check if a project is configured as a reactive parent.
 * A reactive parent has a `reactive` truthy flag in its project config.
 */
function isReactiveParent(projectKey, config) {
  if (!config || !config.projects) return false;
  const proj = config.projects[projectKey];
  return !!(proj && proj.reactive);
}

// ── Manifest discovery ──────────────────────────────────────────

/**
 * Load project manifest (perpetual.yaml / perpetual.yml) from project root.
 * Returns parsed object or null if not found / parse error.
 *
 * @param {string} projectCwd - Absolute path to project root
 * @returns {object|null}
 */
function loadProjectManifest(projectCwd) {
  const yaml = require('js-yaml');
  for (const name of ['perpetual.yaml', 'perpetual.yml']) {
    const p = path.join(projectCwd, name);
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf8');
        return yaml.load(content) || null;
      } catch (e) {
        process.stderr.write(`[reactive-lifecycle] WARN: failed to parse ${p}: ${e.message}\n`);
        return null;
      }
    }
  }
  return null;
}

/**
 * Resolve project script paths using convention-over-configuration.
 * Manifest fields override defaults; all paths are absolute.
 *
 * @param {string} projectCwd - Absolute path to project root
 * @param {object|null} manifest - Parsed perpetual.yaml or null
 * @returns {{ verifier: string, archiver: string, missionQueue: string }}
 */
function resolveProjectScripts(projectCwd, manifest) {
  const resolve = (override, fallback) => path.join(projectCwd, override || fallback);
  return {
    verifier:     resolve(manifest?.verifier, 'scripts/verifier.js'),
    archiver:     resolve(manifest?.archiver, 'scripts/archiver.js'),
    missionQueue: resolve(manifest?.mission_queue, 'scripts/mission-queue.js'),
  };
}

// ── Verifier helpers ────────────────────────────────────────────

function resolveProjectCwd(projectKey, config) {
  const proj = config.projects?.[projectKey];
  if (!proj || !proj.cwd) return null;
  return proj.cwd.replace(/^~/, os.homedir());
}

function readPhaseFromState(statePath) {
  try {
    const content = fs.readFileSync(statePath, 'utf8');
    const match = content.match(/^phase:\s*(\S+)/m);
    return match ? match[1] : '';
  } catch { return ''; }
}

/**
 * Load working memory file for a project.
 * Returns the file content as a string, or empty string if not found.
 *
 * @param {string} projectKey
 * @param {string} [metameDir] - Override ~/.metame path (for testing)
 * @returns {string}
 */
function loadWorkingMemory(projectKey, metameDir) {
  const base = metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, base);
  const memPath = paths.memory;
  try {
    const content = fs.readFileSync(memPath, 'utf8').trim();
    return content || '';
  } catch { return ''; }
}

/**
 * Run project-level verifier script if it exists.
 * Returns parsed JSON result or null if no verifier / error.
 */
function runProjectVerifier(projectKey, config, deps) {
  const projectCwd = resolveProjectCwd(projectKey, config);
  if (!projectCwd) return null;

  const manifest = loadProjectManifest(projectCwd);
  const scripts = resolveProjectScripts(projectCwd, manifest);
  if (!fs.existsSync(scripts.verifier)) return null;

  const metameDir = deps.metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, metameDir);
  const statePath = paths.state;

  // Read phase from event log (SoT), fall back to state file for backward compat
  const { phase: eventPhase } = replayEventLog(projectKey, deps);
  const phase = eventPhase || readPhaseFromState(statePath);
  const relVerifier = path.relative(projectCwd, scripts.verifier);

  try {
    const output = execSync(`node "${relVerifier}"`, {
      cwd: projectCwd,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        VERIFIER_CWD: projectCwd,
        VERIFIER_PHASE: phase || '',
        VERIFIER_STATE_PATH: statePath,
      },
    }).trim();
    return JSON.parse(output);
  } catch (e) {
    deps.log('WARN', `Verifier failed for ${projectKey}: ${e.message}`);
    return { passed: false, phase: phase || 'unknown', details: `verifier_error: ${e.message.slice(0, 200)}`, artifacts: [], hints: ['Verifier script failed — check scripts/'] };
  }
}

/**
 * Run project-level completion hooks (archive + topic pool).
 * Platform only calls scripts if they exist — no business logic here.
 * @returns {{ archived: boolean, nextTopic: string|null, nextTopicPrompt: string|null }}
 */
function runCompletionHooks(projectKey, projectCwd, deps) {
  const manifest = loadProjectManifest(projectCwd);
  const scripts = resolveProjectScripts(projectCwd, manifest);
  const result = { archived: false, nextMission: null, nextMissionId: null, nextMissionPrompt: null };

  // 1. Archive (if script exists)
  if (fs.existsSync(scripts.archiver)) {
    try {
      const metameDir = deps.metameDir || path.join(os.homedir(), '.metame');
      const rPaths = resolveReactivePaths(projectKey, metameDir);
      const statePath = rPaths.state;
      let projectName = projectKey;
      try {
        const stateContent = fs.readFileSync(statePath, 'utf8');
        const m = stateContent.match(/^project:\s*"?(.+?)"?\s*$/m);
        if (m) projectName = m[1];
      } catch { /* use projectKey */ }

      const relArchiver = path.relative(projectCwd, scripts.archiver);
      const archiveOut = execSync(`node "${relArchiver}"`, {
        cwd: projectCwd, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, ARCHIVE_CWD: projectCwd, ARCHIVE_PROJECT_NAME: projectName, ARCHIVE_STATE_PATH: statePath },
      }).trim();
      const archiveResult = JSON.parse(archiveOut);
      result.archived = archiveResult.success === true;
      deps.log('INFO', `Reactive: archive result for ${projectKey}: ${archiveOut.slice(0, 200)}`);
    } catch (e) {
      deps.log('WARN', `Reactive: archive failed for ${projectKey}: ${e.message}`);
    }
  }

  // 2. Mission queue — only proceed if archive succeeded
  if (result.archived && fs.existsSync(scripts.missionQueue)) {
    const relQueue = path.relative(projectCwd, scripts.missionQueue);
    const queueEnv = { ...process.env, MISSION_CWD: projectCwd, TOPICS_CWD: projectCwd };
    // Sanitize topic IDs to prevent shell injection (only allow alphanumeric, dash, underscore)
    const sanitizeId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    // 2a. Complete current active mission
    try {
      const listOut = execSync(`node "${relQueue}" list`, {
        cwd: projectCwd, encoding: 'utf8', timeout: 10000, env: queueEnv,
      }).trim();
      const listResult = JSON.parse(listOut);
      if (listResult.success && Array.isArray(listResult.topics)) {
        const activeTopic = listResult.topics.find(t => t.status === 'active');
        if (activeTopic) {
          execSync(`node "${relQueue}" complete ${sanitizeId(activeTopic.id)}`, {
            cwd: projectCwd, encoding: 'utf8', timeout: 10000, env: queueEnv,
          });
          deps.log('INFO', `Reactive: completed mission ${activeTopic.id}: ${activeTopic.title}`);
        }
      }
    } catch (e) {
      deps.log('WARN', `Reactive: mission complete failed: ${e.message}`);
    }
    // 2b. Get next pending mission
    try {
      const nextOut = execSync(`node "${relQueue}" next`, {
        cwd: projectCwd, encoding: 'utf8', timeout: 10000, env: queueEnv,
      }).trim();
      const nextResult = JSON.parse(nextOut);
      if (nextResult.success && nextResult.topic) {
        try {
          execSync(`node "${relQueue}" activate ${sanitizeId(nextResult.topic.id)}`, {
            cwd: projectCwd, encoding: 'utf8', timeout: 10000, env: queueEnv,
          });
        } catch (e) {
          deps.log('WARN', `Reactive: mission activate failed: ${e.message}`);
        }
        result.nextMission = nextResult.topic.title;
        result.nextMissionId = nextResult.topic.id || '';
        result.nextMissionPrompt = `New mission: "${nextResult.topic.title}"\n\nStart this mission. Read your CLAUDE.md for instructions, then decide on the first step using NEXT_DISPATCH.`;
        deps.log('INFO', `Reactive: next mission for ${projectKey}: ${nextResult.topic.title}`);
      }
    } catch (e) {
      deps.log('WARN', `Reactive: mission queue query failed for ${projectKey}: ${e.message}`);
    }
  } else if (!result.archived && fs.existsSync(scripts.missionQueue)) {
    deps.log('WARN', `Reactive: skipping mission queue for ${projectKey} — archive did not succeed`);
  }

  return result;
}

// ── Event Log (Event Sourcing) ──────────────────────────────────

/**
 * Append an event to the project's event log.
 * Daemon-exclusive: agents cannot write to ~/.metame/reactive/<key>/.
 */
function appendEvent(projectKey, event, metameDir) {
  const base = metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, base);
  fs.mkdirSync(paths.dir, { recursive: true });
  const logPath = paths.events;
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  fs.appendFileSync(logPath, line, 'utf8');
}

/**
 * Replay event log to derive current state.
 * Returns { phase, mission, history[] }
 *
 * DESIGN CONTRACT (Tolerant Reader):
 * Malformed lines (e.g. from crash/truncation) are skipped with a WARN log.
 * This function NEVER throws.
 */
function replayEventLog(projectKey, deps) {
  const base = deps?.metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, base);
  const logPath = paths.events;
  if (!fs.existsSync(logPath)) return { phase: '', mission: null, history: [] };

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  let phase = '';
  let mission = null;
  const history = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const evt = JSON.parse(lines[i]);
      if (evt.type === 'MISSION_START') {
        mission = { id: evt.mission_id, title: evt.mission_title };
      }
      if (evt.type === 'PHASE_GATE' && evt.passed) {
        phase = evt.phase;
        history.push({ phase: evt.phase, date: evt.ts, artifacts: evt.artifacts });
      }
      if (evt.type === 'MISSION_COMPLETE') {
        phase = '';
        mission = null;
      }
    } catch {
      // DESIGN CONTRACT: Tolerant Reader (尾行容错)
      // 断电/Kernel Panic 可能导致最后一行残缺。
      // 逐行 parse，损坏行静默丢弃 + log WARN，绝不 crash loop。
      deps?.log?.('WARN', `Event log ${projectKey} line ${i + 1}: malformed JSON, skipped`);
    }
  }

  return { phase, mission, history };
}

/**
 * Generate progress.tsv as a human-readable projection of the event log.
 * Not SoT — can be safely regenerated at any time.
 */
function projectProgressTsv(projectCwd, projectKey, metameDir) {
  const tsvPath = path.join(projectCwd, 'workspace', 'progress.tsv');
  const header = 'phase\tresult\tverifier_passed\tartifact\ttimestamp\tnotes\n';

  const base = metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, base);
  const logPath = paths.events;
  if (!fs.existsSync(logPath)) return;

  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  let rows = header;
  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      if (evt.type === 'PHASE_GATE') {
        rows += [
          evt.phase,
          evt.passed ? 'done' : 'in_progress',
          String(evt.passed),
          (evt.artifacts || [])[0] || '',
          evt.ts,
          (evt.details || '').replace(/[\t\n]/g, ' '),
        ].join('\t') + '\n';
      }
    } catch { /* skip */ }
  }

  fs.mkdirSync(path.dirname(tsvPath), { recursive: true });
  fs.writeFileSync(tsvPath, rows, 'utf8');
}

/**
 * Generate now/<key>.md state file by replaying the event log.
 * This is the canonical way to (re)build the agent-visible state file
 * from the append-only event log (event sourcing projection).
 *
 * @param {string} projectKey
 * @param {object} config - Full daemon config
 * @param {object} deps   - Injected dependencies (loadState, log, metameDir)
 * @returns {string} statePath - Absolute path to the written file
 */
function generateStateFile(projectKey, config, deps) {
  const metameDir = deps.metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, metameDir);
  const statePath = paths.state;

  const { phase, mission, history } = replayEventLog(projectKey, deps);

  const rs = deps.loadState().reactive?.[projectKey] || {};
  const projectName = config.projects?.[projectKey]?.name || projectKey;

  const round = Math.max(1, history.filter(h => h.phase === 'topic').length);

  const lines = [
    `# ${projectName} status`,
    `project: "${mission?.title || 'unknown'}"`,
    `phase: ${phase || 'topic'}`,
    `status: ${rs.status || 'idle'}`,
    'waiting_for: ""',
    `round: ${round}`,
    `last_update: "${new Date().toISOString()}"`,
    '',
    '# Phase history (from event log)',
  ];

  for (const h of history) {
    lines.push(`  - phase: ${h.phase}`);
    lines.push(`    date: "${h.date}"`);
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, lines.join('\n'), 'utf8');

  return statePath;
}

/**
 * Periodic reconciliation check for all perpetual projects.
 * Zero-token: pure state file inspection, no LLM calls.
 */
function reconcilePerpetualProjects(config, deps) {
  const projects = config.projects || {};
  for (const [key, proj] of Object.entries(projects)) {
    if (!proj.reactive) continue;

    const st = deps.loadState();
    const rs = st.reactive?.[key];
    if (!rs || rs.status !== 'running') continue;

    const lastUpdate = new Date(rs.updated_at).getTime();
    if (!Number.isFinite(lastUpdate)) {
      deps.log('WARN', `Reconcile: ${key} has invalid updated_at: ${rs.updated_at}`);
      continue;
    }
    const staleMinutes = proj.stale_timeout_minutes || 120;
    const staleThreshold = staleMinutes * 60 * 1000;

    if (Date.now() - lastUpdate > staleThreshold) {
      if (isReactiveExecutionActive(key, config, deps)) {
        deps.log('INFO', `Reconcile: ${key} exceeds stale threshold but reactive execution is still active`);
        continue;
      }
      deps.log('WARN', `Reconcile: ${key} stuck since ${rs.updated_at}`);
      setReactiveStatus(st, key, 'stale', 'no_activity');
      deps.saveState(st);
      appendEvent(key, { type: 'STALE', last_signal: rs.last_signal || '' }, deps.metameDir);
      if (deps.notifyUser) {
        const pName = proj.name || key;
        deps.notifyUser(`⚠️ ${pName} stale: no activity for ${staleMinutes}+ minutes (last signal: ${rs.last_signal || 'none'})`);
      }
    }
  }
}

// ── Memory System (L1/L2) ───────────────────────────────────────

/**
 * Parse event log file into an array of event objects.
 * Single read — callers share the result to avoid redundant I/O.
 *
 * @param {string} projectKey
 * @param {object} deps
 * @returns {Array<object>} Parsed events (malformed lines silently skipped)
 */
function parseEventLog(projectKey, deps) {
  const metameDir = deps.metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, metameDir);
  const logPath = paths.events;
  if (!fs.existsSync(logPath)) return [];

  const raw = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
  const events = [];
  for (const line of raw) {
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return events;
}

/**
 * Build L1 running memory from parsed events.
 * Extracts key decisions, lessons, phase trail, and round count
 * from the current mission (since last MISSION_START).
 *
 * @param {string} projectKey
 * @param {object} config
 * @param {object} deps
 * @param {Array<object>} [parsedEvents] - Pre-parsed events (avoids re-read)
 * @returns {string} Markdown string (~600-800 tokens)
 */
function buildRunningMemory(projectKey, config, deps, parsedEvents) {
  const events = parsedEvents || parseEventLog(projectKey, deps);
  if (events.length === 0) return '';

  // Find last MISSION_START to scope to current mission
  let missionStartIdx = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'MISSION_START') {
      missionStartIdx = i;
      break;
    }
  }

  const decisions = [];
  const lessons = [];
  const phaseTrail = [];
  let roundCount = 0;

  const decisionVerbs = /(?:chose|decided|switched|because|instead|using|adopted|rejected)/i;

  for (let i = missionStartIdx; i < events.length; i++) {
    const evt = events[i];

    if (evt.type === 'MEMBER_COMPLETE') roundCount++;

    if (evt.type === 'DISPATCH' && evt.prompt && evt.prompt.length > 80 && decisionVerbs.test(evt.prompt)) {
      decisions.push({ round: roundCount, text: evt.prompt.slice(0, 150) });
    }

    if (evt.type === 'PHASE_GATE' && !evt.passed && evt.details) {
      lessons.push({ round: roundCount, text: evt.details.slice(0, 120) });
    }

    if (evt.type === 'PHASE_GATE' && evt.passed) {
      phaseTrail.push({ phase: evt.phase, round: roundCount });
    }
  }

  const recentDecisions = decisions.slice(-5);
  const recentLessons = lessons.slice(-5);

  const parts = [];

  if (recentDecisions.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('## Recent Decisions');
    for (const d of recentDecisions) {
      parts.push(`- [R${d.round}] ${d.text}`);
    }
  }

  if (recentLessons.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('## Lessons Learned');
    for (const l of recentLessons) {
      parts.push(`- [R${l.round}] ${l.text}`);
    }
  }

  if (phaseTrail.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push('## Phase Trail');
    parts.push(phaseTrail.map(p => `${p.phase}(R${p.round})`).join(' → '));
  }

  if (parts.length === 0) return '';
  return parts.join('\n');
}

/**
 * Scan workspace for relevant artifacts (files sorted by mtime).
 *
 * @param {string} projectKey
 * @param {object} config
 * @param {object} deps
 * @returns {Array<{ path: string, desc: string }>} Top 5 artifacts
 */
function scanRelevantArtifacts(projectKey, config, deps) {
  const projectCwd = resolveProjectCwd(projectKey, config);
  if (!projectCwd) return [];

  const wsDir = path.join(projectCwd, 'workspace');
  if (!fs.existsSync(wsDir)) return [];

  const validExts = new Set(['.md', '.json', '.tsv', '.py', '.csv']);
  const files = [];

  // Walk max depth 2
  try {
    const d1Entries = fs.readdirSync(wsDir, { withFileTypes: true });
    for (const e1 of d1Entries) {
      const p1 = path.join(wsDir, e1.name);
      if (e1.isFile() && validExts.has(path.extname(e1.name))) {
        try { files.push({ abs: p1, rel: `workspace/${e1.name}`, mtime: fs.statSync(p1).mtimeMs }); } catch { /* skip */ }
      } else if (e1.isDirectory()) {
        try {
          const d2Entries = fs.readdirSync(p1, { withFileTypes: true });
          for (const e2 of d2Entries) {
            if (e2.isFile() && validExts.has(path.extname(e2.name))) {
              const p2 = path.join(p1, e2.name);
              try { files.push({ abs: p2, rel: `workspace/${e1.name}/${e2.name}`, mtime: fs.statSync(p2).mtimeMs }); } catch { /* skip */ }
            }
          }
        } catch { /* skip unreadable dirs */ }
      }
    }
  } catch { return []; }

  // Sort by mtime descending, take top 5
  files.sort((a, b) => b.mtime - a.mtime);
  const top = files.slice(0, 5);

  // Heuristic descriptions based on path/name
  const descMap = {
    'progress.tsv': 'phase progress tracker',
    'results': 'experiment results',
    'proposal': 'research proposal',
    'draft': 'paper draft',
    'notes': 'research notes',
    'config': 'configuration',
    'data': 'dataset',
  };

  return top.map(f => {
    let desc = path.extname(f.rel).slice(1) + ' file';
    for (const [key, label] of Object.entries(descMap)) {
      if (f.rel.toLowerCase().includes(key)) { desc = label; break; }
    }
    return { path: f.rel, desc };
  });
}

/**
 * Build L2 working memory from event log replay + memory.db FTS5.
 *
 * @param {string} projectKey
 * @param {object} config
 * @param {object} deps
 * @returns {string} Markdown string (~300-500 tokens)
 */
function buildWorkingMemory(projectKey, config, deps) {
  const parts = [];

  // Phase history as causal chain from event replay
  const { phase, mission, history } = replayEventLog(projectKey, deps);

  // FTS5 query: mission title + current phase (fixed rule, no smart inference)
  const query = ((mission?.title || '') + ' ' + (phase || '')).trim();
  if (!query) return '';

  let facts = [];
  try {
    const memory = require('./memory');
    memory.acquire();
    try {
      facts = memory.searchFacts(query, { limit: 5, project: projectKey });
    } finally {
      memory.release();
    }
  } catch { /* memory.db unavailable — graceful degradation */ }

  if (facts.length > 0) {
    parts.push('## Long-term Context');
    for (const f of facts) {
      const tag = f.relation || f.entity || 'fact';
      parts.push(`- [${tag}] ${f.value}`);
    }
  }

  if (parts.length === 0) return '';
  return parts.join('\n');
}

/**
 * Persist unified memory file (L1 + L2 merged).
 * L1 rebuilds every round; L2 refreshes every 5 rounds or on phase change.
 *
 * @param {string} projectKey
 * @param {object} config
 * @param {object} deps
 * @param {object} [opts]
 * @param {boolean} [opts.phaseChanged]
 */
function persistMemoryFiles(projectKey, config, deps, opts = {}) {
  const metameDir = deps.metameDir || path.join(os.homedir(), '.metame');
  const paths = resolveReactivePaths(projectKey, metameDir);
  fs.mkdirSync(paths.dir, { recursive: true });
  const memPath = paths.memory;

  // Single parse of event log — shared across L1 and round counting
  const events = parseEventLog(projectKey, deps);

  // Derive round count and mission title from parsed events
  let roundCount = 0;
  let missionTitle = 'unknown';
  let maxDepth = 50;
  for (const evt of events) {
    if (evt.type === 'MEMBER_COMPLETE') roundCount++;
    if (evt.type === 'MISSION_START') { missionTitle = evt.mission_title || 'unknown'; roundCount = 0; }
    if (evt.type === 'MISSION_COMPLETE') roundCount = 0;
  }

  // Read manifest for max_depth
  const projectCwd = resolveProjectCwd(projectKey, config);
  if (projectCwd) {
    const manifest = loadProjectManifest(projectCwd);
    if (manifest?.max_depth) maxDepth = manifest.max_depth;
  }

  // Always rebuild L1 (pass pre-parsed events to avoid re-read)
  const l1 = buildRunningMemory(projectKey, config, deps, events);
  const artifacts = scanRelevantArtifacts(projectKey, config, deps);

  // Conditionally rebuild L2 (every 5 rounds or phase change)
  const shouldRefreshL2 = opts.phaseChanged || (roundCount % 5 === 0);
  let l2 = '';
  if (shouldRefreshL2) {
    l2 = buildWorkingMemory(projectKey, config, deps);
    // Stash L2 for next time
    try {
      fs.writeFileSync(paths.l2cache, l2, 'utf8');
    } catch { /* non-critical */ }
  } else {
    // Read stale L2 from cache
    try {
      if (fs.existsSync(paths.l2cache)) {
        l2 = fs.readFileSync(paths.l2cache, 'utf8').trim();
      }
    } catch { /* non-critical */ }
  }

  // Build merged document
  const parts = [`# Memory Context: ${missionTitle} (round ${roundCount}/${maxDepth})`];

  if (l1) parts.push('', l1);

  if (artifacts.length > 0) {
    parts.push('', '## Current Artifacts');
    for (const a of artifacts) {
      parts.push(`- ${a.path} — ${a.desc}`);
    }
  }

  if (l2) parts.push('', l2);

  const content = parts.join('\n') + '\n';
  fs.writeFileSync(memPath, content, 'utf8');
  return memPath;
}

/**
 * Pattern-based inline fact extraction from agent output.
 * Zero LLM, zero agent format dependency.
 *
 * @param {string} projectKey
 * @param {string} memberOutput
 * @param {string} [phase]
 * @returns {Array<{ entity: string, relation: string, value: string, confidence: string }>}
 */
function extractInlineFacts(projectKey, memberOutput, phase) {
  if (!memberOutput || typeof memberOutput !== 'string') return [];

  const facts = [];
  const CAP = 3;

  // Pattern 1: Error/OOM patterns → bug_lesson
  const errorRe = /(?:OOM|out of memory|CUDA error|killed|Error:|Exception:|Failed:)\s*(.{15,150})/gi;
  let match;
  while ((match = errorRe.exec(memberOutput)) !== null && facts.length < CAP) {
    facts.push({
      entity: projectKey,
      relation: 'bug_lesson',
      value: match[0].trim().slice(0, 150),
      confidence: 'medium',
    });
  }

  // Pattern 2: Decision verbs → tech_decision
  const decisionRe = /(?:decided|chose|selected|switched to|rejected|using|adopted)\s+(.{20,150})/gi;
  while ((match = decisionRe.exec(memberOutput)) !== null && facts.length < CAP) {
    facts.push({
      entity: projectKey,
      relation: 'tech_decision',
      value: match[0].trim().slice(0, 150),
      confidence: 'low',
    });
  }

  return facts.slice(0, CAP);
}

/**
 * Extract a high-density summary from agent output.
 * Tail-biased: conclusions and results are usually at the end.
 * Zero LLM — pure heuristic.
 *
 * Strategy:
 *   - Head (~200 chars): who's speaking, opening context
 *   - Key lines: lines containing signal words (conclusions, decisions, errors)
 *   - Tail (~600 chars): final output, conclusions, recommendations
 *
 * @param {string} output - Raw agent output
 * @param {number} [maxLen=1200] - Max total length
 * @returns {string}
 */
function extractOutputSummary(output, maxLen = 1200) {
  if (!output || output.length <= maxLen) return output || '';

  // Adaptive head/tail sizes — scale down for small maxLen
  const HEAD_LEN = Math.min(200, Math.floor(maxLen * 0.25));
  const TAIL_LEN = Math.min(600, Math.floor(maxLen * 0.6));
  const KEY_BUDGET = Math.max(0, maxLen - HEAD_LEN - TAIL_LEN - 40);

  const head = output.slice(0, HEAD_LEN);
  const tail = output.slice(-TAIL_LEN);

  // Extract key signal lines from the middle (skip head/tail zones)
  let keyLines = '';
  if (KEY_BUDGET > 0 && output.length > HEAD_LEN + TAIL_LEN) {
    const middleZone = output.slice(HEAD_LEN, -TAIL_LEN);
    const signalRe = /(?:结论|conclusion|found that|result|决定|recommend|建议|发现|关键|key finding|error|OOM|failed|chose|decided|switched|important|注意|warning)/i;
    keyLines = middleZone.split('\n')
      .filter(line => line.trim().length > 15 && signalRe.test(line))
      .slice(0, 5)
      .join('\n')
      .slice(0, KEY_BUDGET);
  }

  const parts = [head.trimEnd()];
  if (keyLines) parts.push('[...key findings...]', keyLines);
  else parts.push('[...]');
  parts.push(tail.trimStart());

  return parts.join('\n').slice(0, maxLen);
}

// ── Main handler ────────────────────────────────────────────────

/**
 * Handle reactive agent output. Called from outputHandler in dispatchTask.
 * Responsible for: signal parsing, budget gate, depth gate, completion,
 * constructing follow-up dispatches.
 *
 * @param {string} targetProject - The project key that produced the output
 * @param {string} output        - Raw output text
 * @param {object} config        - Full daemon config
 * @param {object} deps          - Injected dependencies
 * @param {Function} deps.log              - (level, msg) => void
 * @param {Function} deps.loadState        - () => state
 * @param {Function} deps.saveState        - (state) => void
 * @param {Function} deps.checkBudget      - (config, state) => boolean
 * @param {Function} deps.handleDispatchItem - (item, config) => result
 * @param {Function} [deps.notifyUser]     - (msg) => void (Feishu notification)
 * @param {Function} [deps.runVerifier]    - (projectKey, config) => {passed,phase,details,artifacts,hints} | null
 * @param {string}   [deps.metameDir]      - Override ~/.metame path (for testing)
 */
function handleReactiveOutput(targetProject, output, config, deps) {
  if (!config || !config.projects) return;

  // Scoped event logger — uses deps.metameDir for test isolation
  const logEvent = (key, event) => appendEvent(key, event, deps.metameDir);

  // Resolve manifest for completion signal
  const projectCwd = isReactiveParent(targetProject, config)
    ? resolveProjectCwd(targetProject, config)
    : resolveProjectCwd(findReactiveParent(targetProject, config), config);
  const manifest = projectCwd ? loadProjectManifest(projectCwd) : null;
  const completionSignal = manifest?.completion_signal || 'MISSION_COMPLETE';

  const signals = parseReactiveSignals(output, completionSignal);
  const hasSignals = signals.directives.length > 0 || signals.complete;

  // ── Case 1: targetProject is a reactive parent ──
  if (isReactiveParent(targetProject, config)) {
    const projectKey = targetProject;
    const pName = config.projects[projectKey]?.name || projectKey;
    const st = deps.loadState();
    const rs = getReactiveState(st, projectKey);
    const maxRetries = manifest?.no_signal_max_retries || 3;

    const decision = calculateNextAction({
      hasSignals,
      isComplete: signals.complete,
      noSignalCount: rs._no_signal_count || 0,
      maxRetries,
    });

    rs._no_signal_count = decision.nextNoSignalCount;

    if (decision.action === 'pause') {
      setReactiveStatus(st, projectKey, 'paused', decision.pauseReason);
      deps.saveState(st);
      logEvent(projectKey, { type: 'NO_SIGNAL_PAUSE', count: decision.nextNoSignalCount });
      if (deps.notifyUser) {
        deps.notifyUser(`\u26a0\ufe0f ${pName} continuous ${maxRetries} rounds without signal, paused`);
      }
      return;
    }

    if (decision.action === 'retry') {
      deps.saveState(st);
      logEvent(projectKey, { type: 'NO_SIGNAL_RETRY', count: decision.nextNoSignalCount, output_length: output.length });
      const maxDepthForRetry = manifest?.max_depth || rs.max_depth || 50;
      const workingMemory = loadWorkingMemory(projectKey, deps.metameDir);
      deps.handleDispatchItem({
        target: projectKey,
        prompt: buildReactivePrompt(
          'Check progress and continue executing the task.',
          { depth: rs.depth, maxDepth: maxDepthForRetry, completionSignal, workingMemory, isRetry: true }
        ),
        from: '_system',
        _reactive: true,
        _reactive_project: projectKey,
        new_session: true,
      }, config);
      return;
    }

    // decision.action === 'proceed' — reset no-signal count, continue normal flow

    // Mission complete takes priority
    if (signals.complete) {
      deps.log('INFO', `Reactive: ${projectKey} mission completed`);
      setReactiveStatus(st, projectKey, 'completed', '');
      st.reactive[projectKey].depth = 0;
      rs.last_signal = 'MISSION_COMPLETE';
      deps.saveState(st);
      logEvent(projectKey, { type: 'MISSION_COMPLETE' });

      // Run completion hooks (archive + next mission)
      const pCwd = resolveProjectCwd(projectKey, config);
      if (pCwd) {
        const completionResult = runCompletionHooks(projectKey, pCwd, deps);
        if (completionResult.archived) {
          logEvent(projectKey, { type: 'ARCHIVE', path: pCwd });
        }
        const notifyMsg = completionResult.nextMission
          ? `\u2705 ${pName} mission completed. Next: ${completionResult.nextMission}`
          : `\u2705 ${pName} mission completed. No pending missions — entering idle.`;
        if (deps.notifyUser) deps.notifyUser(notifyMsg);

        // Auto-start next mission if available — requires budget to be OK
        if (completionResult.nextMission && completionResult.nextMissionPrompt) {
          if (!deps.checkBudget(config, st)) {
            deps.log('WARN', `Reactive: budget exceeded, skipping auto-start for ${projectKey}`);
            logEvent(projectKey, { type: 'BUDGET_LIMIT', action: 'skip_next_mission' });
            if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f Next mission "${completionResult.nextMission}" ready but budget exceeded`);
          } else {
            deps.log('INFO', `Reactive: auto-starting next mission for ${projectKey}: ${completionResult.nextMission}`);
            logEvent(projectKey, { type: 'MISSION_START', mission_id: completionResult.nextMissionId || '', mission_title: completionResult.nextMission });
            setReactiveStatus(st, projectKey, 'running', '');
            st.reactive[projectKey].depth = 0;
            deps.saveState(st);
            deps.handleDispatchItem({
              target: projectKey,
              prompt: completionResult.nextMissionPrompt,
              from: '_system',
              _reactive: true,
              _reactive_project: projectKey,
              new_session: true,
            }, config);
          }
        }
      } else {
        if (deps.notifyUser) deps.notifyUser(`\u2705 ${pName} mission completed`);
      }
      return;
    }

    // NEXT_DISPATCH processing
    rs.last_signal = 'NEXT_DISPATCH';

    // Budget gate
    if (!deps.checkBudget(config, st)) {
      deps.log('WARN', `Reactive: budget exceeded, pausing ${projectKey}`);
      setReactiveStatus(st, projectKey, 'paused', 'budget_exceeded');
      deps.saveState(st);
      logEvent(projectKey, { type: 'BUDGET_LIMIT', action: 'paused' });
      if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: daily budget exceeded`);
      return;
    }

    // Depth gate (manifest max_depth overrides default)
    const maxDepth = manifest?.max_depth || rs.max_depth || 50;
    if (rs.depth >= maxDepth) {
      deps.log('WARN', `Reactive: depth ${rs.depth} >= ${maxDepth}, pausing ${projectKey}`);
      setReactiveStatus(st, projectKey, 'paused', 'depth_exceeded');
      deps.saveState(st);
      logEvent(projectKey, { type: 'DEPTH_LIMIT', depth: rs.depth, action: 'paused' });
      if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: depth limit ${maxDepth} reached`);
      return;
    }

    rs.depth += 1;
    rs.status = 'running';
    rs.updated_at = new Date().toISOString();
    deps.saveState(st);

    // Dispatch each directive with fresh session
    const workingMemory = loadWorkingMemory(projectKey, deps.metameDir);
    for (const d of signals.directives) {
      logEvent(projectKey, { type: 'DISPATCH', target: d.target, prompt: d.prompt.slice(0, 200) });
      deps.handleDispatchItem({
        target: d.target,
        prompt: buildReactivePrompt(d.prompt, {
          depth: rs.depth, maxDepth, completionSignal, workingMemory,
        }),
        from: projectKey,
        _reactive: true,
        _reactive_project: projectKey,
        new_session: true,
      }, config);
    }

    // Point B: Persist memory after parent dispatches
    try { persistMemoryFiles(projectKey, config, deps); } catch { /* non-critical */ }

    return;
  }

  // ── Case 2: targetProject is a team member of a reactive parent ──
  const parentKey = findReactiveParent(targetProject, config);
  if (!parentKey || !isReactiveParent(parentKey, config)) return;

  const pName = config.projects[parentKey]?.name || parentKey;
  const st = deps.loadState();

  // Budget gate
  if (!deps.checkBudget(config, st)) {
    deps.log('WARN', `Reactive: budget exceeded, pausing ${parentKey} (via member ${targetProject})`);
    setReactiveStatus(st, parentKey, 'paused', 'budget_exceeded');
    deps.saveState(st);
    logEvent(parentKey, { type: 'BUDGET_LIMIT', action: 'paused', trigger: targetProject });
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: daily budget exceeded`);
    return;
  }

  // Depth gate (manifest max_depth overrides default)
  const rs = getReactiveState(st, parentKey);
  const maxDepth = manifest?.max_depth || rs.max_depth || 50;
  if (rs.depth >= maxDepth) {
    deps.log('WARN', `Reactive: depth ${rs.depth} >= ${maxDepth}, pausing ${parentKey} (via member ${targetProject})`);
    setReactiveStatus(st, parentKey, 'paused', 'depth_exceeded');
    deps.saveState(st);
    logEvent(parentKey, { type: 'DEPTH_LIMIT', depth: rs.depth, action: 'paused' });
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: depth limit ${maxDepth} reached`);
    return;
  }

  rs.depth += 1;
  rs.status = 'running';
  rs.last_signal = 'MEMBER_COMPLETE';
  rs.updated_at = new Date().toISOString();
  deps.saveState(st);
  logEvent(parentKey, { type: 'MEMBER_COMPLETE', member: targetProject, summary_length: output.length });

  // Run verifier if available
  const verifyResult = deps.runVerifier
    ? deps.runVerifier(parentKey, config)
    : runProjectVerifier(parentKey, config, deps);

  // Log verifier result as event
  if (verifyResult) {
    logEvent(parentKey, {
      type: 'PHASE_GATE',
      phase: verifyResult.phase || '',
      passed: !!verifyResult.passed,
      details: (verifyResult.details || '').slice(0, 500),
      artifacts: verifyResult.artifacts || [],
    });
  }

  // DESIGN CONTRACT: Error Semantic Isolation
  // If verifier reports infrastructure failure (_infraFailure),
  // pause the project and notify user — do NOT blame the agent.
  if (verifyResult?._infraFailure) {
    deps.log('WARN', `Verifier infra failure for ${parentKey}: ${verifyResult.details}`);
    setReactiveStatus(st, parentKey, 'paused', 'infra_failure');
    deps.saveState(st);
    logEvent(parentKey, { type: 'INFRA_PAUSE', details: verifyResult.details });
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: external API unavailable. Not an agent error.`);
    return; // Do NOT wake agent
  }

  // Update progress.tsv projection
  const parentCwd = resolveProjectCwd(parentKey, config);
  if (parentCwd) {
    try { projectProgressTsv(parentCwd, parentKey, deps.metameDir); } catch { /* non-critical */ }
  }

  const verifierBlock = verifyResult
    ? `\n\n[Verifier] phase=${verifyResult.phase} passed=${verifyResult.passed}\n${verifyResult.details}${verifyResult.hints?.length ? '\nHints: ' + verifyResult.hints.join('; ') : ''}`
    : '\n\n[Verifier] not configured — proceed with caution';

  // Generate state file from event log BEFORE waking parent (event sourcing projection)
  if (parentCwd) {
    try { generateStateFile(parentKey, config, deps); } catch { /* non-critical */ }
  }

  // Point A: Persist memory + extract inline facts after verifier, before waking parent
  const phaseChanged = verifyResult?.passed && !!verifyResult?.phase;
  try { persistMemoryFiles(parentKey, config, deps, { phaseChanged }); } catch { /* non-critical */ }

  // Inline fact extraction from member output
  try {
    const inlineFacts = extractInlineFacts(parentKey, output, verifyResult?.phase);
    if (inlineFacts.length > 0) {
      const memory = require('./memory');
      memory.acquire();
      try {
        memory.saveFacts(`reactive-${parentKey}-${Date.now()}`, parentKey, inlineFacts);
      } finally {
        memory.release();
      }
    }
  } catch { /* non-critical */ }

  // Trigger parent with member's output summary (tail-biased extraction)
  const parentManifest = parentCwd ? loadProjectManifest(parentCwd) : null;
  const signal = parentManifest?.completion_signal || 'MISSION_COMPLETE';
  const summary = extractOutputSummary(output);
  const parentWorkingMemory = loadWorkingMemory(parentKey, deps.metameDir);
  deps.handleDispatchItem({
    target: parentKey,
    prompt: buildReactivePrompt(
      `[${targetProject} delivery]${verifierBlock}\n\n${summary}\n\nDecide next step.`,
      { depth: rs.depth, maxDepth: manifest?.max_depth || rs.max_depth || 50, completionSignal: signal, workingMemory: parentWorkingMemory }
    ),
    from: targetProject,
    _reactive: true,
    _reactive_project: parentKey,
    new_session: true,
  }, config);
}

module.exports = {
  handleReactiveOutput,
  parseReactiveSignals,
  reconcilePerpetualProjects,
  replayEventLog,
  __test: { runProjectVerifier, readPhaseFromState, resolveProjectCwd, appendEvent, projectProgressTsv, generateStateFile, loadProjectManifest, resolveProjectScripts, parseEventLog, buildRunningMemory, scanRelevantArtifacts, buildWorkingMemory, persistMemoryFiles, extractInlineFacts, extractOutputSummary, isReactiveExecutionActive, loadWorkingMemory },
};
