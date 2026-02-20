/**
 * feishu-adapter.js — Feishu (Lark) Bot adapter using official SDK
 * Uses WebSocket long connection (no public IP needed).
 * Same interface pattern as telegram-adapter.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let Lark;
try {
  Lark = require('@larksuiteoapi/node-sdk');
} catch {
  const metameRoot = process.env.METAME_ROOT;
  if (metameRoot) {
    Lark = require(require('path').join(metameRoot, 'node_modules', '@larksuiteoapi/node-sdk'));
  }
  if (!Lark) {
    console.error('Cannot find @larksuiteoapi/node-sdk. Run: npm install @larksuiteoapi/node-sdk');
    process.exit(1);
  }
}

// Timeout wrapper: prevents SDK calls from hanging indefinitely when
// Feishu's token refresh HTTP request has no response (e.g. network down)
function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Feishu API timeout after ${ms}ms`)), ms)
    ),
  ]);
}

function createBot(config) {
  const { app_id, app_secret } = config;
  if (!app_id || !app_secret) throw new Error('app_id and app_secret are required');

  // Create API client for sending messages
  const client = new Lark.Client({
    appId: app_id,
    appSecret: app_secret,
  });

  return {
    /**
     * Send a plain text message
     */
    async sendMessage(chatId, text) {
      const res = await withTimeout(client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      }));
      // Return Telegram-compatible shape so daemon can edit it later
      const msgId = res?.data?.message_id;
      return msgId ? { message_id: msgId } : null;
    },

    _editBroken: false, // Set to true if patch API consistently fails
    async editMessage(chatId, messageId, text) {
      if (this._editBroken) return false;
      try {
        await withTimeout(client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify({ text }) },
        }));
        return true;
      } catch (e) {
        const code = e?.code || e?.response?.data?.code;
        if (code === 230001 || code === 230002 || /permission|forbidden/i.test(String(e))) {
          this._editBroken = true;
        }
        return false;
      }
    },

    /**
     * Send markdown as Feishu interactive card (lark_md renders bold, lists, code, links)
     */
    async sendMarkdown(chatId, markdown) {
      // Convert standard markdown → lark_md compatible format
      let content = markdown
        .replace(/^(#{1,3})\s+(.+)$/gm, '**$2**')   // headers → bold
        .replace(/^---+$/gm, '─────────────────────');  // hr → unicode line

      // Split into chunks if too long (element limit ~4000 chars)
      const MAX_CHUNK = 3800;
      const chunks = [];
      if (content.length <= MAX_CHUNK) {
        chunks.push(content);
      } else {
        const paragraphs = content.split(/\n\n/);
        let buf = '';
        for (const p of paragraphs) {
          if (buf.length + p.length + 2 > MAX_CHUNK && buf) {
            chunks.push(buf);
            buf = p;
          } else {
            buf = buf ? buf + '\n\n' + p : p;
          }
        }
        if (buf) chunks.push(buf);
      }

      // V2 schema: markdown element with normal text size
      const elements = chunks.map(c => ({
        tag: 'markdown',
        content: c,
        text_size: 'x-large',
      }));

      const card = {
        schema: '2.0',
        body: { elements },
      };

      const res = await withTimeout(client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      }));
      const msgId = res?.data?.message_id;
      return msgId ? { message_id: msgId } : null;
    },

    /**
     * Send a colored interactive card (for project-tagged notifications)
     * @param {string} chatId
     * @param {string} title - card header text
     * @param {string} body - card body (lark markdown)
     * @param {string} color - header color: blue|orange|green|red|grey|purple|turquoise
     */
    async sendCard(chatId, { title, body, color = 'blue' }) {
      // Use card schema V2 for better text sizing
      if (!body) {
        const card = {
          schema: '2.0',
          header: { title: { tag: 'plain_text', content: title }, template: color },
          body: { elements: [] },
        };
        const res = await withTimeout(client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
        }));
        const msgId = res?.data?.message_id;
        return msgId ? { message_id: msgId } : null;
      }

      // Convert standard markdown → lark_md
      let content = body
        .replace(/^(#{1,3})\s+(.+)$/gm, '**$2**')
        .replace(/^---+$/gm, '─────────────────────');

      // Split into chunks (lark_md element limit ~4000 chars)
      const MAX_CHUNK = 3800;
      const chunks = [];
      if (content.length <= MAX_CHUNK) {
        chunks.push(content);
      } else {
        const paragraphs = content.split(/\n\n/);
        let buf = '';
        for (const p of paragraphs) {
          if (buf.length + p.length + 2 > MAX_CHUNK && buf) {
            chunks.push(buf);
            buf = p;
          } else {
            buf = buf ? buf + '\n\n' + p : p;
          }
        }
        if (buf) chunks.push(buf);
      }

      // V2: use markdown element with text_size for readable font
      const elements = chunks.map(c => ({
        tag: 'markdown',
        content: c,
        text_size: 'x-large',
      }));

      const card = {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: title }, template: color },
        body: { elements },
      };
      const res = await withTimeout(client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
      }));
      const msgId = res?.data?.message_id;
      return msgId ? { message_id: msgId } : null;
    },

    /**
     * Delete a message by ID
     */
    async deleteMessage(chatId, messageId) {
      try {
        await withTimeout(client.im.message.delete({ path: { message_id: messageId } }), 5000);
      } catch { /* non-fatal — message may already be deleted or expired */ }
    },

    /**
     * Typing indicator (Feishu has no such API — no-op)
     */
    async sendTyping(_chatId) {},

    /**
     * Send interactive card with action buttons
     * @param {string} chatId
     * @param {string} title - card header
     * @param {Array<Array<{text: string, callback_data: string}>>} buttons - rows of buttons
     */
    async sendButtons(chatId, title, buttons) {
      // Feishu cards: each action element holds up to 3 buttons.
      // For a vertical list, put each button in its own action element.
      const elements = buttons.map(row => ({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: row[0].text },
          type: 'default',
          value: { cmd: row[0].callback_data },
        }],
      }));
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: 'blue',
        },
        elements,
      };
      await withTimeout(client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      }));
    },

    /**
     * Get bot info
     */
    async getMe() {
      // Return app info
      return { app_id, app_name: 'MetaMe' };
    },

    /**
     * Download a file from Feishu to local disk
     * @param {string} messageId - Message ID containing the file
     * @param {string} fileKey - File key from message content
     * @param {string} destPath - Local destination path
     * @returns {Promise<string>} The destination path
     */
    async downloadFile(messageId, fileKey, destPath, msgType = 'file') {
      try {
        let res;
        // All message attachments (images, files, media) use messageResource.get
        // im.image.get only works for images uploaded by the app itself
        const resourceType = msgType === 'image' ? 'image' : 'file';
        res = await client.im.messageResource.get({
          path: { message_id: messageId, file_key: fileKey },
          params: { type: resourceType },
        });

        // SDK returns writeFile method or getReadableStream
        if (res && res.writeFile) {
          await res.writeFile(destPath);
          return destPath;
        } else if (res && res.getReadableStream) {
          const stream = res.getReadableStream();
          const fileStream = fs.createWriteStream(destPath);
          return new Promise((resolve, reject) => {
            stream.pipe(fileStream);
            fileStream.on('finish', () => {
              fileStream.close();
              resolve(destPath);
            });
            fileStream.on('error', (err) => {
              fs.unlink(destPath, () => {});
              reject(err);
            });
          });
        }
        throw new Error('No writeFile or stream in response');
      } catch (err) {
        const detail = err.message || String(err);
        throw new Error(detail);
      }
    },

    /**
     * Send a file/document
     * @param {string} chatId
     * @param {string} filePath - Local file path
     * @param {string} [caption] - Optional caption (sent as separate message)
     */
    async sendFile(chatId, filePath, caption) {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      const fileName = path.basename(filePath);
      const fileSize = fs.statSync(filePath).size;

      // For text files under 4KB, just send as text
      const ext = path.extname(filePath).toLowerCase();
      const isText = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv'].includes(ext);
      if (isText && fileSize < 4096) {
        const content = fs.readFileSync(filePath, 'utf8');
        await this.sendMessage(chatId, `📄 ${fileName}:\n\`\`\`\n${content}\n\`\`\``);
        return;
      }

      // For larger/binary files, try file upload
      try {
        // Use ReadStream as per Feishu SDK docs
        const fileStream = fs.createReadStream(filePath);

        // 1. Upload file to Feishu
        const uploadRes = await client.im.file.create({
          data: {
            file_type: 'stream',
            file_name: fileName,
            file: fileStream,
          },
        });

        console.log('[Feishu] Upload response:', JSON.stringify(uploadRes));

        // Response is { code, msg, data: { file_key } }
        const fileKey = uploadRes?.data?.file_key || uploadRes?.file_key;
        if (!fileKey) {
          throw new Error(`No file_key in response: ${JSON.stringify(uploadRes)}`);
        }

        // 2. Send file message
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
      } catch (uploadErr) {
        // Log detailed error
        const errDetail = uploadErr.response?.data || uploadErr.message || uploadErr;
        console.error('[Feishu] File upload error:', JSON.stringify(errDetail));

        // Fallback: for text files, send content truncated
        if (isText) {
          const content = fs.readFileSync(filePath, 'utf8');
          const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(truncated)' : content;
          await this.sendMessage(chatId, `📄 ${fileName}:\n\`\`\`\n${truncated}\n\`\`\``);
        } else {
          // For binary files, give more helpful error
          const errMsg = errDetail?.msg || errDetail?.message || '上传失败';
          throw new Error(`${errMsg} (请检查飞书应用权限: im:resource)`);
        }
      }

      // 3. Send caption as separate message if provided
      if (caption) {
        await this.sendMessage(chatId, caption);
      }
    },

    /**
     * Start WebSocket long connection to receive messages
     * @param {function} onMessage - callback(chatId, text, event)
     * @returns {Promise<{stop: function}>}
     */
    startReceiving(onMessage) {
      return new Promise((resolve, reject) => {
        const wsClient = new Lark.WSClient({
          appId: app_id,
          appSecret: app_secret,
          loggerLevel: Lark.LoggerLevel.info,
        });

        // Dedup: track recent message_ids (Feishu may redeliver on slow ack)
        const _seenMsgIds = new Map(); // message_id → timestamp
        const DEDUP_TTL = 60000; // 60s window
        function isDuplicate(msgId) {
          if (!msgId) return false;
          const now = Date.now();
          // Cleanup old entries
          if (_seenMsgIds.size > 200) {
            for (const [k, t] of _seenMsgIds) {
              if (now - t > DEDUP_TTL) _seenMsgIds.delete(k);
            }
          }
          if (_seenMsgIds.has(msgId)) return true;
          _seenMsgIds.set(msgId, now);
          return false;
        }

        const eventDispatcher = new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            try {
              const msg = data.message;
              if (!msg) return;

              // Dedup by message_id
              if (isDuplicate(msg.message_id)) return;

              const chatId = msg.chat_id;
              const senderId = data.sender && data.sender.sender_id && data.sender.sender_id.open_id || null;
              let text = '';
              let fileInfo = null;

              if (msg.message_type === 'text') {
                try {
                  const content = JSON.parse(msg.content);
                  text = content.text || '';
                } catch {
                  text = msg.content || '';
                }
              } else if (msg.message_type === 'file' || msg.message_type === 'image' || msg.message_type === 'media') {
                // File, image or media (video) message
                try {
                  const content = JSON.parse(msg.content);
                  fileInfo = {
                    messageId: msg.message_id,
                    fileKey: content.file_key || content.image_key,
                    fileName: content.file_name || (content.image_key ? `image_${Date.now()}.png` : `file_${Date.now()}`),
                    msgType: msg.message_type, // 'file', 'image', or 'media'
                  };
                } catch {}
              }

              // Strip @mention prefix if present
              text = text.replace(/@_user_\d+\s*/g, '').trim();

              if (text || fileInfo) {
                // Fire-and-forget: don't block the event loop (SDK needs fast ack)
                Promise.resolve().then(() => onMessage(chatId, text, data, fileInfo, senderId)).catch(() => {});
              }
            } catch (e) {
              // Non-fatal
            }
          },
          'card.action.trigger': async (data) => {
            try {
              const action = data.action;
              // Try multiple possible chatId fields
              const chatId = data.open_chat_id || data.chat_id
                || (data.context && data.context.open_chat_id)
                || (data.event && data.event.open_chat_id);
              if (action && chatId) {
                const cmd = action.value && action.value.cmd;
                if (cmd) {
                  Promise.resolve().then(() => onMessage(chatId, cmd, data)).catch(() => {});
                }
              }
            } catch (e) {
              // Non-fatal
            }
            return {};
          },
        });

        wsClient.start({ eventDispatcher });

        // SDK doesn't provide a clean "connected" callback,
        // resolve immediately — errors will show in logs
        resolve({
          stop() {
            // SDK doesn't expose a clean shutdown method
            // Process exit will clean up
          },
        });
      });
    },

    client,
  };
}

module.exports = { createBot };
