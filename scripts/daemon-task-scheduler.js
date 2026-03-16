'use strict';

const crypto = require('crypto');
const { classifyTaskUsage } = require('./usage-classifier');

const WEEKDAY_INDEX = Object.freeze({
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
});

function parseAtTime(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function parseDays(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, days: null };

  let tokens = [];
  if (Array.isArray(raw)) {
    tokens = raw;
  } else if (typeof raw === 'string') {
    const lower = raw.trim().toLowerCase();
    if (!lower || lower === 'daily' || lower === 'everyday' || lower === 'all') {
      return { ok: true, days: null };
    }
    if (lower === 'weekdays' || lower === 'workdays') {
      return { ok: true, days: new Set([1, 2, 3, 4, 5]) };
    }
    if (lower === 'weekends') {
      return { ok: true, days: new Set([0, 6]) };
    }
    tokens = lower.split(/[\s,|/]+/).filter(Boolean);
  } else {
    return { ok: false, error: 'days must be string or array' };
  }

  const out = new Set();
  for (const token of tokens) {
    let day = null;
    if (typeof token === 'number' && Number.isInteger(token)) {
      day = token;
    } else if (typeof token === 'string' && token.trim()) {
      const t = token.trim().toLowerCase();
      if (/^\d+$/.test(t)) day = Number(t);
      else if (Object.prototype.hasOwnProperty.call(WEEKDAY_INDEX, t)) day = WEEKDAY_INDEX[t];
    }
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return { ok: false, error: `invalid day token: ${String(token)}` };
    }
    out.add(day);
  }

  return { ok: true, days: out.size > 0 ? out : null };
}

function dayAllowed(days, day) {
  if (!days || days.size === 0) return true;
  return days.has(day);
}

function nextClockRunAfter(schedule, fromMs) {
  const baseMs = Number.isFinite(fromMs) ? fromMs : Date.now();
  const start = new Date(baseMs + 1000);
  start.setSeconds(0, 0);

  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(start);
    candidate.setDate(start.getDate() + offset);
    candidate.setHours(schedule.hour, schedule.minute, 0, 0);
    const ts = candidate.getTime();
    if (ts <= baseMs) continue;
    if (!dayAllowed(schedule.days, candidate.getDay())) continue;
    return ts;
  }

  return baseMs + 24 * 60 * 60 * 1000;
}

// Map short aliases and full model IDs to what Claude CLI accepts.
// Claude CLI 2.x accepts both 'sonnet' and 'claude-sonnet-4-6'.
// This normalization keeps daemon.yaml configs forward-compatible.
const MODEL_ALIASES = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'string') return MODEL_ALIASES.haiku;
  const lower = raw.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MODEL_ALIASES, lower)) return MODEL_ALIASES[lower];
  // Already a full model ID (e.g. 'claude-sonnet-4-6') — pass through
  return raw.trim();
}

function buildTaskSchedule(task, parseInterval) {
  const atRaw = typeof task.at === 'string' ? task.at.trim() : '';
  if (atRaw) {
    const at = parseAtTime(atRaw);
    if (!at) return { ok: false, error: `invalid at time "${task.at}"` };
    const parsedDays = parseDays(task.days !== undefined ? task.days : task.weekdays);
    if (!parsedDays.ok) return { ok: false, error: parsedDays.error };
    return {
      ok: true,
      schedule: {
        mode: 'clock',
        hour: at.hour,
        minute: at.minute,
        days: parsedDays.days,
      },
    };
  }

  return {
    ok: true,
    schedule: {
      mode: 'interval',
      intervalSec: parseInterval(task.interval),
    },
  };
}

function nextRunAfter(schedule, fromMs) {
  if (!schedule || schedule.mode !== 'clock') {
    const intervalSec = schedule && Number.isFinite(schedule.intervalSec)
      ? schedule.intervalSec
      : 3600;
    return fromMs + intervalSec * 1000;
  }
  return nextClockRunAfter(schedule, fromMs);
}

