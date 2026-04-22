'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBot, _internal } = require('./feishu-adapter');

describe('feishu-adapter sendFile', () => {
  it('uploads small markdown files as real file messages', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-feishu-file-'));
    const filePath = path.join(tempDir, 'handoff.md');
    fs.writeFileSync(filePath, '# handoff\nsmall file\n', 'utf8');

    const bot = createBot({ app_id: 'test-app', app_secret: 'test-secret' });
    const calls = [];
    bot.client.im.file.create = async () => ({ data: { file_key: 'file-key-1' } });
    bot.client.im.message.create = async (payload) => {
      calls.push(payload);
      return { data: { message_id: 'msg-file-1' } };
    };

    const msg = await bot.sendFile('chat-1', filePath);

    assert.deepEqual(msg, { message_id: 'msg-file-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].data.msg_type, 'file');
    assert.match(calls[0].data.content, /file-key-1/);
  });
});

describe('feishu-adapter validateCredentials classification', () => {
  // Regression for the wake-kills-bridge bug: SDK internal errors like
  // "Cannot destructure 'tenant_access_token' of undefined" (network empty
  // response) must NOT be classified as isAuthError, or the bridge refuses
  // to start and requires manual restart.
  async function classify(errorMessage) {
    const bot = createBot({ app_id: 'test-app', app_secret: 'test-secret' });
    bot.client.im.chat.list = async () => { throw new Error(errorMessage); };
    return bot.validateCredentials();
  }

  it('treats SDK token-destructure errors as transient, not auth', async () => {
    const r = await classify("Cannot destructure property 'tenant_access_token' of '(intermediate value)' as it is undefined.");
    assert.equal(r.ok, false);
    assert.equal(r.isAuthError, false);
    assert.match(r.error, /transient/);
  });

  it('treats generic network errors as transient', async () => {
    const r = await classify('Client network socket disconnected before secure TLS connection was established');
    assert.equal(r.isAuthError, false);
  });

  it('treats known Feishu auth error codes as auth', async () => {
    const r = await classify('code: 99991663, msg: invalid tenant access token');
    assert.equal(r.isAuthError, true);
  });

  it('treats HTTP 401 as auth', async () => {
    const r = await classify('request failed with status 401 unauthorized');
    assert.equal(r.isAuthError, true);
  });
});

describe('feishu-adapter waitForNetworkReady', () => {
  const { waitForNetworkReady } = _internal;
  // fake sleep that just advances synchronously — no real waits in tests
  const fastSleep = async () => {};

  it('returns ok on first attempt when lookup resolves', async () => {
    let calls = 0;
    const lookup = async () => { calls += 1; return { address: '1.2.3.4' }; };
    const r = await waitForNetworkReady('open.feishu.cn', { lookup, sleep: fastSleep });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 1);
    assert.equal(calls, 1);
  });

  it('retries until lookup succeeds', async () => {
    let calls = 0;
    const lookup = async () => {
      calls += 1;
      if (calls < 3) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
      return { address: '1.2.3.4' };
    };
    const r = await waitForNetworkReady('open.feishu.cn', { lookup, sleep: fastSleep });
    assert.equal(r.ok, true);
    assert.equal(r.attempts, 3);
  });

  it('returns not-ok when budget is exhausted', async () => {
    const lookup = async () => { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; };
    const r = await waitForNetworkReady('open.feishu.cn', {
      lookup,
      sleep: fastSleep,
      totalBudgetMs: 0, // exit loop immediately after one attempt
    });
    assert.equal(r.ok, false);
    assert.ok(r.attempts >= 1);
    assert.match(r.error, /ENOTFOUND/);
  });
});
