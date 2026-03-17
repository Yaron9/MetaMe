'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { createSessionCommandHandler } = require('./daemon-session-commands');

function createHarness(options = {}) {
  const chatId = options.chatId || 'test_chat';
  const cfg = options.config || { projects: {} };
  const sent = [];
  const cards = [];
  const state = { sessions: {} };
  if (options.stateSessions) Object.assign(state.sessions, options.stateSessions);

  const contextCalls = [];

  const { handleSessionCommand } = createSessionCommandHandler({
    fs: require('fs'),
    path,
    HOME: os.homedir(),
    log: () => {},
    loadConfig: () => cfg,
    loadState: () => state,
    saveState: (next) => { Object.assign(state, next); },
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
    sessionRichLabel: (s) => `${s.sessionId.slice(0, 8)} - ${s.customTitle || s.summary || ''}`,
    buildSessionCardElements: () => [],
    sessionLabel: (s) => s.sessionId,
    getDefaultEngine: () => options.defaultEngine || 'claude',
    getSessionRecentContext: (sid) => {
      contextCalls.push(sid);
      const map = options.contextMap || {};
      return map[sid] || null;
    },
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendRawCard: async (_chatId, title, elements) => { cards.push({ title, elements }); },
    sendCard: true,
  };

  // bot without sendCard (text fallback mode)
  const botText = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
  };

  return { handleSessionCommand, bot, botText, chatId, sent, cards, contextCalls };
}

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

describe('/resume display tests', () => {
  it('/resume (no args) calls getSessionRecentContext for each session', async () => {
    const h = createHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: '/resume' });
    // Should have called getSessionRecentContext for both sessions
    assert.equal(h.contextCalls.length, 2);
    assert.equal(h.contextCalls[0], SESSIONS[0].sessionId);
    assert.equal(h.contextCalls[1], SESSIONS[1].sessionId);
  });

  it('/resume (no args) card contains user and assistant markers', async () => {
    const h = createHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: '/resume' });
    assert.equal(h.cards.length, 1);
    const card = h.cards[0];
    // Find div elements with content
    const divs = card.elements.filter(e => e.tag === 'div');
    // First session div should contain user and assistant context
    const body1 = divs[0].text.content;
    assert.ok(body1.includes('👤'), 'First session card should have user marker');
    assert.ok(body1.includes('🤖'), 'First session card should have assistant marker');
    assert.ok(body1.includes('login validation'), 'Should contain user message text');
    assert.ok(body1.includes('validation logic'), 'Should contain assistant reply text');
    // Second session
    const body2 = divs[1].text.content;
    assert.ok(body2.includes('👤'), 'Second session card should have user marker');
    assert.ok(body2.includes('🤖'), 'Second session card should have assistant marker');
  });

  it('/resume (no args) text fallback includes user and assistant context', async () => {
    const h = createHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });
    await h.handleSessionCommand({ bot: h.botText, chatId: h.chatId, text: '/resume' });
    assert.equal(h.sent.length, 1);
    const msg = h.sent[0];
    assert.ok(msg.includes('👤'), 'Text fallback should include user marker');
    assert.ok(msg.includes('🤖'), 'Text fallback should include assistant marker');
    assert.ok(msg.includes('login validation'), 'Text fallback should include user message');
    assert.ok(msg.includes('validation logic'), 'Text fallback should include assistant reply');
  });

  it('/resume <id> confirmation message includes user and assistant context', async () => {
    const h = createHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });
    const sid = SESSIONS[0].sessionId;
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: `/resume ${sid}` });
    assert.equal(h.sent.length, 1);
    const msg = h.sent[0];
    assert.ok(msg.includes('▶️ Resumed'), 'Should show resumed confirmation');
    assert.ok(msg.includes('👤'), 'Confirm msg should include user marker');
    assert.ok(msg.includes('🤖'), 'Confirm msg should include assistant marker');
    assert.ok(msg.includes('login validation'), 'Should include last user question');
    assert.ok(msg.includes('validation logic'), 'Should include last AI reply');
  });

  it('/resume <id> with partial ID match works', async () => {
    const h = createHarness({ sessions: SESSIONS, contextMap: CONTEXT_MAP });
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: '/resume aaaa1111' });
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].includes('👤'));
    assert.ok(h.sent[0].includes('🤖'));
  });

  it('/resume (no args) handles missing context gracefully', async () => {
    // No contextMap — getSessionRecentContext returns null
    const h = createHarness({ sessions: SESSIONS, contextMap: {} });
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: '/resume' });
    assert.equal(h.cards.length, 1);
    // Should still render cards without crashing
    const divs = h.cards[0].elements.filter(e => e.tag === 'div');
    assert.ok(divs.length >= 2, 'Should have div elements even without context');
    // No user/assistant markers when context is null
    const body1 = divs[0].text.content;
    assert.ok(!body1.includes('👤'), 'Should not have user marker when no context');
    assert.ok(!body1.includes('🤖'), 'Should not have assistant marker when no context');
  });

  it('/resume <id> handles missing context gracefully', async () => {
    const h = createHarness({ sessions: SESSIONS, contextMap: {} });
    const sid = SESSIONS[0].sessionId;
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: `/resume ${sid}` });
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].includes('▶️ Resumed'));
    assert.ok(!h.sent[0].includes('👤'), 'No user marker when context is missing');
  });

  it('/resume with no sessions shows empty message', async () => {
    const h = createHarness({ sessions: [] });
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: '/resume' });
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].includes('No sessions found'));
  });

  it('/resume with non-existent ID shows not found', async () => {
    const h = createHarness({ sessions: SESSIONS });
    await h.handleSessionCommand({ bot: h.bot, chatId: h.chatId, text: '/resume zzzz0000' });
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0].includes('Session not found'));
  });
});
