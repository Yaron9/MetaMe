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
  const state = {
    sessions: {
      [chatId]: {
        id: options.currentId || 'sid-current',
        cwd: options.currentCwd || '/tmp/current',
        engine: options.currentEngine || 'claude',
        started: true,
      },
    },
  };

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
    listRecentSessions: (limit, cwd) => {
      if (limit === 5 && cwd) {
        return sessions.filter(s => s.projectPath === cwd).slice(0, 5);
      }
      return sessions.slice(0, limit || sessions.length);
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
    attachOrCreateSession: () => {},
    agentFlowTtlMs: () => 10 * 60 * 1000,
    agentBindTtlMs: () => 10 * 60 * 1000,
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendMarkdown: async (_chatId, text) => { sent.push(String(text)); },
  };

  return { handleAgentCommand, bot, chatId, state, sent };
}

describe('daemon-agent-commands /resume engine resolution', () => {
  it('resolves engine from target session cwd project config', async () => {
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
        { sessionId: 'sid-claude-1', projectPath: '/repo/claude', customTitle: 'claude task' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-claude',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.state.sessions[h.chatId].id, 'sid-claude-1');
    assert.equal(h.state.sessions[h.chatId].engine, 'claude');
  });

  it('keeps current engine when target cwd is not mapped', async () => {
    const h = createHarness({
      currentEngine: 'codex',
      currentCwd: '/repo/codex',
      config: {
        projects: {
          codex_proj: { cwd: '/repo/codex', engine: 'codex' },
        },
      },
      sessions: [
        { sessionId: 'sid-unknown-1', projectPath: '/repo/unknown', customTitle: 'legacy' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-unknown',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.state.sessions[h.chatId].engine, 'codex');
  });
});
