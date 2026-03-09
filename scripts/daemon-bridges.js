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
  function _dispatchToTeamMember(member, boundProj, text, cfg, bot, realChatId, executeTaskByName, acl) {
    const virtualChatId = `_agent_${member.key}`;
    const teamCfg = {
      ...cfg,
      projects: {
        ...(cfg.projects || {}),
        [member.key]: {
          cwd: member.cwd || boundProj.cwd,
          name: member.name,
          icon: member.icon || '🤖',
          color: member.color || 'blue',
          engine: member.engine || boundProj.engine,
          // Each clone keeps its own session — parallel work must not share JSONL files
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
          if (parentId) {
            const st = loadState();
            const mapped = st.msg_sessions && st.msg_sessions[parentId];
            if (mapped) {
              st.sessions[chatId] = { id: mapped.id, cwd: mapped.cwd, started: true };
              saveState(st);
              log('INFO', `Session restored via reply: ${mapped.id.slice(0, 8)} (${path.basename(mapped.cwd)})`);
            }
          }

          // Team group routing: if bound project has a team array, check message for member nickname
          const { key: _boundKey, project: _boundProj } = _getBoundProject(chatId, liveCfg);
          if (_boundProj && Array.isArray(_boundProj.team) && _boundProj.team.length > 0) {
            // 1. Explicit nickname → route to that member
            const teamMatch = _findTeamMember(trimmedText, _boundProj.team);
            if (teamMatch) {
              const { member, rest } = teamMatch;
              if (!rest) {
                // Pure nickname, no task — just confirm member is online
                bot.sendMarkdown(chatId, `${member.icon || '🤖'} **${member.name}** 在线`).catch(() => {});
                return;
              }
              _dispatchToTeamMember(member, _boundProj, rest, liveCfg, bot, chatId, executeTaskByName, acl);
              return;
            }

            // 2. Auto-dispatch: main busy → find first free auto_dispatch clone
            if (activeProcesses) {
              const clones = _boundProj.team.filter(m => m.auto_dispatch);
              const mainBusy = activeProcesses.has(chatId);
              if (mainBusy) {
                const clone = clones.find(m => !activeProcesses.has(`_agent_${m.key}`));
                if (clone) {
                  log('INFO', `Auto-dispatch: main busy → ${clone.key} (${clone.name})`);
                  _dispatchToTeamMember(clone, _boundProj, trimmedText, liveCfg, bot, chatId, executeTaskByName, acl);
                  return;
                }
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
