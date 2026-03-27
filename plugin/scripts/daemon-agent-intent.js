'use strict';

const {
  bindAgentToChat,
  createWorkspaceAgent,
  editAgentRole,
  listAgents,
  unbindAgent,
} = require('./daemon-agent-workflow');
const {
  classifyAgentIntent,
  detectCloneIntent,
  detectTeamIntent,
  extractPathFromText,
} = require('./agent-intent-shared');

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
    const normalized = String(workspaceDir).replace(/[\\/]+$/, '');
    const basename = normalized.split(/[/\\]/).filter(Boolean).pop();
    if (basename) return basename;
  }
  return 'workspace-agent';
}

function extractQuotedContent(input) {
  const m = String(input || '').match(/[“"'「](.+?)[”"'」]/);
  return m ? m[1].trim() : '';
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

function inferAgentEngineFromText(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;
  if (/\bcodex\b/.test(text) || /柯德|科德/.test(text)) return 'codex';
  return null;
}


function projectNameFromResult(data, fallbackName) {
  if (data && data.project && data.project.name) return data.project.name;
  if (data && data.projectKey) return data.projectKey;
  return fallbackName || 'workspace-agent';
}

function createAgentIntentHandler(deps) {
  const {
    agentTools,
    handleAgentCommand,
    attachOrCreateSession,
    normalizeCwd,
    getDefaultEngine,
    loadConfig,
    getBoundProjectForChat,
      log,
      pendingActivations,
      hasFreshPendingFlow,
      HOME,
      writeConfigSafe,
      backupConfig,
    } = deps;

  return async function handleAgentIntent(bot, chatId, text, config) {
    if (!agentTools || !text || text.startsWith('/')) return false;
    const key = String(chatId);
    if (hasFreshPendingFlow(key) || hasFreshPendingFlow(key + ':edit')) return false;

    const input = String(text || '').trim();
    if (!input) return false;

    const intent = classifyAgentIntent(input);
    if (!intent) return false;

    if (intent.action === 'wizard_clone') {
      if (typeof log === 'function') log('INFO', `[CloneIntent] "${input.slice(0, 80)}" → /agent new clone`);
      await handleAgentCommand({ bot, chatId, text: '/agent new clone', config });
      return true;
    }

    if (intent.action === 'wizard_team') {
      if (typeof log === 'function') log('INFO', `[TeamIntent] "${input.slice(0, 80)}" → /agent new team`);
      await handleAgentCommand({ bot, chatId, text: '/agent new team', config });
      return true;
    }

    if (intent.action === 'activate') {
      if (typeof log === 'function') log('INFO', `[AgentIntent] "${input.slice(0, 80)}" → /activate`);
      await handleAgentCommand({ bot, chatId, text: '/activate', config });
      return true;
    }

    if (intent.action === 'reset') {
      if (typeof log === 'function') log('INFO', `[AgentIntent] "${input.slice(0, 80)}" → /agent reset`);
      await handleAgentCommand({ bot, chatId, text: '/agent reset', config });
      return true;
    }

    if (intent.action === 'soul') {
      const soulCommand = /repair/i.test(input) || /修复/.test(input) ? '/agent soul repair' : '/agent soul';
      if (typeof log === 'function') log('INFO', `[AgentIntent] "${input.slice(0, 80)}" → ${soulCommand}`);
      await handleAgentCommand({ bot, chatId, text: soulCommand, config });
      return true;
    }

    if (intent.action === 'list') {
      const res = await listAgents({ agentTools, chatId, loadConfig });
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

    if (intent.action === 'unbind') {
      const res = await unbindAgent({ agentTools, chatId, loadConfig, writeConfigSafe, backupConfig });
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

    if (intent.action === 'edit_role') {
      const freshCfg = loadConfig();
      const bound = getBoundProjectForChat(chatId, freshCfg);
      if (!bound.project || !bound.project.cwd) {
        await bot.sendMessage(chatId, '❌ 当前群未绑定 Agent。先说“给这个群绑定一个 Agent，目录是 ~/xxx”。');
        return true;
      }
      if (agentTools && typeof agentTools.repairAgentSoul === 'function') {
        await agentTools.repairAgentSoul(bound.project.cwd).catch(() => {});
      }
      const roleDelta = deriveRoleDelta(input);
      const res = await editAgentRole({ agentTools, workspaceDir: bound.project.cwd, deltaText: roleDelta });
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 更新角色失败: ${res.error}`);
        return true;
      }
      await bot.sendMessage(chatId, res.data.created ? '✅ 已创建 CLAUDE.md 并写入角色定义' : '✅ 角色定义已更新到 CLAUDE.md');
      return true;
    }

    if (intent.action === 'create') {
      if (!intent.workspaceDir) {
        await bot.sendMessage(chatId, [
          '我可以帮你创建 Agent，还差一个工作目录。',
          '例如：`给这个群创建一个 Agent，目录是 ~/projects/foo`',
          'Windows 也可以直接发：`C:\\\\work\\\\foo`',
          '也可以直接回我一个路径（`~/`、`/`、`./`、`../`、`C:\\\\` 开头都行）。',
        ].join('\n'));
        return true;
      }
      const agentName = deriveAgentName(input, intent.workspaceDir);
      const roleDelta = deriveCreateRoleDelta(input);
      const inferredEngine = inferAgentEngineFromText(input);
      const res = await createWorkspaceAgent({
        agentTools,
        chatId,
        agentName,
        workspaceDir: intent.workspaceDir,
        roleDescription: roleDelta,
        pendingActivations,
        skipChatBinding: true,
        engine: inferredEngine,
        attachOrCreateSession,
        normalizeCwd,
        getDefaultEngine,
      });
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${res.error}`);
        return true;
      }
      const data = res.data || {};
      const projName = projectNameFromResult(data, agentName);
      const engineTip = data.project && data.project.engine ? `\n引擎: ${data.project.engine}` : '';
      await bot.sendMessage(chatId,
        `✅ Agent「${projName}」已创建\n目录: ${data.cwd || '（未知）'}${engineTip}\n\n` +
        `**下一步**: 在新群里发送 \`/activate\` 完成绑定（30分钟内有效）`
      );
      return true;
    }

    if (intent.action === 'bind') {
      const agentName = deriveAgentName(input, intent.workspaceDir);
      const inferredEngine = inferAgentEngineFromText(input);
      const bindTools = agentTools && typeof agentTools.bindAgentToChat === 'function'
        ? {
          ...agentTools,
          bindAgentToChat: (targetChatId, targetAgentName, targetWorkspaceDir) => agentTools.bindAgentToChat(
            targetChatId,
            targetAgentName,
            targetWorkspaceDir,
            { engine: inferredEngine }
          ),
        }
        : agentTools;
      const res = await bindAgentToChat({
        agentTools: bindTools,
        bot,
        chatId,
        agentName,
        agentCwd: intent.workspaceDir || null,
        HOME,
        attachOrCreateSession,
        normalizeCwd,
        getDefaultEngine,
        announce: false,
      });
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 绑定失败: ${res.error}`);
        return true;
      }
      const data = res.data || {};
      const projName = projectNameFromResult(data, agentName);
      await bot.sendMessage(chatId, `✅ 已绑定 Agent\n名称: ${projName}\n目录: ${data.cwd || '（未知）'}`);
      return true;
    }

    return false;
  };
}

module.exports = {
  createAgentIntentHandler,
  _private: {
    classifyAgentIntent,
    detectCloneIntent,
    detectTeamIntent,
    deriveAgentName,
    deriveCreateRoleDelta,
    deriveRoleDelta,
    extractPathFromText,
    inferAgentEngineFromText,
  },
};
