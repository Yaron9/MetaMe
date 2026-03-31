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
  const writes = [];
  let backups = 0;
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
    getSessionForEngine: (id, engine) => {
      const raw = state.sessions[id] || null;
      if (!raw) return null;
      if (raw.engines && raw.engines[engine]) return { cwd: raw.cwd, engine, ...raw.engines[engine] };
      if (raw.id) return { cwd: raw.cwd, engine, id: raw.id, started: !!raw.started };
      return null;
    },
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
    getSessionRecentDialogue: (sid) => options.dialogueMap ? (options.dialogueMap[sid] || null) : null,
    pendingBinds: new Map(),
    pendingAgentFlows: options.pendingAgentFlows || new Map(),
    pendingTeamFlows: options.pendingTeamFlows || new Map(),
    pendingActivations: new Map(),
    writeConfigSafe: (nextCfg) => { writes.push(nextCfg); },
    backupConfig: () => { backups += 1; },
    execSync: () => {},
    doBindAgent: async () => ({ ok: false, error: 'unused' }),
    mergeAgentRole: async () => ({ ok: false, error: 'unused' }),
    agentTools: options.agentTools || null,
    attachOrCreateSession: (...args) => { attached.push(args); },
    agentFlowTtlMs: () => 10 * 60 * 1000,
    agentBindTtlMs: () => 10 * 60 * 1000,
  });

  const bot = {
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendMarkdown: async (_chatId, text) => { sent.push(String(text)); },
  };

  return { handleAgentCommand, bot, chatId, state, sent, attached, writes, get backups() { return backups; } };
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

  it('switches sticky team member chats to the explicitly selected history session', async () => {
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
    assert.doesNotMatch(h.sent[0], /优先恢复当前智能体会话/);
  });

  it('shows the current logical session first in /resume for bound chats', async () => {
    const h = createHarness({
      chatId: 'bound-chat',
      currentEngine: 'claude',
      currentCwd: '/repo/main',
      config: {
        projects: {
          metame: { cwd: '/repo/main', engine: 'codex' },
        },
        feishu: {
          chat_agent_map: {
            'bound-chat': 'metame',
          },
        },
      },
      virtualSessions: {
        _bound_metame: {
          cwd: '/repo/main',
          engines: {
            codex: { id: 'sid-current-logical', started: true },
          },
        },
      },
      sessions: [
        { sessionId: 'sid-old-history', projectPath: '/repo/main', customTitle: 'old history', engine: 'codex' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.match(h.sent[0], /sid-current-logical/);
    assert.ok(h.sent[0].indexOf('sid-current-logical') < h.sent[0].indexOf('sid-old-history'));
    assert.equal(h.state.sessions._bound_metame.engines.codex.id, 'sid-current-logical');
  });

  it('honors explicit old-thread selection in a bound chat', async () => {
    const h = createHarness({
      chatId: 'bound-chat',
      currentEngine: 'claude',
      currentCwd: '/repo/main',
      config: {
        projects: {
          metame: { cwd: '/repo/main', engine: 'codex' },
        },
        feishu: {
          chat_agent_map: {
            'bound-chat': 'metame',
          },
        },
      },
      virtualSessions: {
        _bound_metame: {
          cwd: '/repo/main',
          engines: {
            codex: { id: 'sid-current-logical', started: true },
          },
        },
      },
      sessions: [
        { sessionId: 'sid-old-history', projectPath: '/repo/main', customTitle: 'old history', engine: 'codex' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-old-history',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.state.sessions._bound_metame.engines.codex.id, 'sid-old-history');
    assert.doesNotMatch(h.sent[0], /优先恢复当前智能体会话/);
  });

  it('switches team-group resume targets onto the matched member session and sticky route', async () => {
    const h = createHarness({
      chatId: 'team-chat',
      currentEngine: 'codex',
      currentCwd: '/repo/main',
      config: {
        projects: {
          jarvis: {
            cwd: '/repo/main',
            engine: 'codex',
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
      sessions: [
        { sessionId: 'sid-jia-history', projectPath: '/repo/jia', customTitle: 'jia x thread', engine: 'codex' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-jia-history',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.state.sessions._agent_jia.id, 'sid-jia-history');
    assert.equal(h.state.team_sticky['team-chat'], 'jia');
    assert.match(h.sent[0], /sid-jia-history/);
  });

  it('shows recent dialogue after switching to an explicit history session', async () => {
    const h = createHarness({
      chatId: 'bound-chat',
      currentEngine: 'claude',
      currentCwd: '/repo/main',
      config: {
        projects: {
          metame: { cwd: '/repo/main', engine: 'codex' },
        },
        feishu: {
          chat_agent_map: {
            'bound-chat': 'metame',
          },
        },
      },
      virtualSessions: {
        _bound_metame: {
          cwd: '/repo/main',
          engines: {
            codex: { id: 'sid-current-logical', started: true },
          },
        },
      },
      sessions: [
        { sessionId: 'sid-old-history', projectPath: '/repo/main', customTitle: 'old history', engine: 'codex' },
      ],
      dialogueMap: {
        'sid-old-history': [
          { role: 'user', text: '你先别继续实现，先评估下这个方案。' },
          { role: 'assistant', text: '当前方案最大问题是状态和展示耦合得太紧。' },
          { role: 'user', text: '那就只做 resume 成功后的最近对话。' },
          { role: 'assistant', text: '这个范围最合适，成本低而且收益高。' },
        ],
      },
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-old-history',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.match(h.sent[0], /最近对话:/);
    assert.match(h.sent[0], /状态和展示耦合得太紧/);
    assert.match(h.sent[0], /这个范围最合适/);
  });

  it('still allows resuming the synthetic current logical session entry', async () => {
    const h = createHarness({
      chatId: 'bound-chat',
      currentEngine: 'claude',
      currentCwd: '/repo/main',
      config: {
        projects: {
          metame: { cwd: '/repo/main', engine: 'codex' },
        },
        feishu: {
          chat_agent_map: {
            'bound-chat': 'metame',
          },
        },
      },
      virtualSessions: {
        _bound_metame: {
          cwd: '/repo/main',
          engines: {
            codex: { id: 'sid-current-logical', started: true },
          },
        },
      },
      sessions: [
        { sessionId: 'sid-old-history', projectPath: '/repo/main', customTitle: 'old history', engine: 'codex' },
      ],
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/resume sid-current-logical',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(h.state.sessions._bound_metame.engines.codex.id, 'sid-current-logical');
    assert.match(h.sent[0], /已恢复当前智能体会话/);
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

describe('daemon-agent-commands agent workflows', () => {
  it('binds into the logical _bound_<projectKey> session namespace', async () => {
    const h = createHarness({
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
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '/agent bind MetaMe /repo/main',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.deepEqual(h.attached, [['_bound_metame', '/repo/main', 'MetaMe', 'codex']]);
  });

  it('expires stale /agent new wizard flows before consuming plain text', async () => {
    const pendingAgentFlows = new Map([
      ['oc_test_chat', { step: 'name', dir: '/repo/main', __ts: Date.now() - (11 * 60 * 1000) }],
    ]);
    const h = createHarness({ pendingAgentFlows });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '随便一句话',
      config: { projects: {} },
    });

    assert.equal(handled, false);
    assert.equal(pendingAgentFlows.has('oc_test_chat'), false);
  });

  it('finishes /agent new clone after naming without asking for a role description', async () => {
    const pendingAgentFlows = new Map([
      ['oc_test_chat', { step: 'name', dir: '/repo/clone', isClone: true, parentCwd: '/repo/parent', __ts: Date.now() }],
    ]);
    const h = createHarness({
      pendingAgentFlows,
      agentTools: {
        createNewWorkspaceAgent: async () => ({ ok: true, data: {} }),
      },
    });

    const handled = await h.handleAgentCommand({
      bot: h.bot,
      chatId: h.chatId,
      text: '小分身',
      config: { projects: {} },
    });

    assert.equal(handled, true);
    assert.equal(pendingAgentFlows.has('oc_test_chat'), false);
    assert.doesNotMatch(h.sent.join('\n'), /步骤3\/3/);
    assert.match(h.sent[h.sent.length - 1], /创建完成/);
  });
});
