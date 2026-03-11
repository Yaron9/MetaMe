'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileBrowser } = require('./daemon-file-browser');

describe('daemon-file-browser sendFileButtons', () => {
  it('prefers direct file send when adapter supports it', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-file-browser-'));
    const filePath = path.join(tempDir, 'handoff.md');
    fs.writeFileSync(filePath, '# handoff\n', 'utf8');

    const browser = createFileBrowser({
      fs,
      path,
      HOME: os.homedir(),
      shortenPath: (p) => p,
      expandPath: (p) => p,
    });

    const sentFiles = [];
    const sentMsgs = await browser.sendFileButtons({
      sendFile: async (_chatId, p) => {
        sentFiles.push(p);
        return { message_id: 'file-msg-1' };
      },
      sendButtons: async () => { throw new Error('should not use buttons'); },
      sendMessage: async () => { throw new Error('should not use text fallback'); },
    }, 'chat-1', new Set([filePath]));

    assert.deepEqual(sentFiles, [filePath]);
    assert.deepEqual(sentMsgs, [{ message_id: 'file-msg-1' }]);
  });

  it('falls back to plain message when sendButtons fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-file-browser-'));
    const filePath = path.join(tempDir, 'handoff.md');
    fs.writeFileSync(filePath, '# handoff\n', 'utf8');

    const browser = createFileBrowser({
      fs,
      path,
      HOME: os.homedir(),
      shortenPath: (p) => p,
      expandPath: (p) => p,
    });

    const sent = [];
    const sentMsgs = await browser.sendFileButtons({
      sendButtons: async () => { throw new Error('400 bad request'); },
      sendMessage: async (_chatId, text) => {
        sent.push(String(text));
        return { message_id: 'fallback-msg-1' };
      },
    }, 'chat-1', new Set([filePath]));

    assert.equal(sent.length, 1);
    assert.match(sent[0], /文件已生成/);
    assert.match(sent[0], /handoff\.md/);
    assert.deepEqual(sentMsgs, [{ message_id: 'fallback-msg-1' }]);
  });

  it('falls back to plain message when direct file send fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-file-browser-'));
    const filePath = path.join(tempDir, 'handoff.md');
    fs.writeFileSync(filePath, '# handoff\n', 'utf8');

    const browser = createFileBrowser({
      fs,
      path,
      HOME: os.homedir(),
      shortenPath: (p) => p,
      expandPath: (p) => p,
    });

    const sent = [];
    const sentMsgs = await browser.sendFileButtons({
      sendFile: async () => { throw new Error('upload failed'); },
      sendButtons: async () => { throw new Error('should not hit button fallback'); },
      sendMessage: async (_chatId, text) => {
        sent.push(String(text));
        return { message_id: 'fallback-msg-2' };
      },
    }, 'chat-1', new Set([filePath]));

    assert.equal(sent.length, 1);
    assert.match(sent[0], /文件已生成/);
    assert.deepEqual(sentMsgs, [{ message_id: 'fallback-msg-2' }]);
  });

  it('avoids button cards for stream-style bots', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-file-browser-'));
    const filePath = path.join(tempDir, 'handoff.md');
    fs.writeFileSync(filePath, '# handoff\n', 'utf8');

    const browser = createFileBrowser({
      fs,
      path,
      HOME: os.homedir(),
      shortenPath: (p) => p,
      expandPath: (p) => p,
    });

    const sent = [];
    const sentMsgs = await browser.sendFileButtons({
      editMessage: async () => true,
      sendButtons: async () => { throw new Error('should not use buttons in stream mode'); },
      sendMessage: async (_chatId, text) => {
        sent.push(String(text));
        return { message_id: 'fallback-msg-3' };
      },
    }, 'chat-1', new Set([filePath]));

    assert.equal(sent.length, 1);
    assert.match(sent[0], /文件已生成/);
    assert.deepEqual(sentMsgs, [{ message_id: 'fallback-msg-3' }]);
  });
});
