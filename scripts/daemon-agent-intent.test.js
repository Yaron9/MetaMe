'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createAgentIntentHandler, _private } = require('./daemon-agent-intent');

describe('daemon-agent-intent helpers', () => {
  it('extracts Windows workspace paths from natural language', () => {
    assert.equal(
      _private.extractPathFromText('给这个群创建一个 agent，目录是 C:\\work\\reviewer'),
      'C:\\work\\reviewer'
    );
  });

  it('classifies explicit create requests before wizard fallback', () => {
    const intent = _private.classifyAgentIntent('创建一个 codex agent，目录是 ~/projects/reviewer，负责代码审查');
    assert.equal(intent.action, 'create');
    assert.equal(intent.workspaceDir, '~/projects/reviewer');
  });

  it('routes generic team creation requests to team wizard', () => {
    const intent = _private.classifyAgentIntent('帮我建个团队');
    assert.equal(intent.action, 'wizard_team');
  });

  it('classifies natural reset phrasing for current agent role reset', () => {
    const intent = _private.classifyAgentIntent('帮我重置当前 agent 的角色');
    assert.equal(intent.action, 'reset');
  });

  it('creates agent without explicit path or directAction prefix', () => {
    // Bare "新建 agent 叫 X" — no workspace path, no canonical verb prefix.
    const intent = _private.classifyAgentIntent('新建 agent 叫 datalab');
    assert.equal(intent.action, 'create');
  });

  it('routes create before list when both phrasings overlap', () => {
    // "新建 agent 用于查看日志" — contains both 新建 and 查看, must be create.
    const intent = _private.classifyAgentIntent('新建 agent 用于查看日志');
    assert.equal(intent.action, 'create');
  });

  it('does NOT classify question-form prompts as create', () => {
    assert.equal(_private.classifyAgentIntent('如何新建 agent'), null);
    assert.equal(_private.classifyAgentIntent('怎么创建 agent'), null);
    assert.equal(_private.classifyAgentIntent('能不能新建 agent?'), null);
  });
});

describe('daemon-agent-intent handler', () => {
  it('creates agent directly instead of falling back to /agent new wizard', async () => {
    const calls = [];
    const sent = [];
    const handler = createAgentIntentHandler({
      agentTools: {
        createNewWorkspaceAgent: async (name, cwd, role, chatId, options) => {
          calls.push({ type: 'create', name, cwd, role, chatId, options });
          return {
            ok: true,
            data: {
              projectKey: 'reviewer',
              cwd,
              project: { name: 'reviewer', engine: 'codex' },
            },
          };
        },
      },
      handleAgentCommand: async ({ text }) => {
        calls.push({ type: 'wizard', text });
        return true;
      },
      attachOrCreateSession: () => {},
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      loadConfig: () => ({}),
      getBoundProjectForChat: () => ({ key: null, project: null }),
      log: () => {},
      pendingActivations: new Map(),
      hasFreshPendingFlow: () => false,
      HOME: '/Users/test',
    });

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const handled = await handler(bot, 'chat-1', '创建一个 codex agent，目录是 C:\\work\\reviewer，负责代码审查', {});
    assert.equal(handled, true);
    assert.equal(calls.some((item) => item.type === 'wizard'), false);
    assert.equal(calls[0].type, 'create');
    assert.equal(calls[0].cwd, 'C:\\work\\reviewer');
    assert.equal(calls[0].options.engine, 'codex');
    assert.match(sent[0], /已创建/);
  });

  it('binds to the logical bound session namespace instead of the raw chat id', async () => {
    const attached = [];
    const sent = [];
    const handler = createAgentIntentHandler({
      agentTools: {
        bindAgentToChat: async (_chatId, _name, cwd, options) => ({
          ok: true,
          data: {
            projectKey: 'reviewer',
            cwd,
            project: { name: 'reviewer', engine: options.engine || 'claude' },
          },
        }),
      },
      handleAgentCommand: async () => false,
      attachOrCreateSession: (...args) => attached.push(args),
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      loadConfig: () => ({}),
      getBoundProjectForChat: () => ({ key: null, project: null }),
      log: () => {},
      pendingActivations: new Map(),
      hasFreshPendingFlow: () => false,
      HOME: '/Users/test',
    });

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const handled = await handler(bot, 'chat-1', '给这个群绑定 reviewer，目录是 /repo/reviewer，用 codex', {});
    assert.equal(handled, true);
    assert.deepEqual(attached, [['_bound_reviewer', '/repo/reviewer', 'reviewer', 'codex']]);
    assert.match(sent[0], /已绑定 Agent/);
  });

  it('routes activate/reset/soul intents back into the command handler for execution consistency', async () => {
    const calls = [];
    const handler = createAgentIntentHandler({
      agentTools: {
        listAllAgents: async () => ({ ok: true, data: { agents: [], boundKey: null } }),
      },
      handleAgentCommand: async ({ text }) => {
        calls.push(text);
        return true;
      },
      attachOrCreateSession: () => {},
      normalizeCwd: (v) => v,
      getDefaultEngine: () => 'claude',
      loadConfig: () => ({}),
      getBoundProjectForChat: () => ({ key: null, project: null }),
      log: () => {},
      pendingActivations: new Map(),
      hasFreshPendingFlow: () => false,
      HOME: '/Users/test',
    });

    const bot = { sendMessage: async () => {} };

    assert.equal(await handler(bot, 'chat-1', '请在新群里激活刚建好的 agent', {}), true);
    assert.equal(await handler(bot, 'chat-1', '帮我重置当前 agent 的角色', {}), true);
    assert.equal(await handler(bot, 'chat-1', '帮我修复一下 soul', {}), true);
    assert.deepEqual(calls, ['/activate', '/agent reset', '/agent soul repair']);
  });
});
