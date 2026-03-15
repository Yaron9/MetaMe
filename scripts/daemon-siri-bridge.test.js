'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { createSiriBridge } = require('./daemon-siri-bridge');

function request({ method = 'GET', port, path = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: data,
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('daemon-siri-bridge', () => {
  it('accepts GET /ask?q= and returns plain text', async () => {
    const bridge = createSiriBridge({
      log: () => {},
      loadConfig: () => ({ siri_bridge: { enabled: true, port: 18200, token: 'secret', chat_id: '_siri_', timeout_ms: 3000 } }),
      handleCommand: async (bot, chatId, text) => {
        assert.equal(chatId, '_siri_');
        assert.equal(text, 'hello jarvis');
        await bot.sendMessage(chatId, `reply:${text}`);
      },
    }).startSiriBridge({ siri_bridge: { enabled: true, port: 18200, token: 'secret', chat_id: '_siri_', timeout_ms: 3000 } });

    try {
      const res = await request({
        port: 18200,
        path: '/ask?q=hello%20jarvis&token=secret',
      });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type'] || ''), /^text\/plain/);
      assert.equal(res.body, 'reply:hello jarvis');
    } finally {
      bridge.stop();
    }
  });

  it('accepts POST /ask with plain text body', async () => {
    const bridge = createSiriBridge({
      log: () => {},
      loadConfig: () => ({ siri_bridge: { enabled: true, port: 18201, token: 'secret', chat_id: '_siri_', timeout_ms: 3000 } }),
      handleCommand: async (bot, chatId, text) => {
        await bot.sendMarkdown(chatId, `**ok** ${text}`);
      },
    }).startSiriBridge({ siri_bridge: { enabled: true, port: 18201, token: 'secret', chat_id: '_siri_', timeout_ms: 3000 } });

    try {
      const res = await request({
        method: 'POST',
        port: 18201,
        path: '/ask',
        headers: {
          Authorization: 'Bearer secret',
          'Content-Type': 'text/plain; charset=utf-8',
        },
        body: 'post body',
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body, 'ok post body');
    } finally {
      bridge.stop();
    }
  });
});
