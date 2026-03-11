'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBot } = require('./feishu-adapter');

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
