'use strict';

const {
  USAGE_CATEGORY_ORDER,
  CORE_USAGE_CATEGORIES,
  USAGE_CATEGORY_LABEL,
} = require('./usage-classifier');

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
  } = deps;

  function resolveProjectKey(targetName, projects) {
    if (!targetName || !projects) return null;
    for (const [key, proj] of Object.entries(projects || {})) {
      const nicknames = Array.isArray(proj.nicknames)
        ? proj.nicknames
        : (proj.nicknames ? [proj.nicknames] : []);
      if (key === targetName || nicknames.some(n => n === targetName)) return key;
    }
    return null;
  }

  function resolveSenderKey(chatId, config) {
    const map = {
      ...(config && config.feishu ? config.feishu.chat_agent_map : {}),
      ...(config && config.telegram ? config.telegram.chat_agent_map : {}),
    };
    return map[String(chatId)] || 'user';
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

  async function handleAdminCommand(ctx) {
    const { bot, chatId, text } = ctx;
    const state = ctx.state || {};
    let config = ctx.config || {};

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

      const dismissMatch = arg.match(/^(?:dismiss|skip|ignored?)\s+(\S+)$/i);
      if (dismissMatch) {
        const id = dismissMatch[1];
        const ok = skillEvolution.resolveQueueItemById
          ? skillEvolution.resolveQueueItemById(id, 'dismissed')
          : false;
        await bot.sendMessage(chatId, ok ? `✅ 已标记 dismissed: ${id}` : `❌ 未找到可处理项: ${id}`);
        return { handled: true, config };
      }

      await bot.sendMessage(chatId, '用法: /skill-evo list | /skill-evo done <id> | /skill-evo dismiss <id>');
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
        }, config);
        if (result.success) {
          await bot.sendMessage(chatId, [
            `✅ 已创建 TeamTask 并派发: ${envelope.task_id}`,
            `Scope: ${envelope.scope_id || envelope.task_id}`,
            `查看: /TeamTask ${envelope.task_id}`,
          ].join('\n'));
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
        const envelope = taskEnvelope && taskEnvelope.normalizeTaskEnvelope
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
        }, config);

        if (result.success) {
          taskBoard.appendTaskEvent(task.task_id, 'task_resume_requested', String(chatId), { by: String(chatId) });
          await bot.sendMessage(chatId, `✅ 已续跑 TeamTask: ${task.task_id}`);
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

      // /dispatch to <agent> <prompt>
      const toMatch = args.match(/^to\s+(\S+)\s+(.+)$/s);
      if (toMatch) {
        const targetName = toMatch[1];
        const prompt = toMatch[2].trim();

        // Resolve target by project key or nickname
        const targetKey = resolveProjectKey(targetName, config.projects || {});
        if (!targetKey) {
          await bot.sendMessage(chatId, `未找到 agent: ${targetName}\n可用: ${Object.keys(config.projects || {}).join(', ')}`);
          return { handled: true, config };
        }

        // Determine sender from current chat's project mapping
        const senderKey = resolveSenderKey(chatId, config);

        const projInfo = config.projects[targetKey] || {};
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
        }, config, replyFn, dispatchStreamOptions);

        if (result.success) {
          await bot.sendMessage(chatId, `✅ 已派发给 ${projInfo.name || targetName}，执行中…`);
        } else {
          await bot.sendMessage(chatId, `❌ 派发失败: ${result.error}`);
        }
        return { handled: true, config };
      }

      await bot.sendMessage(chatId, [
        '用法:',
        '/dispatch status — 查看状态',
        '/dispatch log — 查看记录',
        '/dispatch to <agent> <任务内容> — 直接跨 agent 派发',
        '/TeamTask create <agent> <目标> [--scope <id>] [--parent <id>] — 创建/续接 TeamTask',
        '/TeamTask — 查看 TeamTask 列表',
      ].join('\n'));
      return { handled: true, config };
    }

    if (text === '/budget') {
      const limit = (config.budget && config.budget.daily_limit) || 50000;
      const used = state.budget.tokens_used;
      await bot.sendMessage(chatId, `Budget: ${used}/${limit} tokens (${((used / limit) * 100).toFixed(1)}%)`);
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

    // /doctor — diagnostics; /fix — restore backup; /reset — reset model to sonnet
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
        cfg.daemon.model = 'opus';
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

      let cfg = null;
      try {
        cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
        checks.push('✅ 配置可解析');
      } catch {
        checks.push('❌ 配置解析失败');
        issues++;
      }

      const m = (cfg && cfg.daemon && cfg.daemon.model) || 'opus';
      if (validModels.includes(m)) {
        checks.push(`✅ 模型: ${m}`);
      } else {
        checks.push(`❌ 模型: ${m} (无效)`);
        issues++;
      }

      try {
        execSync('which claude', { encoding: 'utf8' });
        checks.push('✅ Claude CLI');
      } catch {
        checks.push('❌ Claude CLI 未找到');
        issues++;
      }

      const bakFile = CONFIG_FILE + '.bak';
      const hasBak = fs.existsSync(bakFile);
      checks.push(hasBak ? '✅ 有备份' : '⚠️ 无备份');

      let msg = `🏥 诊断\n${checks.join('\n')}`;
      if (issues > 0) {
        if (bot.sendButtons) {
          const buttons = [];
          if (hasBak) buttons.push([{ text: '🔧 恢复备份', callback_data: '/fix' }]);
          buttons.push([{ text: '🔄 重置opus', callback_data: '/reset' }]);
          await bot.sendButtons(chatId, msg, buttons);
        } else {
          msg += '\n/fix 恢复备份 /reset 重置opus';
          await bot.sendMessage(chatId, msg);
        }
      } else {
        await bot.sendMessage(chatId, msg + '\n\n全部正常 ✅');
      }
      return { handled: true, config };
    }

    // /model [name] — switch model (interactive, accepts any name for custom providers)
    if (text === '/model' || text.startsWith('/model ')) {
      const arg = text.slice(6).trim();
      const builtinModels = ['sonnet', 'opus', 'haiku'];
      const currentModel = (config.daemon && config.daemon.model) || 'opus';
      const activeProvider = providerMod ? providerMod.getActiveName() : 'anthropic';
      const isCustomProvider = activeProvider !== 'anthropic';

      if (!arg) {
        const hint = isCustomProvider ? `\n💡 ${activeProvider} 可输入任意模型名` : '';
        if (bot.sendButtons) {
          const buttons = builtinModels.map(m => [{
            text: m === currentModel ? `${m} ✓` : m,
            callback_data: `/model ${m}`,
          }]);
          await bot.sendButtons(chatId, `🤖 当前模型: ${currentModel}${hint}`, buttons);
        } else {
          await bot.sendMessage(chatId, `🤖 当前模型: ${currentModel}\n可选: ${builtinModels.join(', ')}${hint}`);
        }
        return { handled: true, config };
      }

      const normalizedArg = arg.toLowerCase();
      // Builtin providers only accept builtin model names
      if (!isCustomProvider && !builtinModels.includes(normalizedArg)) {
        await bot.sendMessage(chatId, `❌ 无效模型: ${arg}\n可选: ${builtinModels.join(', ')}\n💡 切换到自定义 provider 后可用任意模型名`);
        return { handled: true, config };
      }

      const modelName = builtinModels.includes(normalizedArg) ? normalizedArg : arg;
      if (modelName === currentModel) {
        await bot.sendMessage(chatId, `🤖 已经是 ${modelName}`);
        return { handled: true, config };
      }

      try {
        backupConfig();
        const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
        if (!cfg.daemon) cfg.daemon = {};
        cfg.daemon.model = modelName;
        writeConfigSafe(cfg);
        config = loadConfig();
        await bot.sendMessage(chatId, `✅ 模型已切换: ${currentModel} → ${modelName}`);
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

    return { handled: false, config };
  }

  return { handleAdminCommand };
}

module.exports = { createAdminCommandHandler };
