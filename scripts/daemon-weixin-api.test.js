'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWeixinApiClient } = require('./daemon-weixin-api');

test('weixin api client sends token-auth message payload', async () => {
  const calls = [];
  const client = createWeixinApiClient({
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async text() { return '{"ret":0}'; },
      };
    },
  });

  const result = await client.sendTextMessage({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    token: 'secret-token',
    toUserId: 'alice@im.wechat',
    contextToken: 'ctx-1',
    text: 'hello',
  });

  assert.equal(result.ret, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendmessage$/);
  assert.match(calls[0].opts.headers.Authorization, /^Bearer secret-token$/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.msg.from_user_id, '');
  assert.equal(body.msg.to_user_id, 'alice@im.wechat');
  assert.match(body.msg.client_id, /^metame-weixin-/);
  assert.equal(body.msg.message_type, 2);
  assert.equal(body.msg.message_state, 2);
  assert.equal(body.msg.context_token, 'ctx-1');
  assert.equal(body.msg.item_list[0].text_item.text, 'hello');
});

test('weixin api client throws on missing context token', async () => {
  const client = createWeixinApiClient({
    fetchImpl: async () => {
      throw new Error('should not reach fetch');
    },
  });

  await assert.rejects(
    () => client.sendTextMessage({ toUserId: 'alice@im.wechat', text: 'hello' }),
    /contextToken is required/
  );
});
