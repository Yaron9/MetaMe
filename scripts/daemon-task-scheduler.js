'use strict';

function createTaskScheduler(deps) {
  const {
    fs,
    path,
    HOME,
    CLAUDE_BIN,
    spawn,
    execSync,
    execFileSync,
    parseInterval,
    loadState,
    saveState,
    checkBudget,
    recordTokens,
    buildProfilePreamble,
    getDaemonProviderEnv,
    log,
    physiologicalHeartbeat,
    isUserIdle,
    isInSleepMode,
    setSleepMode,
    spawnSessionSummaries,
    skillEvolution,
  } = deps;

  function checkPrecondition(task) {
    if (!task.precondition) return { pass: true, context: '' };

    try {
      const output = execSync(task.precondition, {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 64 * 1024,
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

  function executeTask(task, config) {
    if (task.enabled === false) {
      log('INFO', `Skipping disabled task: ${task.name}`);
      return { success: true, output: '(disabled)', skipped: true };
    }

    const state = loadState();

    if (!checkBudget(config, state)) {
      log('WARN', `Budget exceeded, skipping task: ${task.name}`);
      return { success: false, error: 'budget_exceeded', output: '' };
    }

    // Precondition gate: run a cheap shell check before burning tokens
    const precheck = checkPrecondition(task);
    if (!precheck.pass) {
      state.tasks[task.name] = {
        last_run: new Date().toISOString(),
        status: 'skipped',
        output_preview: 'Precondition not met — no activity',
      };
      saveState(state);
      return { success: true, output: '(skipped — no activity)', skipped: true };
    }

    // Workflow tasks: multi-step skill chain via --resume session
    if (task.type === 'workflow') {
      return executeWorkflow(task, config);
    }

    // Script tasks: run a local script directly (e.g. distill.js), no claude -p
    if (task.type === 'script') {
      log('INFO', `Executing script task: ${task.name} → ${task.command}`);
      try {
        const scriptEnv = { ...process.env, METAME_ROOT: process.env.METAME_ROOT || '' };
        delete scriptEnv.CLAUDECODE;
        const output = execSync(task.command, {
          encoding: 'utf8',
          timeout: (task.timeout || 120) * 1000,
          maxBuffer: 1024 * 1024,
          env: scriptEnv,
        }).trim();

        state.tasks[task.name] = {
          last_run: new Date().toISOString(),
          status: 'success',
          output_preview: output.slice(0, 200),
        };
        saveState(state);
        if (output) log('INFO', `Script task ${task.name} completed: ${output.slice(0, 300)}`);
        else log('INFO', `Script task ${task.name} completed`);
        return { success: true, output, tokens: 0 };
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
    const model = task.model || 'haiku';
    // If precondition returned context data, append it to the prompt
    let taskPrompt = task.prompt;
    if (precheck.context) {
      taskPrompt += `\n\n以下是相关原始数据:\n\`\`\`\n${precheck.context}\n\`\`\``;
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
      const savedSessionId = state.tasks[task.name]?.session_id;
      if (savedSessionId) {
        claudeArgs.push('--resume', savedSessionId);
        log('INFO', `Executing task: ${task.name} (model: ${model}, resuming session ${savedSessionId.slice(0, 8)}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
      } else {
        const newSessionId = crypto.randomUUID();
        claudeArgs.push('--session-id', newSessionId);
        if (!state.tasks[task.name]) state.tasks[task.name] = {};
        state.tasks[task.name].session_id = newSessionId;
        saveState(state);
        log('INFO', `Executing task: ${task.name} (model: ${model}, new session ${newSessionId.slice(0, 8)}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
      }
    } else {
      log('INFO', `Executing task: ${task.name} (model: ${model}${mcpConfig ? ', mcp: ' + path.basename(mcpConfig) : ''})`);
    }

    // Use spawnClaudeAsync (non-blocking spawn with process-group kill) instead of
    // execFileSync (sync, blocks event loop, can't kill sub-agents).
    // executeTask now returns a Promise — callers must handle it with .then() or await.
    const timeoutMs = task.timeout || 120000;
    const asyncArgs = [...claudeArgs];
    const asyncEnv = { ...process.env, ...getDaemonProviderEnv(), CLAUDECODE: undefined };

    return new Promise((resolve) => {
      const child = spawn(CLAUDE_BIN, asyncArgs, {
        cwd: cwd || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true, // own process group — kills sub-agents on timeout too
        env: asyncEnv,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        log('WARN', `Task ${task.name} timeout (${timeoutMs / 1000}s) — killing process group`);
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { } }
        }, 5000);
      }, timeoutMs);

      child.stdin.write(fullPrompt);
      child.stdin.end();
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        const output = stdout.trim();
        if (timedOut) {
          const prevSid = state.tasks[task.name]?.session_id;
          state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'timeout', error: 'Task exceeded timeout', ...(prevSid && { session_id: prevSid }) };
          saveState(state);
          return resolve({ success: false, error: 'timeout', output: '' });
        }
        if (code !== 0) {
          const errMsg = (stderr || `Exit code ${code}`).slice(0, 200);
          // Persistent session expired: reset so next run creates a new one
          if (task.persistent_session && (errMsg.includes('not found') || errMsg.includes('No session'))) {
            log('WARN', `Persistent session for ${task.name} expired, will create new on next run`);
            state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'session_reset', error: 'Session expired' };
            saveState(state);
            return resolve({ success: false, error: 'session_expired', output: '' });
          }
          log('ERROR', `Task ${task.name} failed (exit ${code}): ${errMsg}`);
          const prevSid = state.tasks[task.name]?.session_id;
          state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'error', error: errMsg, ...(prevSid && { session_id: prevSid }) };
          saveState(state);
          return resolve({ success: false, error: errMsg, output: '' });
        }
        const estimatedTokens = Math.ceil((fullPrompt.length + output.length) / 4);
        recordTokens(state, estimatedTokens);
        const prevSessionId = state.tasks[task.name]?.session_id;
        state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'success', output_preview: output.slice(0, 200), ...(prevSessionId && { session_id: prevSessionId }) };
        saveState(state);
        log('INFO', `Task ${task.name} completed (est. ${estimatedTokens} tokens)`);
        resolve({ success: true, output, tokens: estimatedTokens });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        log('ERROR', `Task ${task.name} spawn error: ${err.message}`);
        resolve({ success: false, error: err.message, output: '' });
      });
    });
  }

  // parseInterval — imported from ./utils

  function executeWorkflow(task, config) {
    const state = loadState();
    if (!checkBudget(config, state)) {
      log('WARN', `Budget exceeded, skipping workflow: ${task.name}`);
      return { success: false, error: 'budget_exceeded', output: '' };
    }
    const precheck = checkPrecondition(task);
    if (!precheck.pass) {
      state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'skipped', output_preview: 'Precondition not met' };
      saveState(state);
      return { success: true, output: '(skipped)', skipped: true };
    }
    const steps = task.steps || [];
    if (steps.length === 0) return { success: false, error: 'No steps defined', output: '' };

    const model = task.model || 'sonnet';
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

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let prompt = (step.skill ? `/${step.skill} ` : '') + (step.prompt || '');
      if (i === 0 && precheck.context) prompt += `\n\n相关数据:\n\`\`\`\n${precheck.context}\n\`\`\``;
      const args = ['-p', '--model', model, '--dangerously-skip-permissions'];
      for (const tool of allowed) args.push('--allowedTools', tool);
      if (mcpConfig) args.push('--mcp-config', mcpConfig);
      args.push(i === 0 ? '--session-id' : '--resume', sessionId);

      log('INFO', `Workflow ${task.name} step ${i + 1}/${steps.length}: ${step.skill || 'prompt'}`);
      try {
        const output = execFileSync('claude', args, {
          input: prompt, encoding: 'utf8', timeout: step.timeout || 300000, maxBuffer: 5 * 1024 * 1024, cwd, env: { ...process.env, ...getDaemonProviderEnv(), CLAUDECODE: undefined },
        }).trim();
        const tk = Math.ceil((prompt.length + output.length) / 4);
        totalTokens += tk;
        outputs.push({ step: i + 1, skill: step.skill || null, output: output.slice(0, 500), tokens: tk });
        log('INFO', `Workflow ${task.name} step ${i + 1} done (${tk} tokens)`);
        if (!checkBudget(config, loadState())) { log('WARN', 'Budget exceeded mid-workflow'); break; }
      } catch (e) {
        log('ERROR', `Workflow ${task.name} step ${i + 1} failed: ${e.message.slice(0, 200)}`);
        outputs.push({ step: i + 1, skill: step.skill || null, error: e.message.slice(0, 200) });
        if (!step.optional) {
          recordTokens(loadState(), totalTokens);
          state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'error', error: `Step ${i + 1} failed`, steps_completed: i, steps_total: steps.length };
          saveState(state);
          return { success: false, error: `Step ${i + 1} failed`, output: outputs.map(o => `Step ${o.step}: ${o.error ? 'FAILED' : 'OK'}`).join('\n'), tokens: totalTokens };
        }
      }
    }
    recordTokens(loadState(), totalTokens);
    const lastOk = [...outputs].reverse().find(o => !o.error);
    state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'success', output_preview: (lastOk ? lastOk.output : '').slice(0, 200), steps_completed: outputs.filter(o => !o.error).length, steps_total: steps.length };
    saveState(state);
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

  function startHeartbeat(config, notifyFn) {
    const { all: tasks } = getAllTasks(config);

    const enabledTasks = tasks.filter(t => t.enabled !== false);
    const checkIntervalSec = (config.daemon && config.daemon.heartbeat_check_interval) || 60;
    log('INFO', `Heartbeat scheduler started (check every ${checkIntervalSec}s, ${enabledTasks.length}/${tasks.length} tasks enabled)`);

    // Even with zero tasks, the physiological heartbeat still runs

    // Track next run times
    const nextRun = {};
    const now = Date.now();
    const state = loadState();

    let newTaskIndex = 0;
    for (const task of enabledTasks) {
      const intervalSec = parseInterval(task.interval);
      const lastRun = state.tasks[task.name] && state.tasks[task.name].last_run;
      if (lastRun) {
        const elapsed = (now - new Date(lastRun).getTime()) / 1000;
        nextRun[task.name] = now + Math.max(0, (intervalSec - elapsed)) * 1000;
      } else {
        // First run: stagger new tasks to avoid thundering herd
        // Each new task waits an additional check interval beyond the first
        newTaskIndex++;
        nextRun[task.name] = now + checkIntervalSec * 1000 * newTaskIndex;
      }
    }

    // Tracks tasks currently running (prevents concurrent runs of the same task)
    const runningTasks = new Set();

    const timer = setInterval(() => {
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
      for (const task of enabledTasks) {
        if (currentTime >= (nextRun[task.name] || 0)) {
          const intervalSec = parseInterval(task.interval);
          nextRun[task.name] = currentTime + intervalSec * 1000;

          // Dream tasks: only run when user is idle
          if (task.require_idle && !isUserIdle()) {
            log('INFO', `[DAEMON] Deferring dream task "${task.name}" — user active`);
            continue;
          }

          if (runningTasks.has(task.name)) {
            log('WARN', `Task ${task.name} still running — skipping this interval`);
            continue;
          }

          runningTasks.add(task.name);
          // executeTask now returns a Promise (async, non-blocking, process-group kill)
          Promise.resolve(executeTask(task, config))
            .then((result) => {
              runningTasks.delete(task.name);
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
      if (skillEvolution) {
        try {
          const notifications = skillEvolution.checkEvolutionQueue();
          for (const item of notifications) {
            let msg = '';
            if (item.type === 'skill_gap') {
              msg = `🧬 *技能缺口检测*\n${item.reason}`;
              if (item.search_hint) msg += `\n搜索建议: \`${item.search_hint}\``;
            } else if (item.type === 'skill_fix') {
              msg = `🔧 *技能需要修复*\n技能 \`${item.skill_name}\` ${item.reason}`;
            } else if (item.type === 'user_complaint') {
              msg = `⚠️ *技能反馈*\n技能 \`${item.skill_name}\` 收到用户反馈\n${item.reason}`;
            }
            if (msg && notifyFn) notifyFn(msg);
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

module.exports = { createTaskScheduler };
