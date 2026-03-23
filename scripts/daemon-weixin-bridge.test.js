'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWeixinBridge, createContextTokenStore } = require('./daemon-weixin-bridge');

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
