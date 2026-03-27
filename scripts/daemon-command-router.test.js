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

// NOTE: follow-up merge tests removed — that logic moved to daemon-message-pipeline.js
// See daemon-message-pipeline tests for coverage.

describe('/btw side question command', () => {
  it('should call askClaude with readOnly=true and prefixed prompt', async () => {
    let claudeArgs = null;
    const deps = createDeps({
      askClaude: async (bot, chatId, prompt, config, readOnly, senderId) => {
        claudeArgs = { chatId, prompt, readOnly, senderId };
        return { ok: true };
      },
      resetCooldown: () => {},
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig();

    await handleCommand(createBot(sent), 'chat1', '/btw what is this function', config, null, 'user-1', false);
    assert.ok(claudeArgs, 'askClaude should be called');
    assert.equal(claudeArgs.readOnly, true, 'should pass readOnly=true');
    assert.ok(claudeArgs.prompt.includes('what is this function'), 'should include original question');
    assert.ok(claudeArgs.prompt.includes('Side question'), 'should include concise hint prefix');
  });

  it('should show usage hint for bare /btw with no question', async () => {
    let claudeCalled = false;
    const deps = createDeps({
      askClaude: async () => { claudeCalled = true; return { ok: true }; },
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig();

    await handleCommand(createBot(sent), 'chat1', '/btw', config, null, 'user-1', false);
    assert.equal(claudeCalled, false, 'should NOT call askClaude');
    assert.ok(sent.some((m) => m.includes('/btw')), 'should show usage hint');
  });

  it('should show usage hint for /btw with whitespace only', async () => {
    let claudeCalled = false;
    const deps = createDeps({
      askClaude: async () => { claudeCalled = true; return { ok: true }; },
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig();

    await handleCommand(createBot(sent), 'chat1', '/btw   ', config, null, 'user-1', false);
    assert.equal(claudeCalled, false, 'should NOT call askClaude for whitespace-only');
  });

  it('should call resetCooldown before askClaude', async () => {
    const callOrder = [];
    const deps = createDeps({
      resetCooldown: () => { callOrder.push('resetCooldown'); },
      askClaude: async () => { callOrder.push('askClaude'); return { ok: true }; },
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig();

    await handleCommand(createBot(sent), 'chat1', '/btw test', config, null, 'user-1', false);
    assert.deepEqual(callOrder, ['resetCooldown', 'askClaude'], 'resetCooldown should be called before askClaude');
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

  it('should reattach session when bound project cwd changed in config', async () => {
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
    assert.equal(attachCalls, 1, 'should call attachOrCreateSession when bound project cwd changes');
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

  it('should keep topic-thread session ids isolated instead of collapsing to _bound_ keys', async () => {
    const attachCalls = [];
    const deps = createDeps({
      loadState: () => ({ sessions: {} }),
      attachOrCreateSession: (...args) => { attachCalls.push(args); },
      getDefaultEngine: () => 'claude',
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { 'oc_test123': 'personal' } },
      projects: { personal: { cwd: '/Users/test/Agent_yaron', engine: 'claude', name: '小美' } },
    });

    await handleCommand(createBot(sent), 'thread:oc_test123:om_topic_1', '你好', config, null, 'user-1', false);
    assert.equal(attachCalls.length, 1, 'should initialize exactly one session for a fresh topic thread');
    assert.equal(attachCalls[0][0], 'thread:oc_test123:om_topic_1', 'topic thread should keep its own session key');
  });
});

describe('natural language continue routing', () => {
  it('reuses the current bound session instead of forcing /last', async () => {
    const sessionState = {
      sessions: {
        _bound_metame: {
          cwd: '/repo/metame',
          engines: {
            codex: { id: 'reply-restored-thread', started: true, runtimeSessionObserved: true },
          },
          last_active: Date.now(),
        },
      },
    };
    const sessionCommands = [];
    const askCalls = [];
    const deps = createDeps({
      loadState: () => sessionState,
      getDefaultEngine: () => 'codex',
      handleSessionCommand: async ({ text }) => {
        sessionCommands.push(text);
        return false;
      },
      askClaude: async (_bot, chatId, prompt) => {
        askCalls.push({ chatId, prompt });
        return { ok: true };
      },
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { chat1: 'metame' } },
      projects: { metame: { cwd: '/repo/metame', engine: 'codex', name: 'MetaMe' } },
    });

    await handleCommand(createBot(sent), 'chat1', '继续', config, null, 'user-1', false);

    assert.equal(sessionCommands.includes('/last'), false, 'should not call /last when current chat already has a session');
    assert.equal(askCalls.length, 1, 'should continue the current session directly');
    assert.equal(askCalls[0].prompt, '继续上面的工作');
  });

  it('falls back to /last when the chat has no current session', async () => {
    const sessionCommands = [];
    const askCalls = [];
    const deps = createDeps({
      loadState: () => ({ sessions: {} }),
      handleSessionCommand: async ({ text }) => {
        sessionCommands.push(text);
        return text === '/last';
      },
      askClaude: async (_bot, chatId, prompt) => {
        askCalls.push({ chatId, prompt });
        return { ok: true };
      },
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig();

    await handleCommand(createBot(sent), 'chat1', '继续', config, null, 'user-1', false);

    assert.deepEqual(sessionCommands, ['继续', '/last']);
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].prompt, '继续上面的工作');
  });

  it('reuses an existing non-preferred engine slot before falling back to /last', async () => {
    const sessionState = {
      sessions: {
        _bound_metame: {
          cwd: '/repo/metame',
          engines: {
            claude: { id: 'claude-current-thread', started: true },
          },
          last_active: Date.now(),
        },
      },
    };
    const sessionCommands = [];
    const askCalls = [];
    const deps = createDeps({
      loadState: () => sessionState,
      getDefaultEngine: () => 'claude',
      handleSessionCommand: async ({ text }) => {
        sessionCommands.push(text);
        return false;
      },
      askClaude: async (_bot, chatId, prompt) => {
        askCalls.push({ chatId, prompt });
        return { ok: true };
      },
    });
    const { handleCommand } = createCommandRouter(deps);
    const sent = [];
    const config = createConfig({
      feishu: { chat_agent_map: { chat1: 'metame' } },
      projects: { metame: { cwd: '/repo/metame', engine: 'codex', name: 'MetaMe' } },
    });

    await handleCommand(createBot(sent), 'chat1', '继续', config, null, 'user-1', false);

    assert.equal(sessionCommands.includes('/last'), false);
    assert.equal(askCalls.length, 1);
    assert.equal(askCalls[0].prompt, '继续上面的工作');
  });

  it('attaches topic virtual agent chats using the base agent key before the thread suffix', async () => {
    const attachCalls = [];
    const deps = createDeps({
      attachOrCreateSession: (...args) => attachCalls.push(args),
      loadState: () => ({ sessions: {} }),
    });
    const { handleCommand } = createCommandRouter(deps);
    const config = createConfig({
      projects: {
        bing: { cwd: '/repo/agents/bing', engine: 'codex', name: 'Jarvis · 丙' },
      },
    });

    await handleCommand(
      createBot([]),
      '_agent_bing::thread:oc_topic_1:om_root_1',
      '继续',
      config,
      null,
      'user-1',
      false
    );

    assert.deepEqual(attachCalls[0], [
      '_agent_bing::thread:oc_topic_1:om_root_1',
      '/repo/agents/bing',
      'Jarvis · 丙',
      'codex',
    ]);
  });
});
