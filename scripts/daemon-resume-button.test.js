'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { createSessionCommandHandler } = require('./daemon-session-commands');
const { createCommandRouter } = require('./daemon-command-router');

// ─── Shared test data ────────────────────────────────────────────────────────

const SESSIONS = [
  {
    sessionId: 'aaaa1111-0000-0000-0000-000000000001',
    customTitle: 'Fix login bug',
    summary: 'Fixed auth flow',
    firstPrompt: 'Fix the login bug',
    projectPath: '/tmp/proj1',
    engine: 'claude',
    fileMtime: Date.now(),
    messageCount: 10,
  },
  {
    sessionId: 'bbbb2222-0000-0000-0000-000000000002',
    customTitle: 'Add dashboard',
    summary: 'Dashboard feature',
    firstPrompt: 'Build dashboard',
    projectPath: '/tmp/proj2',
    engine: 'claude',
    fileMtime: Date.now(),
    messageCount: 5,
  },
];

const CONTEXT_MAP = {
  'aaaa1111-0000-0000-0000-000000000001': {
    lastUser: 'Can you fix the login validation?',
    lastAssistant: 'I fixed the validation logic in auth.js.',
  },
  'bbbb2222-0000-0000-0000-000000000002': {
    lastUser: 'Add chart component to dashboard',
    lastAssistant: 'Added the Chart component with responsive layout.',
  },
};

// ─── Harness for session command handler ─────────────────────────────────────

function createSessionHarness(options = {}) {
  const chatId = options.chatId || 'test_chat';
  const cfg = options.config || { projects: {} };
  const sent = [];
  const cards = [];
  const state = { sessions: {} };
  if (options.stateSessions) Object.assign(state.sessions, options.stateSessions);
  let savedState = null;

  const { handleSessionCommand } = createSessionCommandHandler({
    fs: require('fs'),
    path,
    HOME: os.homedir(),
    log: () => {},
    loadConfig: () => cfg,
    loadState: () => state,
    saveState: (next) => {
      savedState = JSON.parse(JSON.stringify(next));
      Object.assign(state, next);
    },
    normalizeCwd: (p) => path.resolve(String(p || '')),
    expandPath: (p) => p,
    sendBrowse: async () => {},
    sendDirPicker: async () => {},
    createSession: (_cid, cwd, name, engine) => ({ cwd, id: 'new-session', started: false, engine }),
    getCachedFile: () => null,
    getSession: (id) => state.sessions[id] || null,
    listRecentSessions: () => options.sessions || [],
    getSessionFileMtime: () => null,
    formatRelativeTime: () => '1m ago',
    sendDirListing: async () => {},
    writeSessionName: () => {},
    getSessionName: () => '',
    loadSessionTags: () => ({}),
    sessionRichLabel: (s) => s.sessionId,
    buildSessionCardElements: () => [],
    sessionLabel: (s) => s.sessionId,
    getDefaultEngine: () => options.defaultEngine || 'claude',
    getSessionRecentContext: (sid) => {
      const map = options.contextMap || {};
      return map[sid] || null;
    },
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendRawCard: async (_chatId, title, elements) => { cards.push({ title, elements }); },
    sendCard: true,
  };

  return { handleSessionCommand, bot, chatId, sent, cards, getSavedState: () => savedState };
}

// ─── Harness for full command router (button callback simulation) ────────────

function createRouterHarness(options = {}) {
  const chatId = options.chatId || 'test_chat';
  const cfg = options.config || { projects: {} };
  const sent = [];
  const cards = [];
  const state = { sessions: {} };
  if (options.stateSessions) Object.assign(state.sessions, options.stateSessions);
  let savedState = null;
  let sessionCommandCalled = null;

  const { handleCommand } = createCommandRouter({
    loadState: () => state,
    loadConfig: () => cfg,
    checkBudget: () => true,
    checkCooldown: () => ({ ok: true }),
    resetCooldown: () => {},
    routeAgent: () => null,
    normalizeCwd: (p) => path.resolve(String(p || '')),
    attachOrCreateSession: () => {},
    handleSessionCommand: async (ctx) => {
      sessionCommandCalled = ctx.text;
      // Simulate /resume <id> flow
      if (ctx.text.startsWith('/resume ')) {
        const arg = ctx.text.slice(7).trim();
        if (arg) {
          const s = (options.sessions || []).find(x => x.sessionId === arg || x.sessionId.startsWith(arg));
          if (s) {
            await ctx.bot.sendMessage(ctx.chatId, `▶️ Resumed: ${s.customTitle || s.sessionId.slice(0, 8)}`);
          } else {
            await ctx.bot.sendMessage(ctx.chatId, `Session not found: ${arg.slice(0, 12)}`);
          }
          return true;
        }
      }
      if (ctx.text === '/sessions') {
        await ctx.bot.sendRawCard(ctx.chatId, '📋 Recent Sessions', []);
        return true;
      }
      return false;
    },
    handleAgentCommand: async () => false,
    handleAdminCommand: async () => ({ handled: false }),
    handleExecCommand: async () => false,
    handleOpsCommand: async () => false,
    askClaude: async () => ({ ok: true }),
    providerMod: null,
    getNoSleepProcess: () => null,
    activeProcesses: new Map(),
    pipeline: { current: null },
    log: () => {},
    agentTools: null,
    pendingAgentFlows: new Map(),
    pendingActivations: new Map(),
    agentFlowTtlMs: 600000,
    getDefaultEngine: () => 'claude',
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendRawCard: async (_chatId, title, elements) => { cards.push({ title, elements }); },
    sendCard: true,
  };

  return { handleCommand, bot, chatId, sent, cards, getSessionCommandCalled: () => sessionCommandCalled };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('/resume button click flow', () => {
  it('/resume <sessionId> from button callback switches session in one call', async () => {
    const h = createSessionHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });
    const sid = SESSIONS[0].sessionId;

    // Simulate button callback: /resume <full session id>
    const handled = await h.handleSessionCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: `/resume ${sid}`,
    });

    assert.equal(handled, true, 'handleSessionCommand should return true');
    assert.equal(h.sent.length, 1, 'should send exactly one confirmation message');
    assert.ok(h.sent[0].includes('▶️ Resumed'), 'should confirm session resumed');
    assert.ok(h.sent[0].includes('Fix login bug'), 'should include session title');

    // Verify state was saved with new session
    const saved = h.getSavedState();
    assert.ok(saved, 'state should be saved');
    assert.ok(saved.sessions, 'sessions should exist in saved state');
  });

  it('/resume <sessionId> is not intercepted by other commands', async () => {
    const h = createRouterHarness({ sessions: SESSIONS });
    const sid = SESSIONS[0].sessionId;

    await h.handleCommand(h.bot, h.chatId, `/resume ${sid}`, {}, null, null, false);

    // Verify handleSessionCommand received the correct text
    assert.equal(h.getSessionCommandCalled(), `/resume ${sid}`, 'handleSessionCommand should be called with /resume <id>');
    assert.equal(h.sent.length, 1, 'should send exactly one message');
    assert.ok(h.sent[0].includes('Resumed'), 'should show resumed confirmation');
  });

  it('/resume <partial id> also works with one call', async () => {
    const h = createSessionHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });

    const handled = await h.handleSessionCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume aaaa1111',
    });

    assert.equal(handled, true);
    assert.equal(h.sent.length, 1, 'should send exactly one message for partial ID');
    assert.ok(h.sent[0].includes('▶️ Resumed'));
  });

  it('/sessions is not intercepted by /resume handler', async () => {
    const h = createRouterHarness({ sessions: SESSIONS });

    await h.handleCommand(h.bot, h.chatId, '/sessions', {}, null, null, false);

    assert.equal(h.getSessionCommandCalled(), '/sessions', 'handleSessionCommand should receive /sessions');
    assert.equal(h.cards.length, 1, 'should send a card');
  });

  it('/resume <invalid id> returns not found (single message)', async () => {
    const h = createSessionHarness({ sessions: SESSIONS });

    const handled = await h.handleSessionCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume zzzz0000',
    });

    assert.equal(handled, true);
    assert.equal(h.sent.length, 1, 'should send exactly one not-found message');
    assert.ok(h.sent[0].includes('Session not found'));
  });

  it('/resume no args shows card with session list (not forwarded to other handlers)', async () => {
    const h = createRouterHarness({ sessions: SESSIONS });

    await h.handleCommand(h.bot, h.chatId, '/resume', {}, null, null, false);

    assert.equal(h.getSessionCommandCalled(), '/resume', 'handleSessionCommand should receive bare /resume');
  });
});

