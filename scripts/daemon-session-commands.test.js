'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { createSessionCommandHandler } = require('./daemon-session-commands');

function createHarness(options = {}) {
  const chatId = options.chatId || 'sess_chat';
  const cfg = options.config || { projects: {} };
  const sent = [];
  const created = [];
  const state = { sessions: {} };
  if (options.stateSessions) Object.assign(state.sessions, options.stateSessions);
  if (options.teamSticky) state.team_sticky = { [chatId]: options.teamSticky };

  const { handleSessionCommand } = createSessionCommandHandler({
    fs: require('fs'),
    path,
    HOME: os.homedir(),
    log: () => {},
    loadConfig: () => cfg,
    loadState: () => state,
    saveState: (next) => {
      Object.assign(state, next);
      state.sessions = next.sessions;
    },
    normalizeCwd: (p) => path.resolve(String(p || '')),
    expandPath: (p) => p,
    sendBrowse: async () => {},
    sendDirPicker: async () => {},
    createSession: (cid, cwd, name, engine) => {
      const rec = { cid, cwd, name, engine };
      created.push(rec);
      return { cwd, id: 'new-session', started: false, engine };
    },
    getSessionForEngine: () => null,
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
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendRawCard: async () => {},
  };

  return { handleSessionCommand, bot, chatId, sent, created };
}

describe('daemon-session-commands empty session bootstrap', () => {
  it('auto-creates a session for /sessions when bound cwd exists', async () => {
    const cwd = os.tmpdir();
    const h = createHarness({
      config: {
        projects: {
          metame: { cwd, engine: 'codex' },
        },
        feishu: {
          chat_agent_map: {
            sess_chat: 'metame',
          },
        },
      },
      sessions: [],
      defaultEngine: 'codex',
    });

    const handled = await h.handleSessionCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/sessions',
    });

    assert.equal(handled, true);
    assert.equal(h.created.length, 1);
    assert.deepEqual(h.created[0], { cid: '_agent_metame', cwd, name: '', engine: 'codex' });
    assert.match(h.sent[0], /已自动创建新会话/);
  });

  it('creates sticky member session for /new in team group', async () => {
    const h = createHarness({
      chatId: 'team-chat',
      teamSticky: 'jia',
      config: {
        projects: {
          jarvis: {
            cwd: '/repo/main',
            engine: 'claude',
            team: [
              { key: 'jia', cwd: '/repo/jia', engine: 'codex' },
            ],
          },
        },
        feishu: {
          chat_agent_map: {
            'team-chat': 'jarvis',
          },
        },
      },
      defaultEngine: 'claude',
    });

    const handled = await h.handleSessionCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/new',
    });

    assert.equal(handled, true);
    assert.deepEqual(h.created[0], { cid: '_agent_jia', cwd: '/repo/jia', name: '', engine: 'codex' });
  });

  it('uses started codex engine slot for /sessions filtering when top-level engine is absent', async () => {
    const h = createHarness({
      stateSessions: {
        sess_chat: {
          cwd: '/repo/codex',
          engines: {
            codex: { id: 'sid-codex-current', started: true },
          },
        },
      },
      sessions: [
        { sessionId: 'sid-codex-1', projectPath: '/repo/codex', engine: 'codex' },
      ],
      defaultEngine: 'claude',
    });

    const handled = await h.handleSessionCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/sessions',
    });

    assert.equal(handled, true);
    assert.equal(h.created.length, 0);
  });
});
