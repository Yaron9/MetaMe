'use strict';

function createSessionCommandHandler(deps) {
  const {
    fs,
    path,
    HOME,
    log,
    loadConfig,
    loadState,
    saveState,
    normalizeCwd,
    expandPath,
    sendBrowse,
    sendDirPicker,
    createSession,
    getCachedFile,
    getSession,
    listRecentSessions,
    getSessionFileMtime,
    formatRelativeTime,
    sendDirListing,
    writeSessionName,
    getSessionName,
    loadSessionTags,
    sessionRichLabel,
    buildSessionCardElements,
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

  function getBoundCwd(chatId) {
    try {
      return getSessionRoute(chatId).cwd;
    } catch { return null; }
  }

  // Write per-engine session slot, preserving cwd and other engine slots.
  function attachEngineSession(state, chatId, engine, sessionId, cwd) {
    const effectiveId = getSessionRoute(chatId).sessionChatId;
    const existing = state.sessions[effectiveId] || {};
    const existingEngines = existing.engines || {};
    state.sessions[effectiveId] = {
      ...existing,
      cwd: cwd || existing.cwd || HOME,
      engines: { ...existingEngines, [engine]: { id: sessionId, started: true } },
    };
  }

  function inferEngineByCwd(cfg, cwd) {
    if (!cfg || !cfg.projects || !cwd) return null;
    const target = normalizeCwd(cwd);
    for (const proj of Object.values(cfg.projects || {})) {
      if (!proj || !proj.cwd) continue;
      if (normalizeCwd(proj.cwd) === target) return normalizeEngineName(proj.engine);
    }
    return null;
  }

  async function autoCreateSessionWhenEmpty(bot, chatId, cwd, engine) {
    const resolvedCwd = cwd ? normalizeCwd(cwd) : null;
    if (!resolvedCwd || !fs.existsSync(resolvedCwd)) {
      await bot.sendMessage(chatId, `No sessions found${resolvedCwd ? ' in ' + path.basename(resolvedCwd) : ''}. Try /new first.`);
      return true;
    }
    const route = getSessionRoute(chatId);
    const session = createSession(route.sessionChatId, resolvedCwd, '', engine || getDefaultEngine());
    await bot.sendMessage(chatId, `📁 ${path.basename(resolvedCwd)}\n✅ 已自动创建新会话\nWorkdir: ${session.cwd}`);
    return true;
  }

  async function handleSessionCommand(ctx) {
    const { bot, chatId, text } = ctx;

    // --- Browse handler (directory navigation) ---
    if (text.startsWith('/browse ')) {
      const parts = text.slice(8).trim().split(' ');
      const mode = parts[0]; // 'new', 'cd', or 'bind'
      // Last token may be a page number
      const lastPart = parts[parts.length - 1];
      const page = /^\d+$/.test(lastPart) ? parseInt(lastPart, 10) : 0;
      const pathParts = /^\d+$/.test(lastPart) ? parts.slice(1, -1) : parts.slice(1);
      const dirPath = expandPath(pathParts.join(' '));
      if (mode && dirPath && fs.existsSync(dirPath)) {
        await sendBrowse(bot, chatId, mode, dirPath, null, page);
      } else if (/^p\d+$/.test(dirPath)) {
        await bot.sendMessage(chatId, '⚠️ Button expired. Pick again:');
        await sendDirPicker(bot, chatId, mode || 'cd', 'Switch workdir:');
      } else {
        await bot.sendMessage(chatId, 'Invalid browse path.');
      }
      return true;
    }

    if (text === '/new' || text.startsWith('/new ')) {
      const arg = text.slice(4).trim();
      if (!arg) {
        // In a dedicated agent group, use the agent's bound cwd directly
        const route = getSessionRoute(chatId);
        if (route.cwd) {
          const session = createSession(route.sessionChatId, route.cwd, '', route.engine);
          await bot.sendMessage(chatId, `✅ 新会话已创建\nWorkdir: ${session.cwd}`);
          return true;
        }
        // Non-dedicated group: show directory picker
        await sendDirPicker(bot, chatId, 'new', 'Pick a workdir:');
        return true;
      }
      // Parse: /new <path> [name] — if arg contains a space after a valid path, rest is name
      let dirPath = expandPath(arg);
      let sessionName = '';
      // Try full arg as path first; if not, split on spaces to find path + name
      if (!fs.existsSync(dirPath)) {
        const spaceIdx = arg.indexOf(' ');
        if (spaceIdx > 0) {
          const maybePath = arg.slice(0, spaceIdx);
          if (fs.existsSync(maybePath)) {
            dirPath = maybePath;
            sessionName = arg.slice(spaceIdx + 1).trim();
          }
        }
        if (!fs.existsSync(dirPath)) {
          await bot.sendMessage(chatId, `Path not found: ${dirPath}`);
          return true;
        }
      }
      const cfgForEngine = loadConfig();
      const mapForEngine = { ...(cfgForEngine.telegram ? cfgForEngine.telegram.chat_agent_map : {}), ...(cfgForEngine.feishu ? cfgForEngine.feishu.chat_agent_map : {}) };
      const mappedKeyForEngine = mapForEngine[String(chatId)];
      const mappedProjForEngine = mappedKeyForEngine && cfgForEngine.projects ? cfgForEngine.projects[mappedKeyForEngine] : null;
      const currentEngine = getDefaultEngine();
      const sessionEngine = normalizeEngineName((mappedProjForEngine && mappedProjForEngine.engine) || currentEngine);
      const session = createSession(chatId, dirPath, sessionName || '', sessionEngine);
      const label = sessionName ? `[${sessionName}]` : '';
      await bot.sendMessage(chatId, `New session ${label}\nWorkdir: ${session.cwd}`);
      return true;
    }

    // /file <shortId> — send cached file (from button callback)
    if (text.startsWith('/file ')) {
      const shortId = text.slice(6).trim();
      const filePath = getCachedFile(shortId);
      if (!filePath) {
        await bot.sendMessage(chatId, '⏰ 文件链接已过期，请重新生成');
        return true;
      }
      if (!fs.existsSync(filePath)) {
        await bot.sendMessage(chatId, '❌ 文件不存在');
        return true;
      }
      if (bot.sendFile) {
        try {
          // Insert zero-width space before extension to prevent link parsing
          const basename = path.basename(filePath);
          const dotIdx = basename.lastIndexOf('.');
          const safeBasename = dotIdx > 0 ? basename.slice(0, dotIdx) + '\u200B' + basename.slice(dotIdx) : basename;
          await bot.sendMessage(chatId, `⏳ 正在发送「${safeBasename}」...`);
          await bot.sendFile(chatId, filePath);
        } catch (e) {
          log('ERROR', `File send failed: ${e.message}`);
          await bot.sendMessage(chatId, `❌ 发送失败: ${e.message.slice(0, 100)}`);
        }
      } else {
        await bot.sendMessage(chatId, '❌ 当前平台不支持文件发送');
      }
      return true;
    }

    // /last — smart resume: prefer current cwd, then most recent globally
    if (text === '/last') {
      const currentEngine = getCurrentEngine(chatId);
      const route = getSessionRoute(chatId);
      const curSession = getSession(route.sessionChatId) || getSession(chatId);
      const curCwd = curSession ? curSession.cwd : null;

      // Strategy: try current cwd first, then fall back to global
      let s = null;
      if (curCwd) {
        const cwdSessions = listRecentSessions(1, curCwd, currentEngine);
        if (cwdSessions.length > 0) s = cwdSessions[0];
      }
      if (!s) {
        const globalSessions = listRecentSessions(1, null, currentEngine);
        if (globalSessions.length > 0) s = globalSessions[0];
      }

      if (!s) {
        // Last resort: use __continue__ to resume whatever Claude thinks is last
        const state2 = loadState();
        const cfgForEngine = loadConfig();
        const engineByCwd = inferEngineByCwd(cfgForEngine, curCwd || HOME) || currentEngine;
        attachEngineSession(state2, chatId, engineByCwd, '__continue__', curCwd || HOME);
        saveState(state2);
        await bot.sendMessage(chatId, `⚡ Resuming last session in ${path.basename(curCwd || HOME)}`);
        return true;
      }

      const state2 = loadState();
      const cfgForEngine = loadConfig();
      const engineByCwd = normalizeEngineName(s.engine) || inferEngineByCwd(cfgForEngine, s.projectPath || HOME) || getDefaultEngine();
      attachEngineSession(state2, chatId, engineByCwd, s.sessionId, s.projectPath || HOME);
      saveState(state2);
      // Display: name/summary + id on separate lines
      const name = s.customTitle;
      const shortId = s.sessionId.slice(0, 8);
      const title = name ? `[${name}]` : (s.summary || s.firstPrompt || '').slice(0, 40) || 'Session';
      // Get real file mtime for accuracy
      const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
      const ago = formatRelativeTime(new Date(realMtime || s.fileMtime || new Date(s.modified).getTime()).toISOString());
      await bot.sendMessage(chatId, `⚡ ${title}\n📁 ${path.basename(s.projectPath || '')} #${shortId}\n🕐 ${ago}`);
      return true;
    }

    // /memory [keyword] — show memory stats or search facts
    if (text === '/memory' || text.startsWith('/memory ')) {
      const query = text.startsWith('/memory ') ? text.slice(8).trim() : '';
      let memMod;
      try { memMod = require('./memory'); } catch { await bot.sendMessage(chatId, '❌ Memory module not available'); return true; }

      if (!query) {
        // Stats view
        try {
          const s = memMod.stats();
          const factCount = s.facts ?? '?';
          const tagFile = path.join(HOME, '.metame', 'session_tags.json');
          let tagCount = 0;
          try { tagCount = Object.keys(JSON.parse(fs.readFileSync(tagFile, 'utf8'))).length; } catch { }
          const lines = [
            '🧠 *Memory Stats*',
            '━━━━━━━━━━━━━━━━',
            `📌 Facts: ${factCount}`,
            `🏷 Sessions tagged: ${tagCount}`,
            `🗃 Sessions in DB: ${s.count}`,
            `💾 DB size: ${s.dbSizeKB} KB`,
            s.newestDate ? `🕐 Last updated: ${new Date(s.newestDate).toLocaleDateString()}` : '',
            '',
            '搜索: /memory <关键词>',
          ].filter(l => l !== undefined && !(l === '' && false));
          await bot.sendMessage(chatId, lines.join('\n'));
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Memory stats error: ${e.message}`);
        }
      } else {
        // Search facts
        try {
          const results = await memMod.searchFactsAsync(query, { limit: 5 });
          if (!results || results.length === 0) {
            await bot.sendMessage(chatId, `🔍 No facts found for「${query}」`);
            return true;
          }
          let msg = `🔍 *Facts: "${query}"* (${results.length})\n━━━━━━━━━━━━━━━━\n`;
          for (const r of results) {
            const tag = r.confidence === 'high' ? '🟢' : '🟡';
            msg += `${tag} *${r.entity}*\n${r.value}\n\n`;
          }
          await bot.sendMessage(chatId, msg.trim());
        } catch (e) {
          await bot.sendMessage(chatId, `❌ Search error: ${e.message}`);
        }
      }
      return true;
    }

    // /sessions — compact list, tap to see details, then tap to switch
    if (text === '/sessions') {
      const allSessions = listRecentSessions(15, getBoundCwd(chatId), getCurrentEngine(chatId));
      if (allSessions.length === 0) {
        return autoCreateSessionWhenEmpty(
          bot,
          chatId,
          getBoundCwd(chatId) || (getSession(chatId) && getSession(chatId).cwd),
          getCurrentEngine(chatId)
        );
      }
      if (bot.sendButtons) {
        await bot.sendRawCard(chatId, '📋 Recent Sessions', buildSessionCardElements(allSessions));
      } else {
        const _tags1 = loadSessionTags();
        let msg = '📋 Recent sessions:\n\n';
        allSessions.forEach((s, i) => {
          msg += sessionRichLabel(s, i + 1, _tags1) + '\n';
        });
        await bot.sendMessage(chatId, msg);
      }
      return true;
    }

    // /sess <id> — show session detail card with switch button
    if (text.startsWith('/sess ')) {
      const sid = text.slice(6).trim();
      const allSessions = listRecentSessions(50, null, getCurrentEngine(chatId));
      const s = allSessions.find(x => x.sessionId === sid || x.sessionId.startsWith(sid));
      if (!s) {
        await bot.sendMessage(chatId, `Session not found: ${sid.slice(0, 8)}`);
        return true;
      }
      const proj = s.projectPath || '~';
      const projName = path.basename(proj);
      const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
      const timeMs = realMtime || s.fileMtime || new Date(s.modified).getTime();
      const ago = formatRelativeTime(new Date(timeMs).toISOString());
      const sessionTags = loadSessionTags();
      const tagEntry = sessionTags[s.sessionId] || {};
      const tagName = tagEntry.name || '';
      const tags = (tagEntry.tags || []).slice(0, 5);
      const title = s.customTitle || tagName || '';
      const summary = s.summary || '';
      const firstMsg = (s.firstPrompt || '').replace(/^<[^>]+>.*?<\/[^>]+>\s*/s, '');
      const msgs = s.messageCount || '?';

      let detail = '📋 Session Detail\n';
      detail += '━━━━━━━━━━━━━━━━━━━━\n';
      if (title) detail += `📝 Title: ${title}\n`;
      if (tags.length) detail += `🏷 Tags: ${tags.map(t => '#' + t).join(' ')}\n`;
      if (summary) detail += `💡 Summary: ${summary}\n`;
      detail += `📁 Project: ${projName}\n`;
      detail += `📂 Path: ${proj}\n`;
      detail += `💬 Messages: ${msgs}\n`;
      detail += `🕐 Last active: ${ago}\n`;
      detail += `🆔 ID: ${s.sessionId.slice(0, 8)}`;
      if (firstMsg && firstMsg !== summary) detail += `\n\n🗨️ First message:\n${firstMsg}`;

      if (bot.sendCard) {
        // Build rich detail as markdown body + buttons
        let body = '';
        if (title) body += `**📝 ${title}**\n`;
        if (tags.length) body += `${tags.map(t => `\`${t}\``).join(' ')}\n`;
        if (summary) body += `💡 ${summary}\n`;
        body += `📁 ${projName} · 📂 ${proj}\n`;
        body += `💬 ${msgs} messages · 🕐 ${ago}\n`;
        body += `🆔 ${s.sessionId.slice(0, 8)}`;
        if (firstMsg && firstMsg !== summary) body += `\n\n🗨️ ${firstMsg.slice(0, 100)}`;
        const elements = [
          { tag: 'div', text: { tag: 'lark_md', content: body } },
          { tag: 'hr' },
          {
            tag: 'action', actions: [
              { tag: 'button', text: { tag: 'plain_text', content: '▶️ Switch to this session' }, type: 'primary', value: { cmd: `/resume ${s.sessionId}` } },
              { tag: 'button', text: { tag: 'plain_text', content: '⬅️ Back to list' }, type: 'default', value: { cmd: '/sessions' } },
            ]
          },
        ];
        await bot.sendRawCard(chatId, '📋 Session Detail', elements);
      } else if (bot.sendButtons) {
        await bot.sendButtons(chatId, detail, [
          [{ text: '▶️ Switch to this session', callback_data: `/resume ${s.sessionId}` }],
          [{ text: '⬅️ Back to list', callback_data: '/sessions' }],
        ]);
      } else {
        await bot.sendMessage(chatId, detail + `\n\n/resume ${s.sessionId.slice(0, 8)}`);
      }
      return true;
    }

    // /continue — alias for /cd last (sync to computer's latest session)
    if (text === '/continue') {
      // Reuse /cd last logic below
      // fall through with newCwd = 'last'
    }

    if (text === '/continue' || text === '/cd' || text.startsWith('/cd ')) {
      let newCwd = text === '/continue' ? 'last' : expandPath(text.slice(3).trim());
      if (!newCwd) {
        await sendDirPicker(bot, chatId, 'cd', 'Switch workdir:');
        return true;
      }
      // /cd last — sync to computer: switch to most recent session AND its directory
      if (newCwd === 'last') {
        const route = getSessionRoute(chatId);
        const currentSession = getSession(route.sessionChatId) || getSession(chatId);
        const excludeId = currentSession?.id;
        const recent = listRecentSessions(10, null, getCurrentEngine(chatId));
        const filtered = excludeId ? recent.filter(s => s.sessionId !== excludeId) : recent;

        // For bound chats, prefer sessions from the same project to avoid
        // the bound-chat guard (handleCommand) immediately overwriting with a new session.
        const boundCwd = getBoundCwd(chatId);

        let candidates = filtered;
        if (boundCwd) {
          const boundFiltered = filtered.filter(s => s.projectPath && normalizeCwd(s.projectPath) === boundCwd);
          if (boundFiltered.length > 0) candidates = boundFiltered;
        }

        if (candidates.length > 0 && candidates[0].projectPath) {
          const target = candidates[0];
          // Switch to that session (like /resume) AND its directory
          const state2 = loadState();
          const cfgForEngine = loadConfig();
          const engineByCwd = inferEngineByCwd(cfgForEngine, target.projectPath) || getDefaultEngine();
          attachEngineSession(state2, chatId, engineByCwd, target.sessionId, target.projectPath);
          saveState(state2);
          const name = target.customTitle || target.summary || '';
          const label = name ? name.slice(0, 40) : target.sessionId.slice(0, 8);
          await bot.sendMessage(chatId, `🔄 Synced to: ${label}\n📁 ${path.basename(target.projectPath)}`);
          return true;
        }
        await bot.sendMessage(chatId, 'No recent session found.');
        return true;
      }
      if (!fs.existsSync(newCwd)) {
        // Likely an expired path shortcode (e.g. p16) from a daemon restart
        if (/^p\d+$/.test(newCwd)) {
          await bot.sendMessage(chatId, '⚠️ Button expired (daemon restarted). Pick again:');
          await sendDirPicker(bot, chatId, 'cd', 'Switch workdir:');
        } else {
          await bot.sendMessage(chatId, `Path not found: ${newCwd}`);
        }
        return true;
      }
      const state2 = loadState();
      // Try to find existing session in this directory
      const recentInDir = listRecentSessions(1, newCwd, getCurrentEngine(chatId));
      if (recentInDir.length > 0 && recentInDir[0].sessionId) {
        // Attach to existing session in this directory
        const target = recentInDir[0];
        const cfgForEngine = loadConfig();
        const engineByCwd = inferEngineByCwd(cfgForEngine, newCwd) || getDefaultEngine();
        attachEngineSession(state2, chatId, engineByCwd, target.sessionId, newCwd);
        saveState(state2);
        const label = target.customTitle || target.summary?.slice(0, 30) || target.sessionId.slice(0, 8);
        await bot.sendMessage(chatId, `📁 ${path.basename(newCwd)}\n🔄 Attached: ${label}`);
      } else if (!state2.sessions[getSessionRoute(chatId).sessionChatId]) {
        const cfgForEngine = loadConfig();
        const engineByCwd = inferEngineByCwd(cfgForEngine, newCwd);
        const currentEngine = getDefaultEngine();
        createSession(getSessionRoute(chatId).sessionChatId, newCwd, '', engineByCwd || currentEngine);
        await bot.sendMessage(chatId, `📁 ${path.basename(newCwd)} (new session)`);
      } else {
        state2.sessions[getSessionRoute(chatId).sessionChatId].cwd = newCwd;
        saveState(state2);
        await bot.sendMessage(chatId, `📁 ${path.basename(newCwd)}`);
      }
      await sendDirListing(bot, chatId, newCwd, null);
      return true;
    }

    // /list [subdir|glob|fullpath] — list files (zero token, daemon-only)
    if (text === '/list' || text.startsWith('/list ')) {
      const route = getSessionRoute(chatId);
      const session = getSession(route.sessionChatId) || getSession(chatId);
      const cwd = session?.cwd || HOME;
      const arg = text.slice(5).trim();
      // If arg is an absolute or ~ path, list that directly
      const expanded = arg ? expandPath(arg) : null;
      if (expanded && /^p\d+$/.test(expanded)) {
        // Expired shortcode from daemon restart
        await bot.sendMessage(chatId, '⚠️ Button expired. Refreshing...');
        await sendDirListing(bot, chatId, cwd, null);
      } else if (expanded && path.isAbsolute(expanded) && fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
        await sendDirListing(bot, chatId, expanded, null);
      } else {
        await sendDirListing(bot, chatId, cwd, arg || null);
      }
      return true;
    }

    if (text.startsWith('/name ')) {
      const name = text.slice(6).trim();
      if (!name) {
        await bot.sendMessage(chatId, 'Usage: /name <session name>');
        return true;
      }
      const route = getSessionRoute(chatId);
      const session = getSession(route.sessionChatId) || getSession(chatId);
      if (!session) {
        await bot.sendMessage(chatId, 'No active session. Start one first.');
        return true;
      }

      // Write to Claude's session file (unified with /rename on desktop)
      if (writeSessionName(session.id, session.cwd, name)) {
        await bot.sendMessage(chatId, `✅ Session: [${name}]`);
      } else {
        await bot.sendMessage(chatId, '⚠️ Failed to save name, but session continues.');
      }
      return true;
    }

    if (text === '/session') {
      const route = getSessionRoute(chatId);
      const session = getSession(route.sessionChatId) || getSession(chatId);
      if (!session) {
        await bot.sendMessage(chatId, 'No active session. Send any message to start one.');
      } else {
        const name = getSessionName(session.id);
        const nameTag = name ? ` [${name}]` : '';
        await bot.sendMessage(chatId, `Session: ${session.id.slice(0, 8)}...${nameTag}\nWorkdir: ${session.cwd}`);
      }
      return true;
    }

    return false;
  }

  return { handleSessionCommand };
}

module.exports = { createSessionCommandHandler };
