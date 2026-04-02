'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMessagePipeline } = require('./daemon-message-pipeline');

const telegramAdapterPath = require.resolve('./telegram-adapter.js');
const originalTelegramAdapter = require.cache[telegramAdapterPath];
const feishuAdapterPath = require.resolve('./feishu-adapter.js');
const originalFeishuAdapter = require.cache[feishuAdapterPath];

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
    if (originalFeishuAdapter) require.cache[feishuAdapterPath] = originalFeishuAdapter;
    else delete require.cache[feishuAdapterPath];
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
      pipeline: {
        processMessage: async (chatId, text, ctx) => {
          // Delegate to handleCommand for test observability
          handled.push({ chatId, text });
        },
        isActive: () => false,
        interruptActive: () => false,
        clearQueue: () => {},
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

  it('stops the replied team member using the reply logical chat id', async () => {
    const updates = [[{
      update_id: 1,
      message: {
        message_id: 201,
        chat: { id: 1001 },
        from: { id: 42 },
        text: '/stop',
        reply_to_message: { message_id: 321 },
      },
    }], []];
    const sent = [];
    const interrupts = [];
    const clears = [];
    const state = {
      sessions: {},
      team_sticky: { '1001': 'stick' },
      msg_sessions: {
        '321': {
          id: 'sid-reply',
          cwd: tempHome,
          engine: 'claude',
          logicalChatId: '_agent_target::thread:1001:321',
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
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline: {
        processMessage: async () => {},
        isActive: () => false,
        interruptActive: (chatId) => {
          interrupts.push(chatId);
          return true;
        },
        clearQueue: (chatId) => clears.push(chatId),
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

    assert.deepEqual(clears, ['_agent_target::thread:1001:321']);
    assert.deepEqual(interrupts, ['_agent_target::thread:1001:321']);
    assert.match(sent[0].text, /Stopping T Target/);
  });

  it('inherits team member routing when a Feishu topic is opened from that member card', async () => {
    const handled = [];
    const sent = [];
    const state = {
      sessions: {},
      team_sticky: {},
      msg_sessions: {
        om_root_agent_card: {
          id: 'sid-jia',
          cwd: tempHome,
          engine: 'codex',
          logicalChatId: '_agent_jia',
          agentKey: 'jia',
        },
      },
    };

    require.cache[feishuAdapterPath] = {
      id: feishuAdapterPath,
      filename: feishuAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          return {
            async validateCredentials() { return { ok: true }; },
            async startReceiving(handler) {
              setImmediate(() => {
                handler(
                  'oc_team_1',
                  '你好',
                  {
                    message: {
                      root_id: 'om_root_agent_card',
                      parent_id: 'om_root_agent_card',
                    },
                  },
                  null,
                  'ou_admin'
                ).catch(() => {});
              });
              return {
                stop() {},
                reconnect() {},
                isAlive() { return true; },
              };
            },
            async sendMessage(chatId, text) {
              sent.push({ chatId, text });
              return { message_id: 'msg-send' };
            },
            async sendMarkdown(chatId, text) {
              sent.push({ chatId, text, markdown: true });
              return { message_id: 'msg-md' };
            },
            async downloadFile() {},
            async sendTyping() {},
            async editMessage() { return true; },
            async deleteMessage() { return true; },
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
        feishu: {
          enabled: true,
          app_id: 'cli_a_test',
          app_secret: 'secret_test',
          allowed_chat_ids: ['oc_team_1'],
          chat_agent_map: { oc_team_1: 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'codex',
            team: [
              { key: 'jia', name: 'Jarvis · 甲', icon: '🅰️', nicknames: ['甲'] },
            ],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: () => null,
      handleCommand: async (_bot, chatId, text) => {
        handled.push({ chatId, text });
      },
      pipeline: {
        processMessage: async (chatId, text) => {
          handled.push({ chatId, text });
        },
        isActive: () => false,
        interruptActive: () => false,
        clearQueue: () => {},
      },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    });

    const running = await bridge.startFeishuBridge({
      feishu: {
        enabled: true,
        app_id: 'cli_a_test',
        app_secret: 'secret_test',
        allowed_chat_ids: ['oc_team_1'],
      },
    }, async () => {});

    await flush();
    await flush();
    running.stop();
    await flush();

    assert.equal(handled.length, 1);
    assert.equal(handled[0].chatId, '_agent_jia::thread:oc_team_1:om_root_agent_card');
    assert.equal(handled[0].text, '你好');
    assert.equal(state.team_sticky['thread:oc_team_1:om_root_agent_card'], 'jia');
    assert.equal(sent.length, 0);
  });

  it('reuses the resumed logical team session when a new Feishu topic is opened after resume', async () => {
    const handled = [];
    const state = {
      sessions: {},
      team_sticky: { oc_team_1: 'jia' },
      team_session_route: { oc_team_1: '_agent_jia' },
      msg_sessions: {},
    };

    require.cache[feishuAdapterPath] = {
      id: feishuAdapterPath,
      filename: feishuAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          return {
            async validateCredentials() { return { ok: true }; },
            async startReceiving(handler) {
              setImmediate(() => {
                handler(
                  'oc_team_1',
                  '继续安装这个 plugin',
                  {
                    message: {
                      root_id: 'om_resume_followup',
                      parent_id: 'om_resume_followup',
                    },
                  },
                  null,
                  'ou_admin'
                ).catch(() => {});
              });
              return {
                stop() {},
                reconnect() {},
                isAlive() { return true; },
              };
            },
            async sendMessage() { return { message_id: 'msg-send' }; },
            async sendMarkdown() { return { message_id: 'msg-md' }; },
            async downloadFile() {},
            async sendTyping() {},
            async editMessage() { return true; },
            async deleteMessage() { return true; },
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
        feishu: {
          enabled: true,
          app_id: 'cli_a_test',
          app_secret: 'secret_test',
          allowed_chat_ids: ['oc_team_1'],
          chat_agent_map: { oc_team_1: 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'codex',
            team: [
              { key: 'jia', name: 'Jarvis · 甲', icon: '🅰️', nicknames: ['甲'] },
            ],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline: {
        processMessage: async (chatId, text) => {
          handled.push({ chatId, text });
        },
        isActive: () => false,
        interruptActive: () => false,
        clearQueue: () => {},
      },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    });

    const running = await bridge.startFeishuBridge({
      feishu: {
        enabled: true,
        app_id: 'cli_a_test',
        app_secret: 'secret_test',
        allowed_chat_ids: ['oc_team_1'],
      },
    }, async () => {});

    await flush();
    await flush();
    running.stop();
    await flush();

    assert.equal(handled.length, 1);
    assert.equal(handled[0].chatId, '_agent_jia');
    assert.equal(state.team_sticky['thread:oc_team_1:om_resume_followup'], 'jia');
    assert.equal(state.team_sticky.oc_team_1, 'jia');
  });

  it('routes topic follow-up for main bound agent back to the raw chat pipeline', async () => {
    const handled = [];
    const state = {
      sessions: {},
      team_sticky: {},
      team_session_route: {},
      msg_sessions: {
        om_main_root: {
          id: 'sid-main',
          cwd: tempHome,
          engine: 'claude',
          logicalChatId: '_bound_main',
          agentKey: null,
        },
      },
    };

    require.cache[feishuAdapterPath] = {
      id: feishuAdapterPath,
      filename: feishuAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          return {
            async validateCredentials() { return { ok: true }; },
            async startReceiving(handler) {
              setImmediate(() => {
                handler(
                  'oc_team_1',
                  '补充一句上下文',
                  {
                    message: {
                      root_id: 'om_main_root',
                      parent_id: 'om_main_root',
                    },
                  },
                  null,
                  'ou_admin'
                ).catch(() => {});
              });
              return {
                stop() {},
                reconnect() {},
                isAlive() { return true; },
              };
            },
            async sendMessage() { return { message_id: 'msg-send' }; },
            async sendMarkdown() { return { message_id: 'msg-md' }; },
            async downloadFile() {},
            async sendTyping() {},
            async editMessage() { return true; },
            async deleteMessage() { return true; },
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
        feishu: {
          enabled: true,
          app_id: 'cli_a_test',
          app_secret: 'secret_test',
          allowed_chat_ids: ['oc_team_1'],
          chat_agent_map: { oc_team_1: 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'claude',
            team: [
              { key: 'jia', name: 'Jarvis · 甲', icon: '🅰️', nicknames: ['甲'] },
            ],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline: {
        processMessage: async (chatId, text) => {
          handled.push({ chatId, text });
        },
        isActive: () => false,
        interruptActive: () => false,
        clearQueue: () => {},
      },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    });

    const running = await bridge.startFeishuBridge({
      feishu: {
        enabled: true,
        app_id: 'cli_a_test',
        app_secret: 'secret_test',
        allowed_chat_ids: ['oc_team_1'],
      },
    }, async () => {});

    await flush();
    await flush();
    running.stop();
    await flush();

    assert.equal(handled.length, 1);
    assert.equal(handled[0].chatId, 'oc_team_1');
    assert.equal(handled[0].text, '补充一句上下文');
  });

  it('merges topic follow-up into the active main pipeline while keeping replies in the topic', async () => {
    const processed = [];
    const sent = [];
    let resolveFirstTurn;
    const activeProcesses = new Map();
    activeProcesses.set('oc_team_1', { child: null, aborted: false, engine: 'claude' });

    const pipeline = createMessagePipeline({
      activeProcesses,
      resetCooldown: () => {},
      log: () => {},
      handleCommand: async (bot, chatId, text) => {
        processed.push({ chatId, text });
        if (text === '原任务') {
          await new Promise(resolve => { resolveFirstTurn = resolve; });
          return { ok: true };
        }
        await bot.sendMessage(chatId, '合并回复');
        return { ok: true };
      },
    });

    const state = {
      sessions: {},
      team_sticky: {},
      team_session_route: {},
      msg_sessions: {
        om_main_root: {
          id: 'sid-main',
          cwd: tempHome,
          engine: 'claude',
          logicalChatId: '_bound_main',
          agentKey: null,
        },
      },
    };

    const rawBot = {
      async sendMessage(chatId, text) {
        sent.push({ method: 'sendMessage', chatId, text });
        return { message_id: 'raw-msg' };
      },
    };
    void pipeline.processMessage('oc_team_1', '原任务', {
      bot: rawBot,
      config: {},
      executeTaskByName: async () => {},
      senderId: 'ou_admin',
      readOnly: false,
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    require.cache[feishuAdapterPath] = {
      id: feishuAdapterPath,
      filename: feishuAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          return {
            async validateCredentials() { return { ok: true }; },
            async startReceiving(handler) {
              setImmediate(() => {
                handler(
                  'oc_team_1',
                  '补一句上下文',
                  {
                    message: {
                      root_id: 'om_main_root',
                      parent_id: 'om_main_root',
                    },
                  },
                  null,
                  'ou_admin'
                ).catch(() => {});
              });
              return {
                stop() {},
                reconnect() {},
                isAlive() { return true; },
              };
            },
            async sendMessage(chatId, text) {
              sent.push({ method: 'sendMessage', chatId, text });
              return { message_id: 'msg-send' };
            },
            async sendMarkdown(chatId, text) {
              sent.push({ method: 'sendMarkdown', chatId, text });
              return { message_id: 'msg-md' };
            },
            async downloadFile() {},
            async sendTyping() {},
            async editMessage() { return true; },
            async deleteMessage() { return true; },
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
        feishu: {
          enabled: true,
          app_id: 'cli_a_test',
          app_secret: 'secret_test',
          allowed_chat_ids: ['oc_team_1'],
          chat_agent_map: { oc_team_1: 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'claude',
            team: [{ key: 'jia', name: 'Jarvis · 甲', icon: '🅰️', nicknames: ['甲'] }],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline,
      pendingActivations: new Map(),
      activeProcesses,
      messageQueue: new Map(),
    });

    const running = await bridge.startFeishuBridge({
      feishu: {
        enabled: true,
        app_id: 'cli_a_test',
        app_secret: 'secret_test',
        allowed_chat_ids: ['oc_team_1'],
      },
    }, async () => {});

    await flush();
    await flush();
    resolveFirstTurn();
    await new Promise(resolve => setTimeout(resolve, 5300));
    running.stop();
    await flush();

    assert.equal(processed.length, 2);
    assert.deepEqual(processed[0], { chatId: 'oc_team_1', text: '原任务' });
    assert.equal(processed[1].chatId, 'oc_team_1');
    assert.ok(processed[1].text.includes('原任务'));
    assert.ok(processed[1].text.includes('补一句上下文'));
    assert.ok(sent.some(entry =>
      entry.chatId === 'thread:oc_team_1:om_main_root' && /已暂停/.test(entry.text || '')
    ));
    assert.ok(sent.some(entry =>
      entry.chatId === 'thread:oc_team_1:om_main_root' && entry.text === '合并回复'
    ));
  });

  it('does not treat another member prefix route as a valid resumed logical session', async () => {
    const handled = [];
    const state = {
      sessions: {},
      team_sticky: { oc_team_1: 'jia' },
      team_session_route: { oc_team_1: '_agent_jia2' },
      msg_sessions: {},
    };

    require.cache[feishuAdapterPath] = {
      id: feishuAdapterPath,
      filename: feishuAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          return {
            async validateCredentials() { return { ok: true }; },
            async startReceiving(handler) {
              setImmediate(() => {
                handler(
                  'oc_team_1',
                  '继续安装这个 plugin',
                  {
                    message: {
                      root_id: 'om_resume_followup_2',
                      parent_id: 'om_resume_followup_2',
                    },
                  },
                  null,
                  'ou_admin'
                ).catch(() => {});
              });
              return {
                stop() {},
                reconnect() {},
                isAlive() { return true; },
              };
            },
            async sendMessage() { return { message_id: 'msg-send' }; },
            async sendMarkdown() { return { message_id: 'msg-md' }; },
            async downloadFile() {},
            async sendTyping() {},
            async editMessage() { return true; },
            async deleteMessage() { return true; },
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
        feishu: {
          enabled: true,
          app_id: 'cli_a_test',
          app_secret: 'secret_test',
          allowed_chat_ids: ['oc_team_1'],
          chat_agent_map: { oc_team_1: 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'codex',
            team: [
              { key: 'jia', name: 'Jarvis · 甲', icon: '🅰️', nicknames: ['甲'] },
            ],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline: {
        processMessage: async (chatId, text) => {
          handled.push({ chatId, text });
        },
        isActive: () => false,
        interruptActive: () => false,
        clearQueue: () => {},
      },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    });

    const running = await bridge.startFeishuBridge({
      feishu: {
        enabled: true,
        app_id: 'cli_a_test',
        app_secret: 'secret_test',
        allowed_chat_ids: ['oc_team_1'],
      },
    }, async () => {});

    await flush();
    await flush();
    running.stop();
    await flush();

    assert.equal(handled.length, 1);
    assert.equal(handled[0].chatId, '_agent_jia::thread:oc_team_1:om_resume_followup_2');
    assert.equal(state.team_session_route.oc_team_1, undefined);
  });

  it('stops the replied Feishu team member using the reply logical chat id', async () => {
    const sent = [];
    const interrupts = [];
    const clears = [];
    const state = {
      sessions: {},
      team_sticky: { oc_team_1: 'stick' },
      msg_sessions: {
        om_reply_target: {
          id: 'sid-jia',
          cwd: tempHome,
          engine: 'codex',
          logicalChatId: '_agent_jia::thread:oc_team_1:om_reply_target',
          agentKey: 'jia',
        },
      },
    };

    require.cache[feishuAdapterPath] = {
      id: feishuAdapterPath,
      filename: feishuAdapterPath,
      loaded: true,
      exports: {
        createBot() {
          return {
            async validateCredentials() { return { ok: true }; },
            async startReceiving(handler) {
              setImmediate(() => {
                handler(
                  'oc_team_1',
                  '/stop',
                  {
                    message: {
                      parent_id: 'om_reply_target',
                    },
                  },
                  null,
                  null
                ).catch(() => {});
              });
              return {
                stop() {},
                reconnect() {},
                isAlive() { return true; },
              };
            },
            async sendMessage(chatId, text) {
              sent.push({ chatId, text });
              return { message_id: 'msg-send' };
            },
            async sendMarkdown(chatId, text) {
              sent.push({ chatId, text, markdown: true });
              return { message_id: 'msg-md' };
            },
            async downloadFile() {},
            async sendTyping() {},
            async editMessage() { return true; },
            async deleteMessage() { return true; },
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
        feishu: {
          enabled: true,
          app_id: 'cli_a_test',
          app_secret: 'secret_test',
          allowed_chat_ids: ['oc_team_1'],
          chat_agent_map: { oc_team_1: 'main' },
        },
        projects: {
          main: {
            cwd: tempHome,
            name: 'Main',
            engine: 'codex',
            team: [
              { key: 'stick', name: 'Stick', icon: 'S', nicknames: ['stick'] },
              { key: 'jia', name: 'Jarvis · 甲', icon: '🅰️', nicknames: ['甲', 'jia'] },
            ],
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => Object.assign(state, next),
      getSession: () => ({ cwd: tempHome }),
      restoreSessionFromReply: () => null,
      handleCommand: async () => {},
      pipeline: {
        processMessage: async () => {},
        isActive: () => false,
        interruptActive: (chatId) => {
          interrupts.push(chatId);
          return true;
        },
        clearQueue: (chatId) => clears.push(chatId),
      },
      pendingActivations: new Map(),
      activeProcesses: new Map(),
      messageQueue: new Map(),
    });

    const running = await bridge.startFeishuBridge({
      feishu: {
        enabled: true,
        app_id: 'cli_a_test',
        app_secret: 'secret_test',
        allowed_chat_ids: ['oc_team_1'],
      },
    }, async () => {});

    await flush();
    await flush();
    running.stop();
    await flush();

    assert.deepEqual(clears, ['_agent_jia::thread:oc_team_1:om_reply_target']);
    assert.deepEqual(interrupts, ['_agent_jia::thread:oc_team_1:om_reply_target']);
    assert.match(sent[0].text, /Stopping .*Jarvis · 甲/);
  });
});
