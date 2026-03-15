'use strict';

let userAcl = null;
try { userAcl = require('./daemon-user-acl'); } catch { /* optional */ }
const { findTeamMember: _findTeamMember } = require('./daemon-team-dispatch');
const { isRemoteMember } = require('./daemon-remote-dispatch');
const imessageIO = (() => { try { return require('./daemon-siri-imessage'); } catch { return null; } })();
const siriBridgeMod = (() => { try { return require('./daemon-siri-bridge'); } catch { return null; } })();

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
    restoreSessionFromReply,
    handleCommand,
    pendingActivations,  // optional — used to show smart activation hint
    activeProcesses,     // optional — used for auto-dispatch to clones
    messageQueue,        // optional — used for /stop to clear queued messages
    sendRemoteDispatch,          // optional — send packet to remote peer via relay chat
    handleRemoteDispatchMessage, // optional — intercept relay chat messages
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

  function unauthorizedMsg(chatId) {
    const pending = getPendingActivationForChat(chatId);
    if (pending) {
      return `⚠️ 此群未授权\n\n发送以下命令激活 Agent「${pending.agentName}」：\n\`/activate\``;
    }
    return '⚠️ 此群未授权\n\n如已创建 Agent，发送 `/activate` 完成绑定。\n否则请先在主群创建 Agent。';
  }

  function extractFeishuReplyMessageId(event) {
    const candidates = [
      event && event.message && event.message.parent_id,
      event && event.message && event.message.parent_message_id,
      event && event.message && event.message.root_id,
      event && event.message && event.message.reply_in_thread_id,
      event && event.event && event.event.message && event.event.message.parent_id,
      event && event.event && event.event.message && event.event.message.parent_message_id,
      event && event.event && event.event.message && event.event.message.root_id,
      event && event.event && event.event.message && event.event.message.reply_in_thread_id,
    ];
    for (const value of candidates) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return null;
  }

  function trackBridgeReplyMapping(messageId, payload = {}) {
    const safeMessageId = String(messageId || '').trim();
    if (!safeMessageId) return;
    const state = loadState();
    if (!state.msg_sessions) state.msg_sessions = {};
    state.msg_sessions[safeMessageId] = {
      ...(state.msg_sessions[safeMessageId] || {}),
      ...payload,
    };
    saveState(state);
  }

  function inferSessionMapping(logicalChatId, fallback = {}) {
    const chatKey = String(logicalChatId || '').trim();
    if (!chatKey) return { ...fallback };
    const state = loadState();
    const raw = state.sessions && state.sessions[chatKey];
    if (!raw || typeof raw !== 'object') {
      return {
        logicalChatId: chatKey,
        ...fallback,
      };
    }
    const engines = raw.engines && typeof raw.engines === 'object' ? raw.engines : {};
    const preferredEngine = String(fallback.engine || '').trim().toLowerCase();
    const slot = (preferredEngine && engines[preferredEngine])
      || engines.codex
      || engines.claude
      || null;
    return {
      ...(slot && slot.id ? { id: String(slot.id) } : {}),
      cwd: raw.cwd || fallback.cwd,
      engine: preferredEngine || (engines.codex ? 'codex' : 'claude'),
      logicalChatId: chatKey,
      ...((slot && slot.sandboxMode) ? { sandboxMode: slot.sandboxMode } : {}),
      ...((slot && slot.approvalPolicy) ? { approvalPolicy: slot.approvalPolicy } : {}),
      ...((slot && slot.permissionMode) ? { permissionMode: slot.permissionMode } : {}),
      ...fallback,
    };
  }

  // ── Team group helpers ─────────────────────────────────────────────────
  function _getBoundProject(chatId, cfg) {
    const map = {
      ...(cfg.telegram  ? cfg.telegram.chat_agent_map  || {} : {}),
      ...(cfg.feishu    ? cfg.feishu.chat_agent_map    || {} : {}),
      ...(cfg.imessage  ? cfg.imessage.chat_agent_map  || {} : {}),
    };
    const key = map[String(chatId)];
    const proj = key && cfg.projects ? cfg.projects[key] : null;
    return { key: key || null, project: proj || null };
  }
  // _findTeamMember is imported from daemon-team-dispatch.js (shared with admin-commands)

  // Creates a bot proxy that redirects all send methods to replyChatId
  function _createTeamProxyBot(bot, replyChatId) {
    const SEND = new Set(['sendMessage', 'sendMarkdown', 'sendCard', 'editMessage', 'deleteMessage', 'sendTyping', 'sendFile', 'sendButtons', 'sendButtonCard']);
    return new Proxy(bot, {
      get(target, prop) {
        const orig = target[prop];
        if (typeof orig !== 'function') return orig;
        if (!SEND.has(prop)) return orig.bind(target);
        return function(_chatId, ...args) { return orig.call(target, replyChatId, ...args); };
      },
    });
  }
  // Get team member's working directory using subdir (not worktree).
  // Creates agents/<key>/ directory and symlinks CLAUDE.md from parent.
  function _getMemberCwd(parentCwd, key) {
    const { existsSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } = require('fs');
    const { execFileSync } = require('child_process');
    const WIN_HIDE = process.platform === 'win32' ? { windowsHide: true } : {};

    // Sanitize key to prevent path traversal
    const safeKey = String(key).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 50);
    if (safeKey !== key) {
      log('WARN', `Sanitized team member key: ${key} -> ${safeKey}`);
    }

    // Use agents/<key>/ as the working directory
    const agentsDir = path.join(parentCwd, 'agents');
    const memberDir = path.join(agentsDir, safeKey);

    // Create agents directory if not exists
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }

    // Create member directory if not exists
    if (!existsSync(memberDir)) {
      mkdirSync(memberDir, { recursive: true });
      log('INFO', `Created agent directory: ${memberDir}`);
    }

    // Initialize git for checkpoint support
    const gitDir = path.join(memberDir, '.git');
    if (!existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], { cwd: memberDir, stdio: 'ignore', ...WIN_HIDE });
        log('INFO', `Git repo initialized: ${memberDir}`);
      } catch (e) {
        log('WARN', `Failed to init git for ${memberDir}: ${e.message}`);
      }
    }

    // Set up CLAUDE.md: use dedicated, or template, or symlink from parent
    const claudeMd = path.join(memberDir, 'CLAUDE.md');
    const parentClaudeMd = path.join(parentCwd, 'CLAUDE.md');
    if (!existsSync(claudeMd)) {
      // Priority 1: dedicated CLAUDE.md in agents/<key>/ directory
      const dedicatedPath = path.join(parentCwd, 'agents', safeKey, 'CLAUDE.md');
      if (existsSync(dedicatedPath)) {
        try {
          // Copy instead of symlink to avoid cross-device issues
          const content = readFileSync(dedicatedPath, 'utf8');
          writeFileSync(claudeMd, content, 'utf8');
          log('INFO', `Copied dedicated CLAUDE.md for ${safeKey}`);
        } catch (e) {
          log('WARN', `Failed to copy CLAUDE.md for ${safeKey}: ${e.message}`);
        }
      } else if (existsSync(parentClaudeMd)) {
        // Priority 2: symlink to parent CLAUDE.md
        try {
          // Use 'junction' on Windows for directories, 'file' for files
          const linkType = process.platform === 'win32' ? 'junction' : 'file';
          symlinkSync(parentClaudeMd, claudeMd, linkType);
          log('INFO', `Symlinked CLAUDE.md for ${safeKey}`);
        } catch (e) {
          // Fallback: copy file
          try {
            const content = readFileSync(parentClaudeMd, 'utf8');
            writeFileSync(claudeMd, content, 'utf8');
            log('INFO', `Copied CLAUDE.md for ${safeKey} (symlink failed)`);
          } catch (e2) {
            log('WARN', `Failed to create CLAUDE.md for ${safeKey}: ${e2.message}`);
          }
        }
      }
    }

    return memberDir;
  }

  function _dispatchToTeamMember(member, boundProj, text, cfg, bot, realChatId, executeTaskByName, acl) {
    // Remote member → send via relay chat
    if (isRemoteMember(member) && sendRemoteDispatch) {
      sendRemoteDispatch({
        type: 'task',
        to_peer: member.peer,
        target_project: member.key,
        prompt: text,
        source_chat_id: String(realChatId),
        source_sender_key: acl.senderId || 'user',
        source_sender_id: acl.senderId || '',
      }, cfg).then(res => {
        if (res.success) {
          bot.sendMessage(realChatId, `📡 已发送给 ${member.icon || '🤖'} ${member.name} (${member.peer})`).catch(() => {});
        } else {
          bot.sendMessage(realChatId, `❌ 远端派发失败: ${res.error}`).catch(() => {});
        }
      });
      return;
    }

    const virtualChatId = `_agent_${member.key}`;
    const parentCwd = member.cwd || boundProj.cwd;
    const resolvedParentCwd = parentCwd.replace(/^~/, require('os').homedir());
    const memberCwd = _getMemberCwd(resolvedParentCwd, member.key);
    if (!memberCwd) {
      log('ERROR', `Team [${member.key}] cannot start: directory unavailable`);
      bot.sendMessage(realChatId, `❌ ${member.icon || '🤖'} ${member.name} 启动失败：工作目录创建失败`).catch(() => {});
      return;
    }
    log('INFO', `Team [${member.key}] using cwd: ${memberCwd}`);
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
    let abortController = new AbortController();
    let pollLoopActive = false;
    let reconnectTimer = null;

    const pollLoop = async (signal) => {
      pollLoopActive = true;
      try {
        while (running && signal === abortController.signal) {
          try {
            const updates = await bot.getUpdates(offset, 30, signal);
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
              const parentId = msg.reply_to_message && msg.reply_to_message.message_id
                ? String(msg.reply_to_message.message_id)
                : null;
              let _replyAgentKey = null;
              const { key: _boundKey, project: _boundProj } = _getBoundProject(chatId, liveCfg);
              const _isTeamSlashCmd = trimmedText.startsWith('/') && !/^\/stop(\s|$)/i.test(trimmedText);

              // Load sticky state
              const _st = loadState();
              if (parentId) {
                const mapped = _st.msg_sessions && _st.msg_sessions[parentId];
                if (mapped) {
                  if (typeof restoreSessionFromReply === 'function') {
                    restoreSessionFromReply(chatId, mapped);
                  } else {
                    if (!_st.sessions) _st.sessions = {};
                    _st.sessions[chatId] = { id: mapped.id, cwd: mapped.cwd, started: true };
                    saveState(_st);
                  }
                  log('INFO', `Telegram session restored via reply: ${mapped.id.slice(0, 8)} (${path.basename(mapped.cwd)})`);
                  _replyAgentKey = mapped.agentKey || null;
                }
              }
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
                  let _targetKey = null;
                  if (_replyAgentKey) {
                    const m = _boundProj.team.find(t => t.key === _replyAgentKey);
                    if (m) _targetKey = m.key;
                  }
                  if (!_targetKey && _stopArg) {
                    const _sa = _stopArg.toLowerCase();
                    const m = _boundProj.team.find(t =>
                      (t.nicknames || []).some(n => n.toLowerCase() === _sa) || (t.name && t.name.toLowerCase() === _sa) || t.key === _sa
                    );
                    if (m) _targetKey = m.key;
                  }
                  if (!_targetKey && !_stopArg) _targetKey = _stickyKey;
                  if (_targetKey) {
                    const vid = `_agent_${_targetKey}`;
                    const member = _boundProj.team.find(t => t.key === _targetKey);
                    const label = member ? `${member.icon || '🤖'} ${member.name}` : _targetKey;
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
                    continue;
                  }
                  if (_stopArg) {
                    await bot.sendMessage(chatId, `❌ 未找到团队成员: ${_stopArg}`).catch(() => {});
                    continue;
                  }
                }

                // 0. Quoted reply → force route + set sticky
                if (_replyAgentKey) {
                  const member = _boundProj.team.find(m => m.key === _replyAgentKey);
                  if (member) {
                    _setSticky(member.key);
                    log('INFO', `Telegram quoted reply → force route to ${_replyAgentKey} (sticky set)`);
                    _dispatchToTeamMember(member, _boundProj, trimmedText, liveCfg, bot, chatId, executeTaskByName, acl);
                    continue;
                  }
                  log('INFO', `Telegram quoted reply agentKey=${_replyAgentKey} not in team, falling through`);
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
      } finally {
        pollLoopActive = false;
      }
    };

    const startPoll = () => {
      if (!running || pollLoopActive) return;
      const signal = abortController.signal;
      pollLoop(signal).catch(e => {
        if (e.message === 'aborted') return;
        log('ERROR', `pollLoop crashed: ${e.message} — restarting in 5s`);
        if (running) setTimeout(startPoll, 5000);
      });
    };
    startPoll();

    return {
      stop() {
        running = false;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        abortController.abort();
      },
      reconnect() {
        if (!running) return;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        try { abortController.abort(); } catch { /* ignore */ }
        abortController = new AbortController();
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startPoll();
        }, 150);
      },
      isAlive() {
        return running && (pollLoopActive || !abortController.signal.aborted);
      },
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
        const relayCfg = liveCfg && liveCfg.feishu && liveCfg.feishu.remote_dispatch;
        const relayChatId = relayCfg && relayCfg.chat_id ? String(relayCfg.chat_id) : '';
        if (relayChatId && String(chatId) === relayChatId) {
          const preview = String(text || '').slice(0, 80).replace(/\s+/g, ' ');
          log('INFO', `Feishu relay event chat=${chatId} sender=${senderId || 'unknown'} preview=${preview}`);
        }

        // ── Remote dispatch interception (before ACL) ──
        if (handleRemoteDispatchMessage && text) {
          const handled = await handleRemoteDispatchMessage({ chatId, text, config: liveCfg });
          if (handled) return;
        }

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
          const parentId = extractFeishuReplyMessageId(event);
          let _replyAgentKey = null;
          // Load state once for the entire routing block
          const _st = loadState();
          if (parentId) {
            log('INFO', `Feishu reply metadata detected chat=${chatId} parentId=${parentId}`);
          }
          if (parentId) {
            const mapped = _st.msg_sessions && _st.msg_sessions[parentId];
            if (mapped) {
              if (typeof restoreSessionFromReply === 'function') {
                restoreSessionFromReply(chatId, mapped);
              } else {
                if (mapped.id) {
                  if (!_st.sessions) _st.sessions = {};
                  _st.sessions[chatId] = { id: mapped.id, cwd: mapped.cwd, started: true };
                  saveState(_st);
                }
              }
              if (mapped.id) {
                log('INFO', `Session restored via reply: ${mapped.id.slice(0, 8)} (${path.basename(mapped.cwd)})`);
              }
              _replyAgentKey = mapped.agentKey || null;
            } else {
              log('INFO', `Feishu reply parentId=${parentId} had no msg_sessions mapping`);
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
                    bot.sendMarkdown(chatId, `${member.icon || '🤖'} **${member.name}** 在线`)
                      .then((msg) => {
                        if (msg && msg.message_id) {
                          trackBridgeReplyMapping(msg.message_id, inferSessionMapping(`_agent_${member.key}`, {
                            agentKey: member.key,
                            cwd: member.cwd || _boundProj.cwd,
                            engine: member.engine || _boundProj.engine || 'claude',
                          }));
                        }
                      })
                      .catch(() => {});
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
                    bot.sendMarkdown(chatId, `${_boundProj.icon || '🤖'} **${_boundProj.name}** 在线`)
                      .then((msg) => {
                        if (msg && msg.message_id) {
                          trackBridgeReplyMapping(msg.message_id, inferSessionMapping(String(chatId), {
                            agentKey: _boundKey || null,
                            cwd: _boundProj.cwd,
                            engine: _boundProj.engine || 'claude',
                            logicalChatId: _boundKey ? `_bound_${_boundKey}` : String(chatId),
                          }));
                        }
                      })
                      .catch(() => {});
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

  // ── iMessage Bridge ─────────────────────────────────────────────────────────
  async function startImessageBridge(config, executeTaskByName) {
    const cfg = config.imessage || {};
    if (!cfg.enabled) return null;
    if (!imessageIO) { log('WARN', '[IMESSAGE] daemon-siri-imessage module not found'); return null; }
    if (!imessageIO.isAvailable()) { log('WARN', '[IMESSAGE] chat.db not found — bridge disabled'); return null; }

    const selfId = cfg.self_id || '';
    const allowedSenders = cfg.allowed_senders || (selfId ? [selfId] : []);
    const allowedChats = cfg.allowed_chat_ids || [];
    const pollMs = cfg.poll_ms || 2000;

    if (!selfId) { log('WARN', '[IMESSAGE] self_id not configured — bridge disabled'); return null; }

    let lastRowId  = imessageIO.getMaxRowId();
    let processing = false;
    let running    = true;

    // Per-chat persistent bot instances (preserve state across polls)
    const chatBots = new Map();
    const getBot = (chatTarget) => {
      if (!chatBots.has(chatTarget)) {
        const bot = imessageIO.createImessageBot(chatTarget, log);
        // After bot sends a reply, advance lastRowId immediately + again after delay
        if (bot.setOnAfterSend) {
          bot.setOnAfterSend(() => {
            // Immediate advance — covers fast echo
            const freshNow = imessageIO.getMaxRowId();
            if (freshNow > lastRowId) {
              log('INFO', `[IMESSAGE] Advanced lastRowId ${lastRowId}→${freshNow} (echo skip immediate)`);
              lastRowId = freshNow;
            }
            // Delayed advance — covers slow iCloud sync echo
            setTimeout(() => {
              const freshLater = imessageIO.getMaxRowId();
              if (freshLater > lastRowId) {
                log('INFO', `[IMESSAGE] Advanced lastRowId ${lastRowId}→${freshLater} (echo skip delayed)`);
                lastRowId = freshLater;
              }
            }, 3000);
          });
        }
        chatBots.set(chatTarget, bot);
      }
      return chatBots.get(chatTarget);
    };

    log('INFO', `[IMESSAGE] Bridge started (poll=${pollMs}ms, self=${selfId}, lastRowId=${lastRowId})`);

    const timer = setInterval(async () => {
      if (!running || processing) return;
      processing = true;
      try {
        const rows = imessageIO.queryNewMessages(lastRowId);
        if (!rows) { processing = false; return; }

        for (const row of rows.split('\n').filter(Boolean)) {
          const parts = row.split('\t');
          const rowId = parseInt(parts[0], 10);
          const text = (parts[1] || '').trim();
          const sender = (parts[2] || '').trim();
          const chatGuid = (parts[3] || '').trim();
          const chatIdentifier = (parts[4] || '').trim();
          const chatName = (parts[5] || '').trim();
          const chatTarget = chatGuid || chatIdentifier || sender;

          if (!rowId || rowId <= lastRowId) continue;
          lastRowId = rowId;
          if (!text) continue;
          if (!chatTarget) continue;

          if (allowedSenders.length && !allowedSenders.includes(sender)) {
            log('INFO', `[IMESSAGE] Ignored message from ${sender} (not in allowed_senders)`);
            continue;
          }
          if (allowedChats.length && !allowedChats.includes(chatTarget) && !allowedChats.includes(chatIdentifier)) {
            log('INFO', `[IMESSAGE] Ignored chat ${chatTarget} (${chatName || sender || 'unknown'}) not in allowed_chat_ids`);
            continue;
          }

          const chatId = chatTarget;
          const liveCfg = loadConfig();
          const bot = getBot(chatTarget);

          // Echo fingerprint check — skip if this text matches something we recently sent
          if (bot.isEcho && bot.isEcho(text)) {
            log('INFO', `[IMESSAGE] Skipped echo: "${text.slice(0, 40)}"`);
            continue;
          }

          const trimmedText = text.trim();
          let commandText = text;

          log('INFO', `[IMESSAGE] Received chat=${chatTarget} sender=${sender || 'unknown'} name=${chatName || '-'}: "${text.slice(0, 60)}"`);

          const acl = await applyUserAcl({
            bot,
            chatId,
            text,
            config: liveCfg,
            senderId: sender,
            bypassAcl: false,
          });
          if (acl.blocked) continue;

          const { project: _boundProj } = _getBoundProject(chatId, liveCfg);
          const _isTeamSlashCmd = trimmedText.startsWith('/') && !/^\/stop(\s|$)/i.test(trimmedText);
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
            const _stopMatch = trimmedText.match(/^\/stop(?:\s+(.+))?$/i);
            if (_stopMatch) {
              const _stopArg = (_stopMatch[1] || '').trim();
              let _targetKey = null;
              if (_stopArg) {
                const _sa = _stopArg.toLowerCase();
                const m = _boundProj.team.find(t =>
                  (t.nicknames || []).some(n => n.toLowerCase() === _sa) || (t.name && t.name.toLowerCase() === _sa) || t.key === _sa
                );
                if (m) _targetKey = m.key;
              }
              if (!_targetKey && !_stopArg) _targetKey = _stickyKey;
              if (_targetKey) {
                const vid = `_agent_${_targetKey}`;
                const member = _boundProj.team.find(t => t.key === _targetKey);
                const label = member ? `${member.icon || '🤖'} ${member.name}` : _targetKey;
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
                  await bot.sendMessage(chatId, `Stopping ${label}...`);
                } else {
                  await bot.sendMessage(chatId, `${label} 当前没有活跃任务`);
                }
                continue;
              }
              if (_stopArg) {
                await bot.sendMessage(chatId, `未找到团队成员: ${_stopArg}`);
                continue;
              }
            }

            const teamMatch = _findTeamMember(trimmedText, _boundProj.team);
            if (teamMatch) {
              const { member, rest } = teamMatch;
              _setSticky(member.key);
              if (!rest) {
                await bot.sendMessage(chatId, `${member.icon || '🤖'} ${member.name} 在线`);
                continue;
              }
              log('INFO', `[IMESSAGE] Team route ${chatId} -> ${member.key}`);
              _dispatchToTeamMember(member, _boundProj, rest, liveCfg, bot, chatId, executeTaskByName, acl);
              continue;
            }

            const _mainNicks = Array.isArray(_boundProj.nicknames) ? _boundProj.nicknames : [];
            const _trimLower = trimmedText.toLowerCase();
            const _mainMatch = _mainNicks.find(n =>
              _trimLower === n.toLowerCase()
              || _trimLower.startsWith(n.toLowerCase() + ' ')
              || _trimLower.startsWith(n.toLowerCase() + '，')
              || _trimLower.startsWith(n.toLowerCase() + ',')
            );
            if (_mainMatch) {
              _clearSticky();
              const rest = trimmedText.slice(_mainMatch.length).replace(/^[\s,，:：]+/, '');
              if (!rest) {
                await bot.sendMessage(chatId, `${_boundProj.icon || '🤖'} ${_boundProj.name || 'Agent'} 在线`);
                continue;
              }
              commandText = rest;
            } else if (_stickyKey) {
              const member = _boundProj.team.find(m => m.key === _stickyKey);
              if (member) {
                log('INFO', `[IMESSAGE] Sticky route ${chatId} -> ${member.key}`);
                _dispatchToTeamMember(member, _boundProj, trimmedText, liveCfg, bot, chatId, executeTaskByName, acl);
                continue;
              }
            }
          }

          handleCommand(bot, chatId, commandText, liveCfg, executeTaskByName, sender, false)
            .catch(e => log('ERROR', `[IMESSAGE] handleCommand error: ${e.message}`));
        }
      } catch (e) {
        log('WARN', `[IMESSAGE] poll error: ${e.message}`);
      }
      processing = false;
    }, pollMs);

    return {
      stop: () => { running = false; clearInterval(timer); },
      bot: imessageIO.createImessageBot(selfId, log),
    };
  }

  // ── Siri HTTP Bridge ────────────────────────────────────────────────────────
  function startSiriBridge(config, executeTaskByName) {
    if (!siriBridgeMod) { log('WARN', '[SIRI] daemon-siri-bridge module not found'); return null; }
    const bridge = siriBridgeMod.createSiriBridge({ log, loadConfig, handleCommand });
    return bridge.startSiriBridge(config, executeTaskByName);
  }

  return { startTelegramBridge, startFeishuBridge, startImessageBridge, startSiriBridge };
}

module.exports = { createBridgeStarter };
