'use strict';

function buildBoundSessionChatId(projectKey) {
  const key = String(projectKey || '').trim();
  return key ? `_bound_${key}` : '';
}

function getBoundProject(chatId, cfg) {
  const agentMap = {
    ...(cfg && cfg.telegram ? cfg.telegram.chat_agent_map : {}),
    ...(cfg && cfg.feishu ? cfg.feishu.chat_agent_map : {}),
  };
  const boundKey = agentMap[String(chatId)];
  const boundProj = boundKey && cfg && cfg.projects && cfg.projects[boundKey];
  return { boundKey: boundKey || null, boundProj: boundProj || null };
}

function getLatestActivationForChat(chatId, pendingActivations) {
  if (!pendingActivations || pendingActivations.size === 0) return null;
  const cid = String(chatId);
  let latest = null;
  for (const rec of pendingActivations.values()) {
    if (rec.createdByChatId === cid) continue;
    if (!latest || rec.createdAt > latest.createdAt) latest = rec;
  }
  return latest;
}

function listUnboundProjects(cfg) {
  const allBoundKeys = new Set(Object.values({
    ...(cfg && cfg.telegram ? cfg.telegram.chat_agent_map : {}),
    ...(cfg && cfg.feishu ? cfg.feishu.chat_agent_map : {}),
  }));

  return Object.entries((cfg && cfg.projects) || {})
    .filter(([key, p]) => p && p.cwd && !allBoundKeys.has(key))
    .map(([key, p]) => ({ key, name: p.name || key, cwd: p.cwd, icon: p.icon || '🤖' }));
}

function attachBoundSession({
  attachOrCreateSession,
  projectKey,
  chatId,
  cwd,
  name,
  engine,
  normalizeCwd,
  getDefaultEngine,
}) {
  if (!cwd || typeof attachOrCreateSession !== 'function') return;
  const sessionChatId = projectKey ? buildBoundSessionChatId(projectKey) : String(chatId);
  attachOrCreateSession(
    sessionChatId,
    normalizeCwd(cwd),
    name || projectKey || '',
    engine || getDefaultEngine()
  );
}

async function bindAgentToChat({
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
  announce = true,
}) {
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
    attachBoundSession({
      attachOrCreateSession,
      projectKey: res.data.projectKey,
      chatId,
      cwd: res.data.cwd,
      name: p.name || agentName || res.data.projectKey || '',
      engine: p.engine,
      normalizeCwd,
      getDefaultEngine,
    });
    if (announce) {
      await bot.sendMessage(chatId, `${icon} ${p.name || agentName} ${action}\n目录: ${displayCwd}`);
    }
    return { ok: true, data: res.data };
  }

  const fallback = await doBindAgent(bot, chatId, agentName, agentCwd);
  if (!fallback || fallback.ok === false) {
    return { ok: false, error: (fallback && fallback.error) || 'bind failed' };
  }
  const fallbackCwd = (fallback.data && fallback.data.cwd) || agentCwd;
  attachBoundSession({
    attachOrCreateSession,
    projectKey: fallback && fallback.data ? fallback.data.projectKey : null,
    chatId,
    cwd: fallbackCwd,
    name: agentName || '',
    engine: fallback && fallback.data && fallback.data.project ? fallback.data.project.engine : null,
    normalizeCwd,
    getDefaultEngine,
  });
  return {
    ok: true,
    data: {
      cwd: fallbackCwd,
      projectKey: fallback && fallback.data ? fallback.data.projectKey : null,
      project: fallback && fallback.data ? fallback.data.project : null,
    },
  };
}

async function editAgentRole({ agentTools, mergeAgentRole, workspaceDir, deltaText }) {
  if (agentTools && typeof agentTools.editAgentRoleDefinition === 'function') {
    return agentTools.editAgentRoleDefinition(workspaceDir, deltaText);
  }
  const legacy = await mergeAgentRole(workspaceDir, deltaText);
  if (legacy.error) return { ok: false, error: legacy.error };
  return { ok: true, data: legacy };
}

async function listAgents({ agentTools, chatId, loadConfig }) {
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

async function unbindAgent({ agentTools, chatId, loadConfig, writeConfigSafe, backupConfig }) {
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
    if (typeof writeConfigSafe === 'function') writeConfigSafe(cfg);
    if (typeof backupConfig === 'function') backupConfig();
  }
  return { ok: true, data: { unbound: !!old, previousProjectKey: old } };
}

