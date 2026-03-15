'use strict';
/**
 * daemon-siri-bridge.js — HTTP bridge for Siri Shortcuts integration
 *
 * Exposes GET/POST /ask endpoint and returns plain text.
 * Processes through the same Claude pipeline as Telegram/Feishu/iMessage.
 * Designed for iOS Shortcuts: Dictate → HTTP GET/POST → Speak Text.
 */

const http = require('http');
const querystring = require('querystring');

function createSiriBridge(deps) {
  const { log, loadConfig, handleCommand } = deps;

  function writeText(res, statusCode, text, extraHeaders = {}) {
    const body = String(text || '');
    res.writeHead(statusCode, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    res.end(body);
  }

  function writeJson(res, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    res.end(body);
  }

  function normalizePlainText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
  }

  function getAuthToken(req, urlObj) {
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (auth) return auth;
    return String(urlObj.searchParams.get('token') || req.headers['x-api-key'] || '').trim();
  }

  async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  function extractAskText(req, urlObj, rawBody) {
    const queryText = normalizePlainText(urlObj.searchParams.get('q') || urlObj.searchParams.get('text') || '');
    if (queryText) return queryText;

    const body = String(rawBody || '');
    if (!body.trim()) return '';

    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType === 'application/json') {
      try {
        const parsed = JSON.parse(body);
        return normalizePlainText(
          parsed && typeof parsed === 'object'
            ? (parsed.text || parsed.q || parsed.prompt || '')
            : ''
        );
      } catch {
        return '';
      }
    }

    if (contentType === 'application/x-www-form-urlencoded') {
      const parsed = querystring.parse(body);
      return normalizePlainText(parsed.text || parsed.q || parsed.prompt || '');
    }

    return normalizePlainText(body);
  }

  /**
   * Collector bot — captures Claude's response instead of sending to a chat.
   * handleCommand calls bot.sendMessage / sendMarkdown / editMessage as it
   * streams; we collect everything and return the final text.
   */
  function createCollectorBot() {
    const messages = new Map();
    let nextId = 1;

    const bot = {
      suppressAck: true,
      sendMessage: async (_chatId, text) => {
        const id = nextId++;
        messages.set(id, String(text || ''));
        return { message_id: id };
      },
      sendMarkdown: async (_chatId, text) => {
        const id = nextId++;
        messages.set(id, String(text || '').replace(/[*_`~#>]/g, '').trim());
        return { message_id: id };
      },
      editMessage: async (_chatId, msgId, text) => {
        const plain = String(text || '').replace(/[*_`~#>]/g, '').trim();
        messages.set(msgId, plain);
        return true;
      },
      deleteMessage: async () => false,
      sendTyping: async () => {},
      getResult: () => {
        let last = '';
        for (const [, text] of messages) {
          if (text && text.trim()) last = text.trim();
        }
        return last;
      },
    };
    return bot;
  }

  function startSiriBridge(config, executeTaskByName) {
    const cfg = config.siri_bridge || {};
    if (!cfg.enabled) return null;

    const port = cfg.port || 8200;
    const token = cfg.token || '';
    const chatId = cfg.chat_id || '_siri_';
    const timeoutMs = cfg.timeout_ms || 120000;
    const maxReplyLen = cfg.max_reply_length || 0; // 0 = unlimited

    if (!token) {
      log('WARN', '[SIRI] siri_bridge.token not configured — bridge disabled');
      return null;
    }

    const server = http.createServer(async (req, res) => {
      log('DEBUG', `[SIRI] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
          'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
      }

      // Health check
      if (req.method === 'GET' && urlObj.pathname === '/health') {
        writeJson(res, 200, { status: 'ok' });
        return;
      }

      // Quick echo test — GET /echo?t=xxx returns plain text immediately
      if (req.method === 'GET' && urlObj.pathname === '/echo') {
        const t = normalizePlainText(urlObj.searchParams.get('t') || 'hello from jarvis');
        writeText(res, 200, t);
        return;
      }

      // /ask supports GET for iOS Shortcuts and POST for compatibility.
      if (!['GET', 'POST'].includes(req.method) || urlObj.pathname !== '/ask') {
        writeText(res, 404, 'Not Found');
        return;
      }

      // Auth
      const auth = getAuthToken(req, urlObj);
      if (auth !== token) {
        writeText(res, 401, 'Unauthorized');
        return;
      }

      const rawBody = req.method === 'POST' ? await readRequestBody(req) : '';
      const text = extractAskText(req, urlObj, rawBody);
      if (!text) {
        writeText(res, 400, 'Missing q/text');
        return;
      }

      log('INFO', `[SIRI] Received: "${text.slice(0, 80)}"`);

      // Timeout guard
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        writeText(res, 504, 'timeout');
      }, timeoutMs);

      try {
        const bot = createCollectorBot();
        const liveCfg = loadConfig();
        await handleCommand(bot, chatId, text, liveCfg, executeTaskByName, null, true);

        if (timedOut) return;
        clearTimeout(timer);

        let reply = bot.getResult() || '(no response)';
        if (maxReplyLen && reply.length > maxReplyLen) {
          reply = reply.slice(0, maxReplyLen) + '...';
        }

        log('INFO', `[SIRI] Reply: "${reply.slice(0, 80)}"`);
        writeText(res, 200, reply);
      } catch (err) {
        if (timedOut) return;
        clearTimeout(timer);
        log('ERROR', `[SIRI] Error: ${err.message}`);
        writeText(res, 500, err.message);
      }
    });

    server.listen(port, '0.0.0.0', () => {
      log('INFO', `[SIRI] HTTP bridge listening on 0.0.0.0:${port}`);
    });

    server.on('error', (err) => {
      log('ERROR', `[SIRI] Server error: ${err.message}`);
    });

    return { stop: () => server.close() };
  }

  return { startSiriBridge };
}

module.exports = { createSiriBridge };
