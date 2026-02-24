'use strict';

function createCommandRouter(deps) {
  const {
    loadState,
    loadConfig,
    checkBudget,
    checkCooldown,
    resetCooldown,
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
    agentTools,
    pendingAgentFlows,
    agentFlowTtlMs,
  } = deps;

  function resolveFlowTtlMs() {
    const raw = typeof agentFlowTtlMs === 'function' ? agentFlowTtlMs() : agentFlowTtlMs;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : (10 * 60 * 1000);
  }

  function hasFreshPendingFlow(flowKey) {
    if (!pendingAgentFlows) return false;
    const flow = pendingAgentFlows.get(flowKey);
    if (!flow) return false;

    const ttlMs = resolveFlowTtlMs();
    const now = Date.now();
    const ts = Number(flow && flow.__ts || 0);
    if (ts > 0 && (now - ts) > ttlMs) {
      pendingAgentFlows.delete(flowKey);
      return false;
    }

    // Backfill timestamp for legacy flow objects so they can expire later.
    if (!(ts > 0) && flow && typeof flow === 'object') {
      pendingAgentFlows.set(flowKey, { ...flow, __ts: now });
    }
    return true;
  }

  function extractQuotedContent(input) {
    const m = String(input || '').match(/[“"'「](.+?)[”"'」]/);
    return m ? m[1].trim() : '';
  }

  function extractPathFromText(input) {
    const m = String(input || '').match(/(?:~\/|\/)[^\s，。；;!！?？"“”'‘’`]+/);
    if (!m) return '';
    return m[0].replace(/[，。；;!！?？]+$/, '');
  }

  function extractAgentName(input) {
    const text = String(input || '').trim();
    const byNameField = text.match(/(?:名字|名称|叫做?|名为|named?)\s*(?:为)?\s*[“"'「]?([^\s，。；;!！?？"“”'‘’`]+)[”"'」]?/i);
    if (byNameField) return byNameField[1].trim();
    const byBind = text.match(/(?:bind|绑定)\s*(?:到|为|成)?\s*[“"'「]?([a-zA-Z0-9_\-\u4e00-\u9fa5]+)[”"'」]?/i);
    if (byBind) return byBind[1].trim();
    return '';
  }

  function deriveAgentName(input, workspaceDir) {
    const explicit = extractAgentName(input);
    if (explicit) return explicit;
    if (workspaceDir) {
      const segs = workspaceDir.split('/').filter(Boolean);
      if (segs.length > 0) return segs[segs.length - 1];
    }
    return 'workspace-agent';
  }

  function deriveRoleDelta(input) {
    const text = String(input || '').trim();
    const quoted = extractQuotedContent(text);
    if (quoted) return quoted;
    const byVerb = text.match(/(?:改成|改为|变成|设为|更新为)\s*[:：]?\s*(.+)$/);
    if (byVerb) return byVerb[1].trim();
    return text;
  }

  function deriveCreateRoleDelta(input) {
    const text = String(input || '').trim();
    const quoted = extractQuotedContent(text);
    if (quoted) return quoted;
    const byRoleField = text.match(/(?:角色|职责|人设)\s*(?:是|为|:|：)?\s*(.+)$/i);
    if (byRoleField) return byRoleField[1].trim();
    return '';
  }

  function projectNameFromResult(data, fallbackName) {
    if (data && data.project && data.project.name) return data.project.name;
    if (data && data.projectKey) return data.projectKey;
    return fallbackName || 'workspace-agent';
  }

  function getBoundProjectForChat(chatId, cfg) {
    const map = {
      ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}),
      ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}),
    };
    const key = map[String(chatId)];
    const proj = key && cfg.projects ? cfg.projects[key] : null;
    return { key: key || null, project: proj || null };
  }

  async function tryHandleAgentIntent(bot, chatId, text, config) {
    if (!agentTools || !text || text.startsWith('/')) return false;
    const key = String(chatId);
    if (hasFreshPendingFlow(key) || hasFreshPendingFlow(key + ':edit')) return false;
    const input = text.trim();
    if (!input) return false;

    const hasAgentContext = /(agent|智能体|工作区|人设|绑定|当前群|这个群|chat|workspace)/i.test(input);
    const wantsList = /(列出|查看|显示|有哪些|list|show)/i.test(input) && /(agent|智能体|工作区|绑定)/i.test(input);
    const wantsUnbind = /(解绑|取消绑定|断开绑定|unbind|unassign)/i.test(input) && hasAgentContext;
    const wantsEditRole =
      ((/(角色|职责|人设)/i.test(input) && /(改|修改|调整|更新|变成|改成|改为)/i.test(input)) ||
      /(把这个agent|把当前agent|当前群.*角色|当前群.*职责)/i.test(input));
    const wantsCreate =
      (/(创建|新建|新增|搞一个|加一个|create)/i.test(input) && /(agent|智能体|人设|工作区)/i.test(input));
    const wantsBind =
      !wantsCreate &&
      (/(绑定|bind)/i.test(input) && hasAgentContext);

    if (!wantsList && !wantsUnbind && !wantsEditRole && !wantsCreate && !wantsBind) {
      return false;
    }

    if (wantsList) {
      const res = await agentTools.listAllAgents(chatId);
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 查询 Agent 失败: ${res.error}`);
        return true;
      }
      const agents = res.data.agents || [];
      if (agents.length === 0) {
        await bot.sendMessage(chatId, '暂无已配置的 Agent。你可以直接说“给这个群创建一个 Agent，目录是 ~/xxx”。');
        return true;
      }
      const lines = ['📋 当前 Agent 列表', ''];
      for (const a of agents) {
        const marker = a.key === res.data.boundKey ? ' ◀ 当前' : '';
        lines.push(`${a.icon || '🤖'} ${a.name}${marker}`);
        lines.push(`目录: ${a.cwd}`);
        lines.push(`Key: ${a.key}`);
        lines.push('');
      }
      await bot.sendMessage(chatId, lines.join('\n').trimEnd());
      return true;
    }

    if (wantsUnbind) {
      const res = await agentTools.unbindCurrentAgent(chatId);
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 解绑失败: ${res.error}`);
        return true;
      }
      if (res.data.unbound) {
        await bot.sendMessage(chatId, `✅ 已解绑当前群（原 Agent: ${res.data.previousProjectKey}）`);
      } else {
        await bot.sendMessage(chatId, '当前群没有绑定 Agent，无需解绑。');
      }
      return true;
    }

    if (wantsEditRole) {
      const freshCfg = loadConfig();
      const bound = getBoundProjectForChat(chatId, freshCfg);
      if (!bound.project || !bound.project.cwd) {
        await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent。先说“给这个群绑定一个 Agent，目录是 ~/xxx”。');
        return true;
      }
      const roleDelta = deriveRoleDelta(input);
      const res = await agentTools.editAgentRoleDefinition(bound.project.cwd, roleDelta);
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 更新角色失败: ${res.error}`);
        return true;
      }
      await bot.sendMessage(chatId, res.data.created ? '✅ 已创建 CLAUDE.md 并写入角色定义' : '✅ 角色定义已更新到 CLAUDE.md');
      return true;
    }

    if (wantsCreate) {
      const workspaceDir = extractPathFromText(input);
      if (!workspaceDir) {
        await bot.sendMessage(chatId, '请补充工作目录，例如：`给这个群创建一个 Agent，目录是 ~/projects/foo`');
        return true;
      }
      const agentName = deriveAgentName(input, workspaceDir);
      const roleDelta = deriveCreateRoleDelta(input);
      const res = await agentTools.createNewWorkspaceAgent(agentName, workspaceDir, roleDelta, chatId);
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${res.error}`);
        return true;
      }
      const data = res.data || {};
      const projName = projectNameFromResult(data, agentName);
      if (data.cwd) attachOrCreateSession(chatId, normalizeCwd(data.cwd), projName);
      await bot.sendMessage(chatId, `✅ Agent 已创建并绑定\n名称: ${projName}\n目录: ${data.cwd || '（未知）'}`);
      return true;
    }

    if (wantsBind) {
      const workspaceDir = extractPathFromText(input);
      const agentName = deriveAgentName(input, workspaceDir);
      const res = await agentTools.bindAgentToChat(chatId, agentName, workspaceDir || null);
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 绑定失败: ${res.error}`);
        return true;
      }
      const data = res.data || {};
      const projName = projectNameFromResult(data, agentName);
      if (data.cwd) attachOrCreateSession(chatId, normalizeCwd(data.cwd), projName);
      await bot.sendMessage(chatId, `✅ 已绑定 Agent\n名称: ${projName}\n目录: ${data.cwd || '（未知）'}`);
      return true;
    }

    return false;
  }

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
        '/agent unbind — 解绑当前群',
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
        resetCooldown(chatId); // queued msgs already waited, skip cooldown
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

    if (await tryHandleAgentIntent(bot, chatId, text, config)) {
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
