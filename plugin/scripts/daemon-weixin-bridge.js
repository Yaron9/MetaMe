'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeixinApiClient, DEFAULT_BASE_URL, DEFAULT_LONG_POLL_TIMEOUT_MS } = require('./daemon-weixin-api');
const { createWeixinAuthStore } = require('./daemon-weixin-auth');

function extractInboundText(itemList) {
  if (!Array.isArray(itemList)) return '';
  for (const item of itemList) {
    if (item && item.type === 1 && item.text_item && item.text_item.text != null) {
      return String(item.text_item.text).trim();
    }
    if (item && item.type === 3 && item.voice_item && item.voice_item.text) {
      return String(item.voice_item.text).trim();
    }
  }
  return '';
}

function createContextTokenStore() {
  const store = new Map();
  return {
    set(accountId, userId, token) {
      const a = String(accountId || '').trim();
      const u = String(userId || '').trim();
      const t = String(token || '').trim();
      if (!a || !u || !t) return;
      store.set(`${a}:${u}`, t);
    },
    get(accountId, userId) {
      return store.get(`${String(accountId || '').trim()}:${String(userId || '').trim()}`) || null;
    },
    clear(accountId, userId) {
      store.delete(`${String(accountId || '').trim()}:${String(userId || '').trim()}`);
    },
  };
}