function computeInitialNextRun(task, schedule, state, nowMs, checkIntervalSec, newTaskIndex) {
  if (!schedule || schedule.mode !== 'clock') {
    const intervalSec = schedule && Number.isFinite(schedule.intervalSec)
      ? schedule.intervalSec
      : 3600;
    const lastRun = state.tasks[task.name] && state.tasks[task.name].last_run;
    if (lastRun) {
      const elapsed = (nowMs - new Date(lastRun).getTime()) / 1000;
      return nowMs + Math.max(0, (intervalSec - elapsed)) * 1000;
    }
    return nowMs + checkIntervalSec * 1000 * newTaskIndex;
  }

  const lastRun = state.tasks[task.name] && state.tasks[task.name].last_run;
  if (lastRun) {
    const lastMs = new Date(lastRun).getTime();
    if (Number.isFinite(lastMs) && lastMs > 0) {
      const dueAfterLast = nextClockRunAfter(schedule, lastMs);
      if (dueAfterLast <= nowMs) return nowMs;
    }
  }
  return nextClockRunAfter(schedule, nowMs);
}

function createTaskScheduler(deps) {
  const {
    fs,
    path,
    HOME,
    CLAUDE_BIN,
    spawn: _spawn,
    execSync,
    parseInterval,
    loadState,
    saveState,
    checkBudget,
    recordTokens,
    buildProfilePreamble,
    getDaemonProviderEnv,
    getDistillModel,
    log,
    physiologicalHeartbeat,
    isUserIdle,
    isInSleepMode,
    setSleepMode,
    spawnSessionSummaries,
    getWakeRecoveryHook,
    skillEvolution,
  } = deps;

  // Max characters from precondition context to inject into prompts (prevents token bombs)
  const MAX_PRECONDITION_CHARS = 4000;
  // Cap stdout buffer to prevent memory growth in long-running tasks (output_preview uses 200 chars anyway)
  const MAX_STDOUT_BYTES = 1024 * 1024;

  // Shared primitive: spawn a single claude -p invocation with silence watchdog.
  // Resolves to { ok, output, error } — never rejects.
  // label is used only for log messages (e.g. "Task foo" or "Workflow bar step 2").
  function spawnClaude(args, prompt, timeoutMs, cwdPath, label) {
    const env = { ...process.env, ...getDaemonProviderEnv(), CLAUDECODE: undefined, METAME_INTERNAL_PROMPT: '1' };
    return new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, args, {
        cwd: cwdPath || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        env,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let lastActivity = Date.now();
      let sigkillTimer = null;

      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity >= timeoutMs) {
          clearInterval(watchdog);
          timedOut = true;
          log('WARN', `${label} silent for ${timeoutMs / 1000}s — killing`);
          try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
          sigkillTimer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
          }, 5000);
        }
      }, Math.min(timeoutMs, 30000));

      child.stdin.write(prompt);
      child.stdin.end();
      child.stdout.on('data', (d) => { lastActivity = Date.now(); if (stdout.length < MAX_STDOUT_BYTES) stdout += d.toString(); });
      child.stderr.on('data', (d) => { lastActivity = Date.now(); stderr += d.toString(); });

      child.on('close', (code) => {
        clearInterval(watchdog);
        if (sigkillTimer) clearTimeout(sigkillTimer);
        const output = stdout.trim();
        if (timedOut) return resolve({ ok: false, error: 'silent_timeout', output });
        if (code !== 0) return resolve({ ok: false, error: (stderr || `Exit code ${code}`).slice(0, 200), output: '' });
        resolve({ ok: true, output, stderr });
      });

      child.on('error', (err) => {
        clearInterval(watchdog);
        resolve({ ok: false, error: err.message, output: '' });
      });
    });
  }

  // On Windows, resolve .cmd → actual Node.js entry to avoid cmd.exe flash
  function _resolveNodeEntry(cmdPath) {
    try {
      const content = require('fs').readFileSync(cmdPath, 'utf8');
      const m = content.match(/"([^"]+\.js)"\s*%\*\s*$/m);
      if (m) {
        const entry = m[1].replace(/%dp0%/gi, require('path').dirname(cmdPath) + require('path').sep);
        if (require('fs').existsSync(entry)) return entry;
      }
    } catch { /* ignore */ }
    return null;
  }

  function spawn(cmd, args, options) {
    if (process.platform !== 'win32') return _spawn(cmd, args, options);
    const lowerCmd = String(cmd || '').toLowerCase();
    if (lowerCmd.endsWith('.cmd') || lowerCmd.endsWith('.bat') || lowerCmd === 'claude' || lowerCmd === 'codex') {
      const entry = _resolveNodeEntry(cmd);
      if (entry) return _spawn(process.execPath, [entry, ...args], { ...options, windowsHide: true });
      return _spawn(cmd, args, { ...options, shell: process.env.COMSPEC || true, windowsHide: true });
    }
    return _spawn(cmd, args, { ...options, windowsHide: true });
  }

  function checkPrecondition(task) {
    if (!task.precondition) return { pass: true, context: '' };

    try {
      let cmd = task.precondition;

      // Cross-platform: expand ~ to HOME and handle `test -s` via Node.js
      cmd = cmd.replace(/^~|(?<=\s)~/g, HOME);
      // Handle `test -s <file>` natively in JS on ALL platforms.
      // Shell `test -s` produces no stdout on success, which previously
      // caused the empty-output check below to incorrectly skip the task.
      const testMatch = cmd.match(/^test\s+-s\s+(.+)$/);
      if (testMatch) {
        const filePath = testMatch[1].trim().replace(/["']/g, '');
        const fs = require('fs');
        try {
          const content = fs.readFileSync(filePath, 'utf8').trim();
          if (content.length > 0) {
            log('INFO', `Precondition passed for ${task.name} (${content.split('\n').length} lines)`);
            return { pass: true, context: content };
          }
        } catch { /* file doesn't exist or unreadable */ }
        log('INFO', `Precondition failed for ${task.name}: file empty or missing`);
        return { pass: false, context: '' };
      }

      const output = execSync(cmd, {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 64 * 1024,
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
      }).trim();

      if (!output) {
        log('INFO', `Precondition empty for ${task.name}, skipping (zero tokens)`);
        return { pass: false, context: '' };
      }

      log('INFO', `Precondition passed for ${task.name} (${output.split('\n').length} lines)`);
      return { pass: true, context: output };
    } catch (e) {
      // Non-zero exit = precondition failed
      log('INFO', `Precondition failed for ${task.name}: ${e.message.slice(0, 100)}`);
      return { pass: false, context: '' };
    }
  }

  // Timeout compatibility:
  // - numeric values <= 10000 are treated as seconds (recommended)
  // - numeric values > 10000 are treated as legacy milliseconds
  // - string values like "500ms", "30s", "5m", "1h" are supported
  function resolveTimeoutMs(raw, defaultSeconds) {
    if (typeof raw === 'string') {
      const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
      if (m) {
        const v = Number(m[1]);
        const u = m[2].toLowerCase();
        if (u === 'ms') return Math.max(1, Math.floor(v));
        if (u === 's') return Math.max(1, Math.floor(v * 1000));
        if (u === 'm') return Math.max(1, Math.floor(v * 60 * 1000));
        if (u === 'h') return Math.max(1, Math.floor(v * 60 * 60 * 1000));
      }
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return defaultSeconds * 1000;
    if (n > 10000) return Math.floor(n); // legacy ms
    return Math.floor(n * 1000); // default seconds
  }

  function maybeSaveTaskMemory(task, output, tokenCost = 0, sessionId = '') {
    if (!task || !task.memory_log) return;
    try {
      const memory = require('./memory');
      memory.acquire();
      const memoryId = `${task.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      try {
        const nowIso = new Date().toISOString();
        const projectKey = (task._project && task._project.key) || 'heartbeat';
        const summaryText = String(output || '(no output)').trim() || '(no output)';
        const summary = [
          `[heartbeat task] ${task.name}`,
          sessionId ? `session: ${sessionId}` : '',
          summaryText,
        ].filter(Boolean).join('\n').slice(0, 8000);
        const keywords = [task.name, 'heartbeat', 'evolution', nowIso.slice(0, 10)].join(',');
        memory.saveSession({
          sessionId: memoryId,
          project: projectKey,
          summary,
          keywords,
          mood: '',
          tokenCost: Number(tokenCost) || 0,
        });
      } finally {
        memory.release();
      }
      log('INFO', `Task ${task.name}: memory_log saved (${memoryId})`);
    } catch (e) {
      log('WARN', `Task ${task.name}: memory_log failed: ${e.message}`);
    }
  }

  function executeTask(task, config) {
    if (task.enabled === false) {
      log('INFO', `Skipping disabled task: ${task.name}`);
      return { success: true, output: '(disabled)', skipped: true };
    }

    const state = loadState();

    if (!checkBudget(config, state)) {
      log('WARN', `Budget exceeded, skipping task: ${task.name}`);
      return { success: false, error: 'budget_exceeded', output: '', skipped: true };
    }

    // Precondition gate: run a cheap shell check before burning tokens
    const precheck = checkPrecondition(task);
    if (!precheck.pass) {
      // Don't update state — a skipped precondition is not a run.
      // Preserves existing success/error status and keeps last_run accurate
      // so interval math in computeInitialNextRun stays correct.
      return { success: true, output: '(skipped — no activity)', skipped: true };
    }

    // Workflow tasks: multi-step skill chain via --resume session
    if (task.type === 'workflow') {
      return executeWorkflow(task, config, precheck);
    }

    // Script tasks: run a local script directly (e.g. distill.js), no claude -p
    if (task.type === 'script') {
      const scriptCmd = task.command.replace(/^~|(?<=\s)~/g, HOME);
      log('INFO', `Executing script task: ${task.name} → ${scriptCmd}`);
      try {
        const scriptEnv = {
          ...process.env,
          METAME_ROOT: process.env.METAME_ROOT || '',
          METAME_INTERNAL_PROMPT: '1',
        };
        delete scriptEnv.CLAUDECODE;
        const output = execSync(scriptCmd, {
          encoding: 'utf8',
          timeout: resolveTimeoutMs(task.timeout, 120),
          maxBuffer: 1024 * 1024,
          env: scriptEnv,
          ...(process.platform === 'win32' ? { windowsHide: true } : {}),
        }).trim();

        // Parse token report from script stdout: last line matching __TOKENS__:<number>
        // Scripts that call LLM APIs should print this before exiting.
        // Fallback: estimate from output length (rough, but better than 0).
        let scriptTokens = 0;
        const tokenMatch = output.match(/__TOKENS__:(\d+)/);
        if (tokenMatch) {
          scriptTokens = Number(tokenMatch[1]);
        } else if (output.length > 100) {
          // Conservative estimate for scripts that don't self-report
          scriptTokens = Math.ceil(output.length / 4);
        }
        if (scriptTokens > 0) {
          recordTokens(state, scriptTokens, { category: classifyTaskUsage(task) });
        }

        state.tasks[task.name] = {
          last_run: new Date().toISOString(),
          status: 'success',
          output_preview: output.slice(0, 200),
        };
        saveState(state);
        if (output) log('INFO', `Script task ${task.name} completed (${scriptTokens} tokens): ${output.slice(0, 300)}`);
        else log('INFO', `Script task ${task.name} completed`);
        return { success: true, output, tokens: scriptTokens };
      } catch (e) {
        log('ERROR', `Script task ${task.name} failed: ${e.message}`);
        state.tasks[task.name] = {
          last_run: new Date().toISOString(),
          status: 'error',
          error: e.message.slice(0, 200),
        };
        saveState(state);
        return { success: false, error: e.message, output: '' };
      }
    }

    const preamble = buildProfilePreamble();
    const model = normalizeModel(task.model || getDistillModel());
    // If precondition returned context data, append it to the prompt (truncated to prevent token bombs)
    let taskPrompt = task.prompt;
    if (precheck.context) {
      const ctx = precheck.context.length > MAX_PRECONDITION_CHARS
        ? precheck.context.slice(0, MAX_PRECONDITION_CHARS) + '\n... (truncated)'
        : precheck.context;
      taskPrompt += `\n\n以下是相关原始数据:\n\`\`\`\n${ctx}\n\`\`\``;
    }
    const fullPrompt = preamble + taskPrompt;

    const claudeArgs = ['-p', '--model', model, '--dangerously-skip-permissions'];
    for (const t of (task.allowedTools || [])) claudeArgs.push('--allowedTools', t);
    // Auto-detect MCP config in task cwd or project directory
    const cwd = task.cwd ? task.cwd.replace(/^~/, HOME) : undefined;
    const mcpConfig = task.mcp_config
      ? path.resolve(task.mcp_config.replace(/^~/, HOME))
      : cwd && fs.existsSync(path.join(cwd, '.mcp.json'))
        ? path.join(cwd, '.mcp.json')
        : null;
    if (mcpConfig) claudeArgs.push('--mcp-config', mcpConfig);

    // Persistent session: reuse same session across runs (for tasks like weekly-review)
    if (task.persistent_session) {
      const meta = state.tasks[task.name] || {};
      const savedSessionId = meta.session_id;
      const rotateDays = Number(task.persistent_session_rotate_days || 0);
      const rotateMs = Number.isFinite(rotateDays) && rotateDays > 0
        ? rotateDays * 24 * 60 * 60 * 1000
        : 0;
      let createdAtIso = meta.session_created_at || '';
      // Backfill legacy state so old persistent sessions don't rotate immediately after upgrade.
      if (!createdAtIso && savedSessionId) {
        createdAtIso = meta.last_run || new Date().toISOString();
        if (!state.tasks[task.name]) state.tasks[task.name] = {};
        state.tasks[task.name].session_created_at = createdAtIso;
        saveState(state);
      }
      const createdAtMs = createdAtIso ? new Date(createdAtIso).getTime() : 0;
      const shouldRotate = !!(
        savedSessionId &&
        rotateMs > 0 &&
        (!createdAtMs || (Date.now() - createdAtMs) >= rotateMs)
      );

      if (savedSessionId && !shouldRotate) {
        claudeArgs.push('--resume', savedSessionId);
        log('INFO', `Executing task: ${task.name} (model: ${model}, resuming session ${savedSessionId.slice(0, 8)}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
      } else {
        const newSessionId = crypto.randomUUID();
        claudeArgs.push('--session-id', newSessionId);
        if (!state.tasks[task.name]) state.tasks[task.name] = {};
        state.tasks[task.name].session_id = newSessionId;
        state.tasks[task.name].session_created_at = new Date().toISOString();
        saveState(state);
        if (savedSessionId && shouldRotate) {
          log('INFO', `Executing task: ${task.name} (model: ${model}, rotated session ${savedSessionId.slice(0, 8)} -> ${newSessionId.slice(0, 8)}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
        } else {
          log('INFO', `Executing task: ${task.name} (model: ${model}, new session ${newSessionId.slice(0, 8)}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
        }
      }
    } else {
      log('INFO', `Executing task: ${task.name} (model: ${model}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
    }

    const timeoutMs = resolveTimeoutMs(task.timeout, 1800);
    return spawnClaude(claudeArgs, fullPrompt, timeoutMs, cwd, `Task ${task.name}`).then((result) => {
      const { output } = result;
      const prevSid = state.tasks[task.name]?.session_id;
      const prevCreatedAt = state.tasks[task.name]?.session_created_at;
      const sessionFields = { ...(prevSid && { session_id: prevSid }), ...(prevCreatedAt && { session_created_at: prevCreatedAt }) };

      if (!result.ok) {
        if (result.error === 'silent_timeout') {
          state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'error', error: `Task silent for ${timeoutMs / 1000}s`, ...sessionFields };
          saveState(state);
          return { success: false, error: 'silent_timeout', output: output || '' };
        }
        const errMsg = result.error;
        // Persistent session expired: reset so next run creates a new one
        if (task.persistent_session && (errMsg.includes('not found') || errMsg.includes('No session'))) {
          log('WARN', `Persistent session for ${task.name} expired, will create new on next run`);
          state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'session_reset', error: 'Session expired' };
          saveState(state);
          return { success: false, error: 'session_expired', output: '' };
        }
        log('ERROR', `Task ${task.name} failed: ${errMsg}`);
        state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'error', error: errMsg, ...sessionFields };
        saveState(state);
        return { success: false, error: errMsg, output: '' };
      }

      const estimatedTokens = Math.ceil((fullPrompt.length + output.length) / 4);
      recordTokens(state, estimatedTokens, { category: classifyTaskUsage(task) });
      state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'success', output_preview: output.slice(0, 200), ...sessionFields };
      saveState(state);
      maybeSaveTaskMemory(task, output, estimatedTokens, prevSid || '');
      log('INFO', `Task ${task.name} completed (est. ${estimatedTokens} tokens)`);
      return { success: true, output, tokens: estimatedTokens };
    });
  }

  // parseInterval — imported from ./utils

  async function executeWorkflow(task, config, precheck) {
    const state = loadState();
    if (!checkBudget(config, state)) {
      log('WARN', `Budget exceeded, skipping workflow: ${task.name}`);
      return { success: false, error: 'budget_exceeded', output: '', skipped: true };
    }
    // precheck.pass is guaranteed true here — executeTask() already returns early when false
    const steps = task.steps || [];
    if (steps.length === 0) return { success: false, error: 'No steps defined', output: '' };

    // Workflow tasks match the user's session model setting (same quality as interactive)
    const sessionModel = (config && config.daemon && config.daemon.model) || 'sonnet';
    const model = normalizeModel(task.model || sessionModel);
    const cwd = task.cwd ? task.cwd.replace(/^~/, HOME) : HOME;
    const sessionId = crypto.randomUUID();
    const outputs = [];
    let totalTokens = 0;
    const allowed = task.allowedTools || [];
    // Auto-detect MCP config in task cwd
    const mcpConfig = task.mcp_config
      ? path.resolve(task.mcp_config.replace(/^~/, HOME))
      : fs.existsSync(path.join(cwd, '.mcp.json'))
        ? path.join(cwd, '.mcp.json')
        : null;

    log('INFO', `Workflow ${task.name}: ${steps.length} steps, session ${sessionId.slice(0, 8)}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''}`);

    let loopState = loadState();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let prompt = (step.skill ? `/${step.skill} ` : '') + (step.prompt || '');
      if (i === 0 && precheck.context) {
        const ctx = precheck.context.length > MAX_PRECONDITION_CHARS
          ? precheck.context.slice(0, MAX_PRECONDITION_CHARS) + '\n... (truncated)'
          : precheck.context;
        prompt += `\n\n相关数据:\n\`\`\`\n${ctx}\n\`\`\``;
      }
      const args = ['-p', '--model', model, '--dangerously-skip-permissions'];
      for (const tool of allowed) args.push('--allowedTools', tool);
      if (mcpConfig) args.push('--mcp-config', mcpConfig);
      args.push(i === 0 ? '--session-id' : '--resume', sessionId);

      log('INFO', `Workflow ${task.name} step ${i + 1}/${steps.length}: ${step.skill || 'prompt'}`);
      // Steps share a session and must run sequentially
      const stepResult = await spawnClaude(args, prompt, resolveTimeoutMs(step.timeout, 1800), cwd, `Workflow ${task.name} step ${i + 1}`);
      if (stepResult.ok) {
        const output = stepResult.output;
        const tk = Math.ceil((prompt.length + output.length) / 4);
        totalTokens += tk;
        outputs.push({ step: i + 1, skill: step.skill || null, output: output.slice(0, 500), tokens: tk });
        log('INFO', `Workflow ${task.name} step ${i + 1} done (${tk} tokens)`);
        if (!checkBudget(config, loopState)) { log('WARN', 'Budget exceeded mid-workflow'); break; }
      } else {
        const errMsg = stepResult.error.slice(0, 200);
        log('ERROR', `Workflow ${task.name} step ${i + 1} failed: ${errMsg}`);
        outputs.push({ step: i + 1, skill: step.skill || null, error: errMsg });
        if (!step.optional) {
          recordTokens(loopState, totalTokens, { category: classifyTaskUsage(task) });
          state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'error', error: `Step ${i + 1} failed`, steps_completed: i, steps_total: steps.length };
          saveState(state);
          return { success: false, error: `Step ${i + 1} failed`, output: outputs.map(o => `Step ${o.step}: ${o.error ? 'FAILED' : 'OK'}`).join('\n'), tokens: totalTokens };
        }
      }
    }
    recordTokens(loopState, totalTokens, { category: classifyTaskUsage(task) });
    const lastOk = [...outputs].reverse().find(o => !o.error);
    state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'success', output_preview: (lastOk ? lastOk.output : '').slice(0, 200), steps_completed: outputs.filter(o => !o.error).length, steps_total: steps.length };
    saveState(state);
    maybeSaveTaskMemory(task, (lastOk ? lastOk.output : ''), totalTokens, sessionId);
    log('INFO', `Workflow ${task.name} done: ${outputs.filter(o => !o.error).length}/${steps.length} steps (${totalTokens} tokens)`);
    return { success: true, output: outputs.map(o => `Step ${o.step} (${o.skill || 'prompt'}): ${o.error ? 'FAILED' : 'OK'}`).join('\n') + '\n\n' + (lastOk ? lastOk.output : ''), tokens: totalTokens };
  }

  function getAllTasks(cfg) {
    const general = (cfg.heartbeat && cfg.heartbeat.tasks) || [];
    const project = [];
    const generalNames = new Set(general.map(t => t.name));
    for (const [key, proj] of Object.entries(cfg.projects || {})) {
      for (const t of (proj.heartbeat_tasks || [])) {
        if (generalNames.has(t.name)) log('WARN', `Duplicate task name "${t.name}" in project "${key}" and general heartbeat`);
        project.push({ ...t, _project: { key, name: proj.name || key, color: proj.color || 'blue', icon: proj.icon || '🤖' } });
      }
    }
    return { general, project, all: [...general, ...project] };
  }

  function findTask(cfg, name) {
    const { general, project } = getAllTasks(cfg);
    const found = general.find(t => t.name === name) || project.find(t => t.name === name);
    return found || null;
  }

  function startHeartbeat(config, notifyFn, notifyPersonalFn) {
    const { all: tasks } = getAllTasks(config);

    const enabledTasks = tasks.filter(t => t.enabled !== false);
    const checkIntervalSec = (config.daemon && config.daemon.heartbeat_check_interval) || 60;

    // Helper: compute next run time, falling back to 2-tick backoff on error.
    function safeNextRun(taskName, schedule, now) {
      try {
        return { next: nextRunAfter(schedule, now), failed: false };
      } catch (e) {
        log('ERROR', `nextRunAfter failed for "${taskName}": ${e.message}`);
        return { next: now + checkIntervalSec * 2 * 1000, failed: true };
      }
    }

    const taskSchedules = new Map();
    const runnableTasks = [];
    for (const task of enabledTasks) {
      const parsed = buildTaskSchedule(task, parseInterval);
      if (!parsed.ok) {
        log('WARN', `Skipping task "${task.name}": ${parsed.error}`);
        continue;
      }
      taskSchedules.set(task.name, parsed.schedule);
      runnableTasks.push(task);
    }

    log('INFO', `Heartbeat scheduler started (check every ${checkIntervalSec}s, ${runnableTasks.length}/${tasks.length} tasks enabled)`);

    // Even with zero tasks, the physiological heartbeat still runs

    // Track next run times
    const nextRun = {};
    const now = Date.now();
    const state = loadState();

    let newTaskIndex = 0;
    for (const task of runnableTasks) {
      const schedule = taskSchedules.get(task.name);
      if (!schedule) continue;
      if (schedule.mode !== 'clock') newTaskIndex++;
      nextRun[task.name] = computeInitialNextRun(task, schedule, state, now, checkIntervalSec, newTaskIndex);
    }

    // Tracks tasks currently running (prevents concurrent runs of the same task)
    const runningTasks = new Set();

    // Wake detection: if tick interval far exceeds expected, system likely slept (macOS lid close).
    // Use 5min floor to avoid false triggers from CPU load spikes or GC pauses.
    let lastTickTime = Date.now();
    const WAKE_THRESHOLD = Math.max(checkIntervalSec * 3 * 1000, 5 * 60 * 1000);

    const timer = setInterval(() => {
      const tickNow = Date.now();
      const tickElapsed = tickNow - lastTickTime;
      lastTickTime = tickNow;

      if (tickElapsed > WAKE_THRESHOLD) {
        log('WARN', `[WAKE-DETECT] System resumed after ${Math.round(tickElapsed / 1000)}s sleep — letting connections auto-reconnect`);
        const st = loadState();
        st.wake_restart = new Date().toISOString();
        st.wake_sleep_seconds = Math.round(tickElapsed / 1000);
        saveState(st);
        const onWakeDetected = typeof getWakeRecoveryHook === 'function' ? getWakeRecoveryHook() : null;
        if (typeof onWakeDetected === 'function') {
          Promise.resolve(onWakeDetected({
            sleepSeconds: Math.round(tickElapsed / 1000),
            resumedAt: new Date(tickNow).toISOString(),
          })).catch((e) => {
            log('WARN', `[WAKE-DETECT] bridge recovery failed: ${e.message}`);
          });
        }
      }

      // ① Physiological heartbeat (zero token, pure awareness)
      physiologicalHeartbeat(config);

      // Sleep mode detection — log transitions once
      const idle = isUserIdle();
      if (idle && !isInSleepMode()) {
        setSleepMode(true);
        log('INFO', '[DAEMON] Entering Sleep Mode');
        // Generate summaries for sessions idle 2-24h
        spawnSessionSummaries();
      } else if (!idle && isInSleepMode()) {
        setSleepMode(false);
        log('INFO', '[DAEMON] Exiting Sleep Mode — local activity detected');
      }

      // ② Task heartbeat (burns tokens on schedule)
      const currentTime = Date.now();
      for (const task of runnableTasks) {
        const schedule = taskSchedules.get(task.name);
        if (!schedule) continue;
        if (currentTime >= (nextRun[task.name] || 0)) {
          // Dream tasks: only run when user is idle
          if (task.require_idle && !isUserIdle()) {
            // Retry on next scheduler tick instead of waiting full interval.
            nextRun[task.name] = currentTime + checkIntervalSec * 1000;
            log('INFO', `[DAEMON] Deferring dream task "${task.name}" — user active`);
            continue;
          }

          if (runningTasks.has(task.name)) {
            // Task is still running; skip this cycle and keep full interval cadence.
            nextRun[task.name] = safeNextRun(task.name, schedule, currentTime).next;
            log('WARN', `Task ${task.name} still running — skipping this interval`);
            continue;
          }

          const { next: nextRunTime, failed: schedFailed } = safeNextRun(task.name, schedule, currentTime);
          nextRun[task.name] = nextRunTime;
          if (schedFailed) continue; // back off, skip execution this cycle
          runningTasks.add(task.name);
          // executeTask now returns a Promise (async, non-blocking, process-group kill)
          Promise.resolve(executeTask(task, config))
            .then((result) => {
              runningTasks.delete(task.name);
              // Budget exceeded: back off until next day instead of retrying every interval
              if (result.error === 'budget_exceeded') {
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                tomorrow.setHours(0, 5, 0, 0); // 00:05 next day
                nextRun[task.name] = tomorrow.getTime();
                return;
              }
              if (task.notify && notifyFn && !result.skipped) {
                const proj = task._project || null;
                if (result.success) {
                  notifyFn(`✅ *${task.name}* completed\n\n${result.output}`, proj);
                } else {
                  notifyFn(`❌ *${task.name}* failed: ${result.error}`, proj);
                }
              }
            })
            .catch((err) => {
              runningTasks.delete(task.name);
              log('ERROR', `Task ${task.name} threw: ${err.message}`);
            });
        }
      }

      // Skill evolution: check queue and notify user of actionable items
      // Can be disabled via daemon.yaml: skill_evolution_notify: false
      const skillEvolutionNotifyEnabled = !config.daemon || config.daemon.skill_evolution_notify !== false;
      if (skillEvolution && skillEvolutionNotifyEnabled) {
        try {
          const notifications = skillEvolution.checkEvolutionQueue();
          for (const item of notifications) {
            let msg = '';
            const idHint = item.id ? `\nID: \`${item.id}\`` : '';
            if (item.type === 'workflow_proposal') {
              msg = `🔄 *工作流技能建议*\n检测到重复工作流: ${item.search_hint || item.reason}`;
              if (item.tools_signature && item.tools_signature.length) msg += `\n工具: ${item.tools_signature.join(', ')}`;
              if (item.example_prompt) msg += `\n示例: "${item.example_prompt}"`;
              if (item.evidence_count) msg += `\n出现次数: ${item.evidence_count}`;
            } else if (item.type === 'skill_gap') {
              msg = `🧬 *技能缺口检测*\n${item.reason}`;
              if (item.search_hint) msg += `\n搜索建议: \`${item.search_hint}\``;
            } else if (item.type === 'skill_fix') {
              msg = `🔧 *技能需要修复*\n技能 \`${item.skill_name}\` ${item.reason}`;
            } else if (item.type === 'user_complaint') {
              msg = `⚠️ *技能反馈*\n技能 \`${item.skill_name}\` 收到用户反馈\n${item.reason}`;
            }
            if (msg && item.id && item.type === 'workflow_proposal') {
              msg += `${idHint}\n处理: \`/skill-evo approve ${item.id}\` 或 \`/skill-evo dismiss ${item.id}\``;
            } else if (msg && item.id) {
              msg += `${idHint}\n处理: \`/skill-evo done ${item.id}\` 或 \`/skill-evo dismiss ${item.id}\``;
            } else if (msg) msg += idHint;
            // Skill notifications go only to personal chats, not agent group chats
            const skillNotifyFn = notifyPersonalFn || notifyFn;
            if (msg && skillNotifyFn) skillNotifyFn(msg);
          }
        } catch (e) { log('WARN', `Skill evolution queue check failed: ${e.message}`); }
      }
    }, checkIntervalSec * 1000);

    return timer;
  }

  return {
    checkPrecondition,
    executeTask,
    executeWorkflow,
    getAllTasks,
    findTask,
    startHeartbeat,
  };
}

module.exports = {
  createTaskScheduler,
  normalizeModel,
  _private: {
    parseAtTime,
    parseDays,
    nextClockRunAfter,
    buildTaskSchedule,
    computeInitialNextRun,
    nextRunAfter,
  },
};
