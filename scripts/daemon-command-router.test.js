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

  it('should NOT recreate session when cwd changed — only /new creates sessions', async () => {
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
    assert.equal(attachCalls, 0, 'should NOT call attachOrCreateSession when cwd changed — session sticks');
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
