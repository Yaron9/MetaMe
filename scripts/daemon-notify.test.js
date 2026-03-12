'use strict';

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
