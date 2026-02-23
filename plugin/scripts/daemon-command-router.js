'use strict';

function createCommandRouter(deps) {
  const {
    loadState,
    loadConfig,
    checkBudget,
    checkCooldown,
    routeAgent,
    normalizeCwd,
    attachOrCreateSession,
    handleSessionCommand,
    handleAgentCommand,
    handleAdminCommand,
    handleExecCommand,
    handleOpsCommand,
    askClaude,
    providerMod,
    getNoSleepProcess,
    activeProcesses,
    messageQueue,
    sleep,
    log,
  } = deps;

  async function handleCommand(bot, chatId, text, config, executeTaskByName, senderId = null, readOnly = false) {
    if (text && !text.startsWith('/chatid') && !text.startsWith('/myid')) log('INFO', `CMD [${String(chatId).slice(-8)}]: ${text.slice(0, 80)}`);
    const state = loadState();

    // --- /chatid: reply with current chatId ---
    if (text === '/chatid') {
      await bot.sendMessage(chatId, `Chat ID: \`${chatId}\``);
      return;
    }

    // --- /myid: reply with sender's user open_id (for configuring operator_ids) ---
    if (text === '/myid') {
      await bot.sendMessage(chatId, senderId ? `Your ID: \`${senderId}\`` : 'ID not available (Telegram not supported)');
      return;
    }

    // --- chat_agent_map: auto-switch agent based on dedicated chatId ---
    // Configure in daemon.yaml: feishu.chat_agent_map or telegram.chat_agent_map
    //   e.g.  chat_agent_map: { "oc_xxx": "personal", "oc_yyy": "metame" }
    const chatAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const _chatIdStr = String(chatId);
    const mappedKey = chatAgentMap[_chatIdStr] ||
      (_chatIdStr.startsWith('_agent_') ? _chatIdStr.slice(7) : null);
    if (mappedKey && config.projects && config.projects[mappedKey]) {
      const proj = config.projects[mappedKey];
      const projCwd = normalizeCwd(proj.cwd);
      const cur = loadState().sessions?.[chatId];
      if (!cur || cur.cwd !== projCwd) {
        attachOrCreateSession(chatId, projCwd, proj.name || mappedKey);
      }
    }

    if (await handleSessionCommand({ bot, chatId, text })) {
      return;
    }

    const agentResult = await handleAgentCommand({ bot, chatId, text, config });
    if (agentResult === true || agentResult === null) {
      return;
    }

    const adminResult = await handleAdminCommand({ bot, chatId, text, config, state });
    if (adminResult.handled) {
      config = adminResult.config || config;
      return;
    }

    if (await handleExecCommand({ bot, chatId, text, config, executeTaskByName })) {
      return;
    }

    if (await handleOpsCommand({ bot, chatId, text, config })) {
      return;
    }

    if (text.startsWith('/')) {
      const currentModel = (config.daemon && config.daemon.model) || 'opus';
      const currentProvider = providerMod ? providerMod.getActiveName() : 'anthropic';
      await bot.sendMessage(chatId, [
        '📱 手机端 Claude Code',
        '',
        '⚡ 快速同步电脑工作:',
        '/last — 继续电脑上最近的对话',
        '/cd last — 切到电脑最近的项目目录',
        '',
        '🤖 Agent 管理:',
        '/agent — 切换 Agent',
        '/agent new — 向导新建 Agent',
        '/agent bind <名称> [目录] — 绑定当前群',
        '/agent list — 查看所有 Agent',
        '/agent edit — 编辑当前 Agent 角色',
        '/agent reset — 重置当前 Agent 角色',
        '',
        '📂 Session 管理:',
        '/new [path] [name] — 新建会话',
        '/sessions — 浏览所有最近会话',
        '/resume [name] — 选择/恢复会话',
        '/name <name> — 命名当前会话',
        '/cd <path> — 切换工作目录',
        '/session — 查看当前会话',
        '/stop — 中断当前任务 (ESC)',
        '/undo — 选择历史消息，点击回退到该条之前',
        '/undo <hash> — 回退到指定 git checkpoint',
        '/quit — 结束会话，重新加载 MCP/配置',
        '',
        `⚙️ /model [${currentModel}] /provider [${currentProvider}] /status /tasks /run /budget /reload`,
        '🧠 /memory — 记忆统计 · /memory <关键词> — 搜索事实',
        `🔧 /doctor /fix /reset /sh <cmd> /nosleep [${getNoSleepProcess() ? 'ON' : 'OFF'}]`,
        '',
        '直接打字即可对话 💬',
      ].join('\n'));
      return;
    }

    // --- Natural language → Claude Code session ---
    // If a task is running: interrupt + collect + merge
    if (activeProcesses.has(chatId)) {
      const isFirst = !messageQueue.has(chatId);
      if (isFirst) {
        messageQueue.set(chatId, { messages: [], timer: null });
      }
      const q = messageQueue.get(chatId);
      q.messages.push(text);
      // Only notify once (first message), subsequent ones silently queue
      if (isFirst) {
        await bot.sendMessage(chatId, '📝 收到，稍后一起处理');
      }
      // Interrupt the running Claude process
      const proc = activeProcesses.get(chatId);
      if (proc && proc.child && !proc.aborted) {
        proc.aborted = true;
        try { process.kill(-proc.child.pid, 'SIGINT'); } catch { proc.child.kill('SIGINT'); }
      }
      // Debounce: wait 5s for more messages before processing
      if (q.timer) clearTimeout(q.timer);
      q.timer = setTimeout(async () => {
        // Wait for active process to fully exit (up to 10s)
        for (let i = 0; i < 20 && activeProcesses.has(chatId); i++) {
          await sleep(500);
        }
        const msgs = q.messages.splice(0);
        messageQueue.delete(chatId);
        if (msgs.length === 0) return;
        const combined = msgs.join('\n');
        log('INFO', `Processing ${msgs.length} queued message(s) for ${chatId}`);
        try {
          await handleCommand(bot, chatId, combined, config, executeTaskByName);
        } catch (e) {
          log('ERROR', `Queue dispatch failed: ${e.message}`);
        }
      }, 5000);
      return;
    }
    // Nickname-only switch: bypass cooldown + budget (no Claude call)
    const quickAgent = routeAgent(text, config);
    if (quickAgent && !quickAgent.rest) {
      const { key, proj } = quickAgent;
      const projCwd = normalizeCwd(proj.cwd);
      attachOrCreateSession(chatId, projCwd, proj.name || key);
      log('INFO', `Agent switch via nickname: ${key} (${projCwd})`);
      await bot.sendMessage(chatId, `${proj.icon || '🤖'} ${proj.name || key} 在线`);
      return;
    }

    const cd = checkCooldown(chatId);
    if (!cd.ok) { await bot.sendMessage(chatId, `${cd.wait}s`); return; }
    if (!checkBudget(loadConfig(), loadState())) {
      await bot.sendMessage(chatId, 'Daily token budget exceeded.');
      return;
    }
    await askClaude(bot, chatId, text, config, readOnly);
  }

  return { handleCommand };
}

module.exports = { createCommandRouter };
