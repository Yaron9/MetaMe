'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createWeixinBridge, createContextTokenStore, describeFetchError } = require('./daemon-weixin-bridge');

test('weixin bridge routes inbound text through pipeline and caches context token', async () => {
  const handled = [];
  const sent = [];
  const apiClient = {
    async getUpdates() {
      if (this._done) return { msgs: [], get_updates_buf: 'cursor-1' };
      this._done = true;
      return {
        get_updates_buf: 'cursor-1',
        msgs: [{
          from_user_id: 'alice@im.wechat',
          context_token: 'ctx-1',
          item_list: [{ type: 1, text_item: { text: '你好' } }],
        }],
      };
    },
    async sendTextMessage(params) {
      sent.push(params);
      return { ret: 0 };
    },
  };
  const authStore = {
    listAccounts: () => ['bot@im.bot'],
    loadAccount: () => ({
      accountId: 'bot@im.bot',
      token: 'token-1',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    }),
  };

  const bridge = createWeixinBridge({
    log: () => {},
    loadConfig: () => ({ weixin: { enabled: true } }),
    pipeline: {
      async processMessage(chatId, text, ctx) {
        handled.push({ chatId, text });
        await ctx.bot.sendMessage(chatId, '回你');
      },
    },
    apiClient,
    authStore,
    tokenStore: createContextTokenStore(),
  });

  const running = await bridge.startWeixinBridge({ weixin: { enabled: true } }, async () => {});
  await new Promise(resolve => setTimeout(resolve, 30));
  running.stop();

  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0], { chatId: 'alice@im.wechat', text: '你好' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].contextToken, 'ctx-1');
  assert.equal(sent[0].toUserId, 'alice@im.wechat');
});

test('weixin bridge bot refuses outbound send without cached context token', async () => {
  const bridge = createWeixinBridge({
    log: () => {},
    loadConfig: () => ({ weixin: { enabled: false } }),
    pipeline: { processMessage: async () => {} },
    apiClient: {
      async sendTextMessage() {
        throw new Error('should not reach');
      },
    },
    authStore: {
      listAccounts: () => [],
      loadAccount: () => null,
    },
    tokenStore: createContextTokenStore(),
  });

  const bot = bridge.createWeixinBot({
    accountId: 'bot@im.bot',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'token-1',
    routeTag: null,
  });

  await assert.rejects(
    () => bot.sendMessage('alice@im.wechat', 'hello'),
    /context token missing/
  );
});

test('describeFetchError surfaces the underlying cause of a bare "fetch failed"', () => {
  // DNS failure: the actionable code lives on err.cause, not err.message.
  const dnsErr = new TypeError('fetch failed');
  dnsErr.cause = Object.assign(new Error('getaddrinfo ENOTFOUND ilinkai.weixin.qq.com'), {
    code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'ilinkai.weixin.qq.com',
  });
  const dns = describeFetchError(dnsErr);
  assert.match(dns, /fetch failed/);
  assert.match(dns, /ENOTFOUND/);
  assert.match(dns, /getaddrinfo/);
  assert.match(dns, /ilinkai\.weixin\.qq\.com/);

  // undici connect timeout: code only, no syscall/hostname.
  const toErr = new TypeError('fetch failed');
  toErr.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  assert.match(describeFetchError(toErr), /UND_ERR_CONNECT_TIMEOUT/);

  // errno-only cause still yields something better than "fetch failed".
  const ecoErr = new TypeError('fetch failed');
  ecoErr.cause = Object.assign(new Error('connect ECONNREFUSED'), { errno: -61 });
  assert.match(describeFetchError(ecoErr), /errno -61/);

  // Plain error (no cause) and null are handled.
  assert.equal(describeFetchError(new Error('boom')), 'boom');
  assert.equal(describeFetchError(null), 'unknown error');

  // A cyclic cause chain must not loop forever.
  const a = new Error('a');
  const b = new Error('b');
  a.cause = b; b.cause = a;
  assert.doesNotThrow(() => describeFetchError(a));
});

