'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getBoundProject,
  getLatestActivationForChat,
  listUnboundProjects,
  bindAgentToChat,
  handleActivateCommand,
  unbindAgent,
} = require('./daemon-agent-workflow');

describe('daemon-agent-workflow helpers', () => {
  it('resolves the current bound project across platform maps', () => {
    const result = getBoundProject('chat-1', {
      feishu: { chat_agent_map: { 'chat-1': 'metame' } },
      projects: { metame: { cwd: '/repo', name: 'MetaMe' } },
    });

    assert.equal(result.boundKey, 'metame');
    assert.equal(result.boundProj.cwd, '/repo');
  });

  it('returns the latest pending activation excluding the creator chat', () => {
    const pending = new Map([
      ['a', { agentKey: 'old', createdByChatId: 'other', createdAt: 10 }],
      ['b', { agentKey: 'new', createdByChatId: 'other', createdAt: 20 }],
      ['c', { agentKey: 'self', createdByChatId: 'me', createdAt: 30 }],
    ]);

    const result = getLatestActivationForChat('me', pending);
    assert.equal(result.agentKey, 'new');
  });

  it('lists only unbound projects from daemon config', () => {
    const result = listUnboundProjects({
      feishu: { chat_agent_map: { c1: 'bound_proj' } },
      projects: {
        bound_proj: { cwd: '/repo/bound', name: 'Bound' },
        free_proj: { cwd: '/repo/free', name: 'Free' },
      },
    });

    assert.deepEqual(result, [{ key: 'free_proj', name: 'Free', cwd: '/repo/free', icon: '🤖' }]);
  });
});

describe('daemon-agent-workflow activate handling', () => {
  it('auto-binds the only unbound project when there is no pending activation', async () => {
    const sent = [];
    const binds = [];
    const bot = { sendMessage: async (_chatId, text) => sent.push(String(text)) };

    const handled = await handleActivateCommand({
      bot,
      chatId: 'chat-1',
      loadConfig: () => ({
        feishu: { chat_agent_map: {} },
        projects: {
          free_proj: { cwd: '/repo/free', name: 'Free' },
        },
      }),
      pendingActivations: new Map(),
      bindAgent: async (name, cwd) => {
        binds.push([name, cwd]);
        return { ok: true };
      },
    });

    assert.equal(handled, true);
    assert.deepEqual(binds, [['free_proj', '/repo/free']]);
    assert.equal(sent.length, 0);
  });

  it('tells the creator chat to activate from the target group when only self-created activations exist', async () => {
    const sent = [];
    const bot = { sendMessage: async (_chatId, text) => sent.push(String(text)) };

    await handleActivateCommand({
      bot,
      chatId: 'chat-1',
      loadConfig: () => ({ projects: {} }),
      pendingActivations: new Map([
        ['agent_a', { agentName: '甲', cwd: '/repo/a', createdByChatId: 'chat-1', createdAt: 1 }],
      ]),
      bindAgent: async () => ({ ok: true }),
    });

    assert.match(sent[0], /不能在创建来源群激活/);
    assert.match(sent[0], /\/activate/);
  });
});

describe('daemon-agent-workflow bind/unbind semantics', () => {
  it('attaches bound chats to the logical _bound_<projectKey> session namespace', async () => {
    const sent = [];
    const attached = [];
    const bot = { sendMessage: async (_chatId, text) => sent.push(String(text)) };

    const res = await bindAgentToChat({
      agentTools: {
        bindAgentToChat: async () => ({
          ok: true,
          data: {
            projectKey: 'metame',
            cwd: '/repo/main',
            isNewProject: true,
            project: { name: 'MetaMe', engine: 'codex' },
          },
        }),
      },
      bot,
      chatId: 'chat-1',
      agentName: 'MetaMe',
      agentCwd: '/repo/main',
      HOME: '/Users/test',
      attachOrCreateSession: (...args) => attached.push(args),
      normalizeCwd: (value) => value,
      getDefaultEngine: () => 'claude',
    });

    assert.equal(res.ok, true);
    assert.deepEqual(attached, [['_bound_metame', '/repo/main', 'MetaMe', 'codex']]);
    assert.match(sent[0], /绑定成功/);
  });

  it('persists config when unbinding through the fallback path', async () => {
    const cfg = {
      feishu: { chat_agent_map: { 'chat-1': 'metame' } },
      projects: { metame: { cwd: '/repo/main' } },
    };
    const writes = [];
    let backups = 0;

    const res = await unbindAgent({
      agentTools: null,
      chatId: 'chat-1',
      loadConfig: () => cfg,
      writeConfigSafe: (nextCfg) => writes.push(nextCfg.feishu.chat_agent_map['chat-1'] || null),
      backupConfig: () => { backups += 1; },
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.unbound, true);
    assert.deepEqual(writes, [null]);
    assert.equal(backups, 1);
  });
});
