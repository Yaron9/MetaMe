'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

/**
 * daemon-reactive-lifecycle.js — Reactive Loop Lifecycle Module
 *
 * Extracts reactive dispatch logic from daemon.js into a testable,
 * self-contained module with four hard gates:
 *   1. Budget gate   — pauses loop when daily budget exhausted
 *   2. Depth gate    — pauses loop when depth counter hits max
 *   3. Fresh session — every reactive dispatch uses new_session: true
 *   4. RESEARCH_COMPLETE — resets depth, marks completed, notifies user
 *   5. Verifier hook — runs project verifier before waking parent
 */

// ── Signal parsing ──────────────────────────────────────────────

// Supports two formats (both common in LLM output):
//   NEXT_DISPATCH: target "prompt here"           (quoted, single-line)
//   NEXT_DISPATCH: target: prompt here             (colon-separated, until next directive or end)
const QUOTED_RE = /NEXT_DISPATCH:\s*(\S+)\s+"([^"]+)"/g;
const COLON_RE = /NEXT_DISPATCH\s*:\s*(\w+)\s*:\s*(.+?)(?=\nNEXT_DISPATCH\s*:|$)/gs;
const RESEARCH_COMPLETE_RE = /RESEARCH_COMPLETE/;

/**
 * Parse reactive signals from agent output.
 * Pure function — no side effects.
 *
 * @param {string} output - Raw agent output text
 * @returns {{ directives: Array<{target: string, prompt: string}>, complete: boolean }}
 */