test('weixin bridge surfaces fetch cause, dedupes repeat poll errors, and logs recovery', async () => {
  const logs = [];
  const log = (level, msg) => logs.push([level, String(msg)]);
  let calls = 0;
  const makeFetchFailed = () => {
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND ilinkai.weixin.qq.com'), {
      code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'ilinkai.weixin.qq.com',
    });
    return e;
  };
  const apiClient = {
    async getUpdates() {
      calls += 1;
      if (calls <= 3) throw makeFetchFailed();   // transient streak
      return { msgs: [], get_updates_buf: 'cursor' }; // then recovers
    },
    async sendTextMessage() { return { ret: 0 }; },
  };
  const authStore = {
    listAccounts: () => ['bot@im.bot'],
    loadAccount: () => ({ accountId: 'bot@im.bot', token: 'token-1', baseUrl: 'https://ilinkai.weixin.qq.com' }),
  };
  // Tiny backoff so the failure streak + recovery completes within the test window.
  const fastCfg = { weixin: { enabled: true, poll_error_backoff_ms: 5, poll_error_backoff_max_ms: 10 } };

  const bridge = createWeixinBridge({
    log,
    loadConfig: () => fastCfg,
    pipeline: { processMessage: async () => {} },
    apiClient,
    authStore,
    tokenStore: createContextTokenStore(),
  });

  const running = await bridge.startWeixinBridge(fastCfg, async () => {});
  await new Promise(resolve => setTimeout(resolve, 120));
  running.stop();

  const pollErrors = logs.filter(([, m]) => m.includes('poll error'));
  assert.ok(pollErrors.length >= 2, 'expected several poll-error attempts');
  // Diagnosable: every poll-error line carries the real cause, not bare "fetch failed".
  assert.ok(pollErrors.every(([, m]) => m.includes('ENOTFOUND')));
  // Dedupe: identical cause logs WARN exactly once, repeats drop to DEBUG.
  const warns = pollErrors.filter(([lvl]) => lvl === 'WARN');
  const debugs = pollErrors.filter(([lvl]) => lvl === 'DEBUG');
  assert.equal(warns.length, 1);
  assert.ok(debugs.length >= 1, 'repeat failures should drop to DEBUG');
  // Recovery is observable.
  assert.ok(logs.some(([lvl, m]) => lvl === 'INFO' && m.includes('poll recovered')));
});

test('weixin bridge keeps retrying until an account is linked', async () => {
  const handled = [];
  const sent = [];
  let linked = false;
  const apiClient = {
    async getUpdates() {
      if (this._done) return { msgs: [], get_updates_buf: 'cursor-2' };
      this._done = true;
      return {
        get_updates_buf: 'cursor-1',
        msgs: [{
          from_user_id: 'alice@im.wechat',
          context_token: 'ctx-late',
          item_list: [{ type: 1, text_item: { text: '绑定后再试' } }],
        }],
      };
    },
    async sendTextMessage(params) {
      sent.push(params);
      return { ret: 0 };
    },
  };
  const authStore = {
    listAccounts: () => (linked ? ['bot@im.bot'] : []),
    loadAccount: () => (linked ? {
      accountId: 'bot@im.bot',
      token: 'token-late',
      baseUrl: 'https://ilinkai.weixin.qq.com',
    } : null),
  };

  const bridge = createWeixinBridge({
    log: () => {},
    loadConfig: () => ({ weixin: { enabled: true } }),
    pipeline: {
      async processMessage(chatId, text, ctx) {
        handled.push({ chatId, text });
        await ctx.bot.sendMessage(chatId, '现在可以了');
      },
    },
    apiClient,
    authStore,
    tokenStore: createContextTokenStore(),
  });

  const running = await bridge.startWeixinBridge({ weixin: { enabled: true } }, async () => {});
  await new Promise(resolve => setTimeout(resolve, 40));
  linked = true;
  await new Promise(resolve => setTimeout(resolve, 700));
  running.stop();

  assert.equal(handled.length, 1);
  assert.deepEqual(handled[0], { chatId: 'alice@im.wechat', text: '绑定后再试' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].contextToken, 'ctx-late');
});
