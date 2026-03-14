'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createCommandRouter } = require('./daemon-command-router');

function createDeps(overrides = {}) {
  const activeProcesses = overrides.activeProcesses || new Map();
  const messageQueue = overrides.messageQueue || new Map();
  return {
    loadState: () => ({}),
    loadConfig: () => ({}),
    checkBudget: () => true,
    checkCooldown: () => ({ ok: true }),
    resetCooldown: () => {},
    routeAgent: () => null,
    normalizeCwd: (v) => v,
    attachOrCreateSession: () => {},
    handleSessionCommand: async () => false,
    handleAgentCommand: async () => ({ handled: false }),
    handleAdminCommand: async () => ({ handled: false }),
    handleExecCommand: async () => false,
    handleOpsCommand: async () => false,
    askClaude: async () => ({ ok: true }),
    providerMod: null,
    getNoSleepProcess: () => null,
    activeProcesses,
    messageQueue,
    log: () => {},
    agentTools: {},
    pendingAgentFlows: new Map(),
    pendingActivations: new Map(),
    agentFlowTtlMs: 60000,
    getDefaultEngine: () => 'claude',
    ...overrides,
  };
}

function createBot(sent) {
  return {
    sendMessage: async (_chatId, text) => {
      sent.push(String(text));
      return { message_id: `m${sent.length}` };
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createConfig(overrides = {}) {
  return {
    telegram: {},
    feishu: {},
    projects: {},
    daemon: {},
    ...overrides,
  };
}

describe('daemon-command-router follow-up merge', () => {
  it('pauses the active task on the first follow-up message and starts collecting', async () => {
    const sent = [];
    const childSignals = [];
    const activeProcesses = new Map([
      ['chat-1', {
        child: {
          pid: undefined,
          kill: (signal) => { childSignals.push(signal); },
        },
        engine: 'codex',
        killSignal: 'SIGTERM',
      }],
    ]);
    const deps = createDeps({ activeProcesses });
    const { handleCommand } = createCommandRouter(deps);

    await handleCommand(
      createBot(sent),
      'chat-1',
      '先补充第一点',
      createConfig({ daemon: { follow_up_debounce_ms: 300 } }),
      null,
      'user-1',
      false
    );

    const queued = deps.messageQueue.get('chat-1');
    assert.ok(queued, 'message queue should exist');
    assert.equal(queued.mode, 'resume-after-pause');
    assert.deepEqual(queued.messages, ['先补充第一点']);
    assert.deepEqual(childSignals, ['SIGTERM']);
    assert.match(sent[0], /已暂停当前任务/);
    clearTimeout(queued.timer);
  });

  it('merges follow-up bursts and resumes once after the debounce window', async () => {
    const sent = [];
    const askCalls = [];
    const activeProcesses = new Map([
      ['chat-2', {
        child: {
          pid: undefined,
          kill: () => {},
        },
        engine: 'codex',
        killSignal: 'SIGTERM',
      }],
    ]);
    const deps = createDeps({
      activeProcesses,
      askClaude: async (_bot, _chatId, prompt) => {
        askCalls.push(prompt);
        return { ok: true };
      },
    });
    const { handleCommand } = createCommandRouter(deps);
    const bot = createBot(sent);
    const config = createConfig({ daemon: { follow_up_debounce_ms: 300 } });

    await handleCommand(bot, 'chat-2', '第一条补充', config, null, 'user-2', false);
    activeProcesses.delete('chat-2');
    await wait(80);
    await handleCommand(bot, 'chat-2', '第二条补充', config, null, 'user-2', false);

    await wait(380);

    assert.equal(askCalls.length, 1, 'should resume exactly once');
    assert.match(askCalls[0], /继续上面的工作/);
    assert.match(askCalls[0], /第一条补充/);
    assert.match(askCalls[0], /第二条补充/);
    assert.equal(deps.messageQueue.has('chat-2'), false, 'queue should be drained after resume');
  });

  it('keeps Claude follow-ups in the legacy queue without interrupting the active task', async () => {
    const sent = [];
    const childSignals = [];
    const activeProcesses = new Map([
      ['chat-3', {
        child: {
          pid: undefined,
          kill: (signal) => { childSignals.push(signal); },
        },
        engine: 'claude',
        killSignal: 'SIGTERM',
      }],
    ]);
    const deps = createDeps({ activeProcesses });
    const { handleCommand } = createCommandRouter(deps);

    await handleCommand(
      createBot(sent),
      'chat-3',
      '补充给 Claude',
      createConfig(),
      null,
      'user-3',
      false
    );

    const queued = deps.messageQueue.get('chat-3');
    assert.ok(queued, 'message queue should exist');
    assert.equal(queued.mode, undefined);
    assert.deepEqual(queued.messages, ['补充给 Claude']);
    assert.deepEqual(childSignals, []);
    assert.match(sent[0], /完成后继续处理/);
  });

  it('keeps the legacy follow-up queue cap for non-Codex runs', async () => {
    const sent = [];
    const activeProcesses = new Map([
      ['chat-4', {
        child: {
          pid: undefined,
          kill: () => {},
        },
        engine: 'claude',
        killSignal: 'SIGTERM',
      }],
    ]);
    const messageQueue = new Map([
      ['chat-4', { messages: Array.from({ length: 10 }, (_, i) => `m${i}`) }],
    ]);
    const deps = createDeps({ activeProcesses, messageQueue });
    const { handleCommand } = createCommandRouter(deps);

    await handleCommand(
      createBot(sent),
      'chat-4',
      '第十一条',
      createConfig(),
      null,
      'user-4',
      false
    );

    assert.match(sent[0], /排队已满（10条）/);
    assert.equal(deps.messageQueue.get('chat-4').messages.length, 10);
  });
});

describe('chat_agent_map session reuse (multi-engine format)', () => {
  it('should NOT recreate session when multi-engine session already has the correct engine slot', async () => {
    let attachCalls = 0;
    const deps = createDeps({
      loadState: () => ({
        sessions: {
          '_bound_personal': {
            cwd: '/Users/test/Agent_yaron',
            engines: { codex: { id: 'existing-session-id', started: true, runtimeSessionObserved: true } },
            last_active: Date.now(),
          },
        },
      }),
      attachOrCreateSession: () => { attachCalls++; },
      getDefaultEngine: () => 'claude',
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { 'oc_test123': 'personal' } },
      projects: { personal: { cwd: '/Users/test/Agent_yaron', engine: 'codex', name: '小美' } },
    });

    await handleCommand(createBot(sent), 'oc_test123', '你好', config, null, 'user-1', false);
    assert.equal(attachCalls, 0, 'should NOT call attachOrCreateSession when session already has codex engine slot');
  });

  it('should recreate session when multi-engine session is missing the required engine slot', async () => {
    let attachCalls = 0;
    const deps = createDeps({
      loadState: () => ({
        sessions: {
          '_bound_personal': {
            cwd: '/Users/test/Agent_yaron',
            engines: { claude: { id: 'claude-session-id', started: true } },
            last_active: Date.now(),
          },
        },
      }),
      attachOrCreateSession: () => { attachCalls++; },
      getDefaultEngine: () => 'claude',
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { 'oc_test123': 'personal' } },
      projects: { personal: { cwd: '/Users/test/Agent_yaron', engine: 'codex', name: '小美' } },
    });

    await handleCommand(createBot(sent), 'oc_test123', '你好', config, null, 'user-1', false);
    assert.equal(attachCalls, 1, 'should call attachOrCreateSession when codex slot is missing');
  });

  it('should recreate session when cwd changed', async () => {
    let attachCalls = 0;
    const deps = createDeps({
      loadState: () => ({
        sessions: {
          '_bound_personal': {
            cwd: '/Users/test/OLD_DIR',
            engines: { codex: { id: 'old-session', started: true } },
            last_active: Date.now(),
          },
        },
      }),
      attachOrCreateSession: () => { attachCalls++; },
      getDefaultEngine: () => 'claude',
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { 'oc_test123': 'personal' } },
      projects: { personal: { cwd: '/Users/test/NEW_DIR', engine: 'codex', name: '小美' } },
    });

    await handleCommand(createBot(sent), 'oc_test123', '你好', config, null, 'user-1', false);
    assert.equal(attachCalls, 1, 'should call attachOrCreateSession when cwd changed');
  });

  it('should handle legacy flat session format gracefully', async () => {
    let attachCalls = 0;
    const deps = createDeps({
      loadState: () => ({
        sessions: {
          '_bound_personal': {
            cwd: '/Users/test/Agent_yaron',
            engine: 'codex',
            id: 'legacy-session-id',
            started: true,
          },
        },
      }),
      attachOrCreateSession: () => { attachCalls++; },
      getDefaultEngine: () => 'claude',
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { 'oc_test123': 'personal' } },
      projects: { personal: { cwd: '/Users/test/Agent_yaron', engine: 'codex', name: '小美' } },
    });

    await handleCommand(createBot(sent), 'oc_test123', '你好', config, null, 'user-1', false);
    assert.equal(attachCalls, 0, 'should NOT recreate session when legacy format engine matches');
  });
});
