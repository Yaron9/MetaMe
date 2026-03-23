'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWeixinAuthStore } = require('./daemon-weixin-auth');

test('weixin auth store persists confirmed account after qr login', async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-weixin-auth-'));
  const calls = [];
  const apiClient = {
    async getBotQrCode(params) {
      calls.push(['start', params]);
      return { qrcode: 'qr-1', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/demo' };
    },
    async getQrCodeStatus(params) {
      calls.push(['wait', params]);
      return {
        status: 'confirmed',
        ilink_bot_id: 'bot@im.bot',
        ilink_user_id: 'user@im.wechat',
        bot_token: 'token-1',
        baseurl: 'https://ilinkai.weixin.qq.com',
      };
    },
  };

  try {
    const store = createWeixinAuthStore({
      HOME,
      apiClient,
      sleep: async () => {},
    });

    const session = await store.startQrLogin({ sessionKey: 's1', botType: '3' });
    assert.equal(session.qrcode, 'qr-1');

    const result = await store.waitForQrLogin({ sessionKey: 's1', timeoutMs: 1000 });
    assert.equal(result.connected, true);
    assert.equal(result.account.accountId, 'bot@im.bot');
    assert.equal(store.listAccounts()[0], 'bot@im.bot');
    assert.equal(store.loadAccount('bot@im.bot').userId, 'user@im.wechat');
    assert.equal(calls.length, 2);
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});

test('weixin auth store rejects unsafe session key values', async () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-weixin-auth-'));
  const store = createWeixinAuthStore({
    HOME,
    apiClient: {
      async getBotQrCode() {
        throw new Error('should not reach api');
      },
    },
    sleep: async () => {},
  });

  try {
    await assert.rejects(
      () => store.startQrLogin({ sessionKey: '../../daemon_state' }),
      /invalid sessionKey/
    );
  } finally {
    fs.rmSync(HOME, { recursive: true, force: true });
  }
});
