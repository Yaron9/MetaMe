'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, resolveAdminChatId } = require('./daemon-notify');

describe('resolveAdminChatId', () => {
  it('prefers explicit admin_chat_id over allowed_chat_ids order', () => {
    const id = resolveAdminChatId({
      admin_chat_id: 'chat_admin',
      allowed_chat_ids: ['chat_group', 'chat_admin'],
    });
    assert.equal(id, 'chat_admin');
  });

  it('falls back to first allowed chat when admin_chat_id is absent', () => {
    const id = resolveAdminChatId({
      allowed_chat_ids: ['chat_first', 'chat_second'],
    });
    assert.equal(id, 'chat_first');
  });
});

describe('daemon-notify notifyAdmin', () => {
  it('sends startup notifications to explicit feishu admin chat', async () => {
    const sent = [];
    const notifier = createNotifier({
      log: () => {},
      getConfig: () => ({
        feishu: {
          admin_chat_id: 'chat_admin',
          allowed_chat_ids: ['chat_group', 'chat_admin'],
        },
      }),
      getBridges: () => ({
        feishuBridge: {
          bot: {
            sendMessage: async (chatId, message) => { sent.push({ chatId, message }); },
          },
        },
      }),
    });

    await notifier.notifyAdmin('ready');
    assert.deepEqual(sent, [{ chatId: 'chat_admin', message: 'ready' }]);
  });

  it('falls back to the first telegram allowed chat when explicit admin chat is missing', async () => {
    const sent = [];
    const notifier = createNotifier({
      log: () => {},
      getConfig: () => ({
        telegram: {
          allowed_chat_ids: ['tg_first', 'tg_second'],
        },
      }),
      getBridges: () => ({
        telegramBridge: {
          bot: {
            sendMarkdown: async (chatId, message) => { sent.push({ chatId, message }); },
          },
        },
      }),
    });

    await notifier.notifyAdmin('ready');
    assert.deepEqual(sent, [{ chatId: 'tg_first', message: 'ready' }]);
  });
});

describe('daemon-notify project receipts', () => {
  it('strictly targets the bound Feishu project and returns delivery evidence', async () => {
    const sent = [];
    const notifier = createNotifier({
      log: () => {},
      getConfig: () => ({
        feishu: {
          allowed_chat_ids: ['chat-scientist', 'chat-other'],
          chat_agent_map: {
            'chat-scientist': 'scientist',
            'chat-other': 'other',
          },
        },
        telegram: { allowed_chat_ids: ['tg-admin'] },
      }),
      getBridges: () => ({
        feishuBridge: {
          bot: {
            sendCard: async (chatId, card) => sent.push({ chatId, card }),
          },
        },
        telegramBridge: {
          bot: {
            sendMarkdown: async () => {
              throw new Error('telegram must not be used');
            },
          },
        },
      }),
    });
    const receipt = await notifier.notify('radar', {
      key: 'scientist',
      name: '科研总监',
      icon: '🔬',
      color: 'blue',
      notificationChannel: 'feishu',
      strictNotifyTarget: true,
    });

    assert.equal(receipt.attempted, 1);
    assert.equal(receipt.delivered, 1);
    assert.deepEqual(receipt.errors, []);
    assert.equal(sent[0].chatId, 'chat-scientist');
  });

  it('does not fall back when a strict project has no matching chat', async () => {
    const notifier = createNotifier({
      log: () => {},
      getConfig: () => ({
        feishu: {
          allowed_chat_ids: ['chat-other'],
          chat_agent_map: { 'chat-other': 'other' },
        },
      }),
      getBridges: () => ({
        feishuBridge: { bot: { sendMessage: async () => {} } },
      }),
    });
    const receipt = await notifier.notify('radar', {
      key: 'scientist',
      notificationChannel: 'feishu',
      strictNotifyTarget: true,
    });
    assert.equal(receipt.attempted, 0);
    assert.equal(receipt.delivered, 0);
  });
});
