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

  it('renders placeholder user dispatchers as user-facing sender names', () => {
    const card = __test.buildDispatchTaskCard({
      id: 'd_demo_002',
      from: '_claude_session',
      payload: {
        prompt: '帮我看一下这个问题。',
      },
    }, 'coder', {
      projects: {
        coder: { name: 'Coder', icon: '🛠', color: 'green' },
      },
    });

    assert.match(card.body, /发起: 👤 用户/);
    assert.doesNotMatch(card.body, /claude_session/);
  });

  it('builds daemon dispatch prompts with scoped now context for direct and team tasks', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-daemon-prompt-'));
    const nowDir = path.join(baseDir, 'memory', 'now');
    fs.mkdirSync(nowDir, { recursive: true });
    fs.writeFileSync(path.join(nowDir, 'builder.md'), 'PRIVATE builder progress', 'utf8');
    fs.writeFileSync(path.join(nowDir, 'shared.md'), 'SHARED team progress', 'utf8');
    const directPrompt = __test.buildDispatchPrompt('builder', {
      payload: { prompt: '修一下登录超时' },
    }, null, baseDir);
    assert.match(directPrompt, /PRIVATE builder progress/);
    assert.doesNotMatch(directPrompt, /SHARED team progress/);

    const teamPrompt = __test.buildDispatchPrompt('builder', {
      payload: { prompt: '团队继续推进登录修复' },
    }, {
      task_id: 't_demo',
      scope_id: 'epic_auth',
      task_kind: 'team',
      from_agent: 'user',
      to_agent: 'builder',
      goal: '团队继续推进登录修复',
    }, baseDir);
    assert.match(teamPrompt, /PRIVATE builder progress/);
    assert.match(teamPrompt, /SHARED team progress/);
  });

  it('derives dispatch write access from source sender open_id', () => {
    const cfg = {
      feishu: {
        operator_ids: ['ou_admin_sender_12345'],
      },
      projects: {
        planner: { name: 'Planner', icon: '🧭' },
        coder: { name: 'Coder', icon: '🛠', color: 'green' },
        metame: {
          name: 'Jarvis',
          team: [{ key: 'jia', name: '甲' }],
        },
      },
    };

    assert.equal(__test.resolveDispatchReadOnly({ from: 'planner', source_sender_id: 'ou_admin_sender_12345' }, cfg, 'coder'), false);
    assert.equal(__test.resolveDispatchReadOnly({ from: 'user', source_sender_id: 'ou_admin_sender_12345' }, cfg, 'jia'), false);
    assert.equal(__test.resolveDispatchReadOnly({ from: 'external_peer', source_sender_id: 'ou_guest_sender_67890' }, cfg, 'coder'), true);
    assert.equal(__test.resolveDispatchReadOnly({ from: 'external_peer' }, cfg, 'coder'), true);
  });
});
