'use strict';

const {
  USAGE_CATEGORY_ORDER,
  CORE_USAGE_CATEGORIES,
  USAGE_CATEGORY_LABEL,
} = require('./usage-classifier');
const { IS_WIN } = require('./platform');
const { ENGINE_MODEL_CONFIG, resolveEngineModel, normalizeClaudeModel } = require('./daemon-engine-runtime');
const { resolveProjectKey: _resolveProjectKey } = require('./daemon-team-dispatch');
const {
  parseRemoteTargetRef,
  getRemoteDispatchStatus,
  generatePairCode,
  isValidPairCode,
  deriveSecretFromPairCode,
} = require('./daemon-remote-dispatch');
let mentorEngine = null;
try { mentorEngine = require('./mentor-engine'); } catch { /* optional */ }
let weixinApiMod = null;
let weixinAuthMod = null;
try { weixinApiMod = require('./daemon-weixin-api'); } catch { /* optional */ }
try { weixinAuthMod = require('./daemon-weixin-auth'); } catch { /* optional */ }

function createAdminCommandHandler(deps) {
  const {
    fs,
    yaml,
    execSync,
    BRAIN_FILE,
    CONFIG_FILE,
    DISPATCH_LOG,
    providerMod,
    loadConfig,
    backupConfig,
    writeConfigSafe,
    restoreConfig,
    getSession,
    getAllTasks,
    dispatchTask,
    log,
    skillEvolution,
    taskBoard,
    taskEnvelope,
    getActiveProcesses,
    getMessageQueue,
    loadState,
    saveState,
    getDefaultEngine = () => 'claude',
    setDefaultEngine = () => {},
    getDistillModel = () => 'haiku',
    weixinAuthStore = null,
  } = deps;

  // resolveProjectKey: imported from daemon-team-dispatch.js (shared with dispatch_to and daemon.js)
  const resolveProjectKey = _resolveProjectKey;

  /**
   * Resolve a target name to { dispatchKey, projInfo }.
   * resolveProjectKey returns 'parent/member' for team members; this splits
   * it into the bare dispatch key and looks up the project/member config.
   */
  function resolveDispatchTarget(targetName, projects) {
    const resolved = resolveProjectKey(targetName, projects || {});
    if (!resolved) return null;
    if (!resolved.includes('/')) {
      return { dispatchKey: resolved, projInfo: (projects || {})[resolved] || {} };
    }
    const [parentKey, memberKey] = resolved.split('/');
    const parent = (projects || {})[parentKey] || {};
    const member = Array.isArray(parent.team)
      ? (parent.team.find(m => m.key === memberKey) || {})
      : {};
    return { dispatchKey: memberKey, projInfo: member };
  }

  function resolveSenderKey(chatId, config) {
    const map = {
      ...(config && config.feishu ? config.feishu.chat_agent_map : {}),
      ...(config && config.telegram ? config.telegram.chat_agent_map : {}),
    };
    return map[String(chatId)] || 'user';
  }

  function resolveBoundProjectKey(chatId, config) {
    const map = {
      ...(config && config.feishu ? config.feishu.chat_agent_map : {}),
      ...(config && config.telegram ? config.telegram.chat_agent_map : {}),
    };
    return map[String(chatId)] || '';
  }

  function popFlag(input, flagName) {
    const src = String(input || '');
    const re = new RegExp(`(?:^|\\s)--${flagName}\\s+(\\S+)`, 'i');
    const m = src.match(re);
    if (!m) return { text: src.trim(), value: '' };
    const value = String(m[1] || '').trim();
    const text = src.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    return { text, value };
  }

  function parseTeamTaskArgs(raw) {
    const src = String(raw || '').trim();
    const first = src.match(/^(\S+)\s+([\s\S]+)$/);
    if (!first) return null;
    const targetName = first[1];
    let rest = first[2].trim();
    const scopePop = popFlag(rest, 'scope');
    rest = scopePop.text;
    const parentPop = popFlag(rest, 'parent');
    rest = parentPop.text;
    return {
      targetName,
      goal: rest,
      scopeId: scopePop.value || '',
      parentTaskId: parentPop.value || '',
    };
  }

  function isLikelyTeamTaskResumeIntent(text) {
    const src = String(text || '').trim();
    if (!src || src.startsWith('/')) return false;
    if (src.length < 4 || src.length > 120) return false;
    if (/(?:新建|创建|查看|列出|列表|详情|状态|有哪些|teamtask\s*$|\/teamtask)/i.test(src)) return false;
    return /(?:继续(?:做|改|修)?|接着(?:做|改|修)?|续上|接续|返工|复工|再修(?:一下)?|再改(?:一下)?).*(?:上次|那个|这单|这个任务|任务|TeamTask|team task|工单)?|(?:上次|那个|这单|这个任务).*(?:继续|接着|返工|复工|再修|再改)/i.test(src);
  }

  function listAutoResumeCandidates(chatId, senderKey, config) {
    if (!taskBoard || typeof taskBoard.listRecentTasks !== 'function') return [];
    const now = Date.now();
    const chatKey = String(chatId);
    const recent = taskBoard.listRecentTasks(12, null, 'team');
    return recent.filter((task) => {
      if (!task || task.task_kind !== 'team') return false;
      if (!config.projects || !config.projects[task.to_agent]) return false;
      const sourceChatId = String(task.inputs && task.inputs.source_chat_id || '').trim();
      if (!sourceChatId || sourceChatId !== chatKey) return false;
      const updatedAt = Date.parse(task.updated_at || task.created_at || '');
      if (!Number.isFinite(updatedAt) || (now - updatedAt) > 12 * 3600_000) return false;
      const participants = Array.isArray(task.participants) ? task.participants : [];
      return task.from_agent === senderKey || participants.includes(senderKey);
    });
  }

  function buildTeamTaskResumeEnvelope(task, targetKey, chatId, config) {
    return taskEnvelope && taskEnvelope.normalizeTaskEnvelope
      ? taskEnvelope.normalizeTaskEnvelope({
        ...task,
        status: 'queued',
        updated_at: new Date().toISOString(),
        task_kind: 'team',
        participants: taskBoard.listScopeParticipants(task.scope_id || task.task_id),
      }, {
        from_agent: task.from_agent || resolveSenderKey(chatId, config),
        to_agent: targetKey,
        scope_id: task.scope_id || task.task_id,
      })
      : {
        task_id: task.task_id,
        scope_id: task.scope_id || task.task_id,
        from_agent: task.from_agent || resolveSenderKey(chatId, config),
        to_agent: targetKey,
        participants: taskBoard.listScopeParticipants(task.scope_id || task.task_id),
        goal: task.goal,
        definition_of_done: task.definition_of_done || [],
        inputs: task.inputs || {},
        artifacts: task.artifacts || [],
        owned_paths: task.owned_paths || [],
        priority: task.priority || 'normal',
        status: 'queued',
        task_kind: 'team',
        created_at: task.created_at,
        updated_at: new Date().toISOString(),
      };
  }

  function dispatchTeamTaskResume(task, chatId, config, senderId = null) {
    const targetKey = task.to_agent;
    if (!config.projects || !config.projects[targetKey]) {
      return { success: false, error: `target_missing:${targetKey}` };
    }
    const envelope = buildTeamTaskResumeEnvelope(task, targetKey, chatId, config);
    const result = dispatchTask(targetKey, {
      from: envelope.from_agent || 'user',
      type: 'task',
      priority: envelope.priority || 'normal',
      payload: {
        title: envelope.goal.slice(0, 60),
        prompt: envelope.goal,
        task_envelope: envelope,
      },
      callback: false,
      new_session: false,
      source_chat_id: String(chatId),
      source_sender_key: envelope.from_agent || resolveSenderKey(chatId, config),
      source_sender_id: String(senderId || '').trim() || '',
    }, config);
    return { success: !!(result && result.success), result, envelope, targetKey };
  }

  function formatTaskSchedule(task) {
    const at = typeof task.at === 'string' ? task.at.trim() : '';
    if (at) {
      const rawDays = task.days !== undefined ? task.days : task.weekdays;
      let daysLabel = '';
      if (Array.isArray(rawDays)) daysLabel = rawDays.join(',');
      else if (typeof rawDays === 'string') daysLabel = rawDays.trim();
      return daysLabel ? `at ${at} ${daysLabel}` : `at ${at}`;
    }
    if (task.interval) return `every ${task.interval}`;
    return 'unspecified';
  }

  function modeFromLevel(level) {
    const n = Number(level);
    if (!Number.isFinite(n)) return 'gentle';
    if (n >= 8) return 'intense';
    if (n >= 4) return 'active';
    return 'gentle';
  }

  function parseDistillModelIntent(input) {
    const text = String(input || '').trim();
    if (!text || text.startsWith('/')) return null;
    if (!/(蒸馏|distill|提炼|提纯)/i.test(text)) return null;
    const setVerb = '(?:改成|改为|设为|设置|切到|切换到|换成|改用|使用|用|set|switch|use)';
    if (!(new RegExp(setVerb, 'i')).test(text)) return null;

    const explicitModel = text.match(new RegExp(`(?:蒸馏模型|模型|distill\\s*model|model)\\s*(?:${setVerb}|to|is)?\\s*[:：]?\\s*([a-zA-Z0-9._-]{2,80})`, 'i'));
    if (explicitModel) return { model: explicitModel[1] };

    if (/(蒸馏模型|模型|distill\s*model|model)/i.test(text)) {
      const quotedModel = text.match(/[“"'「]([a-zA-Z0-9._-]{2,80})[”"'」]/);
      if (quotedModel) return { model: quotedModel[1] };
    }

    const knownToken = text.match(new RegExp(`${setVerb}\\s*(?:为|成|到|to)?\\s*[:：]?\\s*(gpt-5\\.1-codex-mini|gpt-5-mini|haiku|sonnet|opus|5\\.1mini|5mini|codex-mini)\\b`, 'i'));
    if (knownToken) return { model: knownToken[1] };

    return null;
  }

  function ensureMentorConfig(cfg) {
    if (!cfg.daemon) cfg.daemon = {};
    if (!cfg.daemon.mentor || typeof cfg.daemon.mentor !== 'object') {
      cfg.daemon.mentor = {};
    }
    const mentor = cfg.daemon.mentor;
    if (typeof mentor.enabled !== 'boolean') mentor.enabled = false;
    if (!Number.isFinite(Number(mentor.friction_level))) mentor.friction_level = 3;
    if (!mentor.mode || !['gentle', 'active', 'intense'].includes(String(mentor.mode))) {
      mentor.mode = modeFromLevel(mentor.friction_level);
    }
    if (!Array.isArray(mentor.exclude_agents)) mentor.exclude_agents = ['personal', 'xianyu'];
    if (!Array.isArray(mentor.emotion_keywords_extra)) mentor.emotion_keywords_extra = [];
    return mentor;
  }

  function hasCli(execSyncFn, bin) {
    try {
      const cmd = process.platform === 'win32' ? `where ${bin}` : `which ${bin}`;
      execSyncFn(cmd, { encoding: 'utf8', ...(process.platform === 'win32' ? { windowsHide: true } : {}) });
      return true;
    } catch {
      return false;
    }
  }

  function getWeixinStore() {
    if (weixinAuthStore) return weixinAuthStore;
    if (!weixinApiMod || !weixinAuthMod) return null;
    try {
      const apiClient = weixinApiMod.createWeixinApiClient({ log });
      return weixinAuthMod.createWeixinAuthStore({ apiClient, log });
    } catch {
      return null;
    }
  }

  function parseWeixinCommand(raw) {
    const src = String(raw || '').trim();
    const tail = src.replace(/^\/weixin\b/i, '').trim();
    if (!tail) return { action: 'status' };
    const parts = tail.split(/\s+/).filter(Boolean);
    const main = String(parts[0] || '').toLowerCase();
    const sub = String(parts[1] || '').toLowerCase();
    const rest = parts.slice(2);
    const flags = {};
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i];
      if (!token.startsWith('--')) continue;
      const key = token.slice(2);
      const next = rest[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
    if (main === 'status') return { action: 'status' };
    if (main === 'login' && (sub === 'start' || sub === 'wait')) {
      return { action: `login:${sub}`, flags };
    }
    if (main === 'login' && !sub) {
      return { action: 'usage' };
    }
    return { action: 'usage' };
  }

  async function sendLocalDispatchReceipt(bot, chatId, targetKey, projInfo, result, preview) {
    if (!result || !result.success) return;
    const icon = projInfo && projInfo.icon ? projInfo.icon : '🤖';
    const name = projInfo && projInfo.name ? projInfo.name : targetKey;
    const lines = [
      '📮 Dispatch 回执',
      '',
      `状态: ${icon} ${name} 已接收并入队`,
    ];
    if (result.id) lines.push(`编号: ${result.id}`);
    if (preview) lines.push(`摘要: ${String(preview).slice(0, 120)}`);
    if (result.task_id) {
      lines.push('');
      lines.push(`TeamTask: ${result.task_id}`);
      if (result.scope_id && result.scope_id !== result.task_id) {
        lines.push(`Scope: ${result.scope_id}`);
      }
      lines.push(`如需复工，请使用: /TeamTask resume ${result.task_id}`);
    }
    await bot.sendMessage(chatId, lines.join('\n'));
  }

  async function handleAdminCommand(ctx) {
    const { bot, chatId, text, senderId = null } = ctx;
    const state = ctx.state || {};
    let config = ctx.config || {};

    if (text === '/status perpetual' || text === '/status reactive') {
      const { replayEventLog } = require('./daemon-reactive-lifecycle');
      const projects = config.projects || {};
      const lines = ['**Perpetual Projects**\n'];
      let found = false;

      for (const [key, proj] of Object.entries(projects)) {
        if (!proj.reactive) continue;
        found = true;

        const rs = (state.reactive && state.reactive[key]) || {};
        const { phase, mission } = replayEventLog(key, { log: () => {} });

        const icon = proj.icon || '🔄';
        const name = proj.name || key;
        const status = rs.status || 'idle';
        const depth = rs.depth || 0;
        const maxDepth = rs.max_depth || 50;
        const lastSignal = rs.last_signal || '-';
        const updatedAt = rs.updated_at ? new Date(rs.updated_at).toLocaleString() : '-';

        lines.push(`${icon} **${name}** (\`${key}\`)`);
        lines.push(`  Status: ${status} | Phase: ${phase || '-'} | Depth: ${depth}/${maxDepth}`);
        if (mission) lines.push(`  Mission: ${mission.title}`);
        lines.push(`  Last signal: ${lastSignal} | Updated: ${updatedAt}`);
        lines.push('');
      }

      if (!found) lines.push('No reactive projects configured.');

      await bot.sendMessage(chatId, lines.join('\n'));
      return { handled: true, config };
    }

    if (text === '/status') {
      const session = getSession(chatId);
      let msg = `MetaMe Daemon\nStatus: Running\nStarted: ${state.started_at || 'unknown'}\n`;
      msg += `Budget: ${state.budget.tokens_used}/${(config.budget && config.budget.daily_limit) || 50000} tokens`;
      if (session) msg += `\nSession: ${session.id.slice(0, 8)}... (${session.cwd})`;
      try {
        if (fs.existsSync(BRAIN_FILE)) {
          const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
          if (doc.identity) msg += `\nProfile: ${doc.identity.nickname || 'unknown'}`;
          const nowPath = require('path').join(require('os').homedir(), '.metame', 'memory', 'NOW.md');
          try {
            if (fs.existsSync(nowPath)) {
              const nowContent = fs.readFileSync(nowPath, 'utf8').trim().split('\n')[0];
              if (nowContent) msg += `\nNOW: ${nowContent.slice(0, 80)}`;
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      await bot.sendMessage(chatId, msg);
      return { handled: true, config };
    }

    if (text === '/weixin' || text.startsWith('/weixin ')) {
      const store = getWeixinStore();
      if (!store) {
        await bot.sendMessage(chatId, '❌ weixin 模块不可用');
        return { handled: true, config };
      }

      const parsed = parseWeixinCommand(text);
      const weixinCfg = (config && config.weixin) || {};

      if (parsed.action === 'usage') {
        await bot.sendMessage(chatId, [
          '用法:',
          '/weixin',
          '/weixin status',
          '/weixin login start [--bot-type 3] [--session <key>]',
          '/weixin login wait --session <key>',
        ].join('\n'));
        return { handled: true, config };
      }

      if (parsed.action === 'status') {
        const accountIds = store.listAccounts();
        const activeAccountId = String(weixinCfg.account_id || accountIds[0] || '').trim();
        const lines = [
          '💬 Weixin',
          `enabled: ${weixinCfg.enabled ? 'yes' : 'no'}`,
          `base_url: ${weixinCfg.base_url || (weixinApiMod && weixinApiMod.DEFAULT_BASE_URL) || 'https://ilinkai.weixin.qq.com'}`,
          `bot_type: ${weixinCfg.bot_type || '3'}`,
          `linked_accounts: ${accountIds.length}`,
          `active_account: ${activeAccountId || '(none)'}`,
        ];
        if (accountIds.length > 0) {
          for (const id of accountIds.slice(0, 5)) {
            const account = store.loadAccount(id) || {};
            const label = id === activeAccountId ? ' (active)' : '';
            lines.push(`- ${id}${label} user=${account.userId || '-'} linked=${account.linkedAt || account.savedAt || '-'}`);
          }
        } else {
          lines.push('- no linked account');
        }
        await bot.sendMessage(chatId, lines.join('\n'));
        return { handled: true, config };
      }

      if (parsed.action === 'login:start') {
        const flags = parsed.flags || {};
        const botType = String(flags['bot-type'] || weixinCfg.bot_type || '3').trim();
        const sessionKey = String(flags.session || `${Date.now()}-${botType}`).trim();
        try {
          const session = await store.startQrLogin({
            sessionKey,
            botType,
            baseUrl: weixinCfg.base_url || undefined,
            routeTag: weixinCfg.route_tag || undefined,
          });
          const lines = [
            '✅ 微信登录二维码已生成',
            `session: ${session.sessionKey}`,
            `bot_type: ${session.botType}`,
            '',
            `${session.qrcodeUrl || '(no qrcode url returned)'}`,
            '',
            `下一步: /weixin login wait --session ${session.sessionKey}`,
          ];
          await bot.sendMessage(chatId, lines.join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 微信登录启动失败: ${e.message}`);
        }
        return { handled: true, config };
      }

      if (parsed.action === 'login:wait') {
        const flags = parsed.flags || {};
        const sessionKey = String(flags.session || '').trim();
        if (!sessionKey) {
          await bot.sendMessage(chatId, '❌ 缺少 session\n用法: /weixin login wait --session <key>');
          return { handled: true, config };
        }
        try {
          const result = await store.waitForQrLogin({ sessionKey });
          if (result.connected) {
            await bot.sendMessage(chatId, [
              '✅ 微信账号已绑定',
              `account: ${result.account.accountId}`,
              `user: ${result.account.userId || '-'}`,
              `base_url: ${result.account.baseUrl || '-'}`,
            ].join('\n'));
          } else if (result.expired) {
            await bot.sendMessage(chatId, '⚠️ 二维码已过期，请重新执行 /weixin login start');
          } else if (result.timeout) {
            await bot.sendMessage(chatId, '⏳ 仍在等待扫码确认，可稍后再次执行 /weixin login wait --session <key>');
          } else {
            await bot.sendMessage(chatId, '⚠️ 登录未完成');
          }
        } catch (e) {
          await bot.sendMessage(chatId, `❌ 微信登录等待失败: ${e.message}`);
        }
        return { handled: true, config };
      }
    }

    // /skill-evo — inspect and resolve skill evolution queue
    if (text === '/skill-evo' || text.startsWith('/skill-evo ')) {
      if (!skillEvolution) {
        await bot.sendMessage(chatId, '❌ skill-evolution 模块不可用');
        return { handled: true, config };
      }

      const arg = text.slice('/skill-evo'.length).trim();
      const renderItem = (i) => {
        const id = i.id || '-';
        const target = i.skill_name ? `skill=${i.skill_name}` : (i.search_hint ? `hint=${i.search_hint}` : 'global');
        const seen = i.last_seen || i.detected || '-';
        const ev = i.evidence_count || 1;
        return `- [${id}] ${i.type}/${i.status} (${target}, ev=${ev})\n  ${i.reason || '(no reason)'}\n  last: ${seen}`;
      };

      if (!arg || arg === 'list') {
        const pendingAll = skillEvolution.listQueueItems({ status: 'pending', limit: 200 });
        const notifiedAll = skillEvolution.listQueueItems({ status: 'notified', limit: 200 });
        const installedAll = skillEvolution.listQueueItems({ status: 'installed', limit: 200 });
        const dismissedAll = skillEvolution.listQueueItems({ status: 'dismissed', limit: 200 });

        const pending = pendingAll.slice(0, 10);
        const notified = notifiedAll.slice(0, 10);
        const resolved = [...installedAll, ...dismissedAll]
          .sort((a, b) => new Date(b.last_seen || b.detected || 0).getTime() - new Date(a.last_seen || a.detected || 0).getTime())
          .slice(0, 5);

        const lines = ['🧬 Skill Evolution Queue'];
        lines.push(`pending: ${pendingAll.length} | notified: ${notifiedAll.length} | resolved(total): ${installedAll.length + dismissedAll.length}`);
        if (pending.length > 0) {
          lines.push('\nPending:');
          for (const item of pending.slice(0, 5)) lines.push(renderItem(item));
        }
        if (notified.length > 0) {
          lines.push('\nNotified:');
          for (const item of notified.slice(0, 5)) lines.push(renderItem(item));
        }
        if (resolved.length > 0) {
          lines.push('\nResolved (latest):');
          for (const item of resolved) lines.push(renderItem(item));
        }
        if (pending.length === 0 && notified.length === 0 && resolved.length === 0) {
          lines.push('\n(queue empty)');
        }
        lines.push('\n用法: /skill-evo done <id> | /skill-evo dismiss <id>');

        await bot.sendMessage(chatId, lines.join('\n'));

        if (bot.sendButtons) {
          const actionable = [...notified, ...pending].slice(0, 3);
          if (actionable.length > 0) {
            const buttons = [];
            for (const item of actionable) {
              const label = `${item.type}:${(item.skill_name || item.search_hint || 'item').slice(0, 10)}`;
              buttons.push([
                { text: `✅ ${label}`, callback_data: `/skill-evo done ${item.id}` },
                { text: `🙈 ${label}`, callback_data: `/skill-evo dismiss ${item.id}` },
              ]);
            }
            await bot.sendButtons(chatId, '处理建议项：', buttons);
          }
        }
        return { handled: true, config };
      }

      const doneMatch = arg.match(/^(?:done|install|installed)\s+(\S+)$/i);
      if (doneMatch) {
        const id = doneMatch[1];
        const ok = skillEvolution.resolveQueueItemById
          ? skillEvolution.resolveQueueItemById(id, 'installed')
          : false;
        await bot.sendMessage(chatId, ok ? `✅ 已标记 installed: ${id}` : `❌ 未找到可处理项: ${id}`);
        return { handled: true, config };
      }

      // /skill-evo approve <id> — approve a workflow_proposal and dispatch skill creation
      const approveMatch = arg.match(/^approve\s+(\S+)$/i);
      if (approveMatch) {
        const id = approveMatch[1];
        // Find the queue item (search both pending and notified states)
        const item = skillEvolution.listQueueItems({ status: ['pending', 'notified'], limit: 200 })
          .find(i => i.id === id && i.type === 'workflow_proposal');
        if (!item) {
          await bot.sendMessage(chatId, `❌ 未找到 workflow_proposal: ${id}`);
          return { handled: true, config };
        }
        // Build skill-creator prefilled prompt
        const toolsSig = (item.tools_signature || []).join(', ');
        const prefilledPrompt = [
          '/skill-creator',
          `创建一个新技能，自动化以下工作流：`,
          `工作流模式: ${item.search_hint || item.reason}`,
          toolsSig ? `常用工具: ${toolsSig}` : '',
          item.example_prompt ? `用户示例: "${item.example_prompt}"` : '',
          `该技能应封装这个多步工作流为单一可调用技能。`,
        ].filter(Boolean).join('\n');
        // Dispatch to metame agent for skill creation (async — must not block event loop)
        try {
          const HOME = require('os').homedir();
          const dispatchBin = require('path').join(HOME, '.metame', 'bin', 'dispatch_to');
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          const execFileAsync = promisify(execFile);
          // dispatch_to is a Node.js script; on Windows shebang resolution is unavailable,
          // so invoke via node explicitly for cross-platform safety
          const cmd = IS_WIN ? process.execPath : dispatchBin;
          const cmdArgs = IS_WIN ? [dispatchBin, 'metame', prefilledPrompt] : ['metame', prefilledPrompt];
          await execFileAsync(cmd, cmdArgs, { encoding: 'utf8', timeout: 15000 });
          // Mark installed only after successful dispatch
          skillEvolution.resolveQueueItemById(id, 'installed');
          await bot.sendMessage(chatId, `✅ 已派发给 Jarvis 创建技能，完成后会通知你\n工作流: ${item.search_hint || item.reason}`);
        } catch (e) {
          // Dispatch failed — don't mark installed, keep in queue
          await bot.sendMessage(chatId, `⚠️ 自动派发失败: ${e.message}\n提案仍在队列中，可重试: /skill-evo approve ${id}`);
        }
        return { handled: true, config };
      }

      const dismissMatch = arg.match(/^(?:dismiss|skip|ignored?)\s+(\S+)$/i);
      if (dismissMatch) {
        const id = dismissMatch[1];
        // Check if this is a workflow_proposal — if so, reset the sketch
        const item = skillEvolution.listQueueItems({ status: ['pending', 'notified'], limit: 200 })
          .find(i => i.id === id);
        const ok = skillEvolution.resolveQueueItemById
          ? skillEvolution.resolveQueueItemById(id, 'dismissed')
          : false;
        // Reset workflow sketch so it can re-accumulate
        if (ok && item && item.type === 'workflow_proposal' && item.workflow_sketch_id) {
          if (skillEvolution.resetWorkflowSketch) {
            skillEvolution.resetWorkflowSketch(item.workflow_sketch_id);
          }
        }
        await bot.sendMessage(chatId, ok ? `✅ 已标记 dismissed: ${id}` : `❌ 未找到可处理项: ${id}`);
        return { handled: true, config };
      }

      await bot.sendMessage(chatId, '用法: /skill-evo list | /skill-evo done <id> | /skill-evo dismiss <id> | /skill-evo approve <id>');
      return { handled: true, config };
    }

    if (text === '/tasks') {
      const { general, project } = getAllTasks(config);
      let msg = '';
      if (general.length > 0) {
        msg += '📋 General:\n';
        for (const t of general) {
          const ts = state.tasks[t.name] || {};
          msg += `${t.enabled !== false ? '✅' : '⏸'} ${t.name} (${formatTaskSchedule(t)}) ${ts.status || 'never_run'}\n`;
        }
      }
      // Project tasks grouped by _project
      const byProject = new Map();
      for (const t of project) {
        const pk = t._project.key;
        if (!byProject.has(pk)) byProject.set(pk, { proj: t._project, tasks: [] });
        byProject.get(pk).tasks.push(t);
      }
      for (const [, { proj, tasks }] of byProject) {
        msg += `\n${proj.icon} ${proj.name}:\n`;
        for (const t of tasks) {
          const ts = state.tasks[t.name] || {};
          msg += `${t.enabled !== false ? '✅' : '⏸'} ${t.name} (${formatTaskSchedule(t)}) ${ts.status || 'never_run'}\n`;
        }
      }
      if (!msg) {
        await bot.sendMessage(chatId, 'No heartbeat tasks configured.');
        return { handled: true, config };
      }
      await bot.sendMessage(chatId, msg.trim());
      return { handled: true, config };
    }

    if (isLikelyTeamTaskResumeIntent(text)) {
      const senderKey = resolveSenderKey(chatId, config);
      const candidates = listAutoResumeCandidates(chatId, senderKey, config);
      if (candidates.length === 1) {
        const task = candidates[0];
        const resumed = dispatchTeamTaskResume(task, chatId, config, senderId);
        if (resumed.success) {
          if (taskBoard && typeof taskBoard.appendTaskEvent === 'function') {
            taskBoard.appendTaskEvent(task.task_id, 'task_resume_requested', String(chatId), { by: String(chatId), source: 'nl_auto_resume' });
          }
          await bot.sendMessage(chatId, [
            `🔄 已自动续跑最近的 TeamTask: ${task.task_id}`,
            `目标: ${task.to_agent}`,
            `意图: ${text.trim().slice(0, 80)}`,
            '回执会在目标端真正接收后返回。',
          ].join('\n'));
          await sendLocalDispatchReceipt(bot, chatId, resumed.targetKey, config.projects[resumed.targetKey], resumed.result, resumed.envelope.goal);
          return { handled: true, config };
        }
        await bot.sendMessage(chatId, `❌ 自动续跑失败: ${resumed.result && resumed.result.error ? resumed.result.error : 'unknown_error'}`);
        return { handled: true, config };
      }
      if (candidates.length > 1) {
        const lines = ['⚠️ 检测到你可能想复工 TeamTask，但最近有多条候选任务：'];
        for (const task of candidates.slice(0, 3)) {
          lines.push(`- ${task.task_id} [${task.status}] ${task.goal.slice(0, 50)}`);
        }
        lines.push('请直接回复更明确一点，或使用 /TeamTask 查看后再选择。');
        await bot.sendMessage(chatId, lines.join('\n'));
        return { handled: true, config };
      }
    }

    // /TeamTask — create/list/detail/resume team collaboration tasks
    const teamTaskCmdMatch = text.match(/^\/teamtask(?:\s+([\s\S]+))?$/i);
    if (teamTaskCmdMatch) {
      const args = String(teamTaskCmdMatch[1] || '').trim();
      if (/^create$/i.test(args)) {
        await bot.sendMessage(chatId, '❌ 用法: /TeamTask create <agent> <目标> [--scope <scopeId>] [--parent <taskId>]');
        return { handled: true, config };
      }
      const createMatch = args.match(/^create\s+([\s\S]+)$/i);
      if (createMatch) {
        if (!taskEnvelope) {
          await bot.sendMessage(chatId, '❌ task protocol 不可用');
          return { handled: true, config };
        }
        const parsed = parseTeamTaskArgs(createMatch[1]);
        if (!parsed || !parsed.targetName || !parsed.goal) {
          await bot.sendMessage(chatId, '❌ 用法: /TeamTask create <agent> <目标> [--scope <scopeId>] [--parent <taskId>]');
          return { handled: true, config };
        }
        const { targetName, goal, scopeId, parentTaskId } = parsed;
        const targetKey = resolveProjectKey(targetName, config.projects || {});
        if (!targetKey) {
          await bot.sendMessage(chatId, `未找到 agent: ${targetName}\n可用: ${Object.keys(config.projects || {}).join(', ')}`);
          return { handled: true, config };
        }
        const senderKey = resolveSenderKey(chatId, config);
        const participants = (scopeId && taskBoard && taskBoard.listScopeParticipants)
          ? taskBoard.listScopeParticipants(scopeId)
          : [];
        participants.push(senderKey, targetKey);
        const envelope = taskEnvelope.normalizeTaskEnvelope({
          from_agent: senderKey,
          to_agent: targetKey,
          scope_id: scopeId || '',
          parent_task_id: parentTaskId || null,
          participants,
          goal,
          task_kind: 'team',
          definition_of_done: [
            '输出可执行结果和关键结论',
            '必要时给出产物路径与下一步建议',
          ],
          inputs: {
            source_chat_id: String(chatId),
            source: 'mobile_teamtask',
          },
          priority: 'normal',
          status: 'queued',
        });
        const checked = taskEnvelope.validateTaskEnvelope(envelope);
        if (!checked.ok) {
          await bot.sendMessage(chatId, `❌ TeamTask 无效: ${checked.error}`);
          return { handled: true, config };
        }
        const result = dispatchTask(targetKey, {
          from: senderKey,
          type: 'task',
          priority: envelope.priority,
          payload: {
            title: goal.slice(0, 60),
            prompt: goal,
            task_envelope: envelope,
          },
          callback: false,
          source_chat_id: String(chatId),
          source_sender_key: senderKey,
          source_sender_id: String(senderId || '').trim() || '',
        }, config);
        if (result.success) {
          await bot.sendMessage(chatId, [
            `✅ 已创建 TeamTask 并提交派发: ${envelope.task_id}`,
            `Scope: ${envelope.scope_id || envelope.task_id}`,
            '回执会在目标端真正接收后返回。',
            `查看: /TeamTask ${envelope.task_id}`,
          ].join('\n'));
          await sendLocalDispatchReceipt(bot, chatId, targetKey, config.projects[targetKey], result, goal);
        } else {
          await bot.sendMessage(chatId, `❌ 创建 TeamTask 失败: ${result.error}`);
        }
        return { handled: true, config };
      }

      if (!taskBoard) {
        await bot.sendMessage(chatId, '❌ Task Board 不可用');
        return { handled: true, config };
      }

      if (!args || /^list$/i.test(args)) {
        const recent = taskBoard.listRecentTasks(10, null, 'team');
        if (recent.length === 0) {
          await bot.sendMessage(chatId, '暂无 TeamTask。\n使用 /TeamTask create <agent> <goal> 创建。');
          return { handled: true, config };
        }
        let msg = '🧩 TeamTask (最近10条)\n';
        for (const t of recent) {
          msg += `\n- ${t.task_id} [${t.status}] scope=${t.scope_id || t.task_id}\n  ${t.from_agent}→${t.to_agent} · ${t.goal.slice(0, 80)}`;
        }
        msg += '\n\n查看详情: /TeamTask <task_id>\n续跑: /TeamTask resume <task_id>';
        await bot.sendMessage(chatId, msg);
        return { handled: true, config };
      }

      const resumeMatch = args.match(/^resume\s+(\S+)$/i);
      if (resumeMatch) {
        const taskId = resumeMatch[1];
        const task = taskBoard.getTask(taskId);
        if (!task || task.task_kind !== 'team') {
          await bot.sendMessage(chatId, `❌ 未找到 TeamTask: ${taskId}`);
          return { handled: true, config };
        }
        const targetKey = task.to_agent;
        if (!config.projects || !config.projects[targetKey]) {
          await bot.sendMessage(chatId, `❌ 目标 agent 不存在: ${targetKey}`);
          return { handled: true, config };
        }
        const resumed = dispatchTeamTaskResume(task, chatId, config, senderId);
        const { result, envelope } = resumed;

        if (result.success) {
          taskBoard.appendTaskEvent(task.task_id, 'task_resume_requested', String(chatId), { by: String(chatId) });
          await bot.sendMessage(chatId, `✅ 已续跑 TeamTask: ${task.task_id}\n回执会在目标端真正接收后返回。`);
          await sendLocalDispatchReceipt(bot, chatId, targetKey, config.projects[targetKey], result, envelope.goal);
        } else {
          await bot.sendMessage(chatId, `❌ 续跑失败: ${result.error}`);
        }
        return { handled: true, config };
      }

      if (/^resume$/i.test(args)) {
        await bot.sendMessage(chatId, '❌ 用法: /TeamTask resume <task_id>');
        return { handled: true, config };
      }

      const task = taskBoard.getTask(args);
      if (!task || task.task_kind !== 'team') {
        await bot.sendMessage(chatId, `❌ 未找到 TeamTask: ${args}`);
        return { handled: true, config };
      }
      const events = taskBoard.listTaskEvents(task.task_id, 8);
      const scopeId = task.scope_id || task.task_id;
      const scopeTasks = taskBoard.listScopeTasks(scopeId, 12);
      const scopeParticipants = taskBoard.listScopeParticipants(scopeId);
      let detail = [
        `🧩 TeamTask: ${task.task_id}`,
        `Scope: ${scopeId}`,
        `状态: ${task.status}`,
        `优先级: ${task.priority}`,
        `流向: ${task.from_agent} → ${task.to_agent}`,
        `目标: ${task.goal}`,
      ];
      if (scopeParticipants.length > 0) {
        detail.push(`参与者: ${scopeParticipants.join(', ')}`);
      }
      if (Array.isArray(task.definition_of_done) && task.definition_of_done.length > 0) {
        detail.push('DoD:');
        for (const d of task.definition_of_done.slice(0, 6)) detail.push(`- ${d}`);
      }
      if (Array.isArray(task.artifacts) && task.artifacts.length > 0) {
        detail.push('产物:');
        for (const a of task.artifacts.slice(0, 6)) detail.push(`- ${a}`);
      }
      if (task.last_error) detail.push(`错误: ${task.last_error.slice(0, 180)}`);
      if (events.length > 0) {
        detail.push('最近事件:');
        for (const ev of events.slice(0, 5)) detail.push(`- [${ev.event_type}] ${ev.actor} @ ${ev.created_at}`);
      }
      if (scopeTasks.length > 1) {
        detail.push('同 Scope 相关任务:');
        for (const st of scopeTasks.filter(x => x.task_id !== task.task_id).slice(0, 5)) {
          detail.push(`- ${st.task_id} [${st.status}] ${st.from_agent}→${st.to_agent}`);
        }
      }
      await bot.sendMessage(chatId, detail.join('\n'));
      return { handled: true, config };
    }

    // /dispatch — inter-agent task dispatch
    if (text.startsWith('/dispatch')) {
      const args = text.slice('/dispatch'.length).trim();

      if (!args || args === 'status') {
        // Show dispatch status from log
        let msg = '📬 Agent Dispatch 状态\n─────────────\n';
        for (const [key, proj] of Object.entries(config.projects || {})) {
          msg += `${proj.icon || '🤖'} ${proj.name || key} — 就绪\n`;
        }
        if (fs.existsSync(DISPATCH_LOG)) {
          const lines = fs.readFileSync(DISPATCH_LOG, 'utf8').trim().split('\n').filter(Boolean);
          const recent = lines.slice(-5).reverse();
          if (recent.length > 0) {
            msg += '\n📤 最近派发:\n';
            for (const l of recent) {
              try {
                const e = JSON.parse(l);
                msg += `${e.from}→${e.to}: ${(e.payload.title || e.payload.prompt || '').slice(0, 40)} (${e.type})\n`;
              } catch { /* skip */ }
            }
          }
        }
        await bot.sendMessage(chatId, msg.trim());
        return { handled: true, config };
      }

      if (args === 'log') {
        if (!fs.existsSync(DISPATCH_LOG)) {
          await bot.sendMessage(chatId, '无派发记录。');
          return { handled: true, config };
        }
        const lines = fs.readFileSync(DISPATCH_LOG, 'utf8').trim().split('\n').filter(Boolean);
        const recent = lines.slice(-10).reverse();
        let msg = '📤 最近 10 条派发记录:\n';
        for (const l of recent) {
          try {
            const e = JSON.parse(l);
            const time = new Date(e.dispatched_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
            msg += `[${time}] ${e.from}→${e.to} ${e.type}: ${(e.payload.title || e.payload.prompt || '').slice(0, 40)}\n`;
          } catch { /* skip */ }
        }
        await bot.sendMessage(chatId, msg.trim());
        return { handled: true, config };
      }

      // /dispatch peers — show remote dispatch config
      if (args === 'peers') {
        const rd = getRemoteDispatchStatus(config);
        if (!rd) {
          await bot.sendMessage(chatId, '📡 远端 Dispatch 未配置\n\n在 daemon.yaml 中设置 feishu.remote_dispatch 启用。');
          return { handled: true, config };
        }
        let msg = `📡 远端 Dispatch 配置\n─────────────\nself: ${rd.selfPeer}\nrelay chat: ${rd.chatId}\nmode: pair code\nsecret: ${rd.hasSecret ? 'configured' : 'missing'}\n\n远端成员:\n`;
        let hasRemote = false;
        for (const [key, proj] of Object.entries(config.projects || {})) {
          if (!Array.isArray(proj.team)) continue;
          for (const m of proj.team) {
            if (m.peer) {
              hasRemote = true;
              msg += `- ${m.icon || '🤖'} ${m.name || m.key} → peer:${m.peer} (${key}/${m.key})\n`;
            }
          }
        }
        if (!hasRemote) msg += '(无远端成员)\n';
        await bot.sendMessage(chatId, msg.trim());
        return { handled: true, config };
      }

      if (args === 'code') {
        const rd = getRemoteDispatchStatus(config);
        if (!rd) {
          await bot.sendMessage(chatId, '📡 远端 Dispatch 未配置\n\n在 daemon.yaml 中设置 feishu.remote_dispatch 启用。');
          return { handled: true, config };
        }
        const code = generatePairCode();
        const secret = deriveSecretFromPairCode(code, rd.chatId);
        backupConfig();
        const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
        if (!cfg.feishu) cfg.feishu = {};
        if (!cfg.feishu.remote_dispatch) cfg.feishu.remote_dispatch = {};
        cfg.feishu.remote_dispatch.secret = secret;
        writeConfigSafe(cfg);
        config = loadConfig();
        await bot.sendMessage(chatId, `🔐 配对码已生成\n\n配对码: ${code}\n\n把这 6 位码发到另一台设备执行:\n/dispatch pair ${code}`);
        return { handled: true, config };
      }

      const pairMatch = args.match(/^pair\s+(\d{6})$/);
      if (pairMatch) {
        const rd = getRemoteDispatchStatus(config);
        if (!rd) {
          await bot.sendMessage(chatId, '📡 远端 Dispatch 未配置\n\n在 daemon.yaml 中设置 feishu.remote_dispatch 启用。');
          return { handled: true, config };
        }
        const code = pairMatch[1];
        if (!isValidPairCode(code)) {
          await bot.sendMessage(chatId, '❌ 配对码必须是 6 位数字');
          return { handled: true, config };
        }
        const secret = deriveSecretFromPairCode(code, rd.chatId);
        backupConfig();
        const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
        if (!cfg.feishu) cfg.feishu = {};
        if (!cfg.feishu.remote_dispatch) cfg.feishu.remote_dispatch = {};
        cfg.feishu.remote_dispatch.secret = secret;
        writeConfigSafe(cfg);
        config = loadConfig();
        await bot.sendMessage(chatId, `✅ 配对码已写入\n\n当前设备: ${rd.selfPeer}\nrelay chat: ${rd.chatId}\n现在可以测试 /dispatch to <peer:project> ...`);
        return { handled: true, config };
      }

      // /dispatch to <agent> <prompt>
      const toMatch = args.match(/^to\s+(\S+)\s+(.+)$/s);
      if (toMatch) {
        const targetName = toMatch[1];
        const prompt = toMatch[2].trim();
        const senderKey = resolveSenderKey(chatId, config);

        // Check for remote target (peer:project format)
        const remoteTarget = parseRemoteTargetRef(targetName);
        if (remoteTarget && deps.sendRemoteDispatch) {
          const res = await deps.sendRemoteDispatch({
            type: 'task',
            to_peer: remoteTarget.peer,
            target_project: remoteTarget.project,
            prompt,
            source_chat_id: String(chatId),
            source_sender_key: senderKey,
            source_sender_id: String(senderId || '').trim() || '',
          }, config);
          if (res.success) {
            await bot.sendMessage(chatId, `📡 已发送给 ${remoteTarget.peer}:${remoteTarget.project}`);
          } else {
            await bot.sendMessage(chatId, `❌ 远端派发失败: ${res.error}`);
          }
          return { handled: true, config };
        }

        // Resolve target by project key or nickname (handles team members via compound key)
        const resolved = resolveDispatchTarget(targetName, config.projects || {});
        if (!resolved) {
          await bot.sendMessage(chatId, `未找到 agent: ${targetName}\n可用: ${Object.keys(config.projects || {}).join(', ')}`);
          return { handled: true, config };
        }
        const { dispatchKey: targetKey, projInfo } = resolved;

        // Check if resolved target is a remote team member
        if (projInfo.peer && deps.sendRemoteDispatch) {
          const res = await deps.sendRemoteDispatch({
            type: 'task',
            to_peer: projInfo.peer,
            target_project: targetKey,
            prompt,
            source_chat_id: String(chatId),
            source_sender_key: senderKey,
            source_sender_id: String(senderId || '').trim() || '',
          }, config);
          if (res.success) {
            await bot.sendMessage(chatId, `📡 已发送给 ${projInfo.icon || '🤖'} ${projInfo.name || targetKey} (${projInfo.peer})`);
          } else {
            await bot.sendMessage(chatId, `❌ 远端派发失败: ${res.error}`);
          }
          return { handled: true, config };
        }

        // Find the target project's own Feishu chat (reverse lookup of chat_agent_map)
        const feishuChatAgentMap = (config.feishu && config.feishu.chat_agent_map) || {};
        const targetChatId = Object.entries(feishuChatAgentMap).find(([, v]) => v === targetKey)?.[0] || null;
        // Stream work directly to target's channel if available; otherwise fallback replyFn
        const dispatchStreamOptions = targetChatId ? { bot, chatId: targetChatId } : null;
        const replyFn = targetChatId ? null : (output) => {
          const text2 = `${projInfo.icon || '📬'} **${projInfo.name || targetKey}**\n\n${output.slice(0, 2000)}`;
          bot.sendMarkdown(chatId, text2)
            .catch(e => {
              log('WARN', `Dispatch sendMarkdown failed: ${e.message}, trying sendMessage`);
              bot.sendMessage(chatId, text2).catch(e2 => log('ERROR', `Dispatch reply failed: ${e2.message}`));
            });
        };

        const result = dispatchTask(targetKey, {
          from: senderKey,
          type: 'task',
          priority: 'normal',
          payload: { title: prompt.slice(0, 60), prompt },
          callback: false,
          source_chat_id: String(chatId),
          source_sender_key: senderKey,
          source_sender_id: String(senderId || '').trim() || '',
        }, config, replyFn, dispatchStreamOptions);

        if (result.success) {
          await bot.sendMessage(chatId, `✅ 已提交派发给 ${projInfo.name || targetName}，等待回执…`);
          await sendLocalDispatchReceipt(bot, chatId, targetKey, projInfo, result, prompt);
        } else {
          await bot.sendMessage(chatId, `❌ 派发失败: ${result.error}`);
        }
        return { handled: true, config };
      }

      await bot.sendMessage(chatId, [
        '用法:',
        '/dispatch status — 查看状态',
        '/dispatch log — 查看记录',
        '/dispatch peers — 查看远端配置',
        '/dispatch code — 生成 6 位配对码并写入本机',
        '/dispatch pair <123456> — 输入 6 位配对码写入本机',
        '/dispatch to <agent> <任务内容> — 直接跨 agent 派发',
        '/dispatch to <peer:project> <任务内容> — 跨设备派发',
        '/TeamTask create <agent> <目标> [--scope <id>] [--parent <id>] — 创建/续接 TeamTask',
        '/TeamTask — 查看 TeamTask 列表',
      ].join('\n'));
      return { handled: true, config };
    }

    // /msg — team internal messaging (like sessions_send)
    if (text.startsWith('/msg ')) {
      const args = text.slice('/msg '.length).trim();
      const msgMatch = args.match(/^(\S+)\s+(.+)$/s);
      if (!msgMatch) {
        await bot.sendMessage(chatId, '用法: /msg <agent> <消息内容>\n示例: /msg 甲 帮我看看这个文档');
        return { handled: true, config };
      }
      const targetName = msgMatch[1];
      const message = msgMatch[2].trim();

      // Resolve target by nickname or key (handles team members via compound key)
      const senderKey = resolveSenderKey(chatId, config);
      const resolved = resolveDispatchTarget(targetName, config.projects || {});

      if (!resolved) {
        await bot.sendMessage(chatId, `未找到 agent: ${targetName}`);
        return { handled: true, config };
      }
      const { dispatchKey: targetKey, projInfo: toProj } = resolved;

      const result = dispatchTask(targetKey, {
        from: senderKey,
        type: 'message',
        priority: 'normal',
        payload: { title: 'team message', prompt: `[来自团队的消息]\n\n${message}` },
        callback: false,
        source_chat_id: String(chatId),
        source_sender_key: senderKey,
        source_sender_id: String(senderId || '').trim() || '',
      }, config, null, null);

      if (result.success) {
        await bot.sendMessage(chatId, `📬 已发送消息给 ${toProj.icon || '🤖'} ${toProj.name || targetKey}`);
        await sendLocalDispatchReceipt(bot, chatId, targetKey, toProj, result, message);
      } else {
        await bot.sendMessage(chatId, `❌ 发送失败: ${result.error}`);
      }
      return { handled: true, config };
    }

    if (text === '/budget') {
      const limit = (config.budget && config.budget.daily_limit) || 50000;
      const used = state.budget.tokens_used;
      await bot.sendMessage(chatId, `Budget: ${used}/${limit} tokens (${((used / limit) * 100).toFixed(1)}%)`);
      return { handled: true, config };
    }

    if (text === '/reset-budget') {
      if (!state.budget) state.budget = {};
      state.budget.tokens_used = 0;
      state.budget.date = new Date().toISOString().slice(0, 10);
      await bot.sendMessage(chatId, `✅ Budget 已重置 (${state.budget.date})`);
      return { handled: true, config };
    }

    if (text === '/toggle' || text.startsWith('/toggle ')) {
      const arg = text.slice('/toggle'.length).trim();
      const cfg = config;
      const tasks = (cfg.heartbeat && cfg.heartbeat.tasks) || [];

      // Group mapping: friendly name → task names
      const groups = {
        cognition: ['cognitive-distill', 'self-reflect'],
        memory: ['memory-extract', 'nightly-reflect', 'memory-gc', 'memory-index'],
        skill: ['skill-evolve'],
      };

      if (!arg) {
        // Show status
        const lines = ['⚙️ 后台任务开关:'];
        for (const [group, names] of Object.entries(groups)) {
          const statuses = names.map(n => {
            const t = tasks.find(t2 => t2.name === n);
            return t ? (t.enabled !== false ? '✅' : '❌') : '⚠️';
          });
          const allOn = statuses.every(s => s === '✅');
          const allOff = statuses.every(s => s === '❌');
          lines.push(`  ${allOn ? '✅' : allOff ? '❌' : '⚠️'} ${group}`);
        }
        lines.push('', '用法: /toggle <cognition|memory|skill> <on|off>');
        await bot.sendMessage(chatId, lines.join('\n'));
        return { handled: true, config };
      }

      const parts = arg.split(/\s+/);
      const groupName = parts[0];
      const action = parts[1];

      if (!groups[groupName]) {
        await bot.sendMessage(chatId, `未知分组: ${groupName}\n可选: cognition, memory, skill`);
        return { handled: true, config };
      }
      if (action !== 'on' && action !== 'off') {
        await bot.sendMessage(chatId, `用法: /toggle ${groupName} <on|off>`);
        return { handled: true, config };
      }

      const enabled = action === 'on';
      const affected = [];
      for (const name of groups[groupName]) {
        const t = tasks.find(t2 => t2.name === name);
        if (t) {
          t.enabled = enabled;
          affected.push(name);
        }
      }
      if (affected.length === 0) {
        await bot.sendMessage(chatId, `⚠️ 未找到 ${groupName} 相关任务，请检查 heartbeat 配置`);
        return { handled: true, config };
      }
      writeConfigSafe(cfg);
      config = loadConfig();
      await bot.sendMessage(chatId, `${enabled ? '✅' : '❌'} ${groupName} ${enabled ? 'ON' : 'OFF'} (${affected.join(', ')})`);
      return { handled: true, config };
    }

    // /broadcast [on|off] — toggle team broadcast for the current chat's bound project
    if (text === '/broadcast' || text.startsWith('/broadcast ')) {
      const arg = text.slice('/broadcast'.length).trim();
      const cfg = config;
      const feishuMap = { ...(cfg.feishu ? cfg.feishu.chat_agent_map : {}), ...(cfg.telegram ? cfg.telegram.chat_agent_map : {}) };
      const boundKey = feishuMap[String(chatId)];
      const boundProj = boundKey && cfg.projects ? cfg.projects[boundKey] : null;
      if (!boundProj || !Array.isArray(boundProj.team) || boundProj.team.length === 0) {
        await bot.sendMessage(chatId, '⚠️ 当前群没有绑定 team 项目');
        return { handled: true, config };
      }
      if (!arg) {
        const status = boundProj.broadcast ? '✅ ON' : '❌ OFF';
        await bot.sendMessage(chatId, `📢 团队广播: ${status}\n\n用法: /broadcast on|off\n开启后 team 成员间的传话会在群里可见`);
        return { handled: true, config };
      }
      if (arg !== 'on' && arg !== 'off') {
        await bot.sendMessage(chatId, '用法: /broadcast on|off');
        return { handled: true, config };
      }
      cfg.projects[boundKey].broadcast = arg === 'on';
      writeConfigSafe(cfg);
      config = loadConfig();
      await bot.sendMessage(chatId, `📢 团队广播已${arg === 'on' ? '开启' : '关闭'}`);
      return { handled: true, config };
    }

    if (text === '/usage' || text.startsWith('/usage ')) {
      const arg = text.slice('/usage'.length).trim() || 'today';
      const usage = state.usage || {};
      const daily = usage.daily || {};
      const categories = usage.categories || {};
      const limit = (config.budget && config.budget.daily_limit) || 50000;
      const todayIso = new Date().toISOString().slice(0, 10);

      // Resolve date range
      let days = 1;
      if (arg === 'week') days = 7;
      else if (arg === 'month') days = 30;
      else if (/^\d+d$/.test(arg)) days = Math.min(90, parseInt(arg, 10));

      const dates = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(`${todayIso}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() - i);
        dates.push(d.toISOString().slice(0, 10));
      }

      // Aggregate tokens by category across the date window
      const totals = {};
      let grandTotal = 0;
      for (const date of dates) {
        const bucket = daily[date] || {};
        for (const [key, val] of Object.entries(bucket)) {
          if (key === 'total') continue;
          const n = Math.max(0, Math.floor(Number(val) || 0));
          totals[key] = (totals[key] || 0) + n;
          grandTotal += n;
        }
      }
      // Fallback: if no daily breakdown yet, use categories totals for today
      if (grandTotal === 0 && days === 1) {
        for (const [key, meta] of Object.entries(categories)) {
          const n = Math.max(0, Math.floor(Number(meta && meta.total) || 0));
          if (n > 0) { totals[key] = n; grandTotal += n; }
        }
      }

      const label = days === 1 ? `今日 (${todayIso})` : `近 ${days} 天`;
      const budgetPct = limit > 0 ? ((grandTotal / limit) * 100).toFixed(1) : '—';
      let lines = [`📊 Token 用量 — ${label}`, `合计: ${grandTotal.toLocaleString()} / ${limit.toLocaleString()} tokens (${budgetPct}%)`];

      // Render by canonical order, then extras
      const orderedKeys = [...USAGE_CATEGORY_ORDER, ...Object.keys(totals).filter(k => !USAGE_CATEGORY_ORDER.includes(k))];
      for (const key of orderedKeys) {
        const n = totals[key] || 0;
        if (n === 0 && !CORE_USAGE_CATEGORIES.includes(key)) continue;
        const pct = grandTotal > 0 ? ((n / grandTotal) * 100).toFixed(1) : '0.0';
        const lbl = USAGE_CATEGORY_LABEL[key] || key;
        const bar = '█'.repeat(Math.round(Number(pct) / 10)).padEnd(10, '░');
        lines.push(`${lbl}: ${n.toLocaleString()} tokens (${pct}%) ${bar}`);
      }

      await bot.sendMessage(chatId, lines.join('\n'));
      return { handled: true, config };
    }

    if (text === '/quiet') {
      try {
        const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
        if (!doc.growth) doc.growth = {};
        doc.growth.quiet_until = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
        await bot.sendMessage(chatId, 'Mirror & reflections silenced for 48h.');
      } catch (e) {
        await bot.sendMessage(chatId, `Error: ${e.message}`);
      }
      return { handled: true, config };
    }

    if (text === '/mentor' || text.startsWith('/mentor ')) {
      try {
        backupConfig();
        const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
        const mentorCfg = ensureMentorConfig(cfg);
        const arg = text.slice('/mentor'.length).trim();

        if (!arg || arg === 'status') {
          const status = mentorCfg.enabled && mentorEngine && typeof mentorEngine.getRuntimeStatus === 'function'
            ? mentorEngine.getRuntimeStatus()
            : { debt_count: 0, cooldown_remaining_ms: 0 };
          const mode = String(mentorCfg.mode || modeFromLevel(mentorCfg.friction_level));
          const level = Number(mentorCfg.friction_level || 0);
          const cooldownSec = Math.ceil((Number(status.cooldown_remaining_ms) || 0) / 1000);
          const lines = [
            `Mentor: ${mentorCfg.enabled ? 'ON' : 'OFF'}`,
            `Mode: ${mode}`,
            `Friction level: ${level}`,
            `Debts: ${status.debt_count || 0}`,
            `Emotion cooldown: ${cooldownSec > 0 ? `${cooldownSec}s` : '0s'}`,
            'Zone: n/a (runtime)',
          ];
          await bot.sendMessage(chatId, lines.join('\n'));
          return { handled: true, config };
        }

        if (arg === 'on' || arg === 'off') {
          mentorCfg.enabled = arg === 'on';
          if (!mentorCfg.enabled && mentorEngine && typeof mentorEngine.clearRuntime === 'function') {
            mentorEngine.clearRuntime();
          }
          writeConfigSafe(cfg);
          config = loadConfig();
          await bot.sendMessage(chatId, mentorCfg.enabled
            ? '✅ Mentor mode enabled.'
            : '✅ Mentor mode disabled.');
          return { handled: true, config };
        }

        const mLevel = arg.match(/^level\s+(-?\d{1,2})$/i);
        if (mLevel) {
          let level = Number(mLevel[1]);
          if (!Number.isFinite(level)) level = 3;
          level = Math.max(0, Math.min(10, Math.floor(level)));
          mentorCfg.friction_level = level;
          mentorCfg.mode = modeFromLevel(level);
          writeConfigSafe(cfg);
          config = loadConfig();
          await bot.sendMessage(chatId, `✅ Mentor level set to ${level} (${mentorCfg.mode}).`);
          return { handled: true, config };
        }

        await bot.sendMessage(chatId, [
          '用法:',
          '/mentor on',
          '/mentor off',
          '/mentor level <0-10>',
          '/mentor status',
        ].join('\n'));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ Mentor command failed: ${e.message}`);
      }
      return { handled: true, config };
    }

    if (text === '/reload') {
      if (global._metameReload) {
        const r = global._metameReload();
        if (r.success) {
          await bot.sendMessage(chatId, `✅ Config reloaded. ${r.tasks} heartbeat tasks active.`);
        } else {
          await bot.sendMessage(chatId, `❌ Reload failed: ${r.error}`);
        }
      } else {
        await bot.sendMessage(chatId, '❌ Reload not available (daemon not fully started).');
      }
      return { handled: true, config };
    }

    // /recover — kill all stuck tasks and reset message queues
    if (text === '/recover') {
      const activeProcesses = getActiveProcesses ? getActiveProcesses() : null;
      const messageQueue = getMessageQueue ? getMessageQueue() : null;
      if (!activeProcesses) {
        await bot.sendMessage(chatId, '❌ 无法访问任务状态');
        return { handled: true, config };
      }
      const stuckChatIds = [...activeProcesses.keys()];
      let killed = 0;
      for (const cid of stuckChatIds) {
        const proc = activeProcesses.get(cid);
        if (proc && proc.child) {
          try { process.kill(-proc.child.pid, 'SIGTERM'); } catch { try { proc.child.kill('SIGTERM'); } catch { } }
          killed++;
        }
        activeProcesses.delete(cid);
        if (messageQueue && messageQueue.has(cid)) {
          const q = messageQueue.get(cid);
          if (q && q.timer) clearTimeout(q.timer);
          messageQueue.delete(cid);
        }
      }
      // Clear stale sessions (started: false = never completed first message, likely locked)
      try {
        const state = loadState();
        let cleared = 0;
        for (const [cid, sess] of Object.entries(state.sessions || {})) {
          if (sess && !sess.started) {
            delete state.sessions[cid];
            cleared++;
          }
        }
        if (cleared > 0) saveState(state);
      } catch { /* non-critical */ }
      // SIGKILL stragglers after 3s grace period
      if (killed > 0) {
        setTimeout(() => {
          for (const cid of stuckChatIds) {
            // proc references are stale but child.pid is still valid for cleanup
            try { const proc = activeProcesses.get(cid); if (proc && proc.child) process.kill(-proc.child.pid, 'SIGKILL'); } catch { }
          }
        }, 3000);
      }
      const summary = killed > 0
        ? `✅ 已重置 ${killed} 个卡住的任务，可重新发送消息。`
        : '✅ 当前没有卡住的任务。';
      await bot.sendMessage(chatId, summary);
      return { handled: true, config };
    }

    // /doctor — diagnostics; /fix — restore backup; /reset — reset Claude slot to opus
    if (text === '/fix') {
      if (restoreConfig()) {
        await bot.sendMessage(chatId, '✅ 已从备份恢复配置');
      } else {
        await bot.sendMessage(chatId, '❌ 无备份文件');
      }
      return { handled: true, config };
    }
    if (text === '/reset') {
      try {
        backupConfig();
        const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
        if (!cfg.daemon) cfg.daemon = {};
        if (!cfg.daemon.models) cfg.daemon.models = {};
        cfg.daemon.models.claude = 'opus';
        writeConfigSafe(cfg);
        config = loadConfig();
        await bot.sendMessage(chatId, '✅ 模型已重置为 opus');
      } catch (e) {
        await bot.sendMessage(chatId, `❌ ${e.message}`);
      }
      return { handled: true, config };
    }
    if (text === '/doctor') {
      const validModels = ['sonnet', 'opus', 'haiku'];
      const checks = [];
      let issues = 0;
      const activeProvider = providerMod && typeof providerMod.getActiveName === 'function'
        ? providerMod.getActiveName()
        : 'anthropic';
      const isCustomProvider = activeProvider !== 'anthropic';

      let cfg = null;
      try {
        cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
        checks.push('✅ 配置可解析');
      } catch {
        checks.push('❌ 配置解析失败');
        issues++;
      }

      const daemonCfg = (cfg && cfg.daemon) || {};
      const m = resolveEngineModel('claude', daemonCfg);
      const modelOk = isCustomProvider
        ? ['sonnet', 'opus', 'haiku'].includes(m)
        : validModels.includes(m);
      if (modelOk) {
        checks.push(`✅ 模型: ${m}`);
      } else {
        checks.push(`❌ 模型: ${m} (${isCustomProvider ? '格式无效' : '无效'})`);
        issues++;
      }

      const hasClaude = hasCli(execSync, 'claude');
      const hasCodex = hasCli(execSync, 'codex');
      checks.push(hasClaude ? '✅ Claude CLI' : '⚠️ Claude CLI 未找到');
      checks.push(hasCodex ? '✅ Codex CLI' : '⚠️ Codex CLI 未找到');

      const currentEngine = getDefaultEngine() === 'codex' ? 'codex' : 'claude';
      if (currentEngine === 'claude' && !hasClaude) {
        checks.push('❌ 当前默认引擎是 claude，但 Claude CLI 不可用');
        issues++;
      }
      if (currentEngine === 'codex' && !hasCodex) {
        checks.push('❌ 当前默认引擎是 codex，但 Codex CLI 不可用');
        issues++;
      }

      checks.push(`✅ 默认引擎: ${currentEngine}`);
      checks.push(`✅ Provider: ${activeProvider}${isCustomProvider ? ' (custom)' : ''}`);

      const bakFile = CONFIG_FILE + '.bak';
      const hasBak = fs.existsSync(bakFile);
      checks.push(hasBak ? '✅ 有备份' : '⚠️ 无备份');

      // Check for stuck tasks (only flag tasks running > 10 minutes as suspicious)
      const activeProcesses = getActiveProcesses ? getActiveProcesses() : null;
      let hasStuck = false;
      if (activeProcesses && activeProcesses.size > 0) {
        const now = Date.now();
        const stuckThreshold = 10 * 60 * 1000; // 10 minutes
        const entries = [...activeProcesses.entries()];
        const stuckEntries = entries.filter(([, proc]) => proc && proc.startedAt && (now - proc.startedAt) > stuckThreshold);
        if (stuckEntries.length > 0) {
          const stuckList = stuckEntries.map(([cid, proc]) => `${cid.slice(-8)}(${Math.round((now - proc.startedAt) / 60000)}min)`).join(', ');
          checks.push(`⚠️ ${stuckEntries.length} 个任务疑似卡住 (${stuckList})`);
          hasStuck = true;
          issues++;
        } else {
          checks.push(`✅ ${entries.length} 个任务正常运行中`);
        }
      } else {
        checks.push('✅ 无运行中任务');
      }

      let msg = `🏥 诊断\n${checks.join('\n')}`;
      if (issues > 0) {
        if (bot.sendButtons) {
          const buttons = [];
          if (hasStuck) buttons.push([{ text: '🔧 一键重置卡住任务', callback_data: '/recover' }]);
          if (hasBak) buttons.push([{ text: '📦 恢复配置备份', callback_data: '/fix' }]);
          buttons.push([{ text: '🔄 重置模型 opus', callback_data: '/reset' }]);
          await bot.sendButtons(chatId, msg, buttons);
        } else {
          msg += '\n/recover 重置卡住任务 /fix 恢复备份 /reset 重置opus';
          await bot.sendMessage(chatId, msg);
        }
      } else {
        await bot.sendMessage(chatId, msg + '\n\n全部正常 ✅');
      }
      return { handled: true, config };
    }

    // /model [name] — switch session model, engine-aware
    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.slice(6).trim();
      const currentEngine = getDefaultEngine();
      const engineCfg = ENGINE_MODEL_CONFIG[currentEngine] || ENGINE_MODEL_CONFIG.claude;
      // options is [{value, label}, ...] — normalize to a flat list for logic
      const optionEntries = (engineCfg.options || []).map(o =>
        typeof o === 'string' ? { value: o, label: o } : o
      );
      const optionValues = optionEntries.map(o => o.value);
      const daemonCfg = config.daemon || {};
      const currentModel = resolveEngineModel(currentEngine, daemonCfg);
      // providerMod manages Claude providers only — for codex use engineCfg.provider
      const activeProvider = (currentEngine === 'claude' && providerMod)
        ? providerMod.getActiveName()
        : engineCfg.provider;
      const isBuiltinProvider = activeProvider === engineCfg.provider;
      const distillModel = getDistillModel();
      const hintLine = engineCfg.hint
        ? `\n💡 ${engineCfg.hint}`
        : (!isBuiltinProvider && currentEngine === 'claude'
            ? `\n💡 ${activeProvider} 的后端真实模型请在 CC Switch / provider 层配置`
            : '');

      if (!arg) {
        const statusLine = `🤖 [${currentEngine}] 会话模型: ${currentModel}  Provider: ${activeProvider}\n🧪 后台轻量: ${distillModel}  (/distill-model 修改)${hintLine}`;
        if (bot.sendButtons && optionEntries.length > 0) {
          const buttons = optionEntries.map(({ value, label }) => [{
            text: value === currentModel ? `${label} ✓` : label,
            callback_data: `/model ${value}`,
          }]);
          await bot.sendButtons(chatId, statusLine, buttons);
        } else {
          const optionHint = optionValues.length > 0 ? `\n\n可选: ${optionValues.join(', ')}` : '';
          await bot.sendMessage(chatId, `${statusLine}${optionHint}`);
        }
        return { handled: true, config };
      }

      const normalizedArg = arg.toLowerCase();
      // Claude session/config layer only accepts canonical slots; provider mapping stays in CC Switch.
      if (currentEngine === 'claude' && !optionValues.includes(normalizedArg)) {
        const suggested = normalizeClaudeModel(arg, '');
        const hint = suggested
          ? `\n💡 检测到它更像 Claude 槽位 ${suggested}，请直接用 /model ${suggested}`
          : '';
        await bot.sendMessage(chatId, `❌ Claude 会话模型只接受: ${optionValues.join(', ')}\n后端真实模型请在 CC Switch / provider 层配置，不要写进会话模型${hint}`);
        return { handled: true, config };
      }

      const modelName = optionValues.includes(normalizedArg) ? normalizedArg : arg;
      if (modelName === currentModel) {
        await bot.sendMessage(chatId, `🤖 已经是 ${modelName}（后台轻量模型: ${distillModel}）`);
        return { handled: true, config };
      }

      try {
        backupConfig();
        const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
        if (!cfg.daemon) cfg.daemon = {};
        if (!cfg.daemon.models) cfg.daemon.models = {};
        cfg.daemon.models[currentEngine] = modelName;
        writeConfigSafe(cfg);
        config = loadConfig();
        await bot.sendMessage(chatId, `✅ [${currentEngine}] 会话模型: ${currentModel} → ${modelName}\n🧪 后台轻量模型: ${distillModel}（如需修改用 /distill-model）`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 切换失败: ${e.message}`);
      }
      return { handled: true, config };
    }

    // /provider [name] — list or switch provider
    if (text === '/provider' || text.startsWith('/provider ')) {
      if (!providerMod) {
        await bot.sendMessage(chatId, '❌ Provider module not available.');
        return { handled: true, config };
      }
      const arg = text.slice(9).trim();
      if (!arg) {
        const list = providerMod.listFormatted();
        await bot.sendMessage(chatId, `🔌 Providers:\n${list}\n\n用法: /provider <name>`);
        return { handled: true, config };
      }
      try {
        backupConfig();
        providerMod.setActive(arg);
        const p = providerMod.getActiveProvider();
        await bot.sendMessage(chatId, `✅ Provider: ${arg} (${p.label || arg})`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ ${e.message}`);
      }
      return { handled: true, config };
    }

    // /engine [name] — show or switch default engine (claude/codex)
    // Switching engine auto-syncs: distill model + preferred provider (if available)
    if (text === '/engine' || text.startsWith('/engine ')) {
      const arg = text.slice('/engine'.length).trim().toLowerCase();
      const boundProjectKey = resolveBoundProjectKey(chatId, config);
      const boundProject = boundProjectKey && config && config.projects ? config.projects[boundProjectKey] : null;
      if (!arg) {
        const cur = boundProject && boundProject.engine ? String(boundProject.engine).trim().toLowerCase() : getDefaultEngine();
        const safeCur = cur === 'codex' ? 'codex' : 'claude';
        const curEngineCfg = ENGINE_MODEL_CONFIG[safeCur] || ENGINE_MODEL_CONFIG.claude;
        const activeProvider = (safeCur === 'claude' && providerMod)
          ? providerMod.getActiveName()
          : curEngineCfg.provider;
        const distill = getDistillModel();
        const daemonCfg = config.daemon || {};
        const currentModel = resolveEngineModel(safeCur, daemonCfg, boundProject && boundProject.model);
        const scopeLine = boundProjectKey
          ? `📍 当前 chat 绑定 Agent: ${boundProjectKey}`
          : `📍 当前 chat 使用全局默认引擎`;
        await bot.sendMessage(chatId, [
          `🔧 引擎: ${safeCur}  |  Provider: ${activeProvider}`,
          `🤖 会话模型: ${currentModel}  |  后台轻量: ${distill}`,
          scopeLine,
          '',
          '用法: /engine claude 或 /engine codex',
          boundProjectKey
            ? '当前 chat 已绑定 Agent；切换时会同步更新该 Agent 的 engine/model'
            : '切换引擎将自动同步 distill model 和首选 provider',
        ].join('\n'));
        return { handled: true, config };
      }
      if (arg !== 'claude' && arg !== 'codex') {
        await bot.sendMessage(chatId, `❌ 不支持的引擎: ${arg}\n可选: claude, codex`);
        return { handled: true, config };
      }

      const preferredProvider = (ENGINE_MODEL_CONFIG[arg] || {}).provider;

      setDefaultEngine(arg); // syncs distill model + providerMod.setEngine (no longer resets session model)
      const distill = getDistillModel();
      let freshCfg = loadConfig();
      if (boundProjectKey && freshCfg && freshCfg.projects && freshCfg.projects[boundProjectKey]) {
        const nextCfg = JSON.parse(JSON.stringify(freshCfg));
        nextCfg.projects[boundProjectKey].engine = arg;
        nextCfg.projects[boundProjectKey].model = resolveEngineModel(arg, nextCfg.daemon || {});
        writeConfigSafe(nextCfg);
        freshCfg = loadConfig();
      }
      const freshDaemon = freshCfg.daemon || {};
      const syncedModel = resolveEngineModel(
        arg,
        freshDaemon,
        boundProjectKey && freshCfg.projects && freshCfg.projects[boundProjectKey]
          ? freshCfg.projects[boundProjectKey].model
          : ''
      );

      // Auto-switch provider only for Claude-compatible routing.
      // Codex auth is handled by `codex login` / `OPENAI_API_KEY`, not providers.yaml.
      let providerNote = '';
      if (arg === 'codex') {
        providerNote = '\n🔌 Codex 认证: 使用 `codex login` 或 OPENAI_API_KEY（/provider 不参与 Codex 路由）';
      } else if (providerMod && preferredProvider) {
        try {
          providerMod.setActive(preferredProvider);
          providerNote = `\n🔌 Provider 已同步: ${preferredProvider}`;
        } catch {
          // Provider not configured — just inform
          const cur = providerMod ? providerMod.getActiveName() : '';
          providerNote = `\n🔌 Provider: ${cur}（如需切换请 /provider ${preferredProvider}）`;
        }
      }

      const scopeNote = boundProjectKey
        ? `\n📍 已同步当前 Agent: ${boundProjectKey}`
        : '';
      await bot.sendMessage(chatId, `✅ 引擎已切换: ${arg}\n🤖 会话模型: ${syncedModel}\n🧪 后台轻量模型: ${distill}${scopeNote}${providerNote}`);
      return { handled: true, config: freshCfg };
    }

    // /distill-model [name] — show or update distill model
    if (text === '/distill-model' || text.startsWith('/distill-model ')) {
      if (!providerMod || typeof providerMod.getDistillModel !== 'function' || typeof providerMod.setDistillModel !== 'function') {
        await bot.sendMessage(chatId, '❌ Distill model config is not available.');
        return { handled: true, config };
      }
      const arg = text.slice('/distill-model'.length).trim();
      if (!arg) {
        await bot.sendMessage(chatId, `🧪 当前蒸馏模型: ${providerMod.getDistillModel()}\n用法: /distill-model <model>\n示例: /distill-model gpt-5.1-codex-mini`);
        return { handled: true, config };
      }
      try {
        providerMod.setDistillModel(arg);
        await bot.sendMessage(chatId, `✅ 蒸馏模型已更新为: ${providerMod.getDistillModel()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 设置失败: ${e.message}`);
      }
      return { handled: true, config };
    }

    const nlDistillIntent = parseDistillModelIntent(text);
    if (nlDistillIntent) {
      if (!providerMod || typeof providerMod.setDistillModel !== 'function' || typeof providerMod.getDistillModel !== 'function') {
        await bot.sendMessage(chatId, '❌ Distill model config is not available.');
        return { handled: true, config };
      }
      try {
        providerMod.setDistillModel(nlDistillIntent.model);
        await bot.sendMessage(chatId, `✅ 已按自然语言请求更新蒸馏模型: ${providerMod.getDistillModel()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 设置失败: ${e.message}`);
      }
      return { handled: true, config };
    }

    return { handled: false, config };
  }

  return { handleAdminCommand, _private: { parseDistillModelIntent } };
}

module.exports = { createAdminCommandHandler };