async function createWorkspaceAgent({
  agentTools,
  chatId,
  agentName,
  workspaceDir,
  roleDescription,
  pendingActivations,
  skipChatBinding = false,
  engine = null,
  attachOrCreateSession,
  normalizeCwd,
  getDefaultEngine,
  legacyCreate,
  // Optional: enable auto-create-chat when set. Requires the bot to expose
  // createChat (currently only feishu-adapter) and a senderOpenId so the
  // human creator can be invited into the new chat.
  bot = null,
  senderOpenId = null,
}) {
  let res;
  if (agentTools && typeof agentTools.createNewWorkspaceAgent === 'function') {
    res = await agentTools.createNewWorkspaceAgent(agentName, workspaceDir, roleDescription, chatId, {
      skipChatBinding,
      engine,
    });
  } else if (typeof legacyCreate === 'function') {
    res = await legacyCreate();
  } else {
    res = { ok: false, error: 'agentTools.createNewWorkspaceAgent unavailable' };
  }

  if (!res.ok) return res;

  const data = res.data || {};
  if (skipChatBinding) {
    // Try the one-shot path: create a Feishu chat for this agent right now,
    // invite the human creator, and bind chat→agent so /activate is unneeded.
    // Pre-conditions: caller provided a bot with createChat, a senderOpenId
    // that looks like Feishu open_id, and bindAgentToChat is wired up.
    const canAutoCreate = bot
      && typeof bot.createChat === 'function'
      && typeof senderOpenId === 'string' && senderOpenId.startsWith('ou_')
      && agentTools && typeof agentTools.bindAgentToChat === 'function';

    if (canAutoCreate) {
      const projName = (data.project && data.project.name) || agentName || data.projectKey;
      const chatName = `MetaMe · ${projName}`;
      const createRes = await bot.createChat({
        name: chatName,
        description: `Agent ${projName} — auto-created`,
        ownerOpenId: senderOpenId,
        inviteOpenIds: [senderOpenId],
      });
      if (createRes.ok && createRes.chatId) {
        const newChatId = createRes.chatId;
        const bindRes = await agentTools.bindAgentToChat(newChatId, projName, data.cwd, { engine });
        if (bindRes.ok) {
          // Skip /activate — directly attach the session in the new chat.
          attachBoundSession({
            attachOrCreateSession,
            projectKey: data.projectKey,
            chatId: newChatId,
            cwd: data.cwd,
            name: projName,
            engine: data.project && data.project.engine,
            normalizeCwd,
            getDefaultEngine,
          });
          // Greeting in the freshly created chat so the user sees the bot is alive.
          try {
            await bot.sendMessage(newChatId, `🤖 ${projName} 已上线。直接说话即可，本群已绑定到 \`${data.projectKey}\`。`);
          } catch { /* non-fatal */ }
          return {
            ok: true,
            data: { ...data, autoChat: { chatId: newChatId, name: chatName } },
          };
        }
        // Bind failed — record the failure but keep the project entry.
        return {
          ok: true,
          data: { ...data, autoChat: { error: `bind failed: ${bindRes.error}` } },
        };
      }
      // createChat failed — fall through to /activate path with diagnostic.
      const errSummary = createRes.error || 'unknown';
      // Still register pendingActivations so user can /activate manually.
      if (data.projectKey && pendingActivations) {
        pendingActivations.set(data.projectKey, {
          agentKey: data.projectKey,
          agentName: projName,
          cwd: data.cwd,
          createdByChatId: String(chatId),
          createdAt: Date.now(),
        });
      }
      return {
        ok: true,
        data: { ...data, autoChat: { error: errSummary } },
      };
    }

    // No auto-create — original /activate flow.
    if (data.projectKey && pendingActivations) {
      pendingActivations.set(data.projectKey, {
        agentKey: data.projectKey,
        agentName: (data.project && data.project.name) || agentName || data.projectKey,
        cwd: data.cwd,
        createdByChatId: String(chatId),
        createdAt: Date.now(),
      });
    }
    return res;
  }

  attachBoundSession({
    attachOrCreateSession,
    projectKey: data.projectKey,
    chatId,
    cwd: data.cwd,
    name: (data.project && data.project.name) || agentName || data.projectKey || '',
    engine: data.project && data.project.engine,
    normalizeCwd,
    getDefaultEngine,
  });
  return res;
}

async function handleActivateCommand({
  bot,
  chatId,
  loadConfig,
  pendingActivations,
  bindAgent,
}) {
  const cfg = loadConfig();
  const { boundKey } = getBoundProject(chatId, cfg);
  if (boundKey) {
    await bot.sendMessage(chatId, `此群已绑定到「${boundKey}」，无需激活。如需更换请先 /agent unbind`);
    return true;
  }

  const activation = getLatestActivationForChat(chatId, pendingActivations);
  if (!activation) {
    if (pendingActivations) {
      for (const rec of pendingActivations.values()) {
        if (rec.createdByChatId === String(chatId)) {
          await bot.sendMessage(
            chatId,
            `❌ 不能在创建来源群激活。\n请在你新建的目标群里发送 \`/activate\`\n\n或在任意群用: \`/agent bind ${rec.agentName} ${rec.cwd}\``
          );
          return true;
        }
      }
    }

    const unboundProjects = listUnboundProjects(cfg);
    if (unboundProjects.length === 1) {
      const proj = unboundProjects[0];
      const bindRes = await bindAgent(proj.key, proj.cwd);
      if (bindRes.ok && pendingActivations) pendingActivations.delete(proj.key);
      return true;
    }

    if (unboundProjects.length > 1) {
      const lines = ['请选择要激活的 Agent：', ''];
      for (const p of unboundProjects) {
        lines.push(`${p.icon} ${p.name}  →  \`/agent bind ${p.key} ${p.cwd}\``);
      }
      lines.push('\n发送对应命令即可绑定此群。');
      await bot.sendMessage(chatId, lines.join('\n'));
      return true;
    }

    await bot.sendMessage(
      chatId,
      '没有待激活的 Agent。\n\n如果已创建过 Agent，直接用:\n`/agent bind <名称> <目录>`\n即可绑定，不需要重新创建。'
    );
    return true;
  }

  const bindRes = await bindAgent(activation.agentName, activation.cwd);
  if (bindRes.ok && pendingActivations) pendingActivations.delete(activation.agentKey);
  return true;
}

module.exports = {
  getBoundProject,
  getLatestActivationForChat,
  listUnboundProjects,
  buildBoundSessionChatId,
  bindAgentToChat,
  createWorkspaceAgent,
  editAgentRole,
  listAgents,
  unbindAgent,
  handleActivateCommand,
};
