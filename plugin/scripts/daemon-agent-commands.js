'use strict';

const { normalizeEngineName: _normalizeEngine } = require('./daemon-utils');
const {
  getBoundProject,
  createWorkspaceAgent,
  bindAgentToChat,
  editAgentRole,
  listAgents,
  unbindAgent,
  handleActivateCommand,
} = require('./daemon-agent-workflow');
const {
  startNewAgentWizard,
  completeAgentCreation,
  readAgentRolePreview,
  resetAgentRoleSection,
  handleSoulCommand,
} = require('./daemon-agent-lifecycle');
const { parseTeamMembers, createTeamWorkspace } = require('./daemon-team-workflow');

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
    getSessionForEngine,
    listRecentSessions,
    buildSessionCardElements,
    sessionLabel,
    loadSessionTags,
    sessionRichLabel,
    getSessionRecentContext,
    getSessionRecentDialogue,
    pendingBinds,
    pendingAgentFlows,
    pendingTeamFlows,
    pendingActivations,
    writeConfigSafe,
    backupConfig,
    execSync,
    doBindAgent,
    mergeAgentRole,
    agentTools,
    attachOrCreateSession,
    agentFlowTtlMs,
    agentBindTtlMs,
    getDefaultEngine = () => 'claude',
    log = () => {},
  } = deps;

  function normalizeEngineName(name) {
    return _normalizeEngine(name, getDefaultEngine);
  }

  function inferStoredEngine(rawSession) {
    if (!rawSession || typeof rawSession !== 'object') return getDefaultEngine();
    if (rawSession.engine) return normalizeEngineName(rawSession.engine);
    const slots = rawSession.engines && typeof rawSession.engines === 'object' ? rawSession.engines : null;
    if (!slots) return getDefaultEngine();
    const started = Object.entries(slots).find(([, slot]) => slot && slot.started);
    if (started) return normalizeEngineName(started[0]);
    const available = Object.keys(slots);
    return available.length === 1 ? normalizeEngineName(available[0]) : getDefaultEngine();
  }

  function buildBoundSessionChatId(projectKey) {
    const key = String(projectKey || '').trim();
    return key ? `_bound_${key}` : '';
  }

  function getSessionRoute(chatId) {
    const cfg = loadConfig();
    const state = loadState();
    const chatKey = String(chatId);
    const agentMap = { ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}), ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}) };
    const boundKey = agentMap[chatKey] || null;
    const boundProj = boundKey && cfg.projects ? cfg.projects[boundKey] : null;
    const stickyKey = state && state.team_sticky ? state.team_sticky[chatKey] : null;
    const stickyMember = stickyKey && boundProj && Array.isArray(boundProj.team)
      ? boundProj.team.find((m) => m && m.key === stickyKey)
      : null;

    if (stickyMember) {
      return {
        sessionChatId: `_agent_${stickyMember.key}`,
        cwd: stickyMember.cwd ? normalizeCwd(stickyMember.cwd) : (boundProj && boundProj.cwd ? normalizeCwd(boundProj.cwd) : null),
        engine: normalizeEngineName(stickyMember.engine || (boundProj && boundProj.engine)),
      };
    }

    if (boundProj) {
      return {
        sessionChatId: buildBoundSessionChatId(boundKey),
        cwd: boundProj.cwd ? normalizeCwd(boundProj.cwd) : null,
        engine: normalizeEngineName(boundProj.engine),
      };
    }

    const rawSession = getSession(chatId);
    return {
      sessionChatId: String(chatId),
      cwd: rawSession && rawSession.cwd ? normalizeCwd(rawSession.cwd) : null,
      engine: inferStoredEngine(rawSession),
    };
  }

  function getCurrentEngine(chatId) {
    return getSessionRoute(chatId).engine;
  }

  function getLogicalSessionForRoute(route) {
    if (!route || !route.sessionChatId) return null;
    if (typeof getSessionForEngine === 'function') {
      const engineSession = getSessionForEngine(route.sessionChatId, route.engine);
      if (engineSession && engineSession.id) return engineSession;
    }
    const raw = getSession(route.sessionChatId);
    if (!raw) return null;
    const slot = raw.engines && raw.engines[route.engine];
    if (slot && slot.id) return { cwd: raw.cwd, engine: route.engine, ...slot };
    if (raw.id) return { cwd: raw.cwd, engine: route.engine, id: raw.id, started: !!raw.started };
    return null;
  }

  function buildResumeChoices({ recentSessions, currentLogical, curCwd, currentEngine, isLogicalRoute }) {
    const items = [];
    const seen = new Set();
    if (
      isLogicalRoute
      && currentLogical
      && currentLogical.id
      && currentLogical.started
    ) {
      items.push({
        sessionId: currentLogical.id,
        projectPath: currentLogical.cwd || curCwd || HOME,
        engine: currentEngine,
        customTitle: '当前会话',
        summary: '优先续接当前智能体会话',
      });
      seen.add(String(currentLogical.id));
    }
    for (const session of recentSessions || []) {
      const key = String(session && session.sessionId || '');
      if (!key || seen.has(key)) continue;
      items.push(session);
      seen.add(key);
    }
    return items;
  }

  function inferEngineByCwd(cfg, cwd) {
    if (!cfg || !cfg.projects || !cwd) return null;
    const targetCwd = normalizeCwd(cwd);
    for (const proj of Object.values(cfg.projects || {})) {
      if (!proj || !proj.cwd) continue;
      if (normalizeCwd(proj.cwd) === targetCwd) {
        return normalizeEngineName(proj.engine);
      }
    }
    return null;
  }

  async function autoCreateSessionOnEmptyResume(bot, chatId, cwd, engine) {
    const resolvedCwd = cwd ? normalizeCwd(cwd) : null;
    if (!resolvedCwd || !fs.existsSync(resolvedCwd) || typeof attachOrCreateSession !== 'function') {
      await bot.sendMessage(chatId, `No sessions found${resolvedCwd ? ' in ' + path.basename(resolvedCwd) : ''}. Try /new first.`);
      return true;
    }
    attachOrCreateSession(getSessionRoute(chatId).sessionChatId, resolvedCwd, '', engine || getDefaultEngine());
    await bot.sendMessage(chatId, `📁 ${path.basename(resolvedCwd)}\n✅ 已自动创建新会话`);
    return true;
  }

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

  function getFreshTimedFlow(flowMap, flowKey) {
    if (!flowMap) return null;
    const flow = flowMap.get(flowKey);
    if (!flow) return null;
    const FLOW_TTL_MS = resolveTtl(agentFlowTtlMs, 10 * 60 * 1000);
    const ts = Number(flow.__ts || 0);
    if (!(ts > 0) && flow && typeof flow === 'object') {
      const stamped = { ...flow, __ts: Date.now() };
      flowMap.set(flowKey, stamped);
      return stamped;
    }
    if (ts > 0 && (Date.now() - ts) > FLOW_TTL_MS) {
      flowMap.delete(flowKey);
      return null;
    }
    return flow;
  }

  function setTimedFlow(flowMap, flowKey, flow) {
    if (!flowMap) return;
    flowMap.set(flowKey, { ...flow, __ts: Date.now() });
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

  async function bindViaUnifiedApi(bot, chatId, agentName, agentCwd) {
    return bindAgentToChat({
      agentTools,
      doBindAgent,
      bot,
      chatId,
      agentName,
      agentCwd,
      HOME,
      attachOrCreateSession,
      normalizeCwd,
      getDefaultEngine,
    });
  }

  async function listAgentsViaUnifiedApi(chatId) {
    return listAgents({ agentTools, chatId, loadConfig });
  }

  async function unbindViaUnifiedApi(chatId) {
    return unbindAgent({ agentTools, chatId, loadConfig, writeConfigSafe, backupConfig });
  }

  async function editRoleViaUnifiedApi(workspaceDir, deltaText) {
    return editAgentRole({ agentTools, mergeAgentRole, workspaceDir, deltaText });
  }

  async function handleAgentCommand(ctx) {
    const { bot, chatId } = ctx;
    const config = ctx.config || {};
    const text = ctx.text || '';

    // /cancel — 取消任何挂起的向导流
    if (text === '/cancel') {
      let cancelled = false;
      if (pendingTeamFlows && pendingTeamFlows.has(String(chatId))) {
        pendingTeamFlows.delete(String(chatId));
        cancelled = true;
      }
      if (pendingAgentFlows && pendingAgentFlows.has(String(chatId))) {
        pendingAgentFlows.delete(String(chatId));
        cancelled = true;
      }
      if (pendingBinds && pendingBinds.has(String(chatId))) {
        pendingBinds.delete(String(chatId));
        cancelled = true;
      }
      await bot.sendMessage(chatId, cancelled ? '✅ 已取消当前操作' : '没有进行中的操作');
      return true;
    }

    if (text === '/resume' || text.startsWith('/resume ')) {
      const arg = text.slice(7).trim();

      // Get current workdir to scope session list — prefer bound project cwd over session cwd
      const route = getSessionRoute(chatId);
      const isLogicalRoute = route.sessionChatId !== String(chatId);
      const currentLogical = getLogicalSessionForRoute(route);
      const curSession = getSession(route.sessionChatId) || getSession(chatId);
      const curCwd = route.cwd || (curSession ? curSession.cwd : null);
      const currentEngine = getCurrentEngine(chatId);
      log('DEBUG', `[/resume] chatId=${chatId} curCwd=${curCwd} engine=${currentEngine} route.sessionChatId=${route.sessionChatId}`);
      const recentSessions = listRecentSessions(5, curCwd, currentEngine);
      log('DEBUG', `[/resume] recentSessions=${recentSessions.length} ids=[${recentSessions.map(s=>s.sessionId.slice(0,8)).join(',')}]`);
      const resumeChoices = buildResumeChoices({
        recentSessions,
        currentLogical,
        curCwd,
        currentEngine,
        isLogicalRoute,
      });

      if (!arg) {
        if (resumeChoices.length === 0) {
          return autoCreateSessionOnEmptyResume(bot, chatId, curCwd, currentEngine);
        }
        const headerTitle = curCwd ? `📋 Sessions in ${path.basename(curCwd)}` : '📋 Recent Sessions';
        try {
          if (bot.sendRawCard) {
            await bot.sendRawCard(chatId, headerTitle, buildSessionCardElements(resumeChoices));
          } else {
            throw new Error('raw-card-unavailable');
          }
        } catch {
          try {
            if (bot.sendButtons) {
              const buttons = resumeChoices.map(s => {
                return [{ text: sessionLabel(s), callback_data: `/resume ${s.sessionId}` }];
              });
              await bot.sendButtons(chatId, headerTitle, buttons);
            } else {
              throw new Error('buttons-unavailable');
            }
          } catch {
            const _tags2 = loadSessionTags();
            let msg = `${headerTitle}\n`;
            msg += '\n';
            resumeChoices.forEach((s, i) => {
              msg += sessionRichLabel(s, i + 1, _tags2) + '\n';
            });
            await bot.sendMessage(chatId, msg);
          }
        }
        return true;
      }

      // Argument given -> match current resume choices first (includes synthetic
      // "当前会话" entry for logical routes), then fall back to global history.
      const allSessions = listRecentSessions(50, null, currentEngine);
      const argLower = arg.toLowerCase();
      let fullMatch = resumeChoices.find(s => s.customTitle && s.customTitle.toLowerCase() === argLower);
      if (!fullMatch) {
        fullMatch = allSessions.find(s => s.customTitle && s.customTitle.toLowerCase() === argLower);
      }
      if (!fullMatch) {
        fullMatch = resumeChoices.find(s => s.customTitle && s.customTitle.toLowerCase().includes(argLower));
      }
      if (!fullMatch) {
        fullMatch = allSessions.find(s => s.customTitle && s.customTitle.toLowerCase().includes(argLower));
      }
      if (!fullMatch) {
        fullMatch = recentSessions.find(s => s.sessionId.startsWith(arg))
          || allSessions.find(s => s.sessionId.startsWith(arg));
      }
      if (!fullMatch) {
        fullMatch = resumeChoices.find(s => s.sessionId.startsWith(arg));
      }
      if (!fullMatch) {
        // keep historical behavior:
        // "/resume 看到的session信息太少了" should be treated as normal text
        return null;
      }
      const sessionId = fullMatch.sessionId;
      const cwd = fullMatch.projectPath || (curSession && curSession.cwd) || HOME;

      const state2 = loadState();
      const cfgForEngine = loadConfig();
      const sessionKey = route.sessionChatId;
      const existing = state2.sessions[sessionKey] || {};
      const existingEngine = normalizeEngineName(
        existing.engine
        || (existing.engines && Object.entries(existing.engines).find(([, slot]) => slot && slot.started)?.[0])
      );
      const engineByTargetCwd = normalizeEngineName(fullMatch.engine)
        || inferEngineByCwd(cfgForEngine, cwd)
        || existingEngine;
      const selectedLogicalCurrent = isLogicalRoute
        && currentLogical
        && currentLogical.id
        && sessionId === currentLogical.id;
      const targetSessionId = sessionId;
      const targetCwd = cwd;
      const existingEngines = existing.engines || {};
      state2.sessions[sessionKey] = {
        ...existing,
        cwd: targetCwd,
        id: targetSessionId,
        started: true,
        engine: engineByTargetCwd,
        engines: { ...existingEngines, [engineByTargetCwd]: { id: targetSessionId, started: true } },
      };
      saveState(state2);
      const name = fullMatch.customTitle;
      const label = name || (fullMatch.summary || fullMatch.firstPrompt || '').slice(0, 40) || targetSessionId.slice(0, 8);

      // 读取最近对话片段，帮助确认是否切换到正确的 session
      const recentCtx = getSessionRecentContext ? getSessionRecentContext(targetSessionId) : null;
      const recentDialogue = getSessionRecentDialogue ? getSessionRecentDialogue(targetSessionId, 4) : null;
      let msg = `✅ 已切换: **${label}**\n📁 ${path.basename(cwd)}`;
      if (selectedLogicalCurrent) {
        msg += '\n\n已恢复当前智能体会话。';
      }
      if (Array.isArray(recentDialogue) && recentDialogue.length > 0) {
        msg += '\n\n最近对话:';
        for (const item of recentDialogue) {
          const marker = item.role === 'assistant' ? '🤖' : '👤';
          const snippet = String(item.text || '').replace(/\n/g, ' ').slice(0, 120);
          if (snippet) msg += `\n${marker} ${snippet}`;
        }
      } else if (recentCtx) {
        if (recentCtx.lastUser) {
          const snippet = recentCtx.lastUser.replace(/\n/g, ' ').slice(0, 80);
          msg += `\n\n💬 上次你说: _${snippet}${recentCtx.lastUser.length > 80 ? '…' : ''}_`;
        }
        if (recentCtx.lastAssistant) {
          const snippet = recentCtx.lastAssistant.replace(/\n/g, ' ').slice(0, 80);
          msg += `\n🤖 上次回复: ${snippet}${recentCtx.lastAssistant.length > 80 ? '…' : ''}`;
        }
      }
      if (bot.sendMarkdown) {
        await bot.sendMarkdown(chatId, msg);
      } else {
        await bot.sendMessage(chatId, msg.replace(/[_*`]/g, ''));
      }
      return true;
    }

    // wizard state machine removed — use natural language to create agents

    // /agent new 多步向导状态机（name/desc 步骤）
    if (pendingAgentFlows) {
      const flow = getFreshTimedFlow(pendingAgentFlows, String(chatId));
      if (flow && text && !text.startsWith('/')) {
        if (flow.step === 'name') {
          flow.name = text.trim();
          if (flow.isClone) {
            pendingAgentFlows.delete(String(chatId));
            return completeAgentCreation({
              bot,
              chatId,
              flow,
              description: '',
              createWorkspaceAgent: ({ chatId: createChatId, agentName, workspaceDir, roleDescription }) => createWorkspaceAgent({
                agentTools,
                chatId: createChatId,
                agentName,
                workspaceDir,
                roleDescription,
                attachOrCreateSession,
                normalizeCwd,
                getDefaultEngine,
              }),
              doBindAgent,
              mergeAgentRole,
            });
          }
          flow.step = 'desc';
          setTimedFlow(pendingAgentFlows, String(chatId), flow);
          await bot.sendMessage(chatId, `好的，Agent 名称是「${flow.name}」\n\n步骤3/3：请描述这个 Agent 的角色和职责（用自然语言）：`);
          return true;
        }
        if (flow.step === 'desc') {
          pendingAgentFlows.delete(String(chatId));
          return completeAgentCreation({
            bot,
            chatId,
            flow,
            description: text.trim(),
            createWorkspaceAgent: ({ chatId: createChatId, agentName, workspaceDir, roleDescription }) => createWorkspaceAgent({
              agentTools,
              chatId: createChatId,
              agentName,
              workspaceDir,
              roleDescription,
              attachOrCreateSession,
              normalizeCwd,
              getDefaultEngine,
            }),
            doBindAgent,
            mergeAgentRole,
          });
        }
      }
    }

    // /agent new team 多步向导状态机
    if (pendingTeamFlows) {
      const teamFlow = getFreshTimedFlow(pendingTeamFlows, String(chatId));
      if (teamFlow && text && !text.startsWith('/')) {
        if (teamFlow.step === 'name') {
          teamFlow.name = text.trim();
          teamFlow.step = 'members';
          setTimedFlow(pendingTeamFlows, String(chatId), teamFlow);
          await bot.sendMessage(chatId, `团队名称：「${teamFlow.name}」

请输入成员列表，格式：
名称:icon:颜色

可用颜色：green, yellow, red, blue, purple, orange, pink, indigo

示例：
编剧:✍️:green, 审核:🔍:yellow, 推广:📢:red

一行一个成员，或用逗号分隔多个`);
          return true;
        }

        if (teamFlow.step === 'members') {
          const members = parseTeamMembers(text, teamFlow.name);
          if (members.length === 0) {
            await bot.sendMessage(chatId, '⚠️ 请至少添加一个成员，格式：名称:icon:颜色');
            return true;
          }
          teamFlow.members = members;
          teamFlow.step = 'cwd';
          setTimedFlow(pendingTeamFlows, String(chatId), teamFlow);
          const memberList = members.map(m => `${m.icon} ${m.name} (${m.color})`).join('\n');
          await bot.sendMessage(chatId, `✅ 成员配置：\n\n${memberList}\n\n正在选择父目录...`);
          await sendBrowse(bot, chatId, 'team-new', HOME, `为「${teamFlow.name}」选择父工作目录`);
          return true;
        }
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

      // /agent new [team] — 创建新 Agent 或团队
      if (agentSub === 'new') {
        return startNewAgentWizard({
          bot,
          chatId,
          secondArg: agentParts[1],
          pendingTeamFlows,
          pendingAgentFlows,
          loadConfig,
          normalizeCwd,
          sendBrowse,
          HOME,
        });
      }

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
          await bot.sendMessage(chatId, '暂无已配置的 Agent。\n用自然语言说"创建一个agent，目录是~/xxx"，或 /agent bind <名称> <目录>。');
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

      // /agent edit [描述]
      if (agentSub === 'edit') {
        const cfg = loadConfig();
        const { boundProj } = getBoundProject(chatId, cfg);
        if (!boundProj || !boundProj.cwd) {
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先用自然语言创建 Agent 或 /agent bind <名称> <目录>');
          return true;
        }
        const cwd = normalizeCwd(boundProj.cwd);
        // Lazy migration: ensure soul layer exists for agents created before this feature
        if (agentTools && typeof agentTools.repairAgentSoul === 'function') {
          await agentTools.repairAgentSoul(cwd).catch(() => {});
        }
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

        const currentContent = readAgentRolePreview({ fs, path, cwd });
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
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先用自然语言创建 Agent 或 /agent bind <名称> <目录>');
          return true;
        }
        const cwd = normalizeCwd(boundProj.cwd);
        const resetResult = resetAgentRoleSection({ fs, path, cwd });
        if (resetResult.status === 'missing') {
          await bot.sendMessage(chatId, '⚠️ CLAUDE.md 不存在，无需重置');
          return true;
        }
        if (resetResult.status === 'unchanged') {
          await bot.sendMessage(chatId, '⚠️ 未找到「## Agent 角色」section，CLAUDE.md 未修改');
          return true;
        }
        await bot.sendMessage(chatId, '✅ 已删除角色 section，请重新发送角色描述（/agent edit 或自然语言修改）');
        return true;
      }


      // /agent soul [repair | edit <text>]
      // Manage the agent's soul.md identity file.
      // "repair"  → lazy-migration: create ~/.metame/agents/<id>/ and project symlinks.
      // "edit"    → overwrite soul.md with provided text.
      // (default) → display current SOUL.md content.
      if (agentSub === 'soul') {
        const soulAction = agentParts[1] || '';
        const cfg = loadConfig();
        const { boundProj } = getBoundProject(chatId, cfg);
        if (!boundProj || !boundProj.cwd) {
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先 /agent bind <名称> <目录>');
          return true;
        }
        return handleSoulCommand({
          bot,
          chatId,
          soulAction,
          soulText: agentParts.slice(2).join(' ').trim(),
          cwd: normalizeCwd(boundProj.cwd),
          fs,
          path,
          agentTools,
        });
      }


      // /agent (no sub command): show agent switch picker
      {
        const projects = config.projects || {};
        const entries = Object.entries(projects).filter(([, p]) => p.cwd);
        if (entries.length === 0) {
          await bot.sendMessage(chatId, '暂无已配置的 Agent。\n用自然语言说"创建一个agent，目录是~/xxx"，或 /agent bind <名称> <目录>。');
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

    // /activate — bind this unbound chat to the most recently created pending agent
    if (text === '/activate' || text.startsWith('/activate ')) {
      return handleActivateCommand({
        bot,
        chatId,
        loadConfig,
        pendingActivations,
        bindAgent: (agentName, agentCwd) => bindViaUnifiedApi(bot, chatId, agentName, agentCwd),
      });
    }

    // /agent-dir <path>: /agent new 向导的目录选择回调（步骤1→步骤2）
    if (text.startsWith('/agent-dir ')) {
      const dirPath = expandPath(text.slice(11).trim());
      const flow = pendingAgentFlows && pendingAgentFlows.get(String(chatId));
      if (!flow || flow.step !== 'dir') {
        await bot.sendMessage(chatId, '❌ 没有待完成的 /agent new，请重新发送 /agent new');
        return true;
      }
      flow.dir = dirPath;
      flow.step = 'name';
      pendingAgentFlows.set(String(chatId), flow);
      const displayPath = dirPath.replace(HOME, '~');
      const cloneHint = flow.isClone ? '（分身模式）' : '';
      await bot.sendMessage(chatId, `✓ 已选择目录：${displayPath}${cloneHint}\n\n${flow.isClone ? '步骤2/2' : '步骤2/3'}：给这个 Agent 起个名字？`);
      return true;
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

    // /agent-team-dir <path>: directory picker callback for team creation
    if (text.startsWith('/agent-team-dir ')) {
      const dirPath = expandPath(text.slice(16).trim());
      const teamFlow = getFreshTimedFlow(pendingTeamFlows, String(chatId));
      if (!teamFlow || teamFlow.step !== 'cwd') {
        await bot.sendMessage(chatId, '❌ 没有待完成的团队创建，请重新发送 /agent new team');
        return true;
      }
      teamFlow.step = 'creating';
      setTimedFlow(pendingTeamFlows, String(chatId), teamFlow);
      await bot.sendMessage(chatId, `⏳ 正在创建团队「${teamFlow.name}」...`);

      try {
        const members = Array.isArray(teamFlow.members) ? teamFlow.members : [];
        const { teamDir, parentProjectKey } = createTeamWorkspace({
          fs,
          path,
          execSync,
          dirPath,
          teamName: teamFlow.name,
          members,
          loadConfig,
          normalizeCwd,
          writeConfigSafe,
          backupConfig,
          HOME,
        });

        const memberList = members.map(m => `${m.icon} ${m.key}`).join('  |  ');
        const yamlNote = parentProjectKey
          ? `📝 已更新 daemon.yaml：${parentProjectKey}.team`
          : '⚠️ 未找到父项目，请手动在 daemon.yaml 中注册 team 段';
        await bot.sendMessage(chatId, `🎉 **团队创建完成！**

**${teamFlow.name}**
${memberList}

📁 目录：${teamDir.replace(HOME, '~')}/
${yamlNote}

💡 发 \`/agent\` 可切换到成员对话`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 创建失败: ${e.message}`);
      }

      pendingTeamFlows.delete(String(chatId));
      return true;
    }

    return false;
  }

  return { handleAgentCommand };
}

module.exports = {
  createAgentCommandHandler,
};
