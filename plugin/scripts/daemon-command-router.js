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
    log,
    agentTools,
    pendingAgentFlows,
    pendingActivations,
    agentFlowTtlMs,
    getDefaultEngine,
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

  const pendingMacConfirmations = new Map();
  const MAC_CONFIRM_TTL_MS = 2 * 60 * 1000;

  function setPendingMacConfirmation(chatId, payload) {
    pendingMacConfirmations.set(String(chatId), { ...payload, createdAt: Date.now() });
  }

  function getPendingMacConfirmation(chatId) {
    const key = String(chatId);
    const pending = pendingMacConfirmations.get(key);
    if (!pending) return null;
    if ((Date.now() - Number(pending.createdAt || 0)) > MAC_CONFIRM_TTL_MS) {
      pendingMacConfirmations.delete(key);
      return null;
    }
    return pending;
  }

  function clearPendingMacConfirmation(chatId) {
    pendingMacConfirmations.delete(String(chatId));
  }

  function isAffirmativeConfirmation(input) {
    return /^(确认|确认执行|执行|继续|好|好的|可以|同意|yes|y|ok|okay)$/i.test(String(input || '').trim());
  }

  function isNegativeConfirmation(input) {
    return /^(取消|不执行|不用了|算了|停止|否|no|n)$/i.test(String(input || '').trim());
  }

  function isReadOnlyMacNaturalLanguageCommand(command) {
    const normalized = String(command || '').trim().toLowerCase();
    return normalized === '/mac check' || normalized === '/mac perms';
  }

  async function requestMacSideEffectConfirmation(bot, chatId, originalText, syntheticCommand, sourceTag) {
    const label = String(originalText || '').trim().slice(0, 160);
    setPendingMacConfirmation(chatId, { originalText: label, syntheticCommand, sourceTag });
    await bot.sendMessage(chatId, [
      '⚠️ 检测到可能有副作用的 macOS 操作，已暂停自动执行。',
      `来源: ${sourceTag}`,
      `原始请求: ${label || '(empty)'}`,
      `拟执行命令: ${syntheticCommand}`,
      '回复“确认”执行，回复“取消”放弃（120 秒内有效）。',
    ].join('\n'));
  }

  async function tryResolvePendingMacConfirmation(bot, chatId, text, config, executeTaskByName) {
    const pending = getPendingMacConfirmation(chatId);
    if (!pending) return false;

    const trimmed = String(text || '').trim();
    if (isNegativeConfirmation(trimmed)) {
      clearPendingMacConfirmation(chatId);
      await bot.sendMessage(chatId, '✅ 已取消该 macOS 操作。');
      return true;
    }

    if (isAffirmativeConfirmation(trimmed)) {
      clearPendingMacConfirmation(chatId);
      log('WARN', `Mac side-effect confirmed [${String(chatId).slice(-8)}] (${pending.sourceTag})`);
      return handleExecCommand({
        bot,
        chatId,
        text: pending.syntheticCommand,
        config,
        executeTaskByName,
        nlIntentText: pending.originalText,
      });
    }

    // Any unrelated message cancels stale pending intent to avoid context stickiness.
    clearPendingMacConfirmation(chatId);
    return false;
  }

  function extractQuotedContent(input) {
    const m = String(input || '').match(/[“"'「](.+?)[”"'」]/);
    return m ? m[1].trim() : '';
  }

  function extractPathFromText(input) {
    const m = String(input || '').match(/(?:~\/|\/|\.\/|\.\.\/)[^\s，。；;!！?？"“”'‘’`]+/);
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
      const basename = workspaceDir.split(/[/\\]/).filter(Boolean).pop();
      if (basename) return basename;
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

  function inferAgentEngineFromText(input) {
    const text = String(input || '').trim().toLowerCase();
    if (!text) return null;
    if (/\bcodex\b/.test(text) || /柯德|科德/.test(text)) return 'codex';
    return null;
  }

  function isLikelyDirectAgentAction(input) {
    const text = String(input || '').trim();
    return /^(?:请|帮我|麻烦|给我|给这个群|给当前群|在这个群|把这个群|把当前群|将这个群|这个群|当前群|本群|群里|我想|我要|我需要|创建|新建|新增|搞一个|加一个|create|bind|绑定|列出|查看|显示|有哪些|解绑|取消绑定|断开绑定|修改|调整)/i.test(text);
  }

  function looksLikeAgentIssueReport(input) {
    const text = String(input || '').trim();
    const hasIssueWords = /(用户反馈|反馈|报错|bug|问题|故障|异常|修复|改一下|修一下|任务|工单|代码)/i.test(text);
    const hasAgentWords = /(agent|智能体|session|会话|目录|工作区|绑定|切换)/i.test(text);
    return hasIssueWords && hasAgentWords;
  }

  function projectNameFromResult(data, fallbackName) {
    if (data && data.project && data.project.name) return data.project.name;
    if (data && data.projectKey) return data.projectKey;
    return fallbackName || 'workspace-agent';
  }

  function projectKeyFromVirtualChatId(chatId) {
    const v = String(chatId || '');
    if (v.startsWith('_agent_')) return v.slice(7) || null;
    if (v.startsWith('_scope_')) {
      const idx = v.lastIndexOf('__');
      if (idx > 7 && idx + 2 < v.length) return v.slice(idx + 2);
    }
    return null;
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

  function escapeAppleScriptString(input) {
    return String(input || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function resolveAppNameFromNaturalLanguage(rawName) {
    if (!rawName) return null;
    const aliasMap = {
      '微信': 'WeChat',
      'wechat': 'WeChat',
      '飞书': 'Feishu',
      'feishu': 'Feishu',
      'finder': 'Finder',
      '访达': 'Finder',
      'safari': 'Safari',
      'chrome': 'Google Chrome',
      '谷歌浏览器': 'Google Chrome',
      'calendar': 'Calendar',
      '日历': 'Calendar',
      'mail': 'Mail',
      '邮件': 'Mail',
      'notes': 'Notes',
      '备忘录': 'Notes',
      'terminal': 'Terminal',
      'iterm': 'iTerm',
      'iterm2': 'iTerm',
      'system settings': 'System Settings',
      '系统设置': 'System Settings',
    };
    let name = String(rawName).trim();
    name = name.replace(/[。！？!?，,;；:：]+$/g, '').trim();
    if (!name) return null;
    const key = name.toLowerCase();
    if (aliasMap[key]) return aliasMap[key];
    if (aliasMap[name]) return aliasMap[name];
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5 .()\-]{1,64}$/.test(name)) return null;
    return name;
  }

  function deriveMacNaturalLanguageCommand(input) {
    const text = String(input || '').trim();
    if (!text) return null;

    // Priority 1: explicit permission/setup intents
    if (/(打开|进入).*(权限|隐私).*设置/.test(text) || /(权限|隐私).*(设置|页面).*(打开|进入)/.test(text)) {
      return '/mac perms open';
    }
    if (/(检查|检测|体检).*(mac|权限|自动化|脚本)/i.test(text) || /(mac|权限|自动化).*(检查|检测|体检)/i.test(text)) {
      return '/mac check';
    }
    if (/(权限|授权).*(怎么|如何|开启|打开|配置)/.test(text)) {
      return '/mac perms';
    }

    // Priority 2: volume / mute
    if (/(取消静音|解除静音|恢复声音|unmute)/i.test(text)) {
      return '/mac osa set volume without output muted';
    }
    if (/(静音|mute)/i.test(text)) {
      return '/mac osa set volume with output muted';
    }
    const volMatch = text.match(/(?:音量|volume)[^\d]{0,8}(\d{1,3})/i) || text.match(/调到\s*(\d{1,3})\s*(?:%|％)/);
    if (volMatch) {
      const v = Math.max(0, Math.min(100, Number(volMatch[1])));
      if (Number.isFinite(v)) return `/mac osa set volume output volume ${v}`;
    }

    // Priority 3: common system actions
    if (/(锁屏|锁定屏幕|lock\s*screen)/i.test(text)) {
      return '/mac osa tell application "System Events" to keystroke "q" using {control down, command down}';
    }
    if (/(让|使|进入)?.*(电脑|系统|mac).*(睡眠|休眠)|(^睡眠$)|(^sleep$)/i.test(text)) {
      return '/mac osa tell application "System Events" to sleep';
    }

    // Priority 4: app open/close
    const openMatch = text.match(/(?:请|帮我|麻烦)?(?:把)?(?:打开|启动|唤起|切到)\s*([a-zA-Z0-9_\u4e00-\u9fa5 .()\-]{1,64})(?:\s*(?:应用|app))?$/i);
    if (openMatch) {
      const app = resolveAppNameFromNaturalLanguage(openMatch[1]);
      if (app) return `/mac osa tell application "${escapeAppleScriptString(app)}" to activate`;
    }
    const closeMatch = text.match(/(?:请|帮我|麻烦)?(?:把)?(?:关闭|退出|停止)\s*([a-zA-Z0-9_\u4e00-\u9fa5 .()\-]{1,64})(?:\s*(?:应用|app))?$/i);
    if (closeMatch) {
      const app = resolveAppNameFromNaturalLanguage(closeMatch[1]);
      if (app) return `/mac osa tell application "${escapeAppleScriptString(app)}" to quit`;
    }

    return null;
  }

  async function tryHandleMacNaturalLanguageIntent(bot, chatId, text, config, options = {}) {
    if (!text || text.startsWith('/')) return false;
    if (process.platform !== 'darwin') return false;
    const daemonCfg = (config && config.daemon) || {};
    if (daemonCfg.enable_nl_mac_control === false) return false;
    const sourceTag = String(options.source || 'direct');
    const safeOnly = !!options.safeOnly;
    const confirmSideEffects = !!options.confirmSideEffects;

    const syntheticCommand = deriveMacNaturalLanguageCommand(text);
    if (!syntheticCommand) return false;
    const isReadOnly = isReadOnlyMacNaturalLanguageCommand(syntheticCommand);

    if (safeOnly && !isReadOnly) {
      if (confirmSideEffects) {
        await requestMacSideEffectConfirmation(bot, chatId, text, syntheticCommand, sourceTag);
        return true;
      }
      return false;
    }

    if (confirmSideEffects && !isReadOnly) {
      await requestMacSideEffectConfirmation(bot, chatId, text, syntheticCommand, sourceTag);
      return true;
    }

    log('INFO', `NL mac intent [${String(chatId).slice(-8)}] (${sourceTag}): ${text.slice(0, 80)} -> ${syntheticCommand}`);
    return handleExecCommand({
      bot,
      chatId,
      text: syntheticCommand,
      config,
      executeTaskByName: () => ({ success: false, error: 'not available' }),
      nlIntentText: text,
    });
  }

  function _detectCloneIntent(text) {
    if (!text || text.startsWith('/') || text.length < 3) return false;
    const cloneKeywords = ['分身', '再造', '克隆', '副本', '另一个自己', '另一个我'];
    const hasCloneKeyword = cloneKeywords.some(k => text.includes(k));
    if (hasCloneKeyword) {
      const excludePatterns = [/已经/, /存在/, /有了/, /好了/, /完成/, /搞定/, /配置好/, /怎么建/, /如何建/, /方法/, /步骤/];
      if (excludePatterns.some(p => p.test(text))) return false;
      return true;
    }
    const actionKeywords = ['新建', '创建', '造', '做一个', '加一个', '增加', '添加'];
    const hasAction = actionKeywords.some(k => text.includes(k));
    if (hasAction && /分身|数字/.test(text)) return true;
    if (/让.*做分身|叫.*做分身|甲.*做分身/.test(text)) return true;
    return false;
  }

  function _detectNewAgentIntent(text) {
    if (!text || text.startsWith('/') || text.length < 3) return false;
    if (_detectCloneIntent(text)) return false;
    if (_detectTeamIntent(text)) return false;
    const agentKeywords = ['agent', '助手', '机器人', '小助手'];
    const hasAgentKeyword = agentKeywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
    const actionKeywords = ['新建', '创建', '造', '做一个', '加一个', '增加', '添加', '开一个'];
    const hasAction = actionKeywords.some(k => text.includes(k));
    if (hasAgentKeyword && hasAction) {
      const excludePatterns = [/已经/, /存在/, /有了/, /好了/, /完成/, /搞定/, /配置好/, /怎么建/, /如何建/, /方法/, /步骤/, /是什么/, /哪个/];
      if (excludePatterns.some(p => p.test(text))) return false;
      return true;
    }
    if (/^(给我|帮我|我要|我想|给我加|帮我加)/.test(text) && hasAgentKeyword) return true;
    return false;
  }

  function _detectTeamIntent(text) {
    if (!text || text.startsWith('/') || text.length < 4) return false;
    // Exclude: only mentioning team, no creation intent
    if (/走team|用team|通过team|team里|team中|团队里|团队中|走团队|用团队|在team|在团队|team.*已经|团队.*已经|team.*讨论|团队.*讨论/.test(text)) return false;
    // Positive match: team + action word
    if ((text.includes('团队') || text.includes('工作组'))) {
      if (/(新建|创建|造一个|加一个|组建|设置|建|搞)/.test(text)) {
        if (/怎么|如何|方法|步骤/.test(text)) return false;
        return true;
      }
    }
    // Pattern: "建个团队" / "搞个团队"
    if (/^(新建|创建|建|搞).*团队/.test(text)) return true;
    return false;
  }

  async function tryHandleAgentIntent(bot, chatId, text, config) {
    if (!agentTools || !text || text.startsWith('/')) return false;
    const key = String(chatId);
    if (hasFreshPendingFlow(key) || hasFreshPendingFlow(key + ':edit')) return false;
    const input = text.trim();
    if (!input) return false;

    // Clone intent — route to /agent new clone wizard
    if (_detectCloneIntent(input)) {
      log('INFO', `[CloneIntent] "${input.slice(0, 80)}" → /agent new clone`);
      await handleAgentCommand({ bot, chatId, text: '/agent new clone', config });
      return true;
    }

    // New agent intent — route to /agent new wizard
    if (_detectNewAgentIntent(input)) {
      log('INFO', `[NewAgentIntent] "${input.slice(0, 80)}" → /agent new`);
      await handleAgentCommand({ bot, chatId, text: '/agent new', config });
      return true;
    }

    // Team creation intent — route to /agent new team wizard
    if (_detectTeamIntent(input)) {
      log('INFO', `[TeamIntent] "${input.slice(0, 80)}" → /agent new team`);
      await handleAgentCommand({ bot, chatId, text: '/agent new team', config });
      return true;
    }

    const directAction = isLikelyDirectAgentAction(input);
    const issueReport = looksLikeAgentIssueReport(input);
    if (issueReport && !directAction) return false;
    const workspaceDir = extractPathFromText(input);
    const hasWorkspacePath = !!workspaceDir;

    const hasAgentContext = /(agent|智能体|工作区|人设|绑定|当前群|这个群|chat|workspace)/i.test(input);
    const wantsList = /(列出|查看|显示|有哪些|list|show)/i.test(input) && /(agent|智能体|工作区|绑定)/i.test(input);
    const wantsUnbind = /(解绑|取消绑定|断开绑定|unbind|unassign)/i.test(input) && hasAgentContext;
    const wantsEditRole =
      ((/(角色|职责|人设)/i.test(input) && /(改|修改|调整|更新|变成|改成|改为)/i.test(input)) ||
      /(把这个agent|把当前agent|当前群.*角色|当前群.*职责)/i.test(input));
    const wantsCreate =
      (/(创建|新建|新增|搞一个|加一个|create)/i.test(input) && /(agent|智能体|人设|工作区)/i.test(input) && (directAction || hasWorkspacePath));
    const wantsBind =
      !wantsCreate &&
      (/(绑定|bind)/i.test(input) && hasAgentContext && (directAction || hasWorkspacePath));

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
      // Lazy migration: ensure soul layer exists for agents created before this feature
      if (agentTools && typeof agentTools.repairAgentSoul === 'function') {
        await agentTools.repairAgentSoul(bound.project.cwd).catch(() => {});
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
      if (!workspaceDir) {
        await bot.sendMessage(chatId, [
          '我可以帮你创建 Agent，还差一个工作目录。',
          '例如：`给这个群创建一个 Agent，目录是 ~/projects/foo`',
          '也可以直接回我一个路径（`~/`、`/`、`./`、`../` 开头都行）。',
        ].join('\n'));
        return true;
      }
      const agentName = deriveAgentName(input, workspaceDir);
      const roleDelta = deriveCreateRoleDelta(input);
      const inferredEngine = inferAgentEngineFromText(input);
      // Always skip binding creating chat — new group activates via /activate
      const res = await agentTools.createNewWorkspaceAgent(agentName, workspaceDir, roleDelta, chatId, {
        skipChatBinding: true,
        engine: inferredEngine,
      });
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${res.error}`);
        return true;
      }
      const data = res.data || {};
      const projName = projectNameFromResult(data, agentName);
      const engineTip = data.project && data.project.engine ? `\n引擎: ${data.project.engine}` : '';
      if (data.projectKey && pendingActivations) {
        pendingActivations.set(data.projectKey, {
          agentKey: data.projectKey, agentName: projName, cwd: data.cwd,
          createdByChatId: String(chatId), createdAt: Date.now(),
        });
      }
      await bot.sendMessage(chatId,
        `✅ Agent「${projName}」已创建\n目录: ${data.cwd || '（未知）'}${engineTip}\n\n` +
        `**下一步**: 在新群里发送 \`/activate\` 完成绑定（30分钟内有效）`
      );
      return true;
    }

    if (wantsBind) {
      const agentName = deriveAgentName(input, workspaceDir);
      const inferredEngine = inferAgentEngineFromText(input);
      const res = await agentTools.bindAgentToChat(chatId, agentName, workspaceDir || null, { engine: inferredEngine });
      if (!res.ok) {
        await bot.sendMessage(chatId, `❌ 绑定失败: ${res.error}`);
        return true;
      }
      const data = res.data || {};
      const projName = projectNameFromResult(data, agentName);
      if (data.cwd) attachOrCreateSession(chatId, normalizeCwd(data.cwd), projName, (data.project && data.project.engine) || getDefaultEngine());
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

    if (await tryResolvePendingMacConfirmation(bot, chatId, text, config, executeTaskByName)) {
      return;
    }

    // --- chat_agent_map: auto-switch agent based on dedicated chatId ---
    // Configure in daemon.yaml: feishu.chat_agent_map or telegram.chat_agent_map
    //   e.g.  chat_agent_map: { "oc_xxx": "personal", "oc_yyy": "metame" }
    const chatAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const _chatIdStr = String(chatId);
    const mappedKey = chatAgentMap[_chatIdStr] ||
      projectKeyFromVirtualChatId(_chatIdStr);
    if (mappedKey && config.projects && config.projects[mappedKey]) {
      const proj = config.projects[mappedKey];
      const projCwd = normalizeCwd(proj.cwd);
      const cur = loadState().sessions?.[chatId];
      const curEngine = String((cur && cur.engine) || getDefaultEngine()).toLowerCase();
      const projEngine = String((proj && proj.engine) || getDefaultEngine()).toLowerCase();
      if (!cur || cur.cwd !== projCwd || curEngine !== projEngine) {
        attachOrCreateSession(chatId, projCwd, proj.name || mappedKey, proj.engine || getDefaultEngine());
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
        '/continue — 接续电脑正在做的工作',
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
        '/agent soul [repair] — 查看/修复 Agent Soul 身份层',
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
        `⚙️ /model [${currentModel}] /engine [${getDefaultEngine()}] /provider [${currentProvider}] /distill-model /status /tasks /run /budget /reload /mentor`,
        '🧩 /TeamTask create <agent> <目标> [--scope <id>] · /TeamTask · /TeamTask <id>',
        '🧠 /memory — 记忆统计 · /memory <关键词> — 搜索事实',
        '🧬 /skill-evo — 查看/处理技能演化队列',
        `🔧 /doctor /fix /reset /mac /sh <cmd> /nosleep [${getNoSleepProcess() ? 'ON' : 'OFF'}]`,
        '',
        '直接打字即可对话 💬',
      ].join('\n'));
      return;
    }

    // --- Natural language → Claude Code session ---
    // Interrupt detection: "等一下/停/hold on" while task is running → stop task, keep session for resume
    const INTERRUPT_RE = /^(等一下|等等|等下|停一下|停下|停|先停|hold\s*on|wait|暂停)$/i;
    if (activeProcesses.has(chatId) && INTERRUPT_RE.test(text.trim())) {
      // Kill current process but preserve session for resume
      if (messageQueue.has(chatId)) {
        const q = messageQueue.get(chatId);
        if (q.timer) clearTimeout(q.timer);
        messageQueue.delete(chatId);
      }
      const proc = activeProcesses.get(chatId);
      if (proc && proc.child) {
        proc.aborted = true;
        const signal = proc.killSignal || 'SIGTERM';
        try { process.kill(-proc.child.pid, signal); } catch { try { proc.child.kill(signal); } catch { /* */ } }
      }
      await bot.sendMessage(chatId, '⏸ 好的，听你说');
      return;
    }

    // "继续" when no task running → resume most recent session via /last, then send prompt
    const CONTINUE_RE = /^(继续|接着|go\s*on|continue)$/i;
    if (!activeProcesses.has(chatId) && CONTINUE_RE.test(text.trim())) {
      // Delegate to /last which attaches the most recent session
      const handled = await handleSessionCommand({ bot, chatId, text: '/last' });
      if (handled) {
        // /last attached the session — now send "继续" to actually resume the conversation
        resetCooldown(chatId);
        await askClaude(bot, chatId, '继续上面的工作', config, readOnly);
        return;
      }
      // No session found — fall through to normal askClaude
    }

    // If a task is running: queue message, DON'T kill — will be sent as follow-up after completion
    if (activeProcesses.has(chatId)) {
      const isFirst = !messageQueue.has(chatId);
      if (isFirst) {
        messageQueue.set(chatId, { messages: [] });
      }
      const q = messageQueue.get(chatId);
      if (q.messages.length >= 10) {
        await bot.sendMessage(chatId, '⚠️ 排队已满（10条），请等当前任务完成');
        return;
      }
      q.messages.push(text);
      if (isFirst) {
        await bot.sendMessage(chatId, '📝 收到，完成后继续处理');
      }
      return;
    }
    // Strict mode: chats with a fixed agent in chat_agent_map must not cross-dispatch
    const _strictChatAgentMap = { ...(config.telegram ? config.telegram.chat_agent_map : {}), ...(config.feishu ? config.feishu.chat_agent_map : {}) };
    const _isStrictChat = !!(_strictChatAgentMap[String(chatId)] || projectKeyFromVirtualChatId(String(chatId)));

    // Nickname-only switch: bypass cooldown + budget (no Claude call)
    // Skipped for strict chats (fixed-agent groups)
    if (!_isStrictChat) {
      const quickAgent = routeAgent(text, config);
      if (quickAgent && !quickAgent.rest) {
        const { key, proj } = quickAgent;
        const projCwd = normalizeCwd(proj.cwd);
        attachOrCreateSession(chatId, projCwd, proj.name || key, proj.engine || getDefaultEngine());
        log('INFO', `Agent switch via nickname: ${key} (${projCwd})`);
        await bot.sendMessage(chatId, `${proj.icon || '🤖'} ${proj.name || key} 在线`);
        return;
      }

      if (await tryHandleAgentIntent(bot, chatId, text, config)) {
        return;
      }
    }

    const daemonCfg = (config && config.daemon) || {};
    const macControlMode = String(daemonCfg.mac_control_mode || 'claude-first').trim().toLowerCase();
    const macLocalFirst = (macControlMode === 'local-first');
    const macFallbackEnabled = (daemonCfg.enable_nl_mac_fallback !== false);
    const allowLocalMacControl = !readOnly && (daemonCfg.enable_nl_mac_control !== false);
    if (macLocalFirst && allowLocalMacControl && await tryHandleMacNaturalLanguageIntent(bot, chatId, text, config, { source: 'local-first' })) {
      return;
    }

    const cd = checkCooldown(chatId);
    if (!cd.ok) { await bot.sendMessage(chatId, `${cd.wait}s`); return; }
    if (!checkBudget(loadConfig(), loadState())) {
      await bot.sendMessage(chatId, 'Daily token budget exceeded.');
      return;
    }
    const claudeResult = await askClaude(bot, chatId, text, config, readOnly);
    const claudeFailed = !!(claudeResult && claudeResult.ok === false);
    const claudeAborted = !!(claudeResult && claudeResult.error === 'Stopped by user');
    if (claudeFailed && !claudeAborted && !macLocalFirst && macFallbackEnabled && allowLocalMacControl) {
      const fallbackHandled = await tryHandleMacNaturalLanguageIntent(bot, chatId, text, config, {
        source: 'claude-fallback',
        safeOnly: true,
        confirmSideEffects: true,
      });
      if (fallbackHandled) {
        log('WARN', `Claude-first mac fallback handled for ${String(chatId).slice(-8)} (mode=${macControlMode})`);
      }
    }

    // Process queued messages as follow-up in the same session (no kill, no context loss)
    // Use while-loop instead of recursion to avoid unbounded stack growth
    while (messageQueue.has(chatId)) {
      const q = messageQueue.get(chatId);
      const msgs = q.messages.splice(0);
      messageQueue.delete(chatId);
      if (msgs.length === 0) break;
      const combined = msgs.join('\n');
      log('INFO', `Follow-up: processing ${msgs.length} queued message(s) for ${chatId}`);
      resetCooldown(chatId);
      const followUp = await askClaude(bot, chatId, combined, config, readOnly);
      if (followUp && followUp.error === 'Stopped by user') break;
    }

  }

  return { handleCommand };
}

module.exports = { createCommandRouter };
