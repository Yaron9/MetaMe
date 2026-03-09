'use strict';

let userAcl = null;
try { userAcl = require('./daemon-user-acl'); } catch { /* optional */ }

function createBridgeStarter(deps) {
  const {
    fs,
    path,
    HOME,
    log,
    sleep,
    loadConfig,
    loadState,
    saveState,
    getSession,
    handleCommand,
    pendingActivations,  // optional — used to show smart activation hint
    activeProcesses,     // optional — used for auto-dispatch to clones
    messageQueue,        // optional — used for /stop to clear queued messages
  } = deps;

  async function sendAclReply(bot, chatId, text) {
    if (!text) return;
    try {
      if (bot.sendMarkdown) await bot.sendMarkdown(chatId, text);
      else await bot.sendMessage(chatId, text.replace(/[*_`]/g, ''));
    } catch { /* non-fatal */ }
  }

  function normalizeSenderId(senderId) {
    if (senderId === undefined || senderId === null) return null;
    const text = String(senderId).trim();
    return text || null;
  }

  async function applyUserAcl({ bot, chatId, text, config, senderId, bypassAcl }) {
    const trimmed = String(text || '').trim();
    const normalizedSenderId = normalizeSenderId(senderId);
    if (!trimmed || bypassAcl || !userAcl) {
      return { blocked: false, readOnly: false, senderId: normalizedSenderId };
    }

    let userCtx;
    try {
      userCtx = userAcl.resolveUserCtx(normalizedSenderId, config || {});
    } catch {
      return { blocked: false, readOnly: false, senderId: normalizedSenderId };
    }

    const userCmd = userAcl.handleUserCommand(trimmed, userCtx);
    if (userCmd && userCmd.handled) {
      await sendAclReply(bot, chatId, userCmd.reply);
      return { blocked: true, readOnly: !!userCtx.readOnly, senderId: normalizedSenderId };
    }

    const publicCmds = Array.isArray(userAcl.PUBLIC_COMMANDS) ? userAcl.PUBLIC_COMMANDS : [];
    const isPublic = publicCmds.includes(trimmed.toLowerCase());
    const action = userAcl.classifyCommandAction(trimmed);
    const allowed = isPublic || (typeof userCtx.can === 'function' && userCtx.can(action));
    if (!allowed) {
      await sendAclReply(bot, chatId, `⚠️ 当前权限不足（角色: ${userCtx.role}）\n命令类型: ${action}\n请联系管理员授权。`);
      return { blocked: true, readOnly: true, senderId: normalizedSenderId };
    }

    return { blocked: false, readOnly: !!userCtx.readOnly, senderId: normalizedSenderId };
  }

  // Returns the best pending activation for a given chatId (excludes self-created)
  function getPendingActivationForChat(chatId) {
    if (!pendingActivations || pendingActivations.size === 0) return null;
    const cid = String(chatId);
    let latest = null;
    for (const rec of pendingActivations.values()) {
      if (rec.createdByChatId === cid) continue;
      if (!latest || rec.createdAt > latest.createdAt) latest = rec;
    }
    return latest;
  }

  function unauthorizedMsg(chatId, useSend) {
    const pending = getPendingActivationForChat(chatId);
    if (pending) {
      return `⚠️ 此群未授权\n\n发送以下命令激活 Agent「${pending.agentName}」：\n\`/activate\``;
    }
    return '⚠️ 此群未授权\n\n如已创建 Agent，发送 `/activate` 完成绑定。\n否则请先在主群创建 Agent。';
  }

  // ── Team group helpers ─────────────────────────────────────────────────
  function _getBoundProject(chatId, cfg) {
    const map = {
      ...(cfg.telegram ? cfg.telegram.chat_agent_map || {} : {}),
      ...(cfg.feishu ? cfg.feishu.chat_agent_map || {} : {}),
    };
    const key = map[String(chatId)];
    const proj = key && cfg.projects ? cfg.projects[key] : null;
    return { key: key || null, project: proj || null };
  }

  function _escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function _findTeamMember(text, team) {
    const t = String(text || '').trim();
    for (const member of team) {
      const nicks = Array.isArray(member.nicknames) ? member.nicknames : [];
      for (const nick of nicks) {
        const n = String(nick || '').trim();
        if (!n) continue;
        if (t.toLowerCase() === n.toLowerCase()) return { member, rest: '' };
        const re = new RegExp(`^${_escapeRe(n)}[\\s,，、:：]+`, 'i');
        const m = t.match(re);
        if (m) return { member, rest: t.slice(m[0].length).trim() };
      }
    }
    return null;
  }

  // Creates a bot proxy that redirects all send methods to replyChatId
  function _createTeamProxyBot(bot, replyChatId) {
    const SEND = new Set(['sendMessage', 'sendMarkdown', 'sendCard', 'editMessage', 'deleteMessage', 'sendTyping', 'sendFile', 'sendButtonCard']);
    return new Proxy(bot, {
      get(target, prop) {
        const orig = target[prop];
        if (typeof orig !== 'function') return orig;
        if (!SEND.has(prop)) return orig.bind(target);
        return function(_chatId, ...args) { return orig.call(target, replyChatId, ...args); };
      },
    });
  }
  // Get team member's working directory. Prefers git worktree if parent is a git repo.
  // Falls back to regular directory if parent is not a git repo.
  const _worktreeLocks = new Map(); // per-key lock to prevent TOCTOU races
  function _getMemberCwd(parentCwd, key) {
    const { existsSync, mkdirSync } = require('fs');
    const { execFileSync } = require('child_process');
    const memberDir = path.join(parentCwd, 'team', key);
    // Check if parent is a git repo
    let isGitRepo = false;
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: parentCwd, stdio: 'ignore' });
      isGitRepo = true;
    } catch { isGitRepo = false; }
    // If not a git repo, use regular directory but initialize git for checkpoint
    if (!isGitRepo) {
      if (!existsSync(memberDir)) {
        mkdirSync(memberDir, { recursive: true });
      }
      // Initialize git repo if not exists (for checkpoint support)
      if (!existsSync(path.join(memberDir, '.git'))) {
        try {
          execFileSync('git', ['init'], { cwd: memberDir, stdio: 'ignore' });
          log('INFO', `Git repo initialized for team member: ${memberDir}`);
        } catch (e) {
          log('WARN', `Failed to init git for ${memberDir}: ${e.message}`);
        }
      }
      return memberDir;
    }
    // Git repo: use worktree
    const wtDir = path.join(parentCwd, '.worktree', key);
    if (existsSync(path.join(wtDir, '.git'))) return wtDir;
    // Concurrency guard
    if (_worktreeLocks.has(key)) return _worktreeLocks.get(key);
    _worktreeLocks.set(key, wtDir);
    mkdirSync(path.join(parentCwd, '.worktree'), { recursive: true });
    const branch = `team/${key}`;
    try {
      try { execFileSync('git', ['branch', branch, 'HEAD'], { cwd: parentCwd, stdio: 'ignore' }); } catch { /* branch exists */ }
      execFileSync('git', ['worktree', 'add', wtDir, branch], { cwd: parentCwd, stdio: 'ignore', timeout: 10000 });
      log('INFO', `Worktree created: ${wtDir} (branch: ${branch})`);
    } catch (e) {
      _worktreeLocks.delete(key);
      if (existsSync(path.join(wtDir, '.git'))) return wtDir;
      log('ERROR', `Worktree creation failed for ${key}: ${e.message} — falling back to regular dir`);
      if (!existsSync(memberDir)) mkdirSync(memberDir, { recursive: true });
      // Initialize git for checkpoint support
      if (!existsSync(path.join(memberDir, '.git'))) {
        try { execFileSync('git', ['init'], { cwd: memberDir, stdio: 'ignore' }); } catch {}
      }
      return memberDir;
    }
    return wtDir;
  }

  function _dispatchToTeamMember(member, boundProj, text, cfg, bot, realChatId, executeTaskByName, acl) {
    const virtualChatId = `_agent_${member.key}`;
    const parentCwd = member.cwd || boundProj.cwd;
    const resolvedParentCwd = parentCwd.replace(/^~/, require('os').homedir());
    const memberCwd = _getMemberCwd(resolvedParentCwd, member.key);
    if (!memberCwd) {
      log('ERROR', `Team [${member.key}] cannot start: worktree unavailable`);
      bot.sendMessage(realChatId, `❌ ${member.icon || '🤖'} ${member.name} 启动失败：工作目录创建失败`).catch(() => {});
      return;
    }
    const teamCfg = {
      ...cfg,
      projects: {
        ...(cfg.projects || {}),
        [member.key]: {
          cwd: memberCwd,
          name: member.name,
          icon: member.icon || '🤖',
          color: member.color || 'blue',
          engine: member.engine || boundProj.engine,
        },
      },
    };
    const proxyBot = _createTeamProxyBot(bot, realChatId);
    handleCommand(proxyBot, virtualChatId, text, teamCfg, executeTaskByName, acl.senderId, acl.readOnly)
      .catch(e => log('ERROR', `Team [${member.key}] error: ${e.message}`));
  }
  // ────────────────────────────────────────────────────────────────────────

  async function startTelegramBridge(config, executeTaskByName) {
    if (!config.telegram || !config.telegram.enabled) return null;
    if (!config.telegram.bot_token) {
      log('WARN', 'Telegram enabled but no bot_token configured');
      return null;
    }

    const { createBot } = require('./telegram-adapter.js');
    const bot = createBot(config.telegram.bot_token);

    try {
      const me = await bot.getMe();
      log('INFO', `Telegram bot connected: @${me.username}`);
    } catch (e) {
      log('ERROR', `Telegram bot auth failed: ${e.message}`);
      return null;
    }

    let offset = 0;
    let running = true;
    const abortController = new AbortController();

    const pollLoop = async () => {
      while (running) {
        try {
          const updates = await bot.getUpdates(offset, 30, abortController.signal);
          for (const update of updates) {
            offset = update.update_id + 1;

            if (update.callback_query) {
              const cb = update.callback_query;
              const chatId = cb.message && cb.message.chat.id;
              const senderId = cb.from && cb.from.id ? String(cb.from.id) : null;
              bot.answerCallback(cb.id).catch(() => { });
              if (chatId && cb.data) {
                const liveCfg = loadConfig();
                const allowedIds = (liveCfg.telegram && liveCfg.telegram.allowed_chat_ids) || [];
                if (!allowedIds.includes(chatId)) continue;
                const isBindCmd = cb.data.startsWith('/agent bind')
                  || cb.data.startsWith('/agent-bind-dir')
                  || cb.data.startsWith('/browse bind')
                  || cb.data === '/activate';
                const acl = await applyUserAcl({
                  bot,
                  chatId,
                  text: cb.data,
                  config: liveCfg,
                  senderId,
                  bypassAcl: !allowedIds.includes(chatId) && !!isBindCmd,
                });
                if (acl.blocked) continue;
                handleCommand(bot, chatId, cb.data, liveCfg, executeTaskByName, acl.senderId, acl.readOnly).catch(e => {
                  log('ERROR', `Telegram callback handler error: ${e.message}`);
                });
              }
              continue;
            }

            if (!update.message) continue;

            const msg = update.message;
            const chatId = msg.chat.id;
            const senderId = msg.from && msg.from.id ? String(msg.from.id) : null;

            const liveCfg = loadConfig();
            const allowedIds = (liveCfg.telegram && liveCfg.telegram.allowed_chat_ids) || [];
            const trimmedText = msg.text && msg.text.trim();
            const isBindCmd = trimmedText && (
              trimmedText.startsWith('/agent bind')
              || trimmedText.startsWith('/agent-bind-dir')
              || trimmedText.startsWith('/browse bind')
              || trimmedText === '/activate'
            );
            const isAllowedChat = allowedIds.includes(chatId);
            if (!isAllowedChat && !isBindCmd) {
              log('WARN', `Rejected message from unauthorized chat: ${chatId}`);
              bot.sendMessage(chatId, unauthorizedMsg(chatId)).catch(() => {});
              continue;
            }

            if ((msg.voice || msg.audio) && !msg.text) {
              await bot.sendMessage(chatId, '🎤 Use Telegram voice-to-text (long press → Transcribe), then send as text.');
              continue;
            }

            if (msg.document || msg.photo) {
              const fileId = msg.document ? msg.document.file_id : msg.photo[msg.photo.length - 1].file_id;
              const fileName = msg.document ? msg.document.file_name : `photo_${Date.now()}.jpg`;
              const caption = msg.caption || '';
              const acl = await applyUserAcl({
                bot,
                chatId,
                text: caption || '[file-upload]',
                config: liveCfg,
                senderId,
                bypassAcl: !isAllowedChat && !!isBindCmd,
              });
              if (acl.blocked) continue;

              const session = getSession(chatId);
              const cwd = session?.cwd || HOME;
              const uploadDir = path.join(cwd, 'upload');
              if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
              const destPath = path.join(uploadDir, fileName);

              try {
                await bot.downloadFile(fileId, destPath);
                await bot.sendMessage(chatId, `📥 Saved: ${fileName}`);

                const prompt = caption
                  ? `User uploaded a file to the project: ${destPath}\nUser says: "${caption}"`
                  : `User uploaded a file to the project: ${destPath}\nAcknowledge receipt. Only read the file if the user asks you to.`;

                handleCommand(bot, chatId, prompt, liveCfg, executeTaskByName, acl.senderId, acl.readOnly).catch(e => {
                  log('ERROR', `Telegram file handler error: ${e.message}`);
                });
              } catch (err) {
                log('ERROR', `File download failed: ${err.message}`);
                await bot.sendMessage(chatId, `❌ Download failed: ${err.message}`);
              }
              continue;
            }

            if (msg.text) {
              const text = msg.text.trim();
              const acl = await applyUserAcl({
                bot,
                chatId,
                text,
                config: liveCfg,
                senderId,
                bypassAcl: !isAllowedChat && !!isBindCmd,
              });
              if (acl.blocked) continue;

              // Team group routing for Telegram (same logic as Feishu)
              const trimmedText = text.trim();
              const { key: _boundKey, project: _boundProj } = _getBoundProject(chatId, liveCfg);
              const _isTeamSlashCmd = trimmedText.startsWith('/') && !/^\/stop(\s|$)/i.test(trimmedText);

              // Load sticky state
              const _st = loadState();
              const _chatKey = String(chatId);
              const _setSticky = (key) => {
                if (!_st.team_sticky) _st.team_sticky = {};
                _st.team_sticky[_chatKey] = key;
                saveState(_st);
              };
              const _clearSticky = () => {
                if (_st.team_sticky) delete _st.team_sticky[_chatKey];
                saveState(_st);
              };
              const _stickyKey = (_st.team_sticky || {})[_chatKey] || null;

              if (_boundProj && Array.isArray(_boundProj.team) && _boundProj.team.length > 0 && !_isTeamSlashCmd) {
                // Team dispatch logic (same as Feishu)
                const _stopMatch = trimmedText && trimmedText.match(/^\/stop(?:\s+(.+))?$/i);
                if (_stopMatch) {
                  const _stopArg = (_stopMatch[1] || '').trim();
                  if (_stopArg) {
                    const _sa = _stopArg.toLowerCase();
                    const m = _boundProj.team.find(t =>
                      (t.nicknames || []).some(n => n.toLowerCase() === _sa) || (t.name && t.name.toLowerCase() === _sa) || t.key === _sa
                    );
                    if (m) {
                      _clearSticky();
                      log('INFO', `Team /stop: ${_chatKey.slice(-8)} → cleared sticky`);
                      await bot.sendMessage(chatId, `⏹ 已切换回主 Agent`).catch(() => {});
                    } else {
                      await bot.sendMessage(chatId, `❌ 未找到团队成员: ${_stopArg}`).catch(() => {});
                    }
                    continue;
                  }
                  // Bare /stop, clear sticky
                  _clearSticky();
                  await bot.sendMessage(chatId, `⏹ 已切换回主 Agent`).catch(() => {});
                  continue;
                }

                // 1. Explicit nickname → route + set sticky
                const teamMatch = _findTeamMember(trimmedText, _boundProj.team);
                if (teamMatch) {
                  const { member, rest } = teamMatch;
                  _setSticky(member.key);
                  if (!rest) {
                    log('INFO', `Sticky set (pure nickname): ${_chatKey.slice(-8)} → ${member.key}`);
                    bot.sendMarkdown(chatId, `${member.icon || '🤖'} **${member.name}** 在线`).catch(() => {});
                    continue;
                  }
                  log('INFO', `Sticky set: ${_chatKey.slice(-8)} → ${member.key}`);
                  _dispatchToTeamMember(member, _boundProj, rest, liveCfg, bot, chatId, executeTaskByName, acl);
                  continue;
                }

                // 1.5. Main project nickname → clear sticky, route to main
                const _mainNicks = Array.isArray(_boundProj.nicknames) ? _boundProj.nicknames : [];
                const _trimLower = trimmedText.toLowerCase();
                const _mainMatch = _mainNicks.find(n => _trimLower === n.toLowerCase() || _trimLower.startsWith(n.toLowerCase() + ' ') || _trimLower.startsWith(n.toLowerCase() + '，') || _trimLower.startsWith(n.toLowerCase() + ','));
                if (_mainMatch) {
                  _clearSticky();
                  const rest = trimmedText.slice(_mainMatch.length).replace(/^[\s,，:：]+/, '');
                  log('INFO', `Main nickname → cleared sticky, routing to main${rest ? ` (task: ${rest.slice(0, 30)})` : ''}`);
                  if (!rest) {
                    bot.sendMarkdown(chatId, `${_boundProj.icon || '🤖'} **${_boundProj.name}** 在线`).catch(() => {});
                    continue;
                  }
                  try {
                    await handleCommand(bot, chatId, rest, liveCfg, executeTaskByName, acl.senderId, acl.readOnly);
                  } catch (e) {
                    log('ERROR', `Team main-route handleCommand failed: ${e.message}`);
                    bot.sendMessage(chatId, `❌ 执行失败: ${e.message}`).catch(() => {});
                  }
                  continue;
                }

                // 2. Sticky: no nickname given → route to last explicitly named member
                if (_stickyKey) {
                  const member = _boundProj.team.find(m => m.key === _stickyKey);
                  if (member) {
                    log('INFO', `Sticky route: → ${_stickyKey}`);
                    _dispatchToTeamMember(member, _boundProj, trimmedText, liveCfg, bot, chatId, executeTaskByName, acl);
                    continue;
                  }
                }
              }

              // Default: route to main project
              handleCommand(bot, chatId, text, liveCfg, executeTaskByName, acl.senderId, acl.readOnly).catch(e => {
                log('ERROR', `Telegram handler error: ${e.message}`);
              });
            }
          }
        } catch (e) {
          if (e.message === 'aborted') break;
          log('ERROR', `Telegram poll error: ${e.message}`);
          await sleep(5000);
        }
      }
    };

    const startPoll = () => {
      pollLoop().catch(e => {
        if (e.message === 'aborted') return;
        log('ERROR', `pollLoop crashed: ${e.message} — restarting in 5s`);
        if (running) setTimeout(startPoll, 5000);
      });
    };
    startPoll();

    return {
      stop() { running = false; abortController.abort(); },
      bot,
    };
  }

  async function startFeishuBridge(config, executeTaskByName) {
    if (!config.feishu || !config.feishu.enabled) return null;
    if (!config.feishu.app_id || !config.feishu.app_secret) {
      log('WARN', 'Feishu enabled but app_id/app_secret missing');
      return null;
    }

    const { createBot } = require('./feishu-adapter.js');
    const bot = createBot(config.feishu);

    try {
      const receiver = await bot.startReceiving(async (chatId, text, event, fileInfo, senderId) => {
        const liveCfg = loadConfig();

        const allowedIds = (liveCfg.feishu && liveCfg.feishu.allowed_chat_ids) || [];
        const trimmedText = text && text.trim();
        const isBindCmd = trimmedText && (
          trimmedText.startsWith('/agent bind')
          || trimmedText.startsWith('/agent-bind-dir')
          || trimmedText.startsWith('/browse bind')
          || trimmedText === '/activate'
        );
        const isAllowedChat = allowedIds.includes(chatId);
        if (!isAllowedChat && !isBindCmd) {
          log('WARN', `Feishu: rejected message from ${chatId}`);
          const msg = unauthorizedMsg(chatId);
          (bot.sendMarkdown ? bot.sendMarkdown(chatId, msg) : bot.sendMessage(chatId, msg)).catch(() => {});
          return;
        }

        if (fileInfo && fileInfo.fileKey) {
          const acl = await applyUserAcl({
            bot,
            chatId,
            text: text || '[file-upload]',
            config: liveCfg,
            senderId,
            bypassAcl: !isAllowedChat && !!isBindCmd,
          });
          if (acl.blocked) return;
          log('INFO', `Feishu file from ${chatId}: ${fileInfo.fileName} (key: ${fileInfo.fileKey}, msgId: ${fileInfo.messageId}, type: ${fileInfo.msgType})`);
          const session = getSession(chatId);
          const cwd = session?.cwd || HOME;
          const uploadDir = path.join(cwd, 'upload');
          if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
          const destPath = path.join(uploadDir, fileInfo.fileName);

          try {
            await bot.downloadFile(fileInfo.messageId, fileInfo.fileKey, destPath, fileInfo.msgType);
            await bot.sendMessage(chatId, `📥 Saved: ${fileInfo.fileName}`);

            const prompt = text
              ? `User uploaded a file to the project: ${destPath}\nUser says: "${text}"`
              : `User uploaded a file to the project: ${destPath}\nAcknowledge receipt. Only read the file if the user asks you to.`;

            await handleCommand(bot, chatId, prompt, liveCfg, executeTaskByName, acl.senderId, acl.readOnly);
          } catch (err) {
            log('ERROR', `Feishu file download failed: ${err.message}`);
            await bot.sendMessage(chatId, `❌ Download failed: ${err.message}`);
          }
          return;
        }

        if (text) {
          const acl = await applyUserAcl({
            bot,
            chatId,
            text,
            config: liveCfg,
            senderId,
            bypassAcl: !isAllowedChat && !!isBindCmd,
          });
          if (acl.blocked) return;
          log('INFO', `Feishu message from ${chatId}: ${text.slice(0, 50)}`);
          const parentId = event?.message?.parent_id;
          let _replyAgentKey = null;
          // Load state once for the entire routing block
          const _st = loadState();
          if (parentId) {
            const mapped = _st.msg_sessions && _st.msg_sessions[parentId];
            if (mapped) {
              if (!_st.sessions) _st.sessions = {};
              _st.sessions[chatId] = { id: mapped.id, cwd: mapped.cwd, started: true };
              saveState(_st);
              log('INFO', `Session restored via reply: ${mapped.id.slice(0, 8)} (${path.basename(mapped.cwd)})`);
              _replyAgentKey = mapped.agentKey || null;
            }
          }

          // Helper: set/clear sticky on shared state object and persist
          const _chatKey = String(chatId);
          const _setSticky = (key) => {
            if (!_st.team_sticky) _st.team_sticky = {};
            _st.team_sticky[_chatKey] = key;
            saveState(_st);
          };
          const _clearSticky = () => {
            if (_st.team_sticky) delete _st.team_sticky[_chatKey];
            saveState(_st);
          };
          const _stickyKey = (_st.team_sticky || {})[_chatKey] || null;

          // Team group routing: if bound project has a team array, check message for member nickname
          // Non-/stop slash commands bypass team routing → handled by main project
          const { key: _boundKey, project: _boundProj } = _getBoundProject(chatId, liveCfg);
          const _isTeamSlashCmd = trimmedText.startsWith('/') && !/^\/stop(\s|$)/i.test(trimmedText);
          if (_boundProj && Array.isArray(_boundProj.team) && _boundProj.team.length > 0 && !_isTeamSlashCmd) {
            // ── /stop precise routing for team groups ──
            const _stopMatch = trimmedText && trimmedText.match(/^\/stop(?:\s+(.+))?$/i);
            if (_stopMatch) {
              const _stopArg = (_stopMatch[1] || '').trim();
              let _targetKey = null;
              // Priority 1: quoted reply → stop that agent
              if (_replyAgentKey) {
                const m = _boundProj.team.find(t => t.key === _replyAgentKey);
                if (m) _targetKey = m.key;
              }
              // Priority 2: /stop <nickname> → match team member (case-insensitive)
              if (!_targetKey && _stopArg) {
                const _sa = _stopArg.toLowerCase();
                const m = _boundProj.team.find(t =>
                  (t.nicknames || []).some(n => n.toLowerCase() === _sa) || (t.name && t.name.toLowerCase() === _sa) || t.key === _sa
                );
                if (m) _targetKey = m.key;
              }
              // Priority 3: bare /stop → sticky
              if (!_targetKey && !_stopArg) _targetKey = _stickyKey;
              if (_targetKey) {
                const vid = `_agent_${_targetKey}`;
                const member = _boundProj.team.find(t => t.key === _targetKey);
                const label = member ? `${member.icon || '🤖'} ${member.name}` : _targetKey;
                // Clear message queue for this virtual agent
                if (messageQueue.has(vid)) {
                  const vq = messageQueue.get(vid);
                  if (vq && vq.timer) clearTimeout(vq.timer);
                  messageQueue.delete(vid);
                }
                const vproc = activeProcesses && activeProcesses.get(vid);
                if (vproc && vproc.child) {
                  vproc.aborted = true;
                  const sig = vproc.killSignal || 'SIGTERM';
                  try { process.kill(-vproc.child.pid, sig); } catch { try { vproc.child.kill(sig); } catch { /* */ } }
                  await bot.sendMessage(chatId, `⏹ Stopping ${label}...`);
                } else {
                  await bot.sendMessage(chatId, `${label} 当前没有活跃任务`);
                }
                return;
              }
              // /stop <bad-nickname> → no match, report error instead of falling through
              if (_stopArg) {
                await bot.sendMessage(chatId, `❌ 未找到团队成员: ${_stopArg}`);
                return;
              }
              // Bare /stop, no sticky set → fall through to handleCommand
            }

            // 0. Quoted reply → force route + set sticky
            if (_replyAgentKey) {
              const member = _boundProj.team.find(m => m.key === _replyAgentKey);
              if (member) {
                _setSticky(member.key);
                log('INFO', `Quoted reply → force route to ${_replyAgentKey} (sticky set)`);
                _dispatchToTeamMember(member, _boundProj, trimmedText, liveCfg, bot, chatId, executeTaskByName, acl);
                return;
              }
              log('INFO', `Quoted reply agentKey=${_replyAgentKey} not in team, falling through`);
            }
            // 1. Explicit nickname → route + set sticky
            const teamMatch = _findTeamMember(trimmedText, _boundProj.team);
            if (teamMatch) {
              const { member, rest } = teamMatch;
              _setSticky(member.key);
              if (!rest) {
                // Pure nickname, no task — confirm member is online
                log('INFO', `Sticky set (pure nickname): ${_chatKey.slice(-8)} → ${member.key}`);
                bot.sendMarkdown(chatId, `${member.icon || '🤖'} **${member.name}** 在线`).catch(() => {});
                return;
              }
              log('INFO', `Sticky set: ${_chatKey.slice(-8)} → ${member.key}`);
              _dispatchToTeamMember(member, _boundProj, rest, liveCfg, bot, chatId, executeTaskByName, acl);
              return;
            }

            // 1.5. Main project nickname → clear sticky, route to main
            const _mainNicks = Array.isArray(_boundProj.nicknames) ? _boundProj.nicknames : [];
            const _trimLower = trimmedText.toLowerCase();
            const _mainMatch = _mainNicks.find(n => _trimLower === n.toLowerCase() || _trimLower.startsWith(n.toLowerCase() + ' ') || _trimLower.startsWith(n.toLowerCase() + '，') || _trimLower.startsWith(n.toLowerCase() + ','));
            if (_mainMatch) {
              _clearSticky();
              const rest = trimmedText.slice(_mainMatch.length).replace(/^[\s,，:：]+/, '');
              log('INFO', `Main nickname → cleared sticky, routing to main${rest ? ` (task: ${rest.slice(0, 30)})` : ''}`);
              if (!rest) {
                bot.sendMarkdown(chatId, `${_boundProj.icon || '🤖'} **${_boundProj.name}** 在线`).catch(() => {});
                return;
              }
              try {
                await handleCommand(bot, chatId, rest, liveCfg, executeTaskByName, acl.senderId, acl.readOnly);
              } catch (e) {
                log('ERROR', `Team main-route handleCommand failed: ${e.message}`);
                bot.sendMessage(chatId, `❌ 执行失败: ${e.message}`).catch(() => {});
              }
              return;
            }

            // 2. Sticky: no nickname given → route to last explicitly named member
            if (_stickyKey) {
              const member = _boundProj.team.find(m => m.key === _stickyKey);
              if (member) {
                log('INFO', `Sticky route: → ${_stickyKey}`);
                _dispatchToTeamMember(member, _boundProj, trimmedText, liveCfg, bot, chatId, executeTaskByName, acl);
                return;
              }
            }

          }

          await handleCommand(bot, chatId, text, liveCfg, executeTaskByName, acl.senderId, acl.readOnly);
        }
      }, { log: (lvl, msg) => log(lvl, msg) });

      log('INFO', 'Feishu bot connected (WebSocket long connection)');
      return { stop: () => receiver.stop(), bot, reconnect: () => receiver.reconnect(), isAlive: () => receiver.isAlive() };
    } catch (e) {
      log('ERROR', `Feishu bridge failed: ${e.message}`);
      return null;
    }
  }

  return { startTelegramBridge, startFeishuBridge };
}

module.exports = { createBridgeStarter };
