'use strict';

const { classifyTaskUsage } = require('./usage-classifier');

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

  function truncateOutput(output, maxLen = 4000) {
    const text = (output || '').trim() || '(no output)';
    return text.length > maxLen ? text.slice(0, maxLen) + '\n... (truncated)' : text;
  }

  function maxReplyLengthForChat(chatId, defaultLen) {
    // Feishu text messages have a lower practical limit than Telegram.
    return typeof chatId === 'number' ? defaultLen : Math.min(defaultLen, 1200);
  }

  async function runCommand(bin, args, options = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn(bin, args, options);
      let stdout = '';
      let stderr = '';

      const finish = (code, errorText = '') => {
        if (settled) return;
        settled = true;
        const merged = `${stdout}${stderr}${errorText}`;
        resolve({
          code: typeof code === 'number' ? code : 1,
          stdout,
          stderr: `${stderr}${errorText}`,
          output: merged.trim(),
        });
      };

      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => finish(code));
      child.on('error', err => finish(1, `${stderr ? '\n' : ''}${err.message}`));
    });
  }

  async function runMacCapabilityChecksInline() {
    const checks = [];
    const shotPath = `/tmp/metame_gui_test_${process.pid}_${Date.now()}.png`;
    checks.push({ name: 'osascript binary available', mode: 'pass_on_zero', cmd: 'which osascript' });
    checks.push({ name: 'AppleScript baseline', mode: 'pass_on_zero', cmd: 'osascript -e \'return "ok"\'' });
    checks.push({ name: 'Finder automation', mode: 'pass_on_zero', cmd: 'osascript -e \'tell application "Finder" to get name of startup disk\'' });
    checks.push({ name: 'System Events accessibility', mode: 'pass_on_zero', cmd: 'osascript -e \'tell application "System Events" to get UI elements enabled\'' });
    checks.push({
      name: 'GUI app launch/control (Calculator)',
      mode: 'pass_on_zero',
      cmd: 'open -a Calculator >/dev/null 2>&1; sleep 1; osascript -e \'tell application "System Events" to tell process "Calculator" to return {frontmost, (count of windows)}\'; osascript -e \'tell application "Calculator" to quit\' >/dev/null 2>&1',
    });
    checks.push({ name: 'Screenshot capability (screencapture)', mode: 'pass_on_zero', cmd: `screencapture -x '${shotPath}' && ls -lh '${shotPath}'` });
    checks.push({ name: 'Full Disk probe: read ~/Library/Mail', mode: 'warn_on_nonzero', cmd: "ls '$HOME/Library/Mail' | head -n 3" });
    checks.push({ name: 'Full Disk probe: query Safari History.db', mode: 'warn_on_nonzero', cmd: "sqlite3 '$HOME/Library/Safari/History.db' 'select count(*) from history_items;'" });

    const lines = [];
    let pass = 0;
    let warn = 0;
    let fail = 0;
    lines.push('MetaMe macOS control capability check');
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    for (const c of checks) {
      const r = await runCommand('bash', ['-o', 'pipefail', '-lc', c.cmd], { timeout: 30000 });
      let level = 'FAIL';
      if (c.mode === 'pass_on_zero') {
        if (r.code === 0) {
          pass++;
          level = 'PASS';
        } else {
          fail++;
          level = 'FAIL';
        }
      } else {
        if (r.code === 0) {
          pass++;
          level = 'PASS';
        } else {
          warn++;
          level = 'WARN';
        }
      }
      lines.push(`[${level}] ${c.name}`);
      if (r.output) lines.push(`  ${r.output.split('\n').join('\n  ')}`);
    }

    await runCommand('rm', ['-f', shotPath], { timeout: 3000 });
    lines.push('');
    lines.push(`Summary: pass=${pass} warn=${warn} fail=${fail}`);
    return { code: fail > 0 ? 1 : 0, output: lines.join('\n') };
  }

  function macCommandHelp() {
    return [
      '🍎 macOS 控制命令',
      '/mac check — 检查 AppleScript/UI 自动化/截图/磁盘权限',
      '/mac perms — 查看建议开启的系统权限',
      '/mac perms open — 打开系统设置权限页',
      '/mac osa <AppleScript> — 直接执行 AppleScript',
      '/mac jxa <JavaScript> — 通过 osascript 执行 JXA',
      '',
      '示例:',
      '/mac osa tell application "Finder" to get name of startup disk',
    ].join('\n');
  }

  function macPermissionGuide() {
    return [
      '🛡 建议给 MetaMe/终端开启这些权限（系统设置 → 隐私与安全性）：',
      '1) 辅助功能（Accessibility）',
      '2) 自动化（Automation / Apple Events）',
      '3) 完全磁盘访问（Full Disk Access）',
      '4) 屏幕录制（Screen Recording）',
      '',
      '说明：',
      '- 辅助功能/自动化：用于控制 Finder、System Events、GUI 应用',
      '- 完全磁盘访问：用于读取 Mail/Safari 等受保护目录',
      '- 屏幕录制：用于截图和视觉回传',
      '',
      '执行 `/mac perms open` 可尝试直接跳转到对应设置页。',
    ].join('\n');
  }

  async function handleExecCommand(ctx) {
    const { bot, chatId, text, config, executeTaskByName, nlIntentText } = ctx;

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
        recordTokens(loadState(), est, { category: classifyTaskUsage({ name: taskName, type: 'manual_task' }) });
        const st = loadState();
        st.tasks[taskName] = { last_run: new Date().toISOString(), status: 'success', output_preview: (output || '').slice(0, 200) };
        saveState(st);
        const truncated = truncateOutput(output, 4000);
        const reply = truncated || '(no output)';
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
        const result = await runCommand('npm', ['publish', `--otp=${otp}`], { cwd, timeout: 60000 });
        const exitCode = result.code;
        const output = result.stdout;
        const stderr = result.stderr;
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

    // /mac — macOS control helpers (AppleScript/JXA/permissions)
    const macMatch = String(text || '').match(/^\/mac(?:\s+(.*))?$/i);
    if (macMatch) {
      if (process.platform !== 'darwin') {
        await bot.sendMessage(chatId, '❌ /mac 仅支持 macOS');
        return true;
      }

      const argRaw = (macMatch[1] || '').trim();
      const arg = argRaw.toLowerCase();
      if (!argRaw || arg === 'help') {
        if (bot.sendButtons) {
          await bot.sendButtons(chatId, macCommandHelp(), [
            [{ text: '✅ /mac check', callback_data: '/mac check' }],
            [{ text: '🛡 /mac perms', callback_data: '/mac perms' }],
            [{ text: '⚙️ /mac perms open', callback_data: '/mac perms open' }],
          ]);
        } else {
          await bot.sendMessage(chatId, macCommandHelp());
        }
        return true;
      }

      if (arg === 'check') {
        const checkScript = path.join(__dirname, 'check-macos-control-capabilities.sh');
        await bot.sendMessage(chatId, '🔍 正在检查 macOS 控制能力...');
        let result;
        if (fs.existsSync(checkScript)) {
          result = await runCommand('bash', [checkScript], { timeout: 120000 });
        } else {
          await bot.sendMessage(chatId, '⚠️ 检测脚本缺失，已切换为内置检查模式。');
          result = await runMacCapabilityChecksInline();
        }
        const out = truncateOutput(result.output, maxReplyLengthForChat(chatId, 3600));
        if (result.code === 0) {
          await bot.sendMessage(chatId, `✅ macOS 能力检查完成\n\n${out}`);
        } else {
          await bot.sendMessage(chatId, `⚠️ 检查未全部通过\n\n${out}`);
        }
        return true;
      }

      if (arg === 'perms' || arg === 'permissions') {
        await bot.sendMessage(chatId, macPermissionGuide());
        return true;
      }

      if (arg === 'perms open' || arg === 'permissions open') {
        const panes = [
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
          'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
        ];
        let ok = 0;
        for (const pane of panes) {
          const r = await runCommand('open', [pane], { timeout: 5000 });
          if (r.code === 0) ok++;
        }
        await bot.sendMessage(chatId, `⚙️ 已尝试打开 ${ok}/${panes.length} 个权限设置页。\n若未跳转，请手动进入“系统设置 → 隐私与安全性”。`);
        return true;
      }

      if (/^osa(?:\s+|$)/i.test(argRaw)) {
        const script = argRaw.replace(/^osa(?:\s+|$)/i, '').trim();
        if (!script) {
          await bot.sendMessage(chatId, '用法: /mac osa <AppleScript>');
          return true;
        }
        const result = await runCommand('osascript', ['-e', script], { timeout: 45000 });
        const out = (result.output || '').trim();
        if (result.code !== 0) {
          await bot.sendMessage(chatId, `❌ AppleScript 执行失败\n${truncateOutput(out, maxReplyLengthForChat(chatId, 3000))}`);
        } else if (nlIntentText) {
          const label = String(nlIntentText).trim().slice(0, 120);
          if (out) {
            await bot.sendMessage(chatId, `✅ 已执行：${label}\n${truncateOutput(out, maxReplyLengthForChat(chatId, 1200))}`);
          } else {
            await bot.sendMessage(chatId, `✅ 已执行：${label}`);
          }
        } else {
          if (out) {
            await bot.sendMessage(chatId, `🍎 AppleScript 结果\n${truncateOutput(out, maxReplyLengthForChat(chatId, 3000))}`);
          } else {
            await bot.sendMessage(chatId, '✅ AppleScript 已执行（无返回值）');
          }
        }
        return true;
      }

      if (/^jxa(?:\s+|$)/i.test(argRaw)) {
        const script = argRaw.replace(/^jxa(?:\s+|$)/i, '').trim();
        if (!script) {
          await bot.sendMessage(chatId, '用法: /mac jxa <JavaScript>');
          return true;
        }
        const result = await runCommand('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 45000 });
        const out = (result.output || '').trim();
        if (result.code !== 0) {
          await bot.sendMessage(chatId, `❌ JXA 执行失败\n${truncateOutput(out, maxReplyLengthForChat(chatId, 3000))}`);
        } else if (nlIntentText) {
          const label = String(nlIntentText).trim().slice(0, 120);
          if (out) {
            await bot.sendMessage(chatId, `✅ 已执行：${label}\n${truncateOutput(out, maxReplyLengthForChat(chatId, 1200))}`);
          } else {
            await bot.sendMessage(chatId, `✅ 已执行：${label}`);
          }
        } else {
          if (out) {
            await bot.sendMessage(chatId, `🍎 JXA 结果\n${truncateOutput(out, maxReplyLengthForChat(chatId, 3000))}`);
          } else {
            await bot.sendMessage(chatId, '✅ JXA 已执行（无返回值）');
          }
        }
        return true;
      }

      await bot.sendMessage(chatId, macCommandHelp());
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
        const result = await runCommand('sh', ['-c', command], { timeout: 30000 });
        const output = truncateOutput(result.output, maxReplyLengthForChat(chatId, 4000));
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
