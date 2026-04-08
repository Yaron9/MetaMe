'use strict';

const { resolveEngineModel } = require('./daemon-engine-runtime');
const { createAgentIntentHandler } = require('./daemon-agent-intent');
const { rawChatId: extractOriginalChatId, isThreadChatId } = require('./core/thread-chat-id');
const { createWikiCommandHandler } = require('./daemon-wiki');

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
    pipeline,      // message pipeline — used for interrupt/clearQueue
    log,
    agentTools,
    pendingAgentFlows,
    pendingActivations,
    agentFlowTtlMs,
    getDefaultEngine,
    getDb,              // optional — () → DatabaseSync (for wiki commands)
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

  function projectKeyFromVirtualChatId(chatId) {
    const v = String(chatId || '');
    if (v.startsWith('_agent_')) {
      const rest = v.slice(7);
      const scopeIdx = rest.indexOf('::');
      const key = scopeIdx >= 0 ? rest.slice(0, scopeIdx) : rest;
      return key || null;
    }
    if (v.startsWith('_scope_')) {
      const idx = v.lastIndexOf('__');
      if (idx > 7 && idx + 2 < v.length) return v.slice(idx + 2);
    }
    return null;
  }

  function buildSessionChatId(chatId, projectKey = null) {
    const rawChatId = String(chatId || '');
    const inferredKey = projectKey || projectKeyFromVirtualChatId(rawChatId);
    if (rawChatId.startsWith('_agent_') || rawChatId.startsWith('_scope_')) return rawChatId;
    // Feishu topics must keep per-thread isolation even when the thread is
    // temporarily routed to a named agent/project via nickname or chat_agent_map.
    if (isThreadChatId(rawChatId)) return rawChatId;
    return inferredKey ? `_bound_${inferredKey}` : rawChatId;
  }

  function resolveCurrentSessionContext(chatId, config) {
    const chatIdStr = String(chatId || '');
    const threadScoped = isThreadChatId(chatIdStr);
    const chatAgentMap = {
      ...(config && config.telegram ? config.telegram.chat_agent_map : {}),
      ...(config && config.feishu ? config.feishu.chat_agent_map : {}),
      ...(config && config.imessage ? config.imessage.chat_agent_map : {}),
      ...(config && config.siri_bridge ? config.siri_bridge.chat_agent_map : {}),
    };
    const _rawChatId = extractOriginalChatId(chatIdStr);
    const mappedKey = chatAgentMap[chatIdStr] || chatAgentMap[_rawChatId] || projectKeyFromVirtualChatId(chatIdStr);
    const mappedProject = mappedKey && config && config.projects ? config.projects[mappedKey] : null;
    const state = loadState() || {};
    const sessions = state.sessions || {};
    const stickyKey = state.team_sticky ? (state.team_sticky[chatIdStr] || state.team_sticky[_rawChatId]) : null;
    const stickyMember = threadScoped && stickyKey && mappedProject && Array.isArray(mappedProject.team)
      ? mappedProject.team.find((member) => member && member.key === stickyKey)
      : null;
    const preferredEngine = String(
      (stickyMember && stickyMember.engine)
      || (mappedProject && mappedProject.engine)
      || getDefaultEngine()
    ).toLowerCase();
    const candidateIds = [
      stickyMember ? `_agent_${stickyMember.key}` : null,
      mappedKey ? buildSessionChatId(chatIdStr, mappedKey) : null,
      buildSessionChatId(chatIdStr),
      chatIdStr,
    ].filter(Boolean);

    for (const candidateId of candidateIds) {
      const record = sessions[candidateId];
      if (!record) continue;
      const candidateSlots = [];
      if (record.engines && typeof record.engines === 'object') {
        if (record.engines[preferredEngine]) candidateSlots.push([preferredEngine, record.engines[preferredEngine]]);
        for (const [engineName, slot] of Object.entries(record.engines)) {
          if (engineName === preferredEngine) continue;
          candidateSlots.push([engineName, slot]);
        }
      } else if (record.engine) {
        candidateSlots.push([String(record.engine).toLowerCase(), record]);
      }

      for (const [engineName, slot] of candidateSlots) {
        if (!slot) continue;
        if (slot.id || record.cwd || slot.runtimeSessionObserved === false) {
          return { record, slot, sessionChatId: candidateId, engine: engineName || preferredEngine };
        }
      }
    }
    return null;
  }

  function getBoundProjectForChat(chatId, cfg) {
    const map = {
      ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}),
      ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}),
      ...(cfg.imessage ? cfg.imessage.chat_agent_map : {}),
      ...(cfg.siri_bridge ? cfg.siri_bridge.chat_agent_map : {}),
    };
    const chatIdStr = String(chatId);
    const key = map[chatIdStr] || map[extractOriginalChatId(chatIdStr)];
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

  const tryHandleAgentIntent = createAgentIntentHandler({
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
  });

  async function handleCommand(bot, chatId, text, config, executeTaskByName, senderId = null, readOnly = false, _meta = {}) {
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
    const chatAgentMap = {
      ...(config.telegram ? config.telegram.chat_agent_map : {}),
      ...(config.feishu ? config.feishu.chat_agent_map : {}),
      ...(config.imessage ? config.imessage.chat_agent_map : {}),
      ...(config.siri_bridge ? config.siri_bridge.chat_agent_map : {}),
    };
    const _chatIdStr = String(chatId);
    const _rawChatId2 = extractOriginalChatId(_chatIdStr);
    const _threadScoped = isThreadChatId(_chatIdStr);
    const mappedKey = chatAgentMap[_chatIdStr] ||
      chatAgentMap[_rawChatId2] ||
      projectKeyFromVirtualChatId(_chatIdStr);
    if (mappedKey && config.projects && config.projects[mappedKey]) {
      const proj = config.projects[mappedKey];
      const stickyKey = state && state.team_sticky ? (state.team_sticky[_chatIdStr] || state.team_sticky[_rawChatId2]) : null;
      const stickyMember = _threadScoped && stickyKey && Array.isArray(proj.team)
        ? proj.team.find((member) => member && member.key === stickyKey)
        : null;
      const targetEngine = (stickyMember && stickyMember.engine) || proj.engine || getDefaultEngine();
      const projCwd = normalizeCwd((stickyMember && stickyMember.cwd) || proj.cwd);
      const sessionChatId = stickyMember ? `_agent_${stickyMember.key}` : buildSessionChatId(chatId, mappedKey);
      const sessions = loadState().sessions || {};
      const cur = sessions[sessionChatId];
      const rawSession = sessions[String(chatId)];
      const projEngine = String(targetEngine).toLowerCase();
      // Multi-engine format stores engines in cur.engines object; legacy format uses cur.engine string.
      // Check whether the session already has a slot for the project's configured engine.
      const curHasEngine = cur && (
        cur.engines ? !!cur.engines[projEngine] : String(cur.engine || '').toLowerCase() === projEngine
      );
      const rawHasEngine = rawSession && (
        rawSession.engines ? !!rawSession.engines[projEngine] : String(rawSession.engine || '').toLowerCase() === projEngine
      );
      const isVirtualSession = _chatIdStr.startsWith('_agent_') || _chatIdStr.startsWith('_scope_');
      const shouldReattachForCwdChange =
        !stickyMember &&
        !isVirtualSession &&
        !!cur &&
        !!curHasEngine &&
        cur.cwd !== projCwd &&
        !rawHasEngine;
      const _isControlCmd = text && /^\/(stop|quit)$/.test(text.trim());
      if (!_isControlCmd && (!cur || !curHasEngine || shouldReattachForCwdChange)) {
        const initReason = !cur ? 'no-session' : (!curHasEngine ? 'engine-missing' : 'cwd-changed');
        log('INFO', `SESSION-INIT [${String(sessionChatId).slice(-32)}] ${initReason}`);
        attachOrCreateSession(sessionChatId, projCwd, proj.name || mappedKey, targetEngine);
      }
    }

    if (await handleSessionCommand({ bot, chatId, text })) {
      return;
    }

    const agentResult = await handleAgentCommand({ bot, chatId, text, config });
    if (agentResult === true || agentResult === null) {
      return;
    }

    const adminResult = await handleAdminCommand({ bot, chatId, text, config, state, senderId });
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

    // /wiki — knowledge wiki commands
    if (text.startsWith('/wiki') && getDb) {
      const wikiProviders = providerMod ? {
        callHaiku: (...args) => providerMod.callHaiku(...args),
        buildDistillEnv: (...args) => providerMod.buildDistillEnv(...args),
      } : null;
      const { handleWikiCommand } = createWikiCommandHandler({ getDb, providers: wikiProviders, log });
      if (await handleWikiCommand({ bot, chatId, text })) return;
    }

    // /btw — quick side question (read-only, concise, bypasses cooldown)
    if (/^\/btw(\s|$)/i.test(text)) {
      const btwQuestion = text.replace(/^\/btw\s*/i, '').trim();
      if (!btwQuestion) {
        await bot.sendMessage(chatId, '用法: /btw <问题>\n快速提问，不影响主会话节奏');
        return;
      }
      const btwPrompt = `[Side question — answer concisely from existing context, no need for tools]\n\n${btwQuestion}`;
      resetCooldown(chatId);
      await askClaude(bot, chatId, btwPrompt, config, true, senderId);
      return;
    }

    if (text.startsWith('/')) {
      const currentModel = resolveEngineModel('claude', (config && config.daemon) || {});
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
        '💬 快捷:',
        '/btw <问题> — 快速旁白提问（只读，不打断主任务）',
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
      const _pl = pipeline && pipeline.current;
      if (_pl) {
        _pl.clearQueue(chatId);
        _pl.interruptActive(chatId);
      }
      await bot.sendMessage(chatId, '⏸ 好的，听你说');
      return;
    }

    // "继续" when no task running → resume most recent session via /last, then send prompt
    const CONTINUE_RE = /^(继续|接着|go\s*on|continue)$/i;
    if (!activeProcesses.has(chatId) && CONTINUE_RE.test(text.trim())) {
      const currentSession = resolveCurrentSessionContext(chatId, config);
      if (currentSession) {
        resetCooldown(chatId);
        await askClaude(bot, chatId, '继续上面的工作', config, readOnly, senderId);
        return;
      }
      // No current session bound to this chat — delegate to /last as a fallback.
      const handled = await handleSessionCommand({ bot, chatId, text: '/last' });
      if (handled) {
        resetCooldown(chatId);
        await askClaude(bot, chatId, '继续上面的工作', config, readOnly, senderId);
        return;
      }
      // No session found — fall through to normal askClaude
    }

    // Strict mode: chats with a fixed agent in chat_agent_map must not cross-dispatch
    const _strictChatAgentMap = {
      ...(config.telegram ? config.telegram.chat_agent_map : {}),
      ...(config.feishu ? config.feishu.chat_agent_map : {}),
      ...(config.imessage ? config.imessage.chat_agent_map : {}),
      ...(config.siri_bridge ? config.siri_bridge.chat_agent_map : {}),
    };
    const _rawChatId3 = extractOriginalChatId(String(chatId));
    const _isStrictChat = !!(_strictChatAgentMap[String(chatId)] || _strictChatAgentMap[_rawChatId3] || projectKeyFromVirtualChatId(String(chatId)));

    // Nickname-only switch: bypass cooldown + budget (no Claude call)
    // Skipped for strict chats (fixed-agent groups)
    if (!_isStrictChat) {
      const quickAgent = routeAgent(text, config);
      if (quickAgent && !quickAgent.rest) {
        const { key, proj } = quickAgent;
        const projCwd = normalizeCwd(proj.cwd);
        attachOrCreateSession(buildSessionChatId(chatId, key), projCwd, proj.name || key, proj.engine || getDefaultEngine());
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
    const claudeResult = await askClaude(bot, chatId, text, config, readOnly, senderId);
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
    return claudeResult;
  }

  return { handleCommand };
}

module.exports = { createCommandRouter };