function parseReactiveSignals(output) {
  const directives = [];
  let match;
  // Try quoted format first (preferred, documented in CLAUDE.md)
  QUOTED_RE.lastIndex = 0;
  while ((match = QUOTED_RE.exec(output)) !== null) {
    const target = match[1].trim();
    const prompt = match[2].trim();
    if (target && prompt) directives.push({ target, prompt });
  }
  // Fallback: colon-separated format (tolerant of LLM variation)
  if (directives.length === 0) {
    COLON_RE.lastIndex = 0;
    while ((match = COLON_RE.exec(output)) !== null) {
      const target = match[1].trim();
      const prompt = match[2].trim();
      if (target && prompt) directives.push({ target, prompt });
    }
  }
  const complete = RESEARCH_COMPLETE_RE.test(output);
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

  const verifierPath = path.join(projectCwd, 'scripts', 'research-verifier.js');
  if (!fs.existsSync(verifierPath)) return null;

  const statePath = path.join(
    deps.metameDir || path.join(os.homedir(), '.metame'),
    'memory', 'now', `${projectKey}.md`
  );
  const phase = readPhaseFromState(statePath);

  try {
    const output = execSync('node scripts/research-verifier.js', {
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
    return { passed: false, phase: phase || 'unknown', details: `verifier_error: ${e.message.slice(0, 200)}`, artifacts: [], hints: ['验证器执行失败，请检查 verifier 脚本'] };
  }
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

  const signals = parseReactiveSignals(output);
  const hasSignals = signals.directives.length > 0 || signals.complete;

  // ── Case 1: targetProject is a reactive parent ──
  if (isReactiveParent(targetProject, config)) {
    if (!hasSignals) return;

    const projectKey = targetProject;
    const st = deps.loadState();
    const rs = getReactiveState(st, projectKey);

    // RESEARCH_COMPLETE takes priority
    if (signals.complete) {
      deps.log('INFO', `Reactive: ${projectKey} research completed`);
      setReactiveStatus(st, projectKey, 'completed', '');
      st.reactive[projectKey].depth = 0;
      rs.last_signal = 'RESEARCH_COMPLETE';
      deps.saveState(st);
      if (deps.notifyUser) deps.notifyUser('\u2705 \u79d1\u7814\u8bfe\u9898\u5df2\u5b8c\u6210');
      return;
    }

    // NEXT_DISPATCH processing
    rs.last_signal = 'NEXT_DISPATCH';

    // Budget gate
    if (!deps.checkBudget(config, st)) {
      deps.log('WARN', `Reactive: budget exceeded, pausing ${projectKey}`);
      setReactiveStatus(st, projectKey, 'paused', 'budget_exceeded');
      deps.saveState(st);
      if (deps.notifyUser) deps.notifyUser('\u26a0\ufe0f \u79d1\u7814\u5faa\u73af\u5df2\u6682\u505c\uff1a\u4eca\u65e5\u9884\u7b97\u5df2\u8017\u5c3d');
      return;
    }

    // Depth gate
    const maxDepth = rs.max_depth || 50;
    if (rs.depth >= maxDepth) {
      deps.log('WARN', `Reactive: depth ${rs.depth} >= ${maxDepth}, pausing ${projectKey}`);
      setReactiveStatus(st, projectKey, 'paused', 'depth_exceeded');
      deps.saveState(st);
      if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f \u79d1\u7814\u5faa\u73af\u5df2\u6682\u505c\uff1a\u5faa\u73af\u6df1\u5ea6\u8fbe\u5230\u4e0a\u9650 ${maxDepth}`);
      return;
    }

    rs.depth += 1;
    rs.status = 'running';
    rs.updated_at = new Date().toISOString();
    deps.saveState(st);

    // Dispatch each directive with fresh session
    for (const d of signals.directives) {
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

  const st = deps.loadState();

  // Budget gate
  if (!deps.checkBudget(config, st)) {
    deps.log('WARN', `Reactive: budget exceeded, pausing ${parentKey} (via member ${targetProject})`);
    setReactiveStatus(st, parentKey, 'paused', 'budget_exceeded');
    deps.saveState(st);
    if (deps.notifyUser) deps.notifyUser('\u26a0\ufe0f \u79d1\u7814\u5faa\u73af\u5df2\u6682\u505c\uff1a\u4eca\u65e5\u9884\u7b97\u5df2\u8017\u5c3d');
    return;
  }

  // Depth gate
  const rs = getReactiveState(st, parentKey);
  const maxDepth = rs.max_depth || 50;
  if (rs.depth >= maxDepth) {
    deps.log('WARN', `Reactive: depth ${rs.depth} >= ${maxDepth}, pausing ${parentKey} (via member ${targetProject})`);
    setReactiveStatus(st, parentKey, 'paused', 'depth_exceeded');
    deps.saveState(st);
    if (deps.notifyUser) deps.notifyUser(`\u26a0\ufe0f \u79d1\u7814\u5faa\u73af\u5df2\u6682\u505c\uff1a\u5faa\u73af\u6df1\u5ea6\u8fbe\u5230\u4e0a\u9650 ${maxDepth}`);
    return;
  }

  rs.depth += 1;
  rs.status = 'running';
  rs.last_signal = 'MEMBER_COMPLETE';
  rs.updated_at = new Date().toISOString();
  deps.saveState(st);

  // Run verifier if available
  const verifyResult = deps.runVerifier
    ? deps.runVerifier(parentKey, config)
    : runProjectVerifier(parentKey, config, deps);

  const verifierBlock = verifyResult
    ? `\n\n[验证门结果] phase=${verifyResult.phase} passed=${verifyResult.passed}\n${verifyResult.details}${verifyResult.hints?.length ? '\n建议: ' + verifyResult.hints.join('; ') : ''}`
    : '\n\n[验证门结果] passed=false\n验证器未配置或不可用，请谨慎推进阶段';

  // Trigger parent with member's output summary
  const summary = output.slice(0, 1200);
  deps.handleDispatchItem({
    target: parentKey,
    prompt: `[团队成员交付] ${targetProject} 完成任务。\n\n产出摘要:\n${summary}${verifierBlock}\n\n请阅读产出，评估质量，更新 now/${parentKey}.md，然后决定下一步。\n如需派发新任务，在回复末尾使用 NEXT_DISPATCH 指令。如研究全部完成，输出 RESEARCH_COMPLETE。`,
    from: targetProject,
    _reactive: true,
    new_session: true,
  }, config);
}

module.exports = {
  handleReactiveOutput,
  parseReactiveSignals,
  __test: { runProjectVerifier, readPhaseFromState, resolveProjectCwd },
};
