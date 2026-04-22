/**
 * feishu-adapter.js — Feishu (Lark) Bot adapter using official SDK
 * Uses WebSocket long connection (no public IP needed).
 * Same interface pattern as telegram-adapter.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const dns = require('dns');

let Lark;
function _tryRequireLark() {
  // 1. local node_modules (dev environment)
  try { return require('@larksuiteoapi/node-sdk'); } catch {}
  // 2. METAME_ROOT/node_modules (packaged metame-cli)
  const metameRoot = process.env.METAME_ROOT;
  if (metameRoot) {
    try { return require(path.join(metameRoot, 'node_modules', '@larksuiteoapi/node-sdk')); } catch {}
  }
  // 3. ~/.metame/node_modules (auto-installed for new users)
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    try { return require(path.join(home, '.metame', 'node_modules', '@larksuiteoapi', 'node-sdk')); } catch {}
  }
  return null;
}
Lark = _tryRequireLark();
if (!Lark) {
  // Auto-install into ~/.metame so new users never see this error
  const home = process.env.HOME || process.env.USERPROFILE;
  const prefix = home ? path.join(home, '.metame') : null;
  if (prefix) {
    console.log('[feishu] @larksuiteoapi/node-sdk not found, auto-installing into ~/.metame ...');
    const { execSync } = require('child_process');
    try {
      execSync(`npm install @larksuiteoapi/node-sdk --prefix "${prefix}" --silent`, { stdio: 'inherit' });
      Lark = require(path.join(prefix, 'node_modules', '@larksuiteoapi', 'node-sdk'));
      console.log('[feishu] SDK installed successfully.');
    } catch (e) {
      console.error('[feishu] Auto-install failed:', e.message);
      console.error('Manual fix: npm install @larksuiteoapi/node-sdk --prefix ~/.metame');
      process.exit(1);
    }
  } else {
    console.error('[feishu] Cannot find @larksuiteoapi/node-sdk and HOME is not set.');
    process.exit(1);
  }
}

// Timeout wrapper: prevents SDK calls from hanging indefinitely when
// Feishu's token refresh HTTP request has no response (e.g. network down)
function withTimeout(promise, ms = 10000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Feishu API timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Wait for DNS to resolve a target host with exponential backoff.
// Used after system wake / before reconnect: the OS may report clock/events
// restored before WiFi+DNS are actually usable. Retries 1/2/4/8s, total cap 30s.
async function waitForNetworkReady(hostname, opts = {}) {
  const log = opts.log || (() => {});
  const totalBudget = Number.isFinite(opts.totalBudgetMs) ? opts.totalBudgetMs : 30000;
  const lookup = opts.lookup || dns.promises.lookup;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const startedAt = Date.now();
  let attempt = 0;
  let lastError = null;
  // Backoff schedule: 0s, 1s, 2s, 4s, 8s between attempts (before the next attempt)
  const backoff = [0, 1000, 2000, 4000, 8000];
  // Always make at least one attempt; subsequent attempts are budget-gated.
  do {
    const wait = backoff[Math.min(attempt, backoff.length - 1)];
    if (wait > 0) await sleep(wait);
    attempt += 1;
    try {
      await lookup(hostname);
      return { ok: true, attempts: attempt, elapsed: Date.now() - startedAt };
    } catch (err) {
      lastError = err;
      log('DEBUG', `[net-ready] ${hostname} attempt ${attempt} failed: ${err.code || err.message}`);
    }
  } while (Date.now() - startedAt < totalBudget);
  return {
    ok: false,
    attempts: attempt,
    elapsed: Date.now() - startedAt,
    error: lastError && (lastError.message || String(lastError)),
  };
}

// Max chars per lark_md element (Feishu limit ~4000)
const MAX_CHUNK = 3800;

/**
 * Convert standard markdown to lark_md and split into chunks.
 * Shared by sendMarkdown and sendCard.
 */
