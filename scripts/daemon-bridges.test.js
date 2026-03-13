'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const telegramAdapterPath = require.resolve('./telegram-adapter.js');
const originalTelegramAdapter = require.cache[telegramAdapterPath];

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('daemon-bridges telegram reply routing', () => {
  let tempHome;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-bridges-'));
  });

  afterEach(() => {
    if (originalTelegramAdapter) require.cache[telegramAdapterPath] = originalTelegramAdapter;
    else delete require.cache[telegramAdapterPath];
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('routes quoted replies to the replied team member instead of the sticky member', async () => {
    const updates = [[{
      update_id: 1,
      message: {
        message_id: 200,
        chat: { id: 1001 },
        from: { id: 42 },
        text: '继续这个任务',
        reply_to_message: { message_id: 321 },
      },
    }], []];
    const handled = [];
    const sent = [];
    let restoreArgs = null;
    const state = {
      sessions: {},
      team_sticky: { '1001': 'stick' },
      msg_sessions: {
        '321': {
          id: 'sid-reply',
          cwd: tempHome,
          engine: 'claude',
          logicalChatId: '_agent_target',
          agentKey: 'target',
        },
      },
    };

    require.cache[telegramAdapterPath] = {
      id: telegramAdapterPath,
      filename: telegramAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          let pollCount = 0;
          return {
            async getMe() { return { username: 'jarvis_test_bot' }; },
            async getUpdates() {
              pollCount += 1;
              if (pollCount === 1) return updates.shift() || [];
              await new Promise(resolve => setTimeout(resolve, 5));
              return updates.shift() || [];
            },
            async sendMessage(chatId, text) {
              sent.push({ chatId, text });
              return { message_id: 999 };
            },
            async sendMarkdown(chatId, text) {
              sent.push({ chatId, text, markdown: true });
              return { message_id: 999 };
            },
            async answerCallback() {},
            async downloadFile() {},
            async sendTyping() {},
          };
        },
      },
    };

    delete require.cache[require.resolve('./daemon-bridges.js')];
    const { createBridgeStarter } = require('./daemon-bridges.js');

    const bridge = createBridgeStarter({
      fs,
      path,
      HOME: tempHome,
      log: () => {},
      sleep: async () => {},
      loadConfig: () => ({
        telegram: {
          enabled: true,
          bot_token: 'fake-token',
          allowed_chat_ids: [1001],
          chat_agent_map: { '1001': 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'claude',
            team: [
              { key: 'stick', name: 'Stick', icon: 'S', nicknames: ['stick'] },
              { key: 'target', name: 'Target', icon: 'T', nicknames: ['target'] },
            ],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: (chatId, mapped) => {
        restoreArgs = { chatId, mapped };
        return mapped;
      },
      handleCommand: async (_bot, chatId, text) => {
        handled.push({ chatId, text });
      },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    });

    const running = await bridge.startTelegramBridge({
      telegram: { enabled: true, bot_token: 'fake-token', allowed_chat_ids: [1001] },
    }, async () => {});

    await flush();
    await flush();
    running.stop();
    await flush();

    assert.deepEqual(restoreArgs, {
      chatId: 1001,
      mapped: state.msg_sessions['321'],
    });
    assert.equal(handled.length, 1);
    assert.equal(handled[0].chatId, '_agent_target');
    assert.equal(handled[0].text, '继续这个任务');
    assert.equal(state.team_sticky['1001'], 'target');
    assert.equal(sent.length, 0);
  });
});
