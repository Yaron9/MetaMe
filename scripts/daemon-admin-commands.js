'use strict';

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
  } = deps;

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
          if (doc.context && doc.context.focus) msg += `\nFocus: ${doc.context.focus}`;
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
        const pending = skillEvolution.listQueueItems({ status: 'pending', limit: 10 });
        const notified = skillEvolution.listQueueItems({ status: 'notified', limit: 10 });
        const resolved = skillEvolution.listQueueItems({ limit: 50 }).filter(i => i.status === 'installed' || i.status === 'dismissed').slice(0, 5);

        const lines = ['🧬 Skill Evolution Queue'];
        lines.push(`pending: ${pending.length} | notified: ${notified.length} | resolved(last): ${resolved.length}`);
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
          msg += `${t.enabled !== false ? '✅' : '⏸'} ${t.name} (${t.interval}) ${ts.status || 'never_run'}\n`;
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
          msg += `${t.enabled !== false ? '✅' : '⏸'} ${t.name} (${t.interval}) ${ts.status || 'never_run'}\n`;
        }
      }
      if (!msg) {
        await bot.sendMessage(chatId, 'No heartbeat tasks configured.');
        return { handled: true, config };
      }
      await bot.sendMessage(chatId, msg.trim());
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
        let targetKey = null;
        for (const [key, proj] of Object.entries(config.projects || {})) {
          if (key === targetName || (proj.nicknames || []).some(n => n === targetName)) {
            targetKey = key;
            break;
          }
        }
        if (!targetKey) {
          await bot.sendMessage(chatId, `未找到 agent: ${targetName}\n可用: ${Object.keys(config.projects || {}).join(', ')}`);
          return { handled: true, config };
        }

        // Determine sender from current chat's project mapping
        const chatAgentMap = (config.feishu && config.feishu.chat_agent_map) || {};
        const senderKey = chatAgentMap[chatId] || 'user';

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

      await bot.sendMessage(chatId, '用法:\n/dispatch status — 查看状态\n/dispatch log — 查看记录\n/dispatch to <agent> <任务内容>');
      return { handled: true, config };
    }

    if (text === '/budget') {
      const limit = (config.budget && config.budget.daily_limit) || 50000;
      const used = state.budget.tokens_used;
      await bot.sendMessage(chatId, `Budget: ${used}/${limit} tokens (${((used / limit) * 100).toFixed(1)}%)`);
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