function toMdChunks(text) {
  const content = text
    .replace(/^(#{1,3})\s+(.+)$/gm, '**$2**')      // headers → bold
    .replace(/^---+$/gm, '─────────────────────');  // hr → unicode line
  if (content.length <= MAX_CHUNK) return [content];
  const paragraphs = content.split(/\n\n/);
  const chunks = [];
  let buf = '';
  for (const p of paragraphs) {
    if (buf.length + p.length + 2 > MAX_CHUNK && buf) { chunks.push(buf); buf = p; }
    else { buf = buf ? buf + '\n\n' + p : p; }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function createBot(config) {
  const { app_id, app_secret } = config;
  if (!app_id || !app_secret) throw new Error('app_id and app_secret are required');

  // Create API client for sending messages
  const client = new Lark.Client({
    appId: app_id,
    appSecret: app_secret,
  });

  /**
   * Validate credentials by attempting a lightweight API call.
   * Returns { ok: true } or { ok: false, error: string }.
   */
  async function validateCredentials() {
    try {
      await withTimeout(client.im.chat.list({ params: { page_size: 1 } }), 15000);
      return { ok: true };
    } catch (err) {
      const msg = err && err.message || String(err);
      // Only flag as auth error when we have strong evidence: known Feishu
      // auth error codes, HTTP 401/403, or explicit 'invalid app_id/secret'.
      // Previously a loose /token/ regex false-positived on SDK-internal
      // messages like "Cannot destructure 'tenant_access_token' of undefined"
      // (which is really a network/empty-response failure) and caused the
      // bridge to refuse to start across a lid-close/wake cycle.
      const authPatterns = [
        /\b(99991663|99991664|99991665)\b/,                                  // Feishu token invalid codes
        /\b(401|403)\b/,                                                     // HTTP 401/403
        /invalid\s+(app_?id|app_?secret|tenant_access_token|access_?token)/i,
        /unauthorized/i,
        /\bforbidden\b/i,
      ];
      const isAuthError = authPatterns.some((p) => p.test(msg));
      return {
        ok: false,
        error: isAuthError
          ? `Feishu credential validation failed (app_id/app_secret may be incorrect): ${msg}`
          : `Feishu API probe failed (network or transient issue): ${msg}`,
        isAuthError,
      };
    }
  }

  // ── Thread-aware send primitive ──────────────────────────────────────
  // Detects composite "thread:chatId:threadId" IDs from daemon-bridges
  // and routes to client.im.message.reply (stays inside the topic thread)
  // instead of client.im.message.create.
  const { parseThreadChatId } = require('./core/thread-chat-id');

  async function _dispatchSend(chatId, msgType, content, timeout = 15000) {
    const thread = parseThreadChatId(chatId);
    let res;
    if (thread) {
      // Topic mode: reply inside the thread so the response stays in the topic
      res = await withTimeout(client.im.message.reply({
        path: { message_id: thread.threadId },
        data: { msg_type: msgType, content },
      }), timeout);
    } else {
      // Normal mode: create message in chat
      res = await withTimeout(client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType, content },
      }), timeout);
    }
    const msgId = res?.data?.message_id;
    return msgId ? { message_id: msgId } : null;
  }

  // Private: send an interactive card JSON; returns { message_id } or null.
  // All card functions funnel through here to avoid repeating the SDK call.
  async function _sendInteractive(chatId, card) {
    return _dispatchSend(chatId, 'interactive', JSON.stringify(card), 30000);
  }

  let _editBroken = false;      // closure var — safe against destructured calls
  let _editBrokenAt = 0;        // timestamp when broken; auto-resets after 10min

  return {
    validateCredentials,
    /**
     * Send a plain text message
     */
    async sendMessage(chatId, text) {
      return _dispatchSend(chatId, 'text', JSON.stringify({ text }));
    },

    async editMessage(chatId, messageId, text, header = null) {
      if (_editBroken && Date.now() - _editBrokenAt < 10 * 60 * 1000) return false;
      if (_editBroken) _editBroken = false; // auto-reset after 10min
      try {
        // Feishu patch API only works on card (interactive) messages
        // Update card content with markdown element; preserve header if provided
        const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: text, text_size: 'x-large' }] } };
        if (header && header.title) {
          card.header = { title: { tag: 'plain_text', content: header.title }, template: header.color || 'blue' };
        }
        await withTimeout(client.im.message.patch({
          path: { message_id: messageId },
          data: { content: JSON.stringify(card) },
        }), 30000); // 30s: must not timeout after Feishu has applied the patch
        return true;
      } catch (e) {
        const code = e?.code || e?.response?.data?.code;
        if (code === 230001 || code === 230002 || /permission|forbidden/i.test(String(e))) {
          _editBroken = true;
          _editBrokenAt = Date.now();
        }
        return false;
      }
    },

    /**
     * Send markdown as Feishu interactive card (lark_md renders bold, lists, code, links)
     */
    async sendMarkdown(chatId, markdown) {
      const elements = toMdChunks(markdown).map(c => ({ tag: 'markdown', content: c, text_size: 'x-large' }));
      return _sendInteractive(chatId, { schema: '2.0', body: { elements } });
    },

    /**
     * Send a colored interactive card with optional markdown body (V2 schema)
     * @param {string} chatId
     * @param {object} opts
     * @param {string} opts.title - card header text
     * @param {string} [opts.body] - card body (standard markdown)
     * @param {string} [opts.color='blue'] - header color: blue|orange|green|red|grey|purple|turquoise
     */
    async sendCard(chatId, { title, body, color = 'blue' }) {
      const header = { title: { tag: 'plain_text', content: title }, template: color };
      const elements = body ? toMdChunks(body).map(c => ({ tag: 'markdown', content: c, text_size: 'x-large' })) : [];
      return _sendInteractive(chatId, { schema: '2.0', header, body: { elements } });
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
     * Send interactive card with action buttons (V1 schema — required for card.action.trigger)
     * @param {string} chatId
     * @param {string} title - card header (first line) + optional body (remaining lines)
     * @param {Array<Array<{text: string, callback_data: string}>>} buttons - rows of buttons
     */
    async sendButtons(chatId, title, buttons) {
      // Each row becomes one action element; a row can hold up to 3 buttons side-by-side.
      const buttonElements = buttons.map(row => ({
        tag: 'action',
        actions: row.map(b => ({
          tag: 'button',
          text: { tag: 'plain_text', content: b.text },
          type: 'default',
          value: { cmd: b.callback_data },
        })),
      }));

      // Feishu card header is single-line — split multi-line title into header + body
      const lines = title.split('\n');
      const headerText = lines[0].slice(0, 60);
      const bodyText = lines.slice(1).join('\n').trim();

      const elements = [];
      if (bodyText) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: bodyText } });
        elements.push({ tag: 'hr' });
      }
      elements.push(...buttonElements);

      return _sendInteractive(chatId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: headerText }, template: 'blue' },
        elements,
      });
    },

    /**
     * Send a rich interactive card with pre-built elements (V1 schema — required for card.action.trigger)
     * @param {string} chatId
     * @param {string} headerText - single-line card header
     * @param {Array} elements - Feishu V1 card elements array
     */
    async sendRawCard(chatId, headerText, elements) {
      return _sendInteractive(chatId, {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: headerText }, template: 'blue' },
        elements,
      });
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
      const ext = path.extname(filePath).toLowerCase();
      const isText = ['.md', '.txt', '.json', '.yaml', '.yml', '.csv'].includes(ext);

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

        // Upload response logged at debug level if needed

        // Response is { code, msg, data: { file_key } }
        const fileKey = uploadRes?.data?.file_key || uploadRes?.file_key;
        if (!fileKey) {
          throw new Error(`No file_key in response: ${JSON.stringify(uploadRes)}`);
        }

        // 2. Send file message (thread-aware)
        const sendResult = await _dispatchSend(chatId, 'file', JSON.stringify({ file_key: fileKey }));
        const msgId = sendResult?.message_id;
        if (caption) await this.sendMessage(chatId, caption);
        return msgId ? { message_id: msgId } : null;
      } catch (uploadErr) {
        // Log detailed error
        const errDetail = uploadErr.response?.data || uploadErr.message || uploadErr;
        console.error('[Feishu] File upload error:', JSON.stringify(errDetail));

        // Fallback: for text files, send content truncated
        if (isText) {
          const content = fs.readFileSync(filePath, 'utf8');
          const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n...(truncated)' : content;
          const textMsg = await this.sendMessage(chatId, `📄 ${fileName}:\n\`\`\`\n${truncated}\n\`\`\``);
          if (caption) await this.sendMessage(chatId, caption);
          return textMsg || null;
        } else {
          // For binary files, give more helpful error
          const errMsg = errDetail?.msg || errDetail?.message || '上传失败';
          throw new Error(`${errMsg} (请检查飞书应用权限: im:resource)`);
        }
      }
    },

    /**
     * Start WebSocket long connection to receive messages (with auto-reconnect)
     * @param {function} onMessage - callback(chatId, text, event)
     * @param {object} [opts]
     * @param {function} [opts.log] - logger function(level, msg)
     * @returns {Promise<{stop: function, reconnect: function, isAlive: function}>}
     */
    startReceiving(onMessage, opts = {}) {
      const _log = opts.log || ((lvl, msg) => console.log(`[feishu] [${lvl}] ${msg}`));
      let stopped = false;
      let currentWs = null;
      let healthTimer = null;
      let sleepWakeTimer = null;
      let reconnectTimer = null;
      let aliveTimer = null;
      let reconnectScheduled = false; // dedup flag: true while a reconnect is pending
      let wsEpoch = 0; // increments each connect(); underlying-ws hooks capture their own epoch
      const INITIAL_RECONNECT_DELAY = 5000;
      const MAX_RECONNECT_DELAY = 60000;
      let reconnectDelay = INITIAL_RECONNECT_DELAY;
      const HEALTH_CHECK_INTERVAL = 30000; // tighter bottom-line probe (was 90s)
      const SILENT_THRESHOLD = 90000; // 90s no SDK activity → probe (was 300s)
      const SLEEP_DETECT_INTERVAL = 5000;
      const SLEEP_JUMP_THRESHOLD = 30000; // clock jump >30s = was sleeping
      const ALIVE_CHECK_WINDOW = 15000; // after connect, must see activity within 15s
      const FEISHU_HOST = 'open.feishu.cn';

      // Track last SDK activity (any event received = alive)
      let _lastActivityAt = Date.now();
      let _connectedAt = 0; // when the current WSClient was (re)started
      function touchActivity() { _lastActivityAt = Date.now(); }

      // Dedup: track recent message_ids (Feishu may redeliver on slow ack)
      const _seenMsgIds = new Map(); // message_id → timestamp
      const DEDUP_TTL = 60000; // 60s window
      function isDuplicate(msgId) {
        if (!msgId) return false;
        const now = Date.now();
        if (_seenMsgIds.size > 200) {
          for (const [k, t] of _seenMsgIds) {
            if (now - t > DEDUP_TTL) _seenMsgIds.delete(k);
          }
        }
        if (_seenMsgIds.has(msgId)) return true;
        _seenMsgIds.set(msgId, now);
        return false;
      }

      function buildDispatcher() {
        return new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            touchActivity();
            try {
              const msg = data.message;
              if (!msg) return;
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
                try {
                  const content = JSON.parse(msg.content);
                  fileInfo = {
                    messageId: msg.message_id,
                    fileKey: content.file_key || content.image_key,
                    fileName: content.file_name || (content.image_key ? `image_${Date.now()}.png` : `file_${Date.now()}`),
                    msgType: msg.message_type,
                  };
                } catch {}
              }

              text = text.replace(/@_user_\d+\s*/g, '').trim();

              if (text || fileInfo) {
                Promise.resolve().then(() => onMessage(chatId, text, data, fileInfo, senderId)).catch((err) => {
                  try { console.error(`[feishu-adapter] onMessage error: ${err && err.message || err}`); } catch { }
                });
              }
            } catch (e) { /* Non-fatal */ }
          },
          'card.action.trigger': async (data) => {
            touchActivity();
            try {
              const action = data.action;
              const chatId = data.open_chat_id || data.chat_id
                || (data.context && data.context.open_chat_id)
                || (data.event && data.event.open_chat_id);
              const senderId = (data.operator && data.operator.open_id)
                || (data.open_id)
                || (data.user && data.user.open_id)
                || (data.context && data.context.open_id)
                || null;
              if (action && chatId) {
                const cmd = action.value && action.value.cmd;
                if (cmd) {
                  Promise.resolve().then(() => onMessage(chatId, cmd, data, null, senderId)).catch((err) => {
                    try { console.error(`[feishu-adapter] card action error: ${err && err.message || err}`); } catch { }
                  });
                }
              }
            } catch (e) { /* Non-fatal */ }
            return {};
          },
        });
      }

      // Hook the underlying ws instance for first-class close/error notification.
      // Lark SDK stores the live WebSocket via wsConfig.setWSInstance; we wrap it
      // so we learn about 'close' immediately instead of waiting for silence.
      // Defensive: SDK internals can change between versions — any failure just
      // downgrades to the silent/health/sleep bottom-lines.
      function hookUnderlyingWs(wsClient, epoch) {
        try {
          const cfg = wsClient && wsClient.wsConfig;
          if (!cfg || typeof cfg.setWSInstance !== 'function') return;
          const orig = cfg.setWSInstance.bind(cfg);
          cfg.setWSInstance = (inst) => {
            orig(inst);
            if (!inst || inst._metameHooked) return;
            inst._metameHooked = true;
            try {
              inst.on('close', () => {
                if (stopped) return;
                if (epoch !== wsEpoch) return; // stale: a newer connect() has superseded this one
                _log('INFO', 'Feishu underlying WS closed — scheduling reconnect');
                scheduleReconnect({ immediate: true, reason: 'ws-close' });
              });
              inst.on('error', (e) => {
                if (epoch !== wsEpoch) return;
                _log('WARN', `Feishu underlying WS error: ${e && e.message || e}`);
              });
            } catch (hookErr) {
              _log('WARN', `Feishu ws event hook failed: ${hookErr.message}`);
            }
          };
        } catch (err) {
          _log('WARN', `Feishu SDK hook unavailable (${err.message}) — falling back to silence/sleep detection`);
        }
      }

      function connect() {
        if (stopped) return;
        clearTimeout(aliveTimer);
        wsEpoch += 1;
        const myEpoch = wsEpoch;
        let ws;
        try {
          ws = new Lark.WSClient({
            appId: app_id,
            appSecret: app_secret,
            loggerLevel: Lark.LoggerLevel.info,
            autoReconnect: false, // we own the reconnect lifecycle
          });
          currentWs = ws;
          hookUnderlyingWs(ws, myEpoch);
          const eventDispatcher = buildDispatcher();
          const startResult = ws.start({ eventDispatcher });
          _connectedAt = Date.now();
          touchActivity();
          _log('INFO', 'Feishu WebSocket connecting...');
          startAliveCheck();
          // start() may return a Promise. Surface async failures into the reconnect pipeline
          // so we don't depend solely on the 15s alive-check to recover.
          if (startResult && typeof startResult.then === 'function') {
            startResult.catch((err) => {
              if (stopped) return;
              if (myEpoch !== wsEpoch) return; // superseded
              _log('ERROR', `Feishu WSClient.start rejected: ${err && err.message || err}`);
              scheduleReconnect({ immediate: true, reason: 'start-rejected', failed: true });
            });
          }
        } catch (err) {
          _log('ERROR', `Feishu WSClient.start failed: ${err.message}`);
          scheduleReconnect({ immediate: true, reason: 'start-failed', failed: true });
        }
      }

      // Single entry point for all reconnect signals. Dedup'd via reconnectScheduled
      // so concurrent ws-close + alive-probe-fail + sleep events collapse into one
      // reconnect. Backoff only grows when the caller marks this as a failure recovery
      // (failed:true) — known-cause resets (manual / system-wake) start from 0s.
      function scheduleReconnect({ immediate = false, reason = '', failed = false } = {}) {
        if (stopped) return;
        if (reconnectScheduled) {
          _log('DEBUG', `Feishu reconnect already scheduled — dropping duplicate (reason: ${reason})`);
          return;
        }
        reconnectScheduled = true;
        clearTimeout(reconnectTimer);
        clearTimeout(aliveTimer);
        try { currentWs?.stop?.(); } catch { /* ignore */ }
        currentWs = null;
        if (failed) {
          // Only failure paths grow the backoff ceiling for the *next* attempt.
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        }
        const delay = immediate ? 0 : reconnectDelay;
        _log('INFO', `Feishu reconnect in ${Math.round(delay / 1000)}s (reason: ${reason || 'unspecified'})`);
        reconnectTimer = setTimeout(async () => {
          reconnectScheduled = false;
          if (stopped) return;
          const net = await waitForNetworkReady(FEISHU_HOST, { log: _log });
          if (stopped) return;
          if (!net.ok) {
            _log('WARN', `Feishu network still down after ${Math.round(net.elapsed / 1000)}s (${net.error || 'unknown'}) — retrying`);
            scheduleReconnect({ immediate: false, reason: 'network-wait-timeout', failed: true });
            return;
          }
          if (net.attempts > 1) {
            _log('INFO', `Feishu network ready after ${net.attempts} attempts (${Math.round(net.elapsed / 1000)}s)`);
          }
          connect();
        }, delay);
      }

      // Alive-check: after each connect, require either SDK activity or a
      // successful API probe within ALIVE_CHECK_WINDOW. Otherwise reconnect.
      // This catches the "WSClient.start returned but underlying socket is
      // dead" case that the 120s SDK loop would otherwise sit on.
      function startAliveCheck() {
        clearTimeout(aliveTimer);
        const connectedAt = _connectedAt;
        aliveTimer = setTimeout(async () => {
          if (stopped) return;
          if (_lastActivityAt > connectedAt) {
            // SDK delivered at least one event strictly after connect → healthy.
            // Using `>` (not `>=`) because connect() calls touchActivity(), so
            // _lastActivityAt === _connectedAt at connect time — `>=` would
            // false-positive immediately without any real post-connect activity.
            reconnectDelay = INITIAL_RECONNECT_DELAY;
            return;
          }
          try {
            await withTimeout(client.im.chat.list({ params: { page_size: 1 } }), 8000);
            touchActivity();
            reconnectDelay = INITIAL_RECONNECT_DELAY;
            _log('INFO', 'Feishu alive probe ok');
          } catch (err) {
            _log('WARN', `Feishu alive probe failed: ${err.message} — reconnecting`);
            scheduleReconnect({ immediate: true, reason: 'alive-probe-failed', failed: true });
          }
        }, ALIVE_CHECK_WINDOW);
      }

      // Health check: bottom-line probe for silent dead-sockets the hooks missed.
      function startHealthCheck() {
        clearInterval(healthTimer);
        healthTimer = setInterval(async () => {
          if (stopped) return;
          const silentMs = Date.now() - _lastActivityAt;
          if (silentMs < SILENT_THRESHOLD) return;
          try {
            await withTimeout(client.im.chat.list({ params: { page_size: 1 } }), 8000);
            touchActivity();
          } catch (err) {
            _log('WARN', `Feishu health check failed after ${Math.round(silentMs / 1000)}s silence: ${err.message} — reconnecting`);
            scheduleReconnect({ immediate: true, reason: 'health-probe-failed', failed: true });
          }
        }, HEALTH_CHECK_INTERVAL);
      }

      // Sleep/wake detector: JS clock jump >30s ⇒ system was suspended.
      function startSleepWakeDetector() {
        let _lastTickAt = Date.now();
        sleepWakeTimer = setInterval(() => {
          if (stopped) return;
          const now = Date.now();
          const elapsed = now - _lastTickAt;
          _lastTickAt = now;
          if (elapsed > SLEEP_JUMP_THRESHOLD) {
            _log('INFO', `Feishu system wake detected (${Math.round(elapsed / 1000)}s gap) — reconnecting`);
            reconnectDelay = INITIAL_RECONNECT_DELAY; // wake is a known cause, not a failure
            scheduleReconnect({ immediate: true, reason: 'system-wake' });
          }
        }, SLEEP_DETECT_INTERVAL);
      }

      // Initial connect
      connect();
      startHealthCheck();
      startSleepWakeDetector();

      return Promise.resolve({
        stop() {
          stopped = true;
          clearTimeout(reconnectTimer);
          clearTimeout(aliveTimer);
          clearInterval(healthTimer);
          clearInterval(sleepWakeTimer);
          try { currentWs?.stop?.(); } catch { /* ignore */ }
          currentWs = null;
        },
        reconnect() {
          _log('INFO', 'Feishu manual reconnect triggered');
          reconnectDelay = INITIAL_RECONNECT_DELAY;
          scheduleReconnect({ immediate: true, reason: 'manual' });
        },
        isAlive() {
          return !stopped && (Date.now() - _lastActivityAt) < SILENT_THRESHOLD;
        },
      });
    },

    client,
  };
}

module.exports = { createBot, _internal: { waitForNetworkReady } };
