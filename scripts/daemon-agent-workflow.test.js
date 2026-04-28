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
  createWorkspaceAgent,
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

describe('daemon-agent-workflow auto-create-chat', () => {
  function fakeAgentTools() {
    const calls = { create: [], bind: [] };
    return {
      calls,
      createNewWorkspaceAgent: async (name, cwd, role, chatId, opts) => {
        calls.create.push({ name, cwd, role, chatId, opts });
        return {
          ok: true,
          data: {
            projectKey: 'foo',
            cwd: '/repo/foo',
            project: { name: 'foo', engine: 'claude' },
          },
        };
      },
      bindAgentToChat: async (newChatId, name, cwd) => {
        calls.bind.push({ newChatId, name, cwd });
        return { ok: true, data: { chatId: String(newChatId), projectKey: 'foo' } };
      },
    };
  }

  it('auto-creates chat and binds when bot.createChat + senderOpenId provided', async () => {
    const sent = [];
    const bot = {
      createChat: async ({ name }) => ({ ok: true, chatId: 'oc_new_chat_1', name }),
      sendMessage: async (_cid, text) => sent.push(String(text)),
    };
    const tools = fakeAgentTools();
    const pending = new Map();

    const res = await createWorkspaceAgent({
      agentTools: tools,
      chatId: 'oc_creator',
      agentName: 'foo',
      workspaceDir: '',
      pendingActivations: pending,
      skipChatBinding: true,
      attachOrCreateSession: () => {},
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      bot,
      senderOpenId: 'ou_human_001',
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.autoChat.chatId, 'oc_new_chat_1');
    assert.equal(tools.calls.bind.length, 1);
    assert.equal(tools.calls.bind[0].newChatId, 'oc_new_chat_1');
    // pendingActivations not used when auto-create succeeds
    assert.equal(pending.size, 0);
    assert.match(sent[0], /已上线/);
  });

  it('falls back to /activate flow when bot.createChat is missing', async () => {
    const tools = fakeAgentTools();
    const pending = new Map();
    const res = await createWorkspaceAgent({
      agentTools: tools,
      chatId: 'oc_creator',
      agentName: 'foo',
      workspaceDir: '',
      pendingActivations: pending,
      skipChatBinding: true,
      attachOrCreateSession: () => {},
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      bot: { sendMessage: async () => {} },  // no createChat
      senderOpenId: 'ou_human_001',
    });

    assert.equal(res.ok, true);
    assert.equal(tools.calls.bind.length, 0);
    assert.equal(pending.size, 1);
    assert.equal(pending.get('foo').agentName, 'foo');
  });

  it('falls back to /activate flow when senderOpenId is missing', async () => {
    const tools = fakeAgentTools();
    const pending = new Map();
    const res = await createWorkspaceAgent({
      agentTools: tools,
      chatId: 'oc_creator',
      agentName: 'foo',
      workspaceDir: '',
      pendingActivations: pending,
      skipChatBinding: true,
      attachOrCreateSession: () => {},
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      bot: { createChat: async () => ({ ok: true, chatId: 'oc_x' }), sendMessage: async () => {} },
      senderOpenId: null,
    });

    assert.equal(res.ok, true);
    assert.equal(tools.calls.bind.length, 0);
    assert.equal(pending.size, 1);
  });

  it('falls back to /activate when bot.createChat returns permission error', async () => {
    const tools = fakeAgentTools();
    const pending = new Map();
    const bot = {
      createChat: async () => ({ ok: false, error: '飞书应用缺少 im:chat 权限', code: 99991663 }),
      sendMessage: async () => {},
    };
    const res = await createWorkspaceAgent({
      agentTools: tools,
      chatId: 'oc_creator',
      agentName: 'foo',
      workspaceDir: '',
      pendingActivations: pending,
      skipChatBinding: true,
      attachOrCreateSession: () => {},
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      bot,
      senderOpenId: 'ou_human_001',
    });

    assert.equal(res.ok, true);
    assert.equal(res.data.autoChat.error, '飞书应用缺少 im:chat 权限');
    assert.equal(tools.calls.bind.length, 0);
    assert.equal(pending.size, 1);
  });
});
