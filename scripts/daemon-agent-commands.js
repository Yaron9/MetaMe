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
    getSessionRecentContext,
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
  } = deps;

  function normalizeEngineName(name) {
    const n = String(name || '').trim().toLowerCase();
    return n === 'codex' ? 'codex' : getDefaultEngine();
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
        sessionChatId: `_agent_${boundKey}`,
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

  // Pending activations have no TTL — they persist until consumed.
  // The creating chatId is stored to prevent self-activation.

  function storePendingActivation(agentKey, agentName, cwd, createdByChatId) {
    if (!pendingActivations) return;
    pendingActivations.set(agentKey, {
      agentKey, agentName, cwd,
      createdByChatId: String(createdByChatId),
      createdAt: Date.now(),
    });
  }

  // Returns the latest pending activation, excluding the creating chat
  function getLatestActivationForChat(chatId) {
    if (!pendingActivations || pendingActivations.size === 0) return null;
    const cid = String(chatId);
    let latest = null;
    for (const rec of pendingActivations.values()) {
      if (rec.createdByChatId === cid) continue; // creating chat cannot self-activate
      if (!latest || rec.createdAt > latest.createdAt) latest = rec;
    }
    return latest;
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
      if (res.data.cwd && typeof attachOrCreateSession === 'function') {
        attachOrCreateSession(
          chatId,
          normalizeCwd(res.data.cwd),
          p.name || agentName || res.data.projectKey || '',
          p.engine || getDefaultEngine()
        );
      }
      await bot.sendMessage(chatId, `${icon} ${p.name || agentName} ${action}\n目录: ${displayCwd}`);
      return { ok: true, data: res.data };
    }

    // Backward-compatible fallback
    const fallback = await doBindAgent(bot, chatId, agentName, agentCwd);
    if (!fallback || fallback.ok === false) {
      return { ok: false, error: (fallback && fallback.error) || 'bind failed' };
    }
    const fallbackCwd = (fallback.data && fallback.data.cwd) || agentCwd;
    if (fallbackCwd && typeof attachOrCreateSession === 'function') {
      attachOrCreateSession(chatId, normalizeCwd(fallbackCwd), agentName || '', getDefaultEngine());
    }
    return {
      ok: true,
      data: {
        cwd: fallbackCwd,
        projectKey: fallback && fallback.data ? fallback.data.projectKey : null,
        project: fallback && fallback.data ? fallback.data.project : null,
      },
    };
  }

  async function editRoleViaUnifiedApi(workspaceDir, deltaText) {
    if (agentTools && typeof agentTools.editAgentRoleDefinition === 'function') {
      return agentTools.editAgentRoleDefinition(workspaceDir, deltaText);
    }
    const legacy = await mergeAgentRole(workspaceDir, deltaText);
    if (legacy.error) return { ok: false, error: legacy.error };
    return { ok: true, data: legacy };
  }

  async function createAgentViaUnifiedApi(chatId, name, dir, roleDesc, opts = {}) {
    // Default: skip binding the creating chat — let the target group activate via /activate
    const { skipChatBinding = true, engine = null } = opts;
    if (agentTools && typeof agentTools.createNewWorkspaceAgent === 'function') {
      const res = await agentTools.createNewWorkspaceAgent(name, dir, roleDesc, chatId, { skipChatBinding, engine });
      if (res.ok && skipChatBinding && res.data && res.data.projectKey) {
        storePendingActivation(res.data.projectKey, name, res.data.cwd, chatId);
      }
      return res;
    }
    const bound = await doBindAgent({ sendMessage: async () => {} }, chatId, name, dir);
    if (!bound || bound.ok === false) {
      return { ok: false, error: (bound && bound.error) || 'bind failed' };
    }
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
      const curSession = getSession(route.sessionChatId) || getSession(chatId);
      const curCwd = route.cwd || (curSession ? curSession.cwd : null);
      const currentEngine = getCurrentEngine(chatId);
      const recentSessions = listRecentSessions(5, curCwd, currentEngine);
      const usedCrossEngineFallback = recentSessions.length === 0;
      const fallbackRecentSessions = usedCrossEngineFallback
        ? listRecentSessions(5, curCwd)
        : recentSessions;

      if (!arg) {
        if (fallbackRecentSessions.length === 0) {
          return autoCreateSessionOnEmptyResume(bot, chatId, curCwd, currentEngine);
        }
        const headerBase = curCwd ? `📋 Sessions in ${path.basename(curCwd)}` : '📋 Recent Sessions';
        const headerTitle = usedCrossEngineFallback ? `${headerBase} · cross-engine` : headerBase;
        if (bot.sendRawCard) {
          await bot.sendRawCard(chatId, headerTitle, buildSessionCardElements(fallbackRecentSessions));
        } else if (bot.sendButtons) {
          const buttons = fallbackRecentSessions.map(s => {
            return [{ text: sessionLabel(s), callback_data: `/resume ${s.sessionId}` }];
          });
          await bot.sendButtons(chatId, headerTitle, buttons);
        } else {
          const _tags2 = loadSessionTags();
          let msg = `${headerTitle}\n`;
          if (usedCrossEngineFallback) msg += `当前 ${currentEngine} 没有可恢复会话，已回退显示同目录其他引擎。\n`;
          msg += '\n';
          fallbackRecentSessions.forEach((s, i) => {
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
        fullMatch = fallbackRecentSessions.find(s => s.sessionId.startsWith(arg))
          || allSessions.find(s => s.sessionId.startsWith(arg));
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
      const existingEngines = existing.engines || {};
      state2.sessions[sessionKey] = {
        ...existing,
        cwd,
        id: sessionId,
        started: true,
        engine: engineByTargetCwd,
        engines: { ...existingEngines, [engineByTargetCwd]: { id: sessionId, started: true } },
      };
      saveState(state2);
      const name = fullMatch.customTitle;
      const label = name || (fullMatch.summary || fullMatch.firstPrompt || '').slice(0, 40) || sessionId.slice(0, 8);

      // 读取最近对话片段，帮助确认是否切换到正确的 session
      const recentCtx = getSessionRecentContext ? getSessionRecentContext(sessionId) : null;
      let msg = `✅ 已切换: **${label}**\n📁 ${path.basename(cwd)}`;
      if (recentCtx) {
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
      const flow = pendingAgentFlows.get(String(chatId));
      if (flow && text && !text.startsWith('/')) {
        if (flow.step === 'name') {
          flow.name = text.trim();
          flow.step = 'desc';
          pendingAgentFlows.set(String(chatId), flow);
          await bot.sendMessage(chatId, `好的，Agent 名称是「${flow.name}」\n\n步骤3/3：请描述这个 Agent 的角色和职责（用自然语言）：`);
          return true;
        }
        if (flow.step === 'desc') {
          pendingAgentFlows.delete(String(chatId));
          const { dir, name, isClone, parentCwd } = flow;
          const description = text.trim();
          await bot.sendMessage(chatId, `⏳ 正在配置 Agent「${name}」，稍等...`);
          try {
            await doBindAgent(bot, chatId, name, dir);
            const mergeResult = await mergeAgentRole(dir, description, isClone, parentCwd);
            if (mergeResult && mergeResult.error) {
              await bot.sendMessage(chatId, `⚠️ CLAUDE.md 合并失败: ${mergeResult.error}，其他配置已保存`);
            } else if (mergeResult && mergeResult.symlinked) {
              await bot.sendMessage(chatId, `🔗 CLAUDE.md 已链接到父 Agent（分身模式）\n✅ Agent「${name}」创建完成`);
            } else if (mergeResult && mergeResult.created) {
              await bot.sendMessage(chatId, `📝 已创建 CLAUDE.md\n✅ Agent「${name}」创建完成`);
            } else {
              await bot.sendMessage(chatId, `📝 已更新 CLAUDE.md\n✅ Agent「${name}」创建完成`);
            }
          } catch (e) {
            await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${e.message}`);
          }
          return true;
        }
      }
    }

    // /agent new team 多步向导状态机
    if (pendingTeamFlows) {
      const teamFlow = pendingTeamFlows.get(String(chatId));
      if (teamFlow && text && !text.startsWith('/')) {
        if (teamFlow.step === 'name') {
          teamFlow.name = text.trim();
          teamFlow.step = 'members';
          pendingTeamFlows.set(String(chatId), teamFlow);
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
          const validColors = ['green', 'yellow', 'red', 'blue', 'purple', 'orange', 'pink', 'indigo'];
          const memberLines = text.split(/[,，\n]/).filter(l => l.trim());
          const members = [];
          for (const line of memberLines) {
            const parts = line.trim().split(':');
            const name = parts[0] && parts[0].trim();
            const icon = (parts[1] && parts[1].trim()) || '🤖';
            const rawColor = parts[2] && parts[2].trim().toLowerCase();
            const color = validColors.includes(rawColor) ? rawColor : validColors[members.length % validColors.length];
            if (name) {
              members.push({ key: name, name: `${teamFlow.name} · ${name}`, icon, color, nicknames: [name] });
            }
          }
          if (members.length === 0) {
            await bot.sendMessage(chatId, '⚠️ 请至少添加一个成员，格式：名称:icon:颜色');
            return true;
          }
          teamFlow.members = members;
          teamFlow.step = 'cwd';
          pendingTeamFlows.set(String(chatId), teamFlow);
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
        const secondArg = agentParts[1];
        if (secondArg === 'team') {
          if (!pendingTeamFlows) {
            await bot.sendMessage(chatId, '❌ 团队向导暂不可用');
            return true;
          }
          pendingTeamFlows.set(String(chatId), { step: 'name' });
          await bot.sendMessage(chatId, `🏗️ **团队创建向导**

请输入团队名称（如：短剧团队、销售团队）：

输入 /cancel 可取消`);
          return true;
        }
        // /agent new clone — 分身模式
        const isClone = secondArg === 'clone';
        let parentCwd = null;
        if (isClone) {
          const cfg = loadConfig();
          const agentMap = {
            ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}),
            ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}),
          };
          const boundKey = agentMap[String(chatId)];
          const boundProj = boundKey && cfg.projects && cfg.projects[boundKey];
          if (boundProj && boundProj.cwd) parentCwd = normalizeCwd(boundProj.cwd);
        }
        pendingAgentFlows.set(String(chatId), { step: 'dir', isClone, parentCwd, __ts: Date.now() });
        const hint = isClone ? `（${parentCwd ? '分身模式：将链接父 Agent 的 CLAUDE.md' : '⚠️ 当前群未绑定 Agent'})` : '';
        await sendBrowse(bot, chatId, 'agent-new', HOME, `步骤1/3：选择 Agent 的工作目录${hint}`);
        return true;
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
          await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent，请先用自然语言创建 Agent 或 /agent bind <名称> <目录>');
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
        const cwd = normalizeCwd(boundProj.cwd);
        const soulPath = path.join(cwd, 'SOUL.md');

        if (soulAction === 'repair') {
          if (agentTools && typeof agentTools.repairAgentSoul === 'function') {
            const res = await agentTools.repairAgentSoul(cwd);
            if (!res.ok) {
              await bot.sendMessage(chatId, '❌ Soul 修复失败: ' + res.error);
            } else {
              const viewModes = res.data.views
                ? Object.entries(res.data.views).map(([k, v]) => k + ':' + v).join(', ')
                : '—';
              await bot.sendMessage(chatId, [
                '✅ Agent Soul 层已就绪',
                'agent_id: ' + res.data.agentId,
                '链接方式: ' + viewModes,
                '',
                '文件位置:',
                '  SOUL.md   → ~/.metame/agents/' + res.data.agentId + '/soul.md',
                '  MEMORY.md → ~/.metame/agents/' + res.data.agentId + '/memory-snapshot.md',
              ].join('\n'));
            }
          } else {
            await bot.sendMessage(chatId, '❌ agentTools 不可用');
          }
          return true;
        }

        if (soulAction === 'edit') {
          const soulText = agentParts.slice(2).join(' ').trim();
          if (!soulText) {
            await bot.sendMessage(chatId, '用法: /agent soul edit <新内容>\n当前内容: /agent soul');
            return true;
          }
          try {
            fs.writeFileSync(soulPath, soulText, 'utf8');
            await bot.sendMessage(chatId, '✅ SOUL.md 已更新');
          } catch (e) {
            await bot.sendMessage(chatId, '❌ 写入失败: ' + e.message);
          }
          return true;
        }

        // Default: show current SOUL.md content
        if (!fs.existsSync(soulPath)) {
          await bot.sendMessage(chatId, [
            '⚠️ SOUL.md 不存在',
            '',
            '老项目或刚绑定的 Agent 可能尚未建立 Soul 层。',
            '运行 /agent soul repair 自动生成。',
          ].join('\n'));
          return true;
        }
        try {
          const soulContent = fs.readFileSync(soulPath, 'utf8').trim().slice(0, 2000);
          await bot.sendMessage(chatId, '📋 当前 Soul:\n\n' + soulContent);
        } catch (e) {
          await bot.sendMessage(chatId, '❌ 读取 SOUL.md 失败: ' + e.message);
        }
        return true;
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
      const cfg = loadConfig();
      const { boundKey } = getBoundProject(chatId, cfg);
      if (boundKey) {
        await bot.sendMessage(chatId, `此群已绑定到「${boundKey}」，无需激活。如需更换请先 /agent unbind`);
        return true;
      }
      const activation = getLatestActivationForChat(chatId);
      if (!activation) {
        // Check if this chat was the creator (self-activate attempt)
        if (pendingActivations) {
          for (const rec of pendingActivations.values()) {
            if (rec.createdByChatId === String(chatId)) {
              await bot.sendMessage(chatId,
                `❌ 不能在创建来源群激活。\n请在你新建的目标群里发送 \`/activate\`\n\n` +
                `或在任意群用: \`/agent bind ${rec.agentName} ${rec.cwd}\``
              );
              return true;
            }
          }
        }
        // No pending activation — fall back to scanning daemon.yaml for unbound projects
        const allBoundKeys = new Set(Object.values({
          ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}),
          ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}),
        }));
        const unboundProjects = Object.entries(cfg.projects || {})
          .filter(([key, p]) => p && p.cwd && !allBoundKeys.has(key))
          .map(([key, p]) => ({ key, name: p.name || key, cwd: p.cwd, icon: p.icon || '🤖' }));

        if (unboundProjects.length === 1) {
          // Exactly one unbound project — auto-bind using project KEY (not display name)
          // to ensure toProjectKey() resolves to the correct existing key in daemon.yaml
          const proj = unboundProjects[0];
          const bindRes2 = await bindViaUnifiedApi(bot, chatId, proj.key, proj.cwd);
          if (bindRes2.ok) pendingActivations && pendingActivations.delete(proj.key);
          return true;
        }

        if (unboundProjects.length > 1) {
          // Multiple unbound projects — show pick list using project keys
          const lines = ['请选择要激活的 Agent：', ''];
          for (const p of unboundProjects) {
            lines.push(`${p.icon} ${p.name}  →  \`/agent bind ${p.key} ${p.cwd}\``);
          }
          lines.push('\n发送对应命令即可绑定此群。');
          await bot.sendMessage(chatId, lines.join('\n'));
          return true;
        }

        // Truly nothing to activate
        await bot.sendMessage(chatId,
          '没有待激活的 Agent。\n\n如果已创建过 Agent，直接用:\n`/agent bind <名称> <目录>`\n即可绑定，不需要重新创建。'
        );
        return true;
      }
      const bindRes = await bindViaUnifiedApi(bot, chatId, activation.agentName, activation.cwd);
      if (bindRes.ok) {
        pendingActivations && pendingActivations.delete(activation.agentKey);
      }
      return true;
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
      await bot.sendMessage(chatId, `✓ 已选择目录：${displayPath}${cloneHint}\n\n步骤2/3：给这个 Agent 起个名字？`);
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
      const teamFlow = pendingTeamFlows && pendingTeamFlows.get(String(chatId));
      if (!teamFlow || teamFlow.step !== 'cwd') {
        await bot.sendMessage(chatId, '❌ 没有待完成的团队创建，请重新发送 /agent new team');
        return true;
      }
      teamFlow.step = 'creating';
      pendingTeamFlows.set(String(chatId), teamFlow);
      await bot.sendMessage(chatId, `⏳ 正在创建团队「${teamFlow.name}」...`);

      try {
        const teamDir = path.join(dirPath, 'team');
        if (!fs.existsSync(teamDir)) fs.mkdirSync(teamDir, { recursive: true });

        const members = Array.isArray(teamFlow.members) ? teamFlow.members : [];
        const results = [];
        for (const member of members) {
          const memberDir = path.join(teamDir, member.key);
          if (!fs.existsSync(memberDir)) fs.mkdirSync(memberDir, { recursive: true });
          const claudeMdPath = path.join(memberDir, 'CLAUDE.md');
          if (!fs.existsSync(claudeMdPath)) {
            fs.writeFileSync(claudeMdPath, `# ${member.name}\n\n（团队成员：${teamFlow.name}）\n`, 'utf8');
          }
          // Init git repo for checkpoint support
          try {
            if (execSync) execSync('git init -q', { cwd: memberDir, stdio: 'ignore' });
          } catch { /* non-critical */ }
          results.push(`✅ ${member.icon} ${member.key}: ${memberDir.replace(HOME, '~')}`);
        }

        // Register in daemon.yaml under parent project's team array
        const cfg = loadConfig();
        let parentProjectKey = null;
        if (cfg.projects) {
          for (const [projKey, proj] of Object.entries(cfg.projects)) {
            if (normalizeCwd(proj.cwd || '') === normalizeCwd(dirPath)) {
              parentProjectKey = projKey;
              break;
            }
          }
        }

        if (parentProjectKey && cfg.projects[parentProjectKey]) {
          const proj = cfg.projects[parentProjectKey];
          if (!proj.team) proj.team = [];
          for (const member of members) {
            if (!proj.team.some(m => m.key === member.key)) {
              proj.team.push({
                key: member.key,
                name: member.name,
                icon: member.icon,
                color: member.color,
                cwd: path.join(teamDir, member.key),
                nicknames: member.nicknames,
              });
            }
          }
          if (writeConfigSafe) writeConfigSafe(cfg);
          if (backupConfig) backupConfig();
        }

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
