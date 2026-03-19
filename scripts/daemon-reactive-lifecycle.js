'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const EVENTS_DIR = path.join(os.homedir(), '.metame', 'events');

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
 *   6. Event sourcing — all state changes logged to ~/.metame/events/
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
 * Run project-level verifier script if it exists.
 * Returns parsed JSON result or null if no verifier / error.
 */
function runProjectVerifier(projectKey, config, deps) {
  const projectCwd = resolveProjectCwd(projectKey, config);
  if (!projectCwd) return null;

  const manifest = loadProjectManifest(projectCwd);
  const scripts = resolveProjectScripts(projectCwd, manifest);
  if (!fs.existsSync(scripts.verifier)) return null;

  const statePath = path.join(
    deps.metameDir || path.join(os.homedir(), '.metame'),
    'memory', 'now', `${projectKey}.md`
  );
  const phase = readPhaseFromState(statePath);
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
      const statePath = path.join(
        deps.metameDir || path.join(os.homedir(), '.metame'),
        'memory', 'now', `${projectKey}.md`
      );
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
 * Daemon-exclusive: agents cannot write to ~/.metame/events/.
 */
function appendEvent(projectKey, event) {
  fs.mkdirSync(EVENTS_DIR, { recursive: true });
  const logPath = path.join(EVENTS_DIR, `${projectKey}.jsonl`);
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
  const logPath = path.join(EVENTS_DIR, `${projectKey}.jsonl`);
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
function projectProgressTsv(projectCwd, projectKey) {
  const tsvPath = path.join(projectCwd, 'workspace', 'progress.tsv');
  const header = 'phase\tresult\tverifier_passed\tartifact\ttimestamp\tnotes\n';

  const logPath = path.join(EVENTS_DIR, `${projectKey}.jsonl`);
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
  const statePath = path.join(metameDir, 'memory', 'now', projectKey + '.md');

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
    if (!hasSignals) return;

    const projectKey = targetProject;
    const pName = config.projects[projectKey]?.name || projectKey;
    const st = deps.loadState();
    const rs = getReactiveState(st, projectKey);

    // Mission complete takes priority
    if (signals.complete) {
      deps.log('INFO', `Reactive: ${projectKey} mission completed`);
      setReactiveStatus(st, projectKey, 'completed', '');
      st.reactive[projectKey].depth = 0;
      rs.last_signal = 'MISSION_COMPLETE';
      deps.saveState(st);
      appendEvent(projectKey, { type: 'MISSION_COMPLETE' });

      // Run completion hooks (archive + next mission)
      const pCwd = resolveProjectCwd(projectKey, config);
      if (pCwd) {
        const completionResult = runCompletionHooks(projectKey, pCwd, deps);
        if (completionResult.archived) {
          appendEvent(projectKey, { type: 'ARCHIVE', path: pCwd });
        }
        const notifyMsg = completionResult.nextMission
          ? `\u2705 ${pName} mission completed. Next: ${completionResult.nextMission}`
          : `\u2705 ${pName} mission completed. No pending missions — entering idle.`;
        if (deps.notifyUser) deps.notifyUser(notifyMsg);

        // Auto-start next mission if available — requires budget to be OK
        if (completionResult.nextMission && completionResult.nextMissionPrompt) {
          if (!deps.checkBudget(config, st)) {
            deps.log('WARN', `Reactive: budget exceeded, skipping auto-start for ${projectKey}`);
            appendEvent(projectKey, { type: 'BUDGET_LIMIT', action: 'skip_next_mission' });
            if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f Next mission "${completionResult.nextMission}" ready but budget exceeded`);
          } else {
            deps.log('INFO', `Reactive: auto-starting next mission for ${projectKey}: ${completionResult.nextMission}`);
            appendEvent(projectKey, { type: 'MISSION_START', mission_id: completionResult.nextMissionId || '', mission_title: completionResult.nextMission });
            setReactiveStatus(st, projectKey, 'running', '');
            st.reactive[projectKey].depth = 0;
            deps.saveState(st);
            deps.handleDispatchItem({
              target: projectKey,
              prompt: completionResult.nextMissionPrompt,
              from: '_system',
              _reactive: true,
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
      appendEvent(projectKey, { type: 'BUDGET_LIMIT', action: 'paused' });
      if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: daily budget exceeded`);
      return;
    }

    // Depth gate (manifest max_depth overrides default)
    const maxDepth = manifest?.max_depth || rs.max_depth || 50;
    if (rs.depth >= maxDepth) {
      deps.log('WARN', `Reactive: depth ${rs.depth} >= ${maxDepth}, pausing ${projectKey}`);
      setReactiveStatus(st, projectKey, 'paused', 'depth_exceeded');
      deps.saveState(st);
      appendEvent(projectKey, { type: 'DEPTH_LIMIT', depth: rs.depth, action: 'paused' });
      if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: depth limit ${maxDepth} reached`);
      return;
    }

    rs.depth += 1;
    rs.status = 'running';
    rs.updated_at = new Date().toISOString();
    deps.saveState(st);

    // Dispatch each directive with fresh session
    for (const d of signals.directives) {
      appendEvent(projectKey, { type: 'DISPATCH', target: d.target, prompt: d.prompt.slice(0, 200) });
      deps.handleDispatchItem({
        target: d.target,
        prompt: d.prompt,
        from: projectKey,
        _reactive: true,
        new_session: true,
      }, config);
    }
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
    appendEvent(parentKey, { type: 'BUDGET_LIMIT', action: 'paused', trigger: targetProject });
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: daily budget exceeded`);
    return;
  }

  // Depth gate (manifest max_depth overrides default)
  const rs = getReactiveState(st, parentKey);
  const parentManifestForDepth = projectCwd ? loadProjectManifest(projectCwd) : null;
  const maxDepth = parentManifestForDepth?.max_depth || rs.max_depth || 50;
  if (rs.depth >= maxDepth) {
    deps.log('WARN', `Reactive: depth ${rs.depth} >= ${maxDepth}, pausing ${parentKey} (via member ${targetProject})`);
    setReactiveStatus(st, parentKey, 'paused', 'depth_exceeded');
    deps.saveState(st);
    appendEvent(parentKey, { type: 'DEPTH_LIMIT', depth: rs.depth, action: 'paused' });
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: depth limit ${maxDepth} reached`);
    return;
  }

  rs.depth += 1;
  rs.status = 'running';
  rs.last_signal = 'MEMBER_COMPLETE';
  rs.updated_at = new Date().toISOString();
  deps.saveState(st);
  appendEvent(parentKey, { type: 'MEMBER_COMPLETE', member: targetProject, summary_length: output.length });

  // Run verifier if available
  const verifyResult = deps.runVerifier
    ? deps.runVerifier(parentKey, config)
    : runProjectVerifier(parentKey, config, deps);

  // Log verifier result as event
  if (verifyResult) {
    appendEvent(parentKey, {
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
    appendEvent(parentKey, { type: 'INFRA_PAUSE', details: verifyResult.details });
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f ${pName} paused: external API unavailable. Not an agent error.`);
    return; // Do NOT wake agent
  }

  // Update progress.tsv projection
  const parentCwd = resolveProjectCwd(parentKey, config);
  if (parentCwd) {
    try { projectProgressTsv(parentCwd, parentKey); } catch { /* non-critical */ }
  }

  const verifierBlock = verifyResult
    ? `\n\n[Verifier] phase=${verifyResult.phase} passed=${verifyResult.passed}\n${verifyResult.details}${verifyResult.hints?.length ? '\nHints: ' + verifyResult.hints.join('; ') : ''}`
    : '\n\n[Verifier] not configured — proceed with caution';

  // Generate state file from event log BEFORE waking parent (event sourcing projection)
  if (parentCwd) {
    try { generateStateFile(parentKey, config, deps); } catch { /* non-critical */ }
  }

  // Trigger parent with member's output summary
  const parentManifest = parentCwd ? loadProjectManifest(parentCwd) : null;
  const signal = parentManifest?.completion_signal || 'MISSION_COMPLETE';
  const summary = output.slice(0, 1200);
  deps.handleDispatchItem({
    target: parentKey,
    prompt: `[Team delivery] ${targetProject} completed task.\n\nOutput summary:\n${summary}${verifierBlock}\n\nEvaluate quality and decide next step.\nTo dispatch tasks, use NEXT_DISPATCH.\nWhen all tasks are done, output ${signal}.`,
    from: targetProject,
    _reactive: true,
    new_session: true,
  }, config);
}

module.exports = {
  handleReactiveOutput,
  parseReactiveSignals,
  __test: { runProjectVerifier, readPhaseFromState, resolveProjectCwd, appendEvent, replayEventLog, projectProgressTsv, generateStateFile, loadProjectManifest, resolveProjectScripts },
};
