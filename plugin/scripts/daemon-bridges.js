'use strict';

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
  } = deps;

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
              bot.answerCallback(cb.id).catch(() => { });
              if (chatId && cb.data) {
                const liveCfg = loadConfig();
                const allowedIds = (liveCfg.telegram && liveCfg.telegram.allowed_chat_ids) || [];
                if (!allowedIds.includes(chatId)) continue;
                handleCommand(bot, chatId, cb.data, liveCfg, executeTaskByName).catch(e => {
                  log('ERROR', `Telegram callback handler error: ${e.message}`);
                });
              }
              continue;
            }

            if (!update.message) continue;

            const msg = update.message;
            const chatId = msg.chat.id;

            const liveCfg = loadConfig();
            const allowedIds = (liveCfg.telegram && liveCfg.telegram.allowed_chat_ids) || [];
            const trimmedText = msg.text && msg.text.trim();
            const isBindCmd = trimmedText && (
              trimmedText.startsWith('/agent bind')
              || trimmedText.startsWith('/agent-bind-dir')
              || trimmedText.startsWith('/browse bind')
              || trimmedText === '/activate'
            );
            if (!allowedIds.includes(chatId) && !isBindCmd) {
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

                handleCommand(bot, chatId, prompt, liveCfg, executeTaskByName).catch(e => {
                  log('ERROR', `Telegram file handler error: ${e.message}`);
                });
              } catch (err) {
                log('ERROR', `File download failed: ${err.message}`);
                await bot.sendMessage(chatId, `❌ Download failed: ${err.message}`);
              }
              continue;
            }

            if (msg.text) {
              handleCommand(bot, chatId, msg.text.trim(), liveCfg, executeTaskByName).catch(e => {
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
        if (!allowedIds.includes(chatId) && !isBindCmd) {
          log('WARN', `Feishu: rejected message from ${chatId}`);
          const msg = unauthorizedMsg(chatId);
          (bot.sendMarkdown ? bot.sendMarkdown(chatId, msg) : bot.sendMessage(chatId, msg)).catch(() => {});
          return;
        }

        const operatorIds = (liveCfg.feishu && liveCfg.feishu.operator_ids) || [];
        if (operatorIds.length > 0 && senderId && !operatorIds.includes(senderId) && !isBindCmd) {
          log('INFO', `Feishu: read-only message from non-operator ${senderId} in ${chatId}: ${(text || '').slice(0, 50)}`);
          if (text && text.startsWith('/')) {
            await (bot.sendMarkdown ? bot.sendMarkdown(chatId, '⚠️ 该操作需要授权，请联系管理员。') : bot.sendMessage(chatId, '⚠️ 该操作需要授权，请联系管理员。'));
            return;
          }
          if (text) {
            await handleCommand(bot, chatId, text, liveCfg, executeTaskByName, senderId, true);
          }
          return;
        }

        if (fileInfo && fileInfo.fileKey) {
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

            await handleCommand(bot, chatId, prompt, liveCfg, executeTaskByName);
          } catch (err) {
            log('ERROR', `Feishu file download failed: ${err.message}`);
            await bot.sendMessage(chatId, `❌ Download failed: ${err.message}`);
          }
          return;
        }

        if (text) {
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
          await handleCommand(bot, chatId, text, liveCfg, executeTaskByName, senderId);
        }
      });

      log('INFO', 'Feishu bot connected (WebSocket long connection)');
      return { stop: () => receiver.stop(), bot };
    } catch (e) {
      log('ERROR', `Feishu bridge failed: ${e.message}`);
      return null;
    }
  }

  return { startTelegramBridge, startFeishuBridge };
}

module.exports = { createBridgeStarter };