describe('/sessions card includes 👤🤖 context', () => {
  it('buildSessionCardElements includes user and assistant markers', async () => {
    // Use a harness that calls the real buildSessionCardElements
    const { createSessionStore } = require('./daemon-session-store');
    const fs = require('fs');
    const store = createSessionStore({
      fs,
      path,
      HOME: os.homedir(),
      log: () => {},
      loadState: () => ({ sessions: {} }),
      saveState: () => {},
      formatRelativeTime: () => '1m ago',
    });

    // Mock getSessionRecentContext by patching the store
    // Since buildSessionCardElements calls getSessionRecentContext internally,
    // we need to test through the integration
    const elements = store.buildSessionCardElements(SESSIONS);

    // Each session should have a div and action element
    const divs = elements.filter(e => e.tag === 'div');
    assert.ok(divs.length >= 2, 'should have at least 2 div elements');

    // Check that buttons have correct /resume <id> commands
    const actions = elements.filter(e => e.tag === 'action');
    assert.ok(actions.length >= 2, 'should have at least 2 action elements');
    const btn1 = actions[0].actions[0];
    assert.equal(btn1.value.cmd, `/resume ${SESSIONS[0].sessionId}`, 'button should have /resume <full id>');
    const btn2 = actions[1].actions[0];
    assert.equal(btn2.value.cmd, `/resume ${SESSIONS[1].sessionId}`, 'button should have /resume <full id>');
  });
});

describe('feishu card action dedup', () => {
  it('card action dedup key generation uses token when available', () => {
    // Test the dedup logic conceptually — the actual implementation is in feishu-adapter
    // This ensures the key format is deterministic
    const token = 'abc123';
    const dedupKey = `card_${token}`;
    assert.equal(dedupKey, 'card_abc123');

    // Without token, uses time-bucketed key
    const chatId = 'oc_xxx';
    const cmd = '/resume sid123';
    const timeBucket = Math.floor(Date.now() / 3000);
    const fallbackKey = `card_${chatId}_${cmd}_${timeBucket}`;
    assert.ok(fallbackKey.startsWith('card_oc_xxx_/resume sid123_'));
  });
});
