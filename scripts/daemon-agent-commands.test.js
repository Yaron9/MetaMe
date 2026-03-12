'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const { createAgentCommandHandler } = require('./daemon-agent-commands');

function createHarness(options = {}) {
  const chatId = options.chatId || 'oc_test_chat';
  const cfg = options.config || { projects: {} };
  const sessions = options.sessions || [];
  const sent = [];
  const attached = [];
  const state = {
    sessions: {
      [chatId]: {
        id: options.currentId || 'sid-current',
        cwd: options.currentCwd || '/tmp/current',
        engine: options.currentEngine || 'claude',
        started: true,
      },
      ...(options.virtualSessions || {}),
    },
  };
  if (options.teamSticky) state.team_sticky = { [chatId]: options.teamSticky };

  const { handleAgentCommand } = createAgentCommandHandler({
    fs: require('fs'),
    path,
    HOME: os.homedir(),
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
    getSession: (id) => state.sessions[id] || null,
    listRecentSessions: (limit, cwd, engine) => {
      let filtered = sessions.slice();
      if (cwd) filtered = filtered.filter(s => s.projectPath === cwd);
      if (engine) filtered = filtered.filter(s => (s.engine || 'claude') === engine);
      return filtered.slice(0, limit || filtered.length);
    },
    buildSessionCardElements: () => [],
    sessionLabel: (s) => s.sessionId,
    loadSessionTags: () => ({}),
    sessionRichLabel: (s) => s.sessionId,
    getSessionRecentContext: () => null,
    pendingBinds: new Map(),
    pendingAgentFlows: new Map(),
    pendingActivations: new Map(),
    doBindAgent: async () => ({ ok: false, error: 'unused' }),
    mergeAgentRole: async () => ({ ok: false, error: 'unused' }),
    agentTools: null,
    attachOrCreateSession: (...args) => { attached.push(args); },
    agentFlowTtlMs: () => 10 * 60 * 1000,
    agentBindTtlMs: () => 10 * 60 * 1000,
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendMarkdown: async (_chatId, text) => { sent.push(String(text)); },
  };

  return { handleAgentCommand, bot, chatId, state, sent, attached };
}

describe('daemon-agent-commands /resume engine resolution', () => {
  it('does not resolve into a claude session from a codex chat even when cwd is mapped', async () => {
    const h = createHarness({
      currentEngine: 'codex',
      currentCwd: '/repo/codex',
      config: {
        projects: {
          claude_proj: { cwd: '/repo/claude', engine: 'claude' },
          codex_proj: { cwd: '/repo/codex', engine: 'codex' },
        },
      },
      sessions: [
        { sessionId: 'sid-claude-1', projectPath: '/repo/claude', customTitle: 'claude task', engine: 'claude' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-claude',
      config: { projects: {} },
    });

    assert.equal(handled, null);
    assert.equal(h.state.sessions[h.chatId].id, 'sid-current');
    assert.equal(h.state.sessions[h.chatId].engine, 'codex');
  });

  it('does not prefer a matched claude session when target cwd is not mapped', async () => {
    const h = createHarness({
      currentEngine: 'codex',
      currentCwd: '/repo/codex',
      config: {
        projects: {
          codex_proj: { cwd: '/repo/codex', engine: 'codex' },
        },
      },
      sessions: [
        { sessionId: 'sid-unknown-1', projectPath: '/repo/unknown', customTitle: 'legacy', engine: 'claude' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-unknown',
      config: { projects: {} },
    });

    assert.equal(handled, null);
    assert.equal(h.state.sessions[h.chatId].id, 'sid-current');
    assert.equal(h.state.sessions[h.chatId].engine, 'codex');
  });

  it('uses started codex engine slot when top-level engine is absent', async () => {
    const h = createHarness({
      currentEngine: 'claude',
      currentCwd: '/repo/codex',
      sessions: [
        { sessionId: 'sid-codex-1', projectPath: '/repo/codex', customTitle: 'codex task', engine: 'codex' },
      ],
    });
    h.state.sessions[h.chatId] = {
      cwd: '/repo/codex',
      engines: {
        codex: { id: 'sid-codex-current', started: true },
      },
    };

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.match(h.sent[0], /codex task|sid-codex-1/);
  });

  it('resumes into sticky team member virtual session when active', async () => {
    const h = createHarness({
      chatId: 'team-chat',
      currentEngine: 'claude',
      currentCwd: '/repo/main',
      config: {
        projects: {
          jarvis: {
            cwd: '/repo/main',
            engine: 'claude',
            team: [
              { key: 'jia', cwd: '/repo/jia', engine: 'codex', nicknames: ['甲'] },
            ],
          },
        },
        feishu: {
          chat_agent_map: {
            'team-chat': 'jarvis',
          },
        },
      },
      teamSticky: 'jia',
      virtualSessions: {
        _agent_jia: {
          id: 'sid-jia-current',
          cwd: '/repo/jia',
          engine: 'codex',
          started: true,
        },
      },
      sessions: [
        { sessionId: 'sid-jia-2', projectPath: '/repo/jia', customTitle: 'jia task', engine: 'codex' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-jia',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.state.sessions._agent_jia.id, 'sid-jia-2');
    assert.equal(h.state.sessions._agent_jia.engine, 'codex');
  });

  it('auto-creates a session when resume list is empty but cwd exists', async () => {
    const cwd = os.tmpdir();
    const h = createHarness({
      currentEngine: 'codex',
      currentCwd: cwd,
      config: {
        projects: {
          codex_proj: { cwd, engine: 'codex' },
        },
      },
      sessions: [],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.attached.length, 1);
    assert.deepEqual(h.attached[0], ['oc_test_chat', cwd, '', 'codex']);
    assert.match(h.sent[0], /已自动创建新会话/);
  });

  it('auto-creates sticky member virtual session when resume list is empty in team group', async () => {
    const h = createHarness({
      chatId: 'team-chat',
      currentEngine: 'claude',
      currentCwd: '/repo/main',
      config: {
        projects: {
          jarvis: {
            cwd: '/repo/main',
            engine: 'claude',
            team: [
              { key: 'jia', cwd: os.tmpdir(), engine: 'codex', nicknames: ['甲'] },
            ],
          },
        },
        feishu: {
          chat_agent_map: {
            'team-chat': 'jarvis',
          },
        },
      },
      teamSticky: 'jia',
      sessions: [],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.deepEqual(h.attached[0], ['_agent_jia', os.tmpdir(), '', 'codex']);
  });

  it('does not show cross-engine sessions when current engine has none', async () => {
    const cwd = os.tmpdir();
    const h = createHarness({
      currentEngine: 'codex',
      currentCwd: cwd,
      config: {
        projects: {
          codex_proj: { cwd, engine: 'codex' },
        },
      },
      sessions: [
        { sessionId: 'sid-claude-legacy', projectPath: cwd, customTitle: 'legacy task', engine: 'claude' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.attached.length, 1);
    assert.deepEqual(h.attached[0], ['oc_test_chat', cwd, '', 'codex']);
    assert.match(h.sent[0], /已自动创建新会话/);
  });

  it('does not match explicit resume args from another engine', async () => {
    const h = createHarness({
      currentEngine: 'codex',
      currentCwd: '/repo/codex',
      config: {
        projects: {
          claude_proj: { cwd: '/repo/claude', engine: 'claude' },
          codex_proj: { cwd: '/repo/codex', engine: 'codex' },
        },
      },
      sessions: [
        { sessionId: 'sid-claude-2', projectPath: '/repo/claude', customTitle: 'claude task', engine: 'claude' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-claude',
      config: { projects: {} },
    });

    assert.equal(handled, null);
    assert.equal(h.state.sessions[h.chatId].id, 'sid-current');
    assert.equal(h.state.sessions[h.chatId].engine, 'codex');
  });
});
