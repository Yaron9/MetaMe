'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('./daemon.js');

describe('dispatch receiver task cards', () => {
  it('waits for the task card before streaming worker output', async () => {
    const calls = [];
    let releaseReady;
    const ready = new Promise(resolve => { releaseReady = resolve; });
    const realBot = {
      sendMessage: async (_chatId, text) => {
        calls.push(text);
        return { message_id: `m_${calls.length}` };
      },
      sendMarkdown: async (_chatId, text) => {
        calls.push(text);
        return { message_id: `m_${calls.length}` };
      },
      sendCard: async (_chatId, card) => {
        calls.push(card.title || card.body || '');
        return { message_id: `m_${calls.length}` };
      },
      sendRawCard: async () => ({ message_id: 'raw_1' }),
      sendButtons: async () => ({ message_id: 'btn_1' }),
      sendTyping: async () => null,
      editMessage: async () => true,
      deleteMessage: async () => null,
      sendFile: async () => null,
      downloadFile: async () => null,
    };
    const streamBot = __test.createStreamForwardBot(realBot, 'chat_1', null, { ready });
    const sendPromise = streamBot.sendMessage('ignored', 'worker output');

    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, []);

    releaseReady();
    await sendPromise;
    assert.deepEqual(calls, ['worker output']);
  });

  it('builds a detailed task card with TeamTask metadata when available', () => {
    const card = __test.buildDispatchTaskCard({
      id: 'd_demo_001',
      from: 'planner',
      payload: {
        prompt: '继续修复登录超时，并把 root cause 和验证结果写清楚。',
      },
      task_id: 't_20260312_demo1',
      scope_id: 'epic_auth',
    }, 'coder', {
      projects: {
        planner: { name: 'Planner', icon: '🧭' },
        coder: { name: 'Coder', icon: '🛠', color: 'green' },
      },
    });

    assert.equal(card.title, '📬 新任务');
    assert.match(card.body, /发起: 🧭 Planner/);
    assert.match(card.body, /目标: 🛠 Coder/);
    assert.match(card.body, /编号: d_demo_001/);
    assert.match(card.body, /TeamTask: t_20260312_demo1/);
    assert.match(card.body, /Scope: epic_auth/);
    assert.match(card.body, /继续修复登录超时/);
  });
});
