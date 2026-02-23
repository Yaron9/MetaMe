'use strict';

function createAgentCommandHandler(deps) {
  const {
    fs,
    path,
    HOME,
    loadConfig,
    loadState,
    saveState,
    normalizeCwd,
    expandPath,
    sendBrowse,
    sendDirPicker,
    getSession,
    listRecentSessions,
    buildSessionCardElements,
    sessionLabel,
    loadSessionTags,
    sessionRichLabel,
    pendingBinds,
    pendingAgentFlows,
    doBindAgent,
    mergeAgentRole,
  } = deps;

  async function handleAgentCommand(ctx) {
    const { bot, chatId } = ctx;
    const config = ctx.config || {};
    const text = ctx.text || '';

    if (text === '/resume' || text.startsWith('/resume ')) {
      const arg = text.slice(7).trim();

      // Get current workdir to scope session list
      const curSession = getSession(chatId);
      const curCwd = curSession ? curSession.cwd : null;
      const recentSessions = listRecentSessions(5, curCwd);

      if (!arg) {
        if (recentSessions.length === 0) {
          await bot.sendMessage(chatId, `No sessions found${curCwd ? ' in ' + path.basename(curCwd) : ''}. Try /new first.`);
          return true;
        }
        const headerTitle = curCwd ? `📋 Sessions in ${path.basename(curCwd)}` : '📋 Recent Sessions';
        if (bot.sendRawCard) {
          await bot.sendRawCard(chatId, headerTitle, buildSessionCardElements(recentSessions));
        } else if (bot.sendButtons) {
          const buttons = recentSessions.map(s => {
            return [{ text: sessionLabel(s), callback_data: `/resume ${s.sessionId}` }];
          });
          await bot.sendButtons(chatId, headerTitle, buttons);
        } else {
          const _tags2 = loadSessionTags();
          let msg = `${title}\n\n`;
          recentSessions.forEach((s, i) => {
            msg += sessionRichLabel(s, i + 1, _tags2) + '\n';
          });
          await bot.sendMessage(chatId, msg);
        }
        return true;
      }

      // Argument given → match by name, then by session ID prefix
      const allSessions = listRecentSessions(50);
      const argLower = arg.toLowerCase();
      // 1. Match by customTitle (Claude's native session name)
      let fullMatch = allSessions.find(s => {
        return s.customTitle && s.customTitle.toLowerCase() === argLower;
      });
      // 2. Partial name match
      if (!fullMatch) {
        fullMatch = allSessions.find(s => {
          return s.customTitle && s.customTitle.toLowerCase().includes(argLower);
        });
      }
      // 3. Session ID prefix match
      if (!fullMatch) {
        fullMatch = recentSessions.find(s => s.sessionId.startsWith(arg))
          || allSessions.find(s => s.sessionId.startsWith(arg));
      }
      if (!fullMatch) {
        // No match found — treat as normal message, not a /resume command
        // (e.g. "/resume 看到的session信息太少了" is feedback, not a session ID)
        return null; // keep historical behavior
      }
      const sessionId = fullMatch.sessionId;
      const cwd = fullMatch.projectPath || (getSession(chatId) && getSession(chatId).cwd) || HOME;

      const state2 = loadState();
      state2.sessions[chatId] = {
        id: sessionId,
        cwd,
        started: true,
      };
      saveState(state2);
      const name = fullMatch.customTitle;
      const label = name || (fullMatch.summary || fullMatch.firstPrompt || '').slice(0, 40) || sessionId.slice(0, 8);
      await bot.sendMessage(chatId, `Resumed: ${label}\nWorkdir: ${cwd}`);
      return true;
    }

    // 处理 /agent new 多步向导状态机中的文本输入（name/desc 步骤）
    {
      const flow = pendingAgentFlows.get(String(chatId));
      if (flow && flow.step === 'name' && text && !text.startsWith('/')) {
        // 步骤2: 用户回复了 Agent 名称
        flow.name = text.trim();
        flow.step = 'desc';
        pendingAgentFlows.set(String(chatId), flow);
        await bot.sendMessage(chatId, `好的，Agent 名称是「${flow.name}」\n\n请描述这个 Agent 的角色和职责（用自然语言）：`);
        return true;
      }
      if (flow && flow.step === 'desc' && text && !text.startsWith('/')) {
        // 步骤3: 用户回复了角色描述
        pendingAgentFlows.delete(String(chatId));
        const { dir, name } = flow;
        const description = text.trim();
        await bot.sendMessage(chatId, `⏳ 正在配置 Agent「${name}」，稍等...`);
        try {
          // a. 写入 config（projects 里新增条目）并绑定当前群
          await doBindAgent(bot, chatId, name, dir);
          // b. 智能合并 CLAUDE.md
          const mergeResult = await mergeAgentRole(dir, description);
          if (mergeResult.error) {
            await bot.sendMessage(chatId, `⚠️ CLAUDE.md 合并失败: ${mergeResult.error}，其他配置已保存`);
          } else if (mergeResult.created) {
            await bot.sendMessage(chatId, `📝 已创建 CLAUDE.md 并写入角色定义`);
          } else {
            await bot.sendMessage(chatId, `📝 已将角色定义合并进现有 CLAUDE.md`);
          }
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${e.message}`);
        }
        return true;
      }
    }

    // /agent edit 状态机：等待用户输入修改意图
    {
      const editFlow = pendingAgentFlows.get(String(chatId) + ':edit');
      if (editFlow && text && !text.startsWith('/')) {
        pendingAgentFlows.delete(String(chatId) + ':edit');
        const { cwd } = editFlow;
        await bot.sendMessage(chatId, '⏳ 正在更新 CLAUDE.md...');
        const mergeResult = await mergeAgentRole(cwd, text.trim());
        if (mergeResult.error) {
          await bot.sendMessage(chatId, `❌ 更新失败: ${mergeResult.error}`);
        } else {
          await bot.sendMessage(chatId, '✅ CLAUDE.md 已更新');
        }
        return true;
      }
    }

    if (text === '/agent' || text.startsWith('/agent ')) {
      const agentArg = text === '/agent' ? '' : text.slice(7).trim();
      const agentParts = agentArg.split(/\s+/);
      const agentSub = agentParts[0]; // bind / list / new / edit / reset / ''

      // /agent bind <名称> [目录]
      if (agentSub === 'bind') {
        const bindName = agentParts[1];
        const bindCwd = agentParts.slice(2).join(' ');
        if (!bindName) {
          await bot.sendMessage(chatId, '用法: /agent bind <名称> [工作目录]\n例: /agent bind 小美 ~/\n或:  /agent bind 教授  (弹出目录选择)');
          return true;
        }
        if (!bindCwd) {
          pendingBinds.set(String(chatId), bindName);
          await sendDirPicker(bot, chatId, 'bind', `为「${bindName}」选择工作目录:`);
          return true;
        }
        await doBindAgent(bot, chatId, bindName, expandPath(bindCwd));
        return true;
      }

      // /agent list — 查看所有已配置的 agent
      if (agentSub === 'list') {
        const cfg = loadConfig();
        const projects = cfg.projects || {};
        const entries = Object.entries(projects).filter(([, p]) => p.cwd);
        if (entries.length === 0) {
          await bot.sendMessage(chatId, '暂无已配置的 Agent。\n使用 /agent new 创建，或 /agent bind <名称> 绑定目录。');
          return true;
        }
        // 找出当前群绑定的 agent
        const agentMap = { ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}), ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}) };
        const boundKey = agentMap[String(chatId)];
        const lines = ['📋 已配置的 Agent：', ''];
        for (const [key, p] of entries) {
          const icon = p.icon || '🤖';
          const name = p.name || key;
          const displayCwd = (p.cwd || '').replace(HOME, '~');
          const bound = key === boundKey ? ' ◀ 当前' : '';
          lines.push(`${icon} ${name}${bound}`);
          lines.push(`   目录: ${displayCwd}`);
          lines.push(`   Key: ${key}`);
          lines.push('');
        }
        await bot.sendMessage(chatId, lines.join('\n').trimEnd());
        return true;
      }

      // /agent new — 多步向导新建 agent
      if (agentSub === 'new') {
        pendingAgentFlows.set(String(chatId), { step: 'dir' });
        await sendBrowse(bot, chatId, 'agent-new', HOME, '步骤1/3：选择这个 Agent 的工作目录');
        return true;
      }

      // /agent edit — 编辑当前 agent 的 CLAUDE.md 角色定义
      if (agentSub === 'edit') {
        const cfg = loadConfig();
        const agentMap = { ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}), ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}) };
        const boundKey = agentMap[String(chatId)];
        const boundProj = boundKey && cfg.projects && cfg.projects[boundKey];
        if (!boundProj || !boundProj.cwd) {
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先使用 /agent bind 或 /agent new');
          return true;
        }
        const cwd = normalizeCwd(boundProj.cwd);
        const claudeMdPath = path.join(cwd, 'CLAUDE.md');
        let currentContent = '（CLAUDE.md 不存在）';
        if (fs.existsSync(claudeMdPath)) {
          currentContent = fs.readFileSync(claudeMdPath, 'utf8');
          // 只展示前 500 字符
          if (currentContent.length > 500) {
            currentContent = currentContent.slice(0, 500) + '\n...(已截断)';
          }
        }
        pendingAgentFlows.set(String(chatId) + ':edit', { cwd });
        await bot.sendMessage(chatId, `📄 当前 CLAUDE.md 内容:\n\`\`\`\n${currentContent}\n\`\`\`\n\n请描述你想做的修改（用自然语言，例如：「把角色改成后端工程师，专注 Python」）：`);
        return true;
      }

      // /agent reset — 删除 CLAUDE.md 里的角色 section
      if (agentSub === 'reset') {
        const cfg = loadConfig();
        const agentMap = { ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}), ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}) };
        const boundKey = agentMap[String(chatId)];
        const boundProj = boundKey && cfg.projects && cfg.projects[boundKey];
        if (!boundProj || !boundProj.cwd) {
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先使用 /agent bind 或 /agent new');
          return true;
        }
        const cwd = normalizeCwd(boundProj.cwd);
        const claudeMdPath = path.join(cwd, 'CLAUDE.md');
        if (!fs.existsSync(claudeMdPath)) {
          await bot.sendMessage(chatId, '⚠️ CLAUDE.md 不存在，无需重置');
          return true;
        }
        let content = fs.readFileSync(claudeMdPath, 'utf8');
        // 用正则删除 ## Agent 角色 section（到下一个 ## 或文件末尾）
        content = content.replace(/(?:^|\n)## Agent 角色\n[\s\S]*?(?=\n## |$)/, '').trimStart();
        // 如果没匹配到，给出提示
        if (content === fs.readFileSync(claudeMdPath, 'utf8').trimStart()) {
          await bot.sendMessage(chatId, '⚠️ 未找到「## Agent 角色」section，CLAUDE.md 未修改');
          return true;
        }
        fs.writeFileSync(claudeMdPath, content, 'utf8');
        await bot.sendMessage(chatId, '✅ 已删除角色 section，请重新发送角色描述（/agent edit 或 /agent new）');
        return true;
      }

      // /agent（无参数）— 弹出 agent 切换选择器
      {
        const projects = config.projects || {};
        const entries = Object.entries(projects).filter(([, p]) => p.cwd);
        if (entries.length === 0) {
          await bot.sendMessage(chatId, '暂无已配置的 Agent。\n使用 /agent new 新建，或 /agent bind <名称> 绑定目录。');
          return true;
        }
        const currentSession = getSession(chatId);
        const currentCwd = currentSession?.cwd ? path.resolve(expandPath(currentSession.cwd)) : null;
        const buttons = entries.map(([key, p]) => {
          const projCwd = normalizeCwd(p.cwd);
          const active = currentCwd && path.resolve(projCwd) === currentCwd ? ' ◀' : '';
          return [{ text: `${p.icon || '🤖'} ${p.name || key}${active}`, callback_data: `/cd ${projCwd}` }];
        });
        await bot.sendButtons(chatId, '切换对话对象', buttons);
        return true;
      }
    }

    // --- /agent-bind-dir <path>: /agent bind 目录选择器的内部回调 ---
    if (text.startsWith('/agent-bind-dir ')) {
      const dirPath = expandPath(text.slice(16).trim());
      const agentName = pendingBinds.get(String(chatId));
      if (!agentName) {
        await bot.sendMessage(chatId, '❌ 没有待完成的 /agent bind，请重新发送');
        return true;
      }
      pendingBinds.delete(String(chatId));
      await doBindAgent(bot, chatId, agentName, dirPath);
      return true;
    }

    // --- /agent-dir <path>: /agent new 向导的目录选择回调 ---
    if (text.startsWith('/agent-dir ')) {
      const dirPath = expandPath(text.slice(11).trim());
      const flow = pendingAgentFlows.get(String(chatId));
      if (!flow || flow.step !== 'dir') {
        await bot.sendMessage(chatId, '❌ 没有待完成的 /agent new，请重新发送 /agent new');
        return true;
      }
      flow.dir = dirPath;
      flow.step = 'name';
      pendingAgentFlows.set(String(chatId), flow);
      const displayPath = dirPath.replace(HOME, '~');
      await bot.sendMessage(chatId, `✓ 已选择目录：${displayPath}\n\n步骤2/3：给这个 Agent 起个名字？`);
      return true;
    }

    return false;
  }

  return { handleAgentCommand };
}

module.exports = { createAgentCommandHandler };
