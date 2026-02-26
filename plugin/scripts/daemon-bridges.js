'use strict';

const { resolveUserCtx } = require('./daemon-user-acl');

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
  } = deps;

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
              || trimmedText.startsWith('/agent new')
              || trimmedText.startsWith('/agent-bind-dir')
              || trimmedText.startsWith('/browse bind')
            );
            if (!allowedIds.includes(chatId) && !isBindCmd) {
              log('WARN', `Rejected message from unauthorized chat: ${chatId}`);
              bot.sendMessage(chatId, '⚠️ This chat is not authorized.\n\nCopy and send this command to register:\n\n/agent bind personal').catch(() => {});
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
          || trimmedText.startsWith('/agent new')
          || trimmedText.startsWith('/agent-bind-dir')
          || trimmedText.startsWith('/browse bind')
        );
        if (!allowedIds.includes(chatId) && !isBindCmd) {
          log('WARN', `Feishu: rejected message from ${chatId}`);
          (bot.sendMarkdown
            ? bot.sendMarkdown(chatId, '⚠️ 此会话未授权\n\n复制发送以下命令注册：\n\n/agent bind personal')
            : bot.sendMessage(chatId, '⚠️ 此会话未授权\n\n复制发送以下命令注册：\n\n/agent bind personal')).catch(() => {});
          return;
        }

        // ── 用户身份解析（ACL 注入）────────────────────────────────────────
        const userCtx = resolveUserCtx(senderId, liveCfg);
        log('INFO', `Feishu: user [${userCtx.name}] role=${userCtx.role} id=${senderId || 'N/A'}`);

        if (!userCtx.isAdmin && !isBindCmd) {
          if (text && text.startsWith('/') && !text.startsWith('/user whoami') && !text.startsWith('/myid') && !text.startsWith('/chatid')) {
            // slash 命令需要权限检查，非 admin 一律拦截（具体 action 检查在 router 层）
            log('INFO', `Feishu: non-admin slash blocked [${userCtx.role}] ${senderId}: ${(text || '').slice(0, 50)}`);
            // stranger 完全拦截，member 交由 router 细粒度判断
            if (userCtx.isStranger) {
              await (bot.sendMarkdown
                ? bot.sendMarkdown(chatId, '⚠️ 你没有权限执行此操作，请联系管理员。')
                : bot.sendMessage(chatId, '⚠️ 你没有权限执行此操作，请联系管理员。'));
              return;
            }
          }
          if (userCtx.isStranger && text && !text.startsWith('/myid') && !text.startsWith('/chatid')) {
            // stranger 只允许 /myid /chatid，其他进 readOnly 问答
            log('INFO', `Feishu: stranger query [readOnly] ${senderId}: ${(text || '').slice(0, 50)}`);
            if (text) await handleCommand(bot, chatId, text, liveCfg, executeTaskByName, senderId, userCtx);
            return;
          }
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

            await handleCommand(bot, chatId, prompt, liveCfg, executeTaskByName, senderId, userCtx);
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
          await handleCommand(bot, chatId, text, liveCfg, executeTaskByName, senderId, userCtx);
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
