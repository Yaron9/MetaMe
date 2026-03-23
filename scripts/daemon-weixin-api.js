'use strict';

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35000;
const DEFAULT_API_TIMEOUT_MS = 15000;
const DEFAULT_QR_POLL_TIMEOUT_MS = 35000;

function ensureTrailingSlash(url) {
  const text = String(url || '').trim();
  return text.endsWith('/') ? text : `${text}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function generateClientId() {
  return `metame-weixin-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function buildHeaders(body, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body || '', 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (opts.token) {
    headers.AuthorizationType = 'ilink_bot_token';
    headers.Authorization = `Bearer ${String(opts.token).trim()}`;
  }
  if (opts.routeTag !== undefined && opts.routeTag !== null && String(opts.routeTag).trim()) {
    headers.SKRouteTag = String(opts.routeTag).trim();
  }
  if (opts.extraHeaders && typeof opts.extraHeaders === 'object') {
    Object.assign(headers, opts.extraHeaders);
  }
  return headers;
}

function createAbortSignal(timeoutMs) {
  if (!(timeoutMs > 0)) return { signal: undefined, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

function createWeixinApiClient(deps = {}) {
  const fetchImpl = deps.fetchImpl || global.fetch;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const baseInfo = deps.baseInfo || { channel_version: 'metame-weixin-bridge' };

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  async function requestJson(params) {
    const baseUrl = String(params.baseUrl || DEFAULT_BASE_URL).trim();
    const endpoint = String(params.endpoint || '').replace(/^\/+/, '');
    const body = JSON.stringify(params.body || {});
    const url = new URL(endpoint, ensureTrailingSlash(baseUrl)).toString();
    const aborter = createAbortSignal(params.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: params.method || 'POST',
        headers: buildHeaders(body, {
          token: params.token,
          routeTag: params.routeTag,
          extraHeaders: params.extraHeaders,
        }),
        body,
        signal: aborter.signal,
      });
      const rawText = await response.text();
      let parsed;
      try {
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch {
        parsed = { rawText };
      }
      if (!response.ok) {
        const err = new Error(`${params.label || endpoint} failed: ${response.status} ${response.statusText}`);
        err.status = response.status;
        err.response = parsed;
        err.rawText = rawText;
        throw err;
      }
      return { response, data: parsed, rawText };
    } finally {
      aborter.cancel();
    }
  }

  async function getBotQrCode(params = {}) {
    const baseUrl = String(params.baseUrl || DEFAULT_BASE_URL).trim();
    const botType = String(params.botType || '3').trim();
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, ensureTrailingSlash(baseUrl)).toString();
    const aborter = createAbortSignal(params.timeoutMs || DEFAULT_API_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: params.routeTag ? { SKRouteTag: String(params.routeTag).trim() } : {},
        signal: aborter.signal,
      });
      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};
      if (!response.ok) {
        const err = new Error(`get_bot_qrcode failed: ${response.status} ${response.statusText}`);
        err.status = response.status;
        err.response = data;
        throw err;
      }
      return data;
    } finally {
      aborter.cancel();
    }
  }

  async function getQrCodeStatus(params = {}) {
    const baseUrl = String(params.baseUrl || DEFAULT_BASE_URL).trim();
    const qrcode = String(params.qrcode || '').trim();
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, ensureTrailingSlash(baseUrl)).toString();
    const aborter = createAbortSignal(params.timeoutMs || DEFAULT_QR_POLL_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        headers: {
          'iLink-App-ClientVersion': '1',
          ...(params.routeTag ? { SKRouteTag: String(params.routeTag).trim() } : {}),
        },
        signal: aborter.signal,
      });
      const rawText = await response.text();
      const data = rawText ? JSON.parse(rawText) : {};
      if (!response.ok) {
        const err = new Error(`get_qrcode_status failed: ${response.status} ${response.statusText}`);
        err.status = response.status;
        err.response = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') return { status: 'wait' };
      throw err;
    } finally {
      aborter.cancel();
    }
  }

  async function getUpdates(params = {}) {
    try {
      const result = await requestJson({
        label: 'getUpdates',
        baseUrl: params.baseUrl,
        endpoint: 'ilink/bot/getupdates',
        token: params.token,
        routeTag: params.routeTag,
        timeoutMs: params.timeoutMs || DEFAULT_LONG_POLL_TIMEOUT_MS,
        body: {
          get_updates_buf: params.getUpdatesBuf || '',
          base_info: baseInfo,
        },
      });
      return result.data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf || '' };
      }
      throw err;
    }
  }

  async function sendTextMessage(params = {}) {
    if (!String(params.contextToken || '').trim()) {
      throw new Error('contextToken is required');
    }
    const text = String(params.text || '');
    const clientId = String(params.clientId || generateClientId()).trim();
    const result = await requestJson({
      label: 'sendMessage',
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/sendmessage',
      token: params.token,
      routeTag: params.routeTag,
      timeoutMs: params.timeoutMs || DEFAULT_API_TIMEOUT_MS,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: String(params.toUserId || '').trim(),
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: String(params.contextToken).trim(),
          item_list: [
            {
              type: 1,
              text_item: { text },
            },
          ],
        },
        base_info: baseInfo,
      },
    });
    return result.data;
  }

  async function getConfig(params = {}) {
    const result = await requestJson({
      label: 'getConfig',
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getconfig',
      token: params.token,
      routeTag: params.routeTag,
      timeoutMs: params.timeoutMs || DEFAULT_API_TIMEOUT_MS,
      body: {
        ilink_user_id: String(params.userId || '').trim(),
        context_token: params.contextToken ? String(params.contextToken).trim() : undefined,
        base_info: baseInfo,
      },
    });
    return result.data;
  }

  async function sendTyping(params = {}) {
    const result = await requestJson({
      label: 'sendTyping',
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/sendtyping',
      token: params.token,
      routeTag: params.routeTag,
      timeoutMs: params.timeoutMs || DEFAULT_API_TIMEOUT_MS,
      body: {
        ilink_user_id: String(params.userId || '').trim(),
        typing_ticket: String(params.typingTicket || '').trim(),
        status: params.status,
        base_info: baseInfo,
      },
    });
    return result.data;
  }

  return {
    DEFAULT_BASE_URL,
    getBotQrCode,
    getQrCodeStatus,
    getUpdates,
    sendTextMessage,
    getConfig,
    sendTyping,
    _requestJson: requestJson,
    _log: log,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  DEFAULT_API_TIMEOUT_MS,
  DEFAULT_QR_POLL_TIMEOUT_MS,
  createWeixinApiClient,
  ensureTrailingSlash,
  generateClientId,
};
