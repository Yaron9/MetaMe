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
    agentTools,
    agentFlowTtlMs,
    agentBindTtlMs,
  } = deps;

  function resolveTtl(valueOrGetter, fallbackMs) {
    const raw = typeof valueOrGetter === 'function' ? valueOrGetter() : valueOrGetter;
    const num = Number(raw);
    return Number.isFinite(num) && num > 0 ? num : fallbackMs;
  }

  function getFreshFlow(flowKey) {
    const flow = pendingAgentFlows.get(flowKey);
    if (!flow) return null;
    const FLOW_TTL_MS = resolveTtl(agentFlowTtlMs, 10 * 60 * 1000);
    const ts = Number(flow.__ts || 0);
    if (!(ts > 0) && flow && typeof flow === 'object') {
      // Backfill timestamp for legacy in-memory flow so it can expire later.
      const stamped = { ...flow, __ts: Date.now() };
      pendingAgentFlows.set(flowKey, stamped);
      return stamped;
    }
    if (ts > 0 && (Date.now() - ts) > FLOW_TTL_MS) {
      pendingAgentFlows.delete(flowKey);
      return null;
    }
    return flow;
  }

  function setFlow(flowKey, flow) {
    pendingAgentFlows.set(flowKey, { ...flow, __ts: Date.now() });
  }

  function setPendingBind(chatKey, agentName) {
    pendingBinds.set(chatKey, { name: agentName, __ts: Date.now() });
  }

  function getFreshPendingBind(chatKey) {
    const raw = pendingBinds.get(chatKey);
    if (!raw) return null;

    if (typeof raw === 'string') {
      // Backward compatibility: old in-memory shape was a plain agentName string.
      pendingBinds.set(chatKey, { name: raw, __ts: Date.now() });
      return raw;
    }

    const BIND_TTL_MS = resolveTtl(agentBindTtlMs, 10 * 60 * 1000);
    const ts = Number(raw.__ts || 0);
    if (ts > 0 && (Date.now() - ts) > BIND_TTL_MS) {
      pendingBinds.delete(chatKey);
      return null;
    }
    return raw.name || null;
  }

  function getBoundProject(chatId, cfg) {
    const agentMap = {
      ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}),
      ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}),
    };
    const boundKey = agentMap[String(chatId)];
    const boundProj = boundKey && cfg.projects && cfg.projects[boundKey];
    return { boundKey: boundKey || null, boundProj: boundProj || null };
  }

  async function bindViaUnifiedApi(bot, chatId, agentName, agentCwd) {
    if (agentTools && typeof agentTools.bindAgentToChat === 'function') {
      const res = await agentTools.bindAgentToChat(chatId, agentName, agentCwd);
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 绑定失败: ${res.error}`);
        return { ok: false };
      }
      const p = res.data.project || {};
      const icon = p.icon || '🤖';
      const action = res.data.isNewProject ? '绑定成功' : '重新绑定';
      const displayCwd = String(res.data.cwd || '').replace(HOME, '~');
      await bot.sendMessage(chatId, `${icon} ${p.name || agentName} ${action}\n目录: ${displayCwd}`);
      return { ok: true, data: res.data };
    }

    // Backward-compatible fallback
    await doBindAgent(bot, chatId, agentName, agentCwd);
    return { ok: true, data: { cwd: agentCwd } };
  }

  async function editRoleViaUnifiedApi(workspaceDir, deltaText) {
    if (agentTools && typeof agentTools.editAgentRoleDefinition === 'function') {
      return agentTools.editAgentRoleDefinition(workspaceDir, deltaText);
    }
    const legacy = await mergeAgentRole(workspaceDir, deltaText);
    if (legacy.error) return { ok: false, error: legacy.error };
    return { ok: true, data: legacy };
  }

  async function createAgentViaUnifiedApi(chatId, name, dir, roleDesc) {
    if (agentTools && typeof agentTools.createNewWorkspaceAgent === 'function') {
      return agentTools.createNewWorkspaceAgent(name, dir, roleDesc, chatId);
    }
    await doBindAgent({ sendMessage: async () => {} }, chatId, name, dir);
    const merged = await mergeAgentRole(dir, roleDesc);
    if (merged.error) return { ok: false, error: merged.error };
    return { ok: true, data: { cwd: dir, project: { name }, role: merged } };
  }

  async function listAgentsViaUnifiedApi(chatId) {
    if (agentTools && typeof agentTools.listAllAgents === 'function') {
      return agentTools.listAllAgents(chatId);
    }

    const cfg = loadConfig();
    const projects = cfg.projects || {};
    const entries = Object.entries(projects)
      .filter(([, p]) => p && p.cwd)
      .map(([key, p]) => ({
        key,
        name: p.name || key,
        cwd: p.cwd,
        icon: p.icon || '🤖',
      }));
    const { boundKey } = getBoundProject(chatId, cfg);
    return { ok: true, data: { agents: entries, boundKey } };
  }

  async function unbindViaUnifiedApi(chatId) {
    if (agentTools && typeof agentTools.unbindCurrentAgent === 'function') {
      return agentTools.unbindCurrentAgent(chatId);
    }

    const cfg = loadConfig();
    const isTg = typeof chatId === 'number';
    const ak = isTg ? 'telegram' : 'feishu';
    if (!cfg[ak]) cfg[ak] = {};
    if (!cfg[ak].chat_agent_map) cfg[ak].chat_agent_map = {};
    const old = cfg[ak].chat_agent_map[String(chatId)] || null;
    if (old) {
      delete cfg[ak].chat_agent_map[String(chatId)];
    }
    return { ok: true, data: { unbound: !!old, previousProjectKey: old } };
  }

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
          let msg = `${headerTitle}\n\n`;
          recentSessions.forEach((s, i) => {
            msg += sessionRichLabel(s, i + 1, _tags2) + '\n';
          });
          await bot.sendMessage(chatId, msg);
        }
        return true;
      }

      // Argument given -> match by name, then by session ID prefix
      const allSessions = listRecentSessions(50);
      const argLower = arg.toLowerCase();
      let fullMatch = allSessions.find(s => s.customTitle && s.customTitle.toLowerCase() === argLower);
      if (!fullMatch) {
        fullMatch = allSessions.find(s => s.customTitle && s.customTitle.toLowerCase().includes(argLower));
      }
      if (!fullMatch) {
        fullMatch = recentSessions.find(s => s.sessionId.startsWith(arg))
          || allSessions.find(s => s.sessionId.startsWith(arg));
      }
      if (!fullMatch) {
        // keep historical behavior:
        // "/resume 看到的session信息太少了" should be treated as normal text
        return null;
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

    // /agent new wizard state machine (kept for command compatibility)
    {
      const flow = getFreshFlow(String(chatId));
      if (flow && flow.step === 'name' && text && !text.startsWith('/')) {
        flow.name = text.trim();
        flow.step = 'desc';
        setFlow(String(chatId), flow);
        await bot.sendMessage(chatId, `好的，Agent 名称是「${flow.name}」\n\n请描述这个 Agent 的角色和职责（用自然语言）：`);
        return true;
      }
      if (flow && flow.step === 'desc' && text && !text.startsWith('/')) {
        pendingAgentFlows.delete(String(chatId));
        const { dir, name } = flow;
        const description = text.trim();
        await bot.sendMessage(chatId, `⏳ 正在配置 Agent「${name}」，稍等...`);
        const created = await createAgentViaUnifiedApi(chatId, name, dir, description);
        if (!created.ok) {
          await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${created.error}`);
          return true;
        }
        const roleInfo = created.data.role || {};
        if (roleInfo.skipped) {
          await bot.sendMessage(chatId, '✅ Agent 创建成功');
        } else if (roleInfo.created) {
          await bot.sendMessage(chatId, '📝 已创建 CLAUDE.md 并写入角色定义');
        } else {
          await bot.sendMessage(chatId, '📝 已将角色定义合并进现有 CLAUDE.md');
        }
        return true;
      }
    }

    // /agent edit wait-input flow (kept for command compatibility)
    {
      const editFlow = getFreshFlow(String(chatId) + ':edit');
      if (editFlow && text && !text.startsWith('/')) {
        pendingAgentFlows.delete(String(chatId) + ':edit');
        const { cwd } = editFlow;
        await bot.sendMessage(chatId, '⏳ 正在更新 CLAUDE.md...');
        const mergeResult = await editRoleViaUnifiedApi(cwd, text.trim());
        if (!mergeResult.ok) {
          await bot.sendMessage(chatId, `❌ 更新失败: ${mergeResult.error}`);
        } else {
          await bot.sendMessage(chatId, '✅ CLAUDE.md 已更新');
        }
        return true;
      }
    }

    if (text === '/agent' || text.startsWith('/agent ')) {
      const agentArg = text === '/agent' ? '' : text.slice(7).trim();
      const agentParts = agentArg.split(/\s+/).filter(Boolean);
      const agentSub = agentParts[0] || ''; // bind / list / new / edit / reset / unbind / ''

      // /agent bind <名称> [目录]
      if (agentSub === 'bind') {
        const bindName = agentParts[1];
        const bindCwd = agentParts.slice(2).join(' ');
        if (!bindName) {
          await bot.sendMessage(chatId, '用法: /agent bind <名称> [工作目录]\n例: /agent bind 小美 ~/\n或:  /agent bind 教授  (弹出目录选择)');
          return true;
        }
        if (!bindCwd) {
          setPendingBind(String(chatId), bindName);
          await sendDirPicker(bot, chatId, 'bind', `为「${bindName}」选择工作目录:`);
          return true;
        }
        await bindViaUnifiedApi(bot, chatId, bindName, expandPath(bindCwd));
        return true;
      }

      // /agent list
      if (agentSub === 'list') {
        const res = await listAgentsViaUnifiedApi(chatId);
        if (!res.ok) {
          await bot.sendMessage(chatId, `❌ 查询 Agent 失败: ${res.error}`);
          return true;
        }
        const agents = res.data.agents || [];
        if (agents.length === 0) {
          await bot.sendMessage(chatId, '暂无已配置的 Agent。\n使用 /agent new 创建，或 /agent bind <名称> 绑定目录。');
          return true;
        }
        const lines = ['📋 已配置的 Agent：', ''];
        for (const a of agents) {
          const icon = a.icon || '🤖';
          const name = a.name || a.key;
          const displayCwd = String(a.cwd || '').replace(HOME, '~');
          const bound = a.key === res.data.boundKey ? ' ◀ 当前' : '';
          lines.push(`${icon} ${name}${bound}`);
          lines.push(`   目录: ${displayCwd}`);
          lines.push(`   Key: ${a.key}`);
          lines.push('');
        }
        await bot.sendMessage(chatId, lines.join('\n').trimEnd());
        return true;
      }

      // /agent new (wizard)
      if (agentSub === 'new') {
        setFlow(String(chatId), { step: 'dir' });
        await sendBrowse(bot, chatId, 'agent-new', HOME, '步骤1/3：选择这个 Agent 的工作目录');
        return true;
      }

      // /agent edit [描述]
      if (agentSub === 'edit') {
        const cfg = loadConfig();
        const { boundProj } = getBoundProject(chatId, cfg);
        if (!boundProj || !boundProj.cwd) {
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先使用 /agent bind 或 /agent new');
          return true;
        }
        const cwd = normalizeCwd(boundProj.cwd);
        const inlineDelta = agentParts.slice(1).join(' ').trim();
        if (inlineDelta) {
          await bot.sendMessage(chatId, '⏳ 正在更新 CLAUDE.md...');
          const mergeResult = await editRoleViaUnifiedApi(cwd, inlineDelta);
          if (!mergeResult.ok) {
            await bot.sendMessage(chatId, `❌ 更新失败: ${mergeResult.error}`);
          } else {
            await bot.sendMessage(chatId, '✅ CLAUDE.md 已更新');
          }
          return true;
        }

        const claudeMdPath = path.join(cwd, 'CLAUDE.md');
        let currentContent = '（CLAUDE.md 不存在）';
        if (fs.existsSync(claudeMdPath)) {
          currentContent = fs.readFileSync(claudeMdPath, 'utf8');
          if (currentContent.length > 500) currentContent = currentContent.slice(0, 500) + '\n...(已截断)';
        }
        setFlow(String(chatId) + ':edit', { cwd });
        await bot.sendMessage(chatId, `📄 当前 CLAUDE.md 内容:\n\`\`\`\n${currentContent}\n\`\`\`\n\n请描述你想做的修改（用自然语言，例如：「把角色改成后端工程师，专注 Python」）：`);
        return true;
      }

      // /agent unbind
      if (agentSub === 'unbind') {
        const res = await unbindViaUnifiedApi(chatId);
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

      // /agent reset — delete "## Agent 角色" section
      if (agentSub === 'reset') {
        const cfg = loadConfig();
        const { boundProj } = getBoundProject(chatId, cfg);
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
        const before = fs.readFileSync(claudeMdPath, 'utf8');
        const after = before.replace(/(?:^|\n)## Agent 角色\n[\s\S]*?(?=\n## |$)/, '').trimStart();
        if (after === before.trimStart()) {
          await bot.sendMessage(chatId, '⚠️ 未找到「## Agent 角色」section，CLAUDE.md 未修改');
          return true;
        }
        fs.writeFileSync(claudeMdPath, after, 'utf8');
        await bot.sendMessage(chatId, '✅ 已删除角色 section，请重新发送角色描述（/agent edit 或自然语言修改）');
        return true;
      }

      // /agent (no sub command): show agent switch picker
      {
        const projects = config.projects || {};
        const entries = Object.entries(projects).filter(([, p]) => p.cwd);
        if (entries.length === 0) {
          await bot.sendMessage(chatId, '暂无已配置的 Agent。\n使用 /agent new 新建，或 /agent bind <名称> 绑定目录。');
          return true;
        }
        const currentSession = getSession(chatId);
        const currentCwd = currentSession && currentSession.cwd ? path.resolve(expandPath(currentSession.cwd)) : null;
        const buttons = entries.map(([key, p]) => {
          const projCwd = normalizeCwd(p.cwd);
          const active = currentCwd && path.resolve(projCwd) === currentCwd ? ' ◀' : '';
          return [{ text: `${p.icon || '🤖'} ${p.name || key}${active}`, callback_data: `/cd ${projCwd}` }];
        });
        await bot.sendButtons(chatId, '切换对话对象', buttons);
        return true;
      }
    }

    // /agent-bind-dir <path>: internal callback for bind picker
    if (text.startsWith('/agent-bind-dir ')) {
      const dirPath = expandPath(text.slice(16).trim());
      const agentName = getFreshPendingBind(String(chatId));
      if (!agentName) {
        await bot.sendMessage(chatId, '❌ 没有待完成的 /agent bind，请重新发送');
        return true;
      }
      pendingBinds.delete(String(chatId));
      await bindViaUnifiedApi(bot, chatId, agentName, dirPath);
      return true;
    }

    // /agent-dir <path>: internal callback for /agent new wizard
    if (text.startsWith('/agent-dir ')) {
      const dirPath = expandPath(text.slice(11).trim());
      const flow = getFreshFlow(String(chatId));
      if (!flow || flow.step !== 'dir') {
        await bot.sendMessage(chatId, '❌ 没有待完成的 /agent new，请重新发送 /agent new');
        return true;
      }
      flow.dir = dirPath;
      flow.step = 'name';
      setFlow(String(chatId), flow);
      const displayPath = dirPath.replace(HOME, '~');
      await bot.sendMessage(chatId, `✓ 已选择目录：${displayPath}\n\n步骤2/3：给这个 Agent 起个名字？`);
      return true;
    }

    return false;
  }

  return { handleAgentCommand };
}

module.exports = { createAgentCommandHandler };