function createPersistentContextTokenStore(deps = {}) {
  const mem = deps.tokenStore || createContextTokenStore();
  const HOME = deps.HOME || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const filePath = deps.filePath || pathMod.join(HOME, '.metame', 'weixin', 'context-tokens.json');

  function loadAll() {
    try {
      if (!fsMod.existsSync(filePath)) return {};
      const raw = JSON.parse(fsMod.readFileSync(filePath, 'utf8'));
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  function saveAll(data) {
    try {
      fsMod.mkdirSync(pathMod.dirname(filePath), { recursive: true });
      fsMod.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      try {
        fsMod.chmodSync(filePath, 0o600);
      } catch {}
    } catch {}
  }

  return {
    set(accountId, userId, token) {
      mem.set(accountId, userId, token);
      const key = `${String(accountId || '').trim()}:${String(userId || '').trim()}`;
      const all = loadAll();
      all[key] = {
        token: String(token || '').trim(),
        savedAt: new Date().toISOString(),
      };
      saveAll(all);
    },
    get(accountId, userId) {
      const hit = mem.get(accountId, userId);
      if (hit) return hit;
      const key = `${String(accountId || '').trim()}:${String(userId || '').trim()}`;
      const all = loadAll();
      const token = all[key] && all[key].token ? String(all[key].token).trim() : '';
      if (token) mem.set(accountId, userId, token);
      return token || null;
    },
    clear(accountId, userId) {
      mem.clear(accountId, userId);
      const key = `${String(accountId || '').trim()}:${String(userId || '').trim()}`;
      const all = loadAll();
      if (Object.prototype.hasOwnProperty.call(all, key)) {
        delete all[key];
        saveAll(all);
      }
    },
  };
}

function createWeixinBridge(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const loadConfig = deps.loadConfig;
  const pipeline = deps.pipeline;
  const sleep = typeof deps.sleep === 'function' ? deps.sleep : (ms) => new Promise(resolve => setTimeout(resolve, ms));
  const apiClient = deps.apiClient || createWeixinApiClient({ log });
  const authStore = deps.authStore || createWeixinAuthStore({
    apiClient,
    HOME: deps.HOME,
    log,
    sleep,
  });
  const tokenStore = deps.tokenStore || createPersistentContextTokenStore({ HOME: deps.HOME });

  if (typeof loadConfig !== 'function') throw new Error('loadConfig is required');
  if (!pipeline || typeof pipeline.processMessage !== 'function') throw new Error('pipeline.processMessage is required');

  function resolveBridgeConfig(config) {
    const cfg = (config && config.weixin) || {};
    return {
      enabled: !!cfg.enabled,
      baseUrl: String(cfg.base_url || DEFAULT_BASE_URL).trim(),
      botType: String(cfg.bot_type || '3').trim(),
      routeTag: cfg.route_tag === undefined || cfg.route_tag === null ? null : String(cfg.route_tag).trim(),
      pollTimeoutMs: Number(cfg.poll_timeout_ms || DEFAULT_LONG_POLL_TIMEOUT_MS),
      allowedChatIds: Array.isArray(cfg.allowed_chat_ids) ? cfg.allowed_chat_ids.map(String) : [],
      accountId: String(cfg.account_id || '').trim(),
    };
  }

  function resolveActiveAccount(config) {
    const cfg = resolveBridgeConfig(config);
    const accountId = cfg.accountId || authStore.listAccounts()[0] || '';
    if (!accountId) return null;
    const account = authStore.loadAccount(accountId);
    if (!account || !account.token) return null;
    return {
      accountId,
      token: account.token,
      baseUrl: String(account.baseUrl || cfg.baseUrl || DEFAULT_BASE_URL).trim(),
      routeTag: account.routeTag || cfg.routeTag || null,
    };
  }

  function createWeixinBot(params) {
    const accountId = params.accountId;
    const baseUrl = params.baseUrl;
    const token = params.token;
    const routeTag = params.routeTag;

    async function sendPlain(chatId, text) {
      const contextToken = tokenStore.get(accountId, chatId);
      if (!contextToken) throw new Error(`weixin context token missing for ${chatId}`);
      log('DEBUG', `[WEIXIN] send chatId=${chatId} text_len=${String(text || '').length} ctx=${contextToken.slice(0, 8)}`);
      const result = await apiClient.sendTextMessage({
        baseUrl,
        token,
        routeTag,
        toUserId: chatId,
        contextToken,
        text,
      });
      log('DEBUG', `[WEIXIN] send ok chatId=${chatId} ret=${result && result.ret} payload=${JSON.stringify(result || {})}`);
      return { message_id: Date.now() };
    }

    return {
      suppressAck: true,
      sendMessage: async (_chatId, text) => sendPlain(_chatId, String(text || '').trim()),
      deleteMessage: async () => false,
      sendTyping: async () => {},
    };
  }

  async function startWeixinBridge(config, executeTaskByName) {
    const cfg = resolveBridgeConfig(config);
    if (!cfg.enabled) return null;
    let running = true;
    let processing = false;
    let timer = null;
    let getUpdatesBuf = '';
    let currentAccount = null;
    let currentBot = null;
    let missingAccountLogged = false;
    let pollErrorDelay = 1000;        // exponential backoff on poll errors
    const MAX_POLL_ERROR_DELAY = 30000;

    function sameAccount(a, b) {
      if (!a || !b) return false;
      return a.accountId === b.accountId
        && a.token === b.token
        && a.baseUrl === b.baseUrl
        && a.routeTag === b.routeTag;
    }

    function setActiveAccount(account) {
      if (sameAccount(currentAccount, account) && currentBot) return;
      currentAccount = account;
      currentBot = account ? createWeixinBot(account) : null;
      getUpdatesBuf = '';
      if (account) {
        log('INFO', `[WEIXIN] bridge active account=${account.accountId}`);
      }
    }

    function scheduleNext(delayMs) {
      if (!running) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { pump().catch(() => {}); }, delayMs);
    }

    async function pump() {
      if (!running || processing) return;
      processing = true;
      let nextDelayMs = 250;
      try {
        const liveCfg = loadConfig();
        const liveBridgeCfg = resolveBridgeConfig(liveCfg);
        if (!liveBridgeCfg.enabled) {
          setActiveAccount(null);
          nextDelayMs = 1000;
          return;
        }
        const liveAccount = resolveActiveAccount(liveCfg);
        if (!liveAccount) {
          if (!missingAccountLogged) {
            missingAccountLogged = true;
            log('WARN', '[WEIXIN] bridge enabled but no linked account found; waiting for account link');
          }
          setActiveAccount(null);
          nextDelayMs = 500;
          return;
        }
        missingAccountLogged = false;
        setActiveAccount(liveAccount);
        const resp = await apiClient.getUpdates({
          baseUrl: currentAccount.baseUrl,
          token: currentAccount.token,
          routeTag: currentAccount.routeTag,
          getUpdatesBuf,
          timeoutMs: liveBridgeCfg.pollTimeoutMs,
        });
        pollErrorDelay = 1000; // reset as soon as HTTP poll succeeds — downstream processMessage errors should not cause poll backoff
        if (resp && typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) {
          getUpdatesBuf = resp.get_updates_buf;
        }
        const messages = Array.isArray(resp && resp.msgs) ? resp.msgs : [];
        for (const full of messages) {
          const chatId = String(full && full.from_user_id || '').trim();
          if (!chatId) continue;
          if (liveBridgeCfg.allowedChatIds.length && !liveBridgeCfg.allowedChatIds.includes(chatId)) {
            continue;
          }
          const text = extractInboundText(full.item_list);
          if (!text) continue;
          if (full && full.context_token) {
            tokenStore.set(currentAccount.accountId, chatId, full.context_token);
          }
          log('DEBUG', `[WEIXIN] inbound chatId=${chatId} text_len=${text.length} has_ctx=${!!(full && full.context_token)} buf=${String(getUpdatesBuf || '').slice(0, 16)}`);
          await pipeline.processMessage(chatId, text, {
            bot: currentBot,
            config: liveCfg,
            executeTaskByName,
            senderId: chatId,
            readOnly: false,
          });
        }
      } catch (err) {
        log('WARN', `[WEIXIN] poll error: ${err.message} — retrying in ${Math.round(pollErrorDelay / 1000)}s`);
        nextDelayMs = pollErrorDelay;
        pollErrorDelay = Math.min(pollErrorDelay * 2, MAX_POLL_ERROR_DELAY);
      } finally {
        processing = false;
        scheduleNext(nextDelayMs);
      }
    }

    scheduleNext(0);
    return {
      stop() {
        running = false;
        if (timer) clearTimeout(timer);
      },
      reconnect() {
        getUpdatesBuf = '';
        scheduleNext(0);
      },
      get bot() {
        return currentBot;
      },
      get accountId() {
        return currentAccount ? currentAccount.accountId : null;
      },
    };
  }

  return {
    startWeixinBridge,
    createWeixinBot,
    createContextTokenStore,
    createPersistentContextTokenStore,
    resolveBridgeConfig,
    resolveActiveAccount,
  };
}

module.exports = {
  createWeixinBridge,
  createContextTokenStore,
  createPersistentContextTokenStore,
  extractInboundText,
};
