'use strict';

function createExecCommandHandler(deps) {
  const {
    fs,
    path,
    spawn,
    HOME,
    checkCooldown,
    activeProcesses,
    messageQueue,
    findTask,
    checkPrecondition,
    buildProfilePreamble,
    spawnClaudeAsync,
    recordTokens,
    loadState,
    saveState,
    getSession,
    getSessionName,
    createSession,
    findSessionFile,
    loadConfig,
  } = deps;

  async function handleExecCommand(ctx) {
    const { bot, chatId, text, config, executeTaskByName } = ctx;

    if (text.startsWith('/run ')) {
      const cd = checkCooldown(chatId);
      if (!cd.ok) { await bot.sendMessage(chatId, `Cooldown: ${cd.wait}s`); return true; }
      if (activeProcesses.has(chatId)) {
        await bot.sendMessage(chatId, '⏳ 任务进行中，/stop 中断');
        return true;
      }
      const taskName = text.slice(5).trim();
      const task = findTask(config, taskName);
      if (!task) { await bot.sendMessage(chatId, `❌ Task "${taskName}" not found`); return true; }

      // Script tasks: quick, run inline
      if (task.type === 'script') {
        await bot.sendMessage(chatId, `Running: ${taskName}...`);
        const result = executeTaskByName(taskName);
        await bot.sendMessage(chatId, result.success ? `${taskName}\n\n${result.output}` : `Error: ${result.error}`);
        return true;
      }

      // Claude tasks: run async via spawn
      const precheck = checkPrecondition(task);
      if (!precheck.pass) {
        await bot.sendMessage(chatId, `${taskName}: skipped (no activity)`);
        return true;
      }
      const preamble = buildProfilePreamble();
      let taskPrompt = task.prompt;
      if (precheck.context) taskPrompt += `\n\n以下是相关原始数据:\n\`\`\`\n${precheck.context}\n\`\`\``;
      const fullPrompt = preamble + taskPrompt;
      const model = task.model || 'haiku';
      const claudeArgs = ['-p', '--model', model, '--dangerously-skip-permissions'];
      for (const t of (task.allowedTools || [])) claudeArgs.push('--allowedTools', t);

      await bot.sendMessage(chatId, `Running: ${taskName} (${model})...`);
      const { output, error } = await spawnClaudeAsync(claudeArgs, fullPrompt, HOME, 120000);
      if (error) {
        await bot.sendMessage(chatId, `❌ ${taskName}: ${error}`);
      } else {
        const est = Math.ceil((fullPrompt.length + (output || '').length) / 4);
        recordTokens(loadState(), est);
        const st = loadState();
        st.tasks[taskName] = { last_run: new Date().toISOString(), status: 'success', output_preview: (output || '').slice(0, 200) };
        saveState(st);
        let reply = output || '(no output)';
        if (reply.length > 4000) reply = reply.slice(0, 4000) + '\n... (truncated)';
        await bot.sendMessage(chatId, `${taskName}\n\n${reply}`);
      }
      return true;
    }

    if (text === '/stop') {
      // Clear message queue (don't process queued messages after stop)
      if (messageQueue.has(chatId)) {
        const q = messageQueue.get(chatId);
        if (q.timer) clearTimeout(q.timer);
        messageQueue.delete(chatId);
      }
      const proc = activeProcesses.get(chatId);
      if (proc && proc.child) {
        proc.aborted = true;
        try { process.kill(-proc.child.pid, 'SIGINT'); } catch { proc.child.kill('SIGINT'); }
        await bot.sendMessage(chatId, '⏹ Stopping Claude...');
      } else {
        await bot.sendMessage(chatId, 'No active task to stop.');
      }
      return true;
    }

    // /quit — restart session process (reloads MCP/config, keeps same session)
    if (text === '/quit') {
      // Stop running task if any
      if (messageQueue.has(chatId)) {
        const q = messageQueue.get(chatId);
        if (q.timer) clearTimeout(q.timer);
        messageQueue.delete(chatId);
      }
      const proc = activeProcesses.get(chatId);
      if (proc && proc.child) {
        proc.aborted = true;
        try { process.kill(-proc.child.pid, 'SIGINT'); } catch { proc.child.kill('SIGINT'); }
      }
      const session = getSession(chatId);
      const name = session ? getSessionName(session.id) : null;
      const label = name || (session ? session.id.slice(0, 8) : 'none');
      await bot.sendMessage(chatId, `🔄 Session restarted. MCP/config reloaded.\n📁 ${session ? path.basename(session.cwd) : '~'} [${label}]`);
      return true;
    }

    // /compact — compress current session context to save tokens
    if (text === '/compact') {
      const session = getSession(chatId);
      if (!session || !session.started) {
        await bot.sendMessage(chatId, '❌ No active session to compact.');
        return true;
      }
      await bot.sendMessage(chatId, '🗜 Compacting session...');

      // Step 1: Read conversation from JSONL (fast, no Claude needed)
      const jsonlPath = findSessionFile(session.id);
      if (!jsonlPath) {
        await bot.sendMessage(chatId, '❌ Session file not found.');
        return true;
      }
      const messages = [];
      try {
        const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'user' || obj.type === 'assistant') {
              const msg = obj.message || {};
              const content = msg.content;
              let textContent = '';
              if (typeof content === 'string') {
                textContent = content;
              } else if (Array.isArray(content)) {
                textContent = content
                  .filter(c => c.type === 'text')
                  .map(c => c.text || '')
                  .join(' ');
              }
              if (textContent.trim()) {
                messages.push({ role: obj.type, text: textContent.trim() });
              }
            }
          } catch { /* skip malformed lines */ }
        }
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Cannot read session: ${e.message}`);
        return true;
      }

      if (messages.length === 0) {
        await bot.sendMessage(chatId, '❌ No messages found in session.');
        return true;
      }

      // Step 2: Build a truncated conversation digest (keep under ~20k chars for haiku)
      const MAX_DIGEST = 20000;
      let digest = '';
      // Take messages from newest to oldest until we hit the limit
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        const prefix = m.role === 'user' ? 'USER' : 'ASSISTANT';
        const entry = `[${prefix}]: ${m.text.slice(0, 800)}\n\n`;
        if (digest.length + entry.length > MAX_DIGEST) break;
        digest = entry + digest;
      }

      // Step 3: Summarize with haiku (new process, no --resume, fast)
      const daemonCfg = loadConfig().daemon || {};
      const compactArgs = ['-p', '--model', 'haiku', '--no-session-persistence'];
      if (daemonCfg.dangerously_skip_permissions) compactArgs.push('--dangerously-skip-permissions');
      const { output, error } = await spawnClaudeAsync(
        compactArgs,
        `Summarize the following conversation into a compact context document. Include: (1) what was being worked on, (2) key decisions made, (3) current state, (4) pending tasks. Be concise but preserve ALL important technical context (file names, function names, variable names, specific values). Output ONLY the summary.\n\n--- CONVERSATION ---\n${digest}`,
        session.cwd,
        60000
      );
      if (error || !output) {
        await bot.sendMessage(chatId, `❌ Compact failed: ${error || 'no output'}`);
        return true;
      }

      // Step 4: Create new session with the summary
      const model = daemonCfg.model || 'opus';
      const oldName = getSessionName(session.id);
      const newSession = createSession(chatId, session.cwd, oldName ? oldName + ' (compacted)' : '');
      const initArgs = ['-p', '--session-id', newSession.id, '--model', model];
      if (daemonCfg.dangerously_skip_permissions) initArgs.push('--dangerously-skip-permissions');
      const preamble = buildProfilePreamble();
      const initPrompt = preamble + `Here is the context from our previous session (compacted):\n\n${output}\n\nContext loaded. Ready to continue.`;
      const { error: initErr } = await spawnClaudeAsync(initArgs, initPrompt, session.cwd, 60000);
      if (initErr) {
        await bot.sendMessage(chatId, `⚠️ Summary saved but new session init failed: ${initErr}`);
        return true;
      }
      // Mark as started
      const state2 = loadState();
      if (state2.sessions[chatId]) {
        state2.sessions[chatId].started = true;
        saveState(state2);
      }
      const tokenEst = Math.round(output.length / 3.5);
      await bot.sendMessage(chatId, `✅ Compacted! ~${tokenEst} tokens of context carried over.\nNew session: ${newSession.id.slice(0, 8)}`);
      return true;
    }

    // /publish <otp> — npm publish with OTP (zero latency, no Claude)
    if (text.startsWith('/publish ')) {
      const otp = text.slice(9).trim();
      if (!otp || !/^\d{6}$/.test(otp)) {
        await bot.sendMessage(chatId, '用法: /publish 123456');
        return true;
      }
      const session = getSession(chatId);
      const cwd = session?.cwd || HOME;
      await bot.sendMessage(chatId, `📦 npm publish --otp=${otp} ...`);
      try {
        const child = spawn('npm', ['publish', `--otp=${otp}`], { cwd, timeout: 60000 });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        const exitCode = await new Promise((resolve) => {
          child.on('close', (code) => resolve(code));
          child.on('error', () => resolve(1));
        });
        const output = (stdout + stderr).trim();
        if (exitCode === 0 && output.includes('+ metame-cli@')) {
          const ver = output.match(/metame-cli@([\d.]+)/);
          await bot.sendMessage(chatId, `✅ Published${ver ? ' v' + ver[1] : ''}!`);
        } else {
          let msg = output.slice(0, 2000) || `(exit code ${exitCode}, no output)`;
          await bot.sendMessage(chatId, `❌ ${msg}`);
        }
      } catch (e) {
        await bot.sendMessage(chatId, `❌ ${e.message}`);
      }
      return true;
    }

    // /sh [command] — direct shell execution (emergency lifeline)
    if (text === '/sh' || text.startsWith('/sh ')) {
      const command = text.slice(3).trim();
      if (!command) {
        if (bot.sendButtons) {
          await bot.sendButtons(chatId, '💻 应急命令', [
            [{ text: '📝 最近日志', callback_data: '/sh tail -30 ~/.metame/daemon.log' }],
            [{ text: '📋 原始配置', callback_data: '/sh cat ~/.metame/daemon.yaml' }],
          ]);
        } else {
          await bot.sendMessage(chatId, '用法: /sh <command>');
        }
        return true;
      }
      try {
        const child = spawn('sh', ['-c', command], { timeout: 30000 });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        await new Promise((resolve) => {
          child.on('close', resolve);
          child.on('error', resolve);
        });
        let output = (stdout + stderr).trim() || '(no output)';
        if (output.length > 4000) output = output.slice(0, 4000) + '\n... (truncated)';
        await bot.sendMessage(chatId, `💻 $ ${command}\n${output}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ ${e.message}`);
      }
      return true;
    }

    return false;
  }

  return { handleExecCommand };
}

module.exports = { createExecCommandHandler };
