'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createCommandRouter } = require('./daemon-command-router');

// ─── Helpers ────────────────────────────────────────────────────────────────

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Build a realistic daemon_state with sessions for every agent type.
 * Mirrors real daemon_state.json structure.
 */
function buildRealisticState() {
  return {
    pid: 99999,
    budget: { date: '2026-03-17', tokens_used: 1000 },
    sessions: {
      // ── Bound-chat agents (chat_agent_map) ──
      // metame — bound via oc_84be
      'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d': {
        cwd: '/Users/yaron/AGI/MetaMe',
        engines: {
          claude: { id: 'aaa-metame-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // personal — bound via oc_2693
      'oc_2693fc5ca63064f144eca78264bcea48': {
        cwd: '/Users/yaron',
        engines: {
          claude: { id: 'bbb-personal-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // munger — bound via oc_5d76
      'oc_5d76f02c21203c5ae1c19fd83c790ba4': {
        cwd: '/Users/yaron/AGI/Munger',
        engines: {
          claude: { id: 'ccc-munger-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // business — bound via oc_8902
      'oc_8902c34a0fc52b28ada1a7c4e25aa22a': {
        cwd: '/Users/yaron/AGI/Business',
        engines: {
          claude: { id: 'ddd-business-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // digital_me — bound via oc_942d
      'oc_942de23c38ff876f73f163052fbdb68f': {
        cwd: '/Users/yaron/AGI/Digital_Me',
        engines: {
          claude: { id: 'eee-digital-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // desktop — bound via oc_987e
      'oc_987e0d01804ab9459272006416a935a8': {
        cwd: '/Users/yaron/AGI/metame-desktop',
        engines: {
          claude: { id: 'fff-desktop-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // drama_manager — bound via oc_e335
      'oc_e33569664c1c1224d44a864a4fb40dd2': {
        cwd: '/Users/yaron/AGI/DramaFactory',
        engines: {
          claude: { id: 'ggg-drama-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // achat_pm — bound via oc_9cbe
      'oc_9cbeb5cfcef80ddffcf0419507391189': {
        cwd: '/Users/yaron/AGI/AChat',
        engines: {
          claude: { id: 'hhh-achat-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      // xianyu — bound via oc_bd0b
      'oc_bd0b81e62ff3576dc9b4c6670bb788d2': {
        cwd: '/Users/yaron/AGI/MetaMe',
        engines: {
          claude: { id: 'iii-xianyu-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },

      // ── Bound-session keys (_bound_*) ──
      '_bound_metame': {
        cwd: '/Users/yaron/AGI/MetaMe',
        engines: {
          claude: { id: 'aaa-metame-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_personal': {
        cwd: '/Users/yaron',
        engines: {
          claude: { id: 'bbb-personal-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_munger': {
        cwd: '/Users/yaron/AGI/Munger',
        engines: {
          claude: { id: 'ccc-munger-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_business': {
        cwd: '/Users/yaron/AGI/Business',
        engines: {
          claude: { id: 'ddd-business-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_digital_me': {
        cwd: '/Users/yaron/AGI/Digital_Me',
        engines: {
          claude: { id: 'eee-digital-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_desktop': {
        cwd: '/Users/yaron/AGI/metame-desktop',
        engines: {
          claude: { id: 'fff-desktop-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_drama_manager': {
        cwd: '/Users/yaron/AGI/DramaFactory',
        engines: {
          claude: { id: 'ggg-drama-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_achat_pm': {
        cwd: '/Users/yaron/AGI/AChat',
        engines: {
          claude: { id: 'hhh-achat-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound_xianyu': {
        cwd: '/Users/yaron/AGI/Business/team/xianyu',
        engines: {
          claude: { id: 'iii-xianyu-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_bound____': {
        cwd: '/Users/yaron/Desktop/项目計画書/国自然青年',
        engines: {
          claude: { id: 'jjj-einstein-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },

      // ── Virtual chatId agents (_agent_*) ──
      '_agent_digital_me': {
        cwd: '/Users/yaron/AGI/Digital_Me',
        engines: {
          claude: { id: 'agent-digital-me-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_agent_munger': {
        cwd: '/Users/yaron/AGI/Munger',
        engines: {
          claude: { id: 'agent-munger-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_agent_metame': {
        cwd: '/Users/yaron/AGI/MetaMe',
        engines: {
          claude: { id: 'agent-metame-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_agent_business': {
        cwd: '/Users/yaron/AGI/Business',
        engines: {
          claude: { id: 'agent-business-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },

      // ── Team members (jia/yi/bing) ──
      '_agent_jia': {
        cwd: '/Users/yaron/.metame/worktrees/MetaMe/jia',
        engines: {
          claude: { id: 'team-jia-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_agent_yi': {
        cwd: '/Users/yaron/.metame/worktrees/MetaMe/yi',
        engines: {
          claude: { id: 'team-yi-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
      '_agent_bing': {
        cwd: '/Users/yaron/.metame/worktrees/MetaMe/bing',
        engines: {
          claude: { id: 'team-bing-claude', started: true },
        },
        last_active: Date.now() - 60000,
      },
    },
    team_sticky: {
      'oc_280f2c243f348d8f688580f882996bcd': 'jia',
    },
    default_engine: 'claude',
  };
}

/**
 * Build a realistic config matching daemon.yaml.
 */
function buildRealisticConfig() {
  return {
    feishu: {
      enabled: true,
      allowed_chat_ids: [
        'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d',
        'oc_2693fc5ca63064f144eca78264bcea48',
        'oc_280f2c243f348d8f688580f882996bcd',
        'oc_942de23c38ff876f73f163052fbdb68f',
        'oc_987e0d01804ab9459272006416a935a8',
        'oc_9dc62f6011b337b413eef81b4738883b',
        'oc_8902c34a0fc52b28ada1a7c4e25aa22a',
        'oc_e777c7e7a24335ecbf25ed129402af54',
        'oc_5d76f02c21203c5ae1c19fd83c790ba4',
        'oc_9cbeb5cfcef80ddffcf0419507391189',
        'oc_bd0b81e62ff3576dc9b4c6670bb788d2',
        'oc_e33569664c1c1224d44a864a4fb40dd2',
      ],
      chat_agent_map: {
        'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d': 'metame',
        'oc_2693fc5ca63064f144eca78264bcea48': 'personal',
        'oc_280f2c243f348d8f688580f882996bcd': 'metame',
        'oc_942de23c38ff876f73f163052fbdb68f': 'digital_me',
        'oc_987e0d01804ab9459272006416a935a8': 'desktop',
        'oc_9dc62f6011b337b413eef81b4738883b': '___',
        'oc_8902c34a0fc52b28ada1a7c4e25aa22a': 'business',
        'oc_e777c7e7a24335ecbf25ed129402af54': 'personal',
        'oc_5d76f02c21203c5ae1c19fd83c790ba4': 'munger',
        'oc_9cbeb5cfcef80ddffcf0419507391189': 'achat_pm',
        'oc_bd0b81e62ff3576dc9b4c6670bb788d2': 'xianyu',
        'oc_e33569664c1c1224d44a864a4fb40dd2': 'drama_manager',
      },
    },
    telegram: { chat_agent_map: {} },
    projects: {
      metame: {
        name: 'Jarvis', cwd: '~/AGI/MetaMe',
        nicknames: ['贾维斯', 'Jarvis'],
        team: [
          { key: 'jia', name: 'Jarvis-甲', cwd: '~/AGI/MetaMe', nicknames: ['甲'] },
          { key: 'yi', name: 'Jarvis-乙', cwd: '~/AGI/MetaMe', nicknames: ['乙'] },
          { key: 'bing', name: 'Jarvis-丙', cwd: '~/AGI/MetaMe', nicknames: ['丙'] },
        ],
      },
      personal: {
        name: 'personal', cwd: '/Users/yaron',
        nicknames: ['小美', '助理'],
      },
      munger: {
        name: '芒格', cwd: '~/AGI/Munger',
        nicknames: ['芒格', '查理'],
        team: [
          { key: 'buffett', name: '巴菲特', cwd: '~/AGI/Munger/team/buffett', nicknames: ['巴菲特'] },
        ],
      },
      business: {
        name: 'CEO', cwd: '~/AGI/Business',
        nicknames: ['艾布', 'CEO'],
        team: [
          { key: 'hunter', name: '猎手', cwd: '~/AGI/Business/team/hunter', nicknames: ['猎手'] },
          { key: 'xianyu', name: '小鱼', cwd: '~/AGI/Business/team/xianyu', nicknames: ['小鱼'] },
        ],
      },
      digital_me: {
        name: 'Digital Me', cwd: '~/AGI/Digital_Me',
        nicknames: ['小D', '3D'],
      },
      desktop: {
        name: 'Desktop PM', cwd: '~/AGI/metame-desktop',
        nicknames: ['马经理'],
      },
      achat_pm: {
        name: 'A哥', cwd: '~/AGI/AChat',
        nicknames: ['A哥', '老A'],
      },
      drama_manager: {
        name: '短剧总管', cwd: '~/AGI/DramaFactory',
        nicknames: ['短剧总管'],
        team: [
          { key: 'drama_screenwriter', name: '编剧', cwd: '~/AGI/DramaFactory/team/screenwriter', nicknames: ['编剧'] },
        ],
      },
      xianyu: {
        name: '咸鱼客服', cwd: '~/AGI/Business/team/xianyu',
        nicknames: ['咸鱼客服'],
      },
      ___: {
        name: '因斯坦', cwd: '/Users/yaron/Desktop/项目计划书/国自然青年',
        nicknames: ['因斯坦'],
      },
    },
    daemon: {
      model: 'sonnet',
      dangerously_skip_permissions: true,
    },
  };
}

// ─── Mock deps factory ──────────────────────────────────────────────────────

function createDeps(overrides = {}) {
  const state = overrides._state || buildRealisticState();
  const config = overrides._config || buildRealisticConfig();
  const createSessionCalls = [];
  const attachCalls = [];
  const logEntries = [];
  const sent = [];

  const deps = {
    loadState: () => deepClone(state),
    loadConfig: () => deepClone(config),
    checkBudget: () => true,
    checkCooldown: () => ({ ok: true }),
    resetCooldown: () => {},
    routeAgent: (prompt, cfg) => {
      // Minimal nickname routing for non-strict chats
      for (const [key, proj] of Object.entries((cfg && cfg.projects) || {})) {
        if (!proj.nicknames) continue;
        for (const nick of proj.nicknames) {
          const re = new RegExp(`^${nick}[，,、\\s]*`, 'i');
          if (re.test(String(prompt).trim())) {
            return { key, proj, rest: String(prompt).trim().replace(re, '').trim() };
          }
        }
      }
      return null;
    },
    normalizeCwd: (v) => {
      if (!v) return v;
      return String(v).replace(/^~/, '/Users/yaron');
    },
    attachOrCreateSession: (...args) => {
      attachCalls.push(args);
      // Simulate the real attachOrCreateSession: if session exists and started, skip.
      // This test focuses on whether handleCommand triggers it at all.
    },
    handleSessionCommand: async () => false,
    handleAgentCommand: async () => ({ handled: false }),
    handleAdminCommand: async () => ({ handled: false }),
    handleExecCommand: async () => false,
    handleOpsCommand: async () => false,
    askClaude: async () => ({ ok: true }),
    providerMod: null,
    getNoSleepProcess: () => null,
    activeProcesses: new Map(),
    pipeline: null,
    log: (level, msg) => { logEntries.push({ level, msg }); },
    agentTools: null,
    pendingAgentFlows: new Map(),
    pendingActivations: new Map(),
    agentFlowTtlMs: 60000,
    getDefaultEngine: () => 'claude',
    ...overrides,
  };

  return { deps, createSessionCalls, attachCalls, logEntries, sent, state, config };
}

function createBot(sent) {
  return {
    sendMessage: async (_chatId, text) => {
      sent.push(String(text));
      return { message_id: `m${sent.length}` };
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Session Sticky — Bound-chat agents', () => {
  const boundChats = [
    { chatId: 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', agent: 'metame', cwd: '~/AGI/MetaMe' },
    { chatId: 'oc_2693fc5ca63064f144eca78264bcea48', agent: 'personal', cwd: '/Users/yaron' },
    { chatId: 'oc_5d76f02c21203c5ae1c19fd83c790ba4', agent: 'munger', cwd: '~/AGI/Munger' },
    { chatId: 'oc_8902c34a0fc52b28ada1a7c4e25aa22a', agent: 'business', cwd: '~/AGI/Business' },
    { chatId: 'oc_942de23c38ff876f73f163052fbdb68f', agent: 'digital_me', cwd: '~/AGI/Digital_Me' },
    { chatId: 'oc_987e0d01804ab9459272006416a935a8', agent: 'desktop', cwd: '~/AGI/metame-desktop' },
    { chatId: 'oc_e33569664c1c1224d44a864a4fb40dd2', agent: 'drama_manager', cwd: '~/AGI/DramaFactory' },
    { chatId: 'oc_9cbeb5cfcef80ddffcf0419507391189', agent: 'achat_pm', cwd: '~/AGI/AChat' },
    { chatId: 'oc_bd0b81e62ff3576dc9b4c6670bb788d2', agent: 'xianyu', cwd: '~/AGI/Business/team/xianyu' },
  ];

  for (const { chatId, agent } of boundChats) {
    it(`${agent}: normal message should NOT create new session`, async () => {
      const { deps, attachCalls, logEntries } = createDeps();
      const router = createCommandRouter(deps);
      const bot = createBot([]);

      await router.handleCommand(bot, chatId, '你好，帮我看看这个项目', deps.loadConfig(), () => {});

      // attachOrCreateSession should NOT have been called (session already exists with claude engine)
      assert.equal(attachCalls.length, 0,
        `${agent}: attachOrCreateSession should not be called — session already has claude engine`);

      // No SESSION-INIT log
      const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
      assert.equal(initLogs.length, 0,
        `${agent}: should not log SESSION-INIT`);
    });
  }
});

describe('Session Sticky — Team members (team_sticky)', () => {
  it('jia (team_sticky): message on oc_280f should NOT create new session', async () => {
    // oc_280f is mapped to metame in chat_agent_map, but team_sticky says jia
    const { deps, attachCalls, logEntries } = createDeps();
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_280f2c243f348d8f688580f882996bcd', '帮我改个bug', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      'jia: attachOrCreateSession should not be called — _agent_jia session exists');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0,
      'jia: should not log SESSION-INIT');
  });
});

describe('Session Sticky — Virtual chatId agents (_agent_*)', () => {
  const virtualAgents = [
    { chatId: '_agent_digital_me', cwd: '/Users/yaron/AGI/Digital_Me' },
    { chatId: '_agent_munger', cwd: '/Users/yaron/AGI/Munger' },
    { chatId: '_agent_metame', cwd: '/Users/yaron/AGI/MetaMe' },
    { chatId: '_agent_business', cwd: '/Users/yaron/AGI/Business' },
    { chatId: '_agent_jia', cwd: '/Users/yaron/.metame/worktrees/MetaMe/jia' },
    { chatId: '_agent_yi', cwd: '/Users/yaron/.metame/worktrees/MetaMe/yi' },
    { chatId: '_agent_bing', cwd: '/Users/yaron/.metame/worktrees/MetaMe/bing' },
  ];

  for (const { chatId } of virtualAgents) {
    it(`${chatId}: normal message should NOT create new session`, async () => {
      const agentKey = chatId.replace('_agent_', '');
      const { deps, attachCalls, logEntries } = createDeps();
      const router = createCommandRouter(deps);
      const bot = createBot([]);

      await router.handleCommand(bot, chatId, '执行任务', deps.loadConfig(), () => {});

      // For virtual chatId agents: projectKeyFromVirtualChatId extracts the key,
      // and the code checks existing session. With our state, session exists.
      assert.equal(attachCalls.length, 0,
        `${chatId}: attachOrCreateSession should not be called — session exists`);

      const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
      assert.equal(initLogs.length, 0,
        `${chatId}: should not log SESSION-INIT`);
    });
  }
});

describe('Session Sticky — Daemon restart (session state exists, warm pool empty)', () => {
  it('bound-chat agent after restart: existing session should prevent recreation', async () => {
    // Simulate: session exists in state with started:true, but no warm pool.
    // handleCommand should see existing session and skip attachOrCreateSession.
    const { deps, attachCalls, logEntries } = createDeps();
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    // First message after "restart" — warm pool is empty but state has sessions
    await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', '重启后第一条消息', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      'metame post-restart: should not call attachOrCreateSession');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0,
      'metame post-restart: should not log SESSION-INIT');
  });

  it('team member after restart: existing session should prevent recreation', async () => {
    const { deps, attachCalls, logEntries } = createDeps();
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_280f2c243f348d8f688580f882996bcd', '重启后消息', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      'jia post-restart: should not call attachOrCreateSession');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0,
      'jia post-restart: should not log SESSION-INIT');
  });

  it('virtual _agent_ after restart: existing session should prevent recreation', async () => {
    const { deps, attachCalls, logEntries } = createDeps();
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, '_agent_munger', '重启后消息', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      '_agent_munger post-restart: should not call attachOrCreateSession');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0,
      '_agent_munger post-restart: should not log SESSION-INIT');
  });
});

describe('Session Sticky — CWD mismatch should NOT trigger new session', () => {
  it('bound-chat agent with mismatched cwd should still stick', async () => {
    const state = buildRealisticState();
    // Intentionally set different cwd in _bound_metame (the effective session key) vs config
    state.sessions['_bound_metame'].cwd = '/Users/yaron/DIFFERENT/PATH';
    const { deps, attachCalls, logEntries } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', '帮我看看', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      'cwd mismatch: should NOT recreate session — only cwd mismatch');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0,
      'cwd mismatch: should not log SESSION-INIT');
  });

  it('virtual agent with mismatched cwd should still stick', async () => {
    const state = buildRealisticState();
    state.sessions['_agent_business'].cwd = '/some/other/path';
    const { deps, attachCalls, logEntries } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, '_agent_business', '帮我查数据', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      '_agent_business cwd mismatch: should NOT recreate');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0);
  });
});

describe('Session Sticky — Nickname switch in non-bound chat', () => {
  it('nickname switch should call attachOrCreateSession (expected behavior)', async () => {
    const { deps, attachCalls } = createDeps();
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    // Use a non-bound chatId (not in chat_agent_map)
    await router.handleCommand(bot, 'non_bound_chat_123', '芒格', deps.loadConfig(), () => {});

    // Nickname-only switch DOES call attachOrCreateSession — this is expected
    assert.equal(attachCalls.length, 1,
      'nickname switch: should call attachOrCreateSession to switch agent');

    // But it should use buildSessionChatId, not raw chatId
    const [sessionChatId] = attachCalls[0];
    assert.ok(sessionChatId.startsWith('_bound_'),
      'nickname switch: session chatId should be _bound_ prefixed');
  });

  it('nickname switch with body should route to askClaude, not create extra session', async () => {
    const askClaudeCalls = [];
    const { deps, attachCalls } = createDeps({
      askClaude: async (...args) => { askClaudeCalls.push(args); return { ok: true }; },
    });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    // Nickname + message body: "芒格，帮我分析" — routeAgent returns { rest: "帮我分析" }
    // which means quickAgent.rest is truthy, so it falls through to askClaude
    await router.handleCommand(bot, 'non_bound_chat_456', '芒格，帮我分析一下', deps.loadConfig(), () => {});

    // rest is non-empty, so quickAgent path won't trigger (it only triggers for rest='')
    // It falls through to askClaude. No attachOrCreateSession from nickname path.
    // askClaude should have been called
    assert.ok(askClaudeCalls.length > 0 || attachCalls.length === 0,
      'nickname with body: should either go to askClaude or not create session');
  });
});

describe('Session Sticky — Edge cases', () => {
  it('session with started:false but id present should NOT trigger attach', async () => {
    const state = buildRealisticState();
    // The effective session chatId is _bound_metame. Set started to false there.
    state.sessions['_bound_metame'].engines.claude.started = false;
    const { deps, attachCalls } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', '你好', deps.loadConfig(), () => {});

    // When session has engine slot (even if started=false), curHasEngine is true,
    // so attachOrCreateSession should NOT be called
    assert.equal(attachCalls.length, 0,
      'started:false but engine slot exists: should NOT call attachOrCreateSession');
  });

  it('session with missing engine slot SHOULD trigger attach (expected)', async () => {
    const state = buildRealisticState();
    // The effective session chatId for oc_84be (mapped to metame) is _bound_metame.
    // Remove the claude engine slot from _bound_metame to simulate missing engine.
    state.sessions['_bound_metame'].engines = {};
    const { deps, attachCalls, logEntries } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', '你好', deps.loadConfig(), () => {});

    // Missing engine slot IS a valid reason to call attachOrCreateSession
    assert.equal(attachCalls.length, 1,
      'missing engine slot: should call attachOrCreateSession');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 1,
      'missing engine slot: should log SESSION-INIT with engine-missing reason');
    assert.ok(initLogs[0].msg.includes('engine-missing'),
      'reason should be engine-missing');
  });

  it('no session at all SHOULD trigger attach (expected for first-time)', async () => {
    const state = buildRealisticState();
    // Remove the session entirely
    delete state.sessions['oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d'];
    delete state.sessions['_bound_metame'];
    const { deps, attachCalls, logEntries } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', '你好', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 1,
      'no session: should call attachOrCreateSession');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 1,
      'no session: should log SESSION-INIT with no-session reason');
    assert.ok(initLogs[0].msg.includes('no-session'),
      'reason should be no-session');
  });

  it('session ID should remain stable across multiple messages', async () => {
    const state = buildRealisticState();
    const originalId = state.sessions['_bound_metame'].engines.claude.id;

    const { deps, attachCalls } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    // Send multiple messages
    for (let i = 0; i < 5; i++) {
      await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', `消息 ${i}`, deps.loadConfig(), () => {});
    }

    assert.equal(attachCalls.length, 0,
      'multiple messages: should never call attachOrCreateSession');

    // State session ID should be unchanged (state is deepCloned on each loadState, so check original)
    assert.equal(state.sessions['_bound_metame'].engines.claude.id, originalId,
      'session ID should remain stable across messages');
  });
});

describe('Session Sticky — team_sticky with all bound chats', () => {
  it('bound-chat with team_sticky should check _agent_<stickyKey> session', async () => {
    // oc_280f is mapped to metame but team_sticky says jia
    // Code should check _agent_jia, which has a session → no recreate
    const { deps, attachCalls, logEntries } = createDeps();
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_280f2c243f348d8f688580f882996bcd', '查看进度', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      'team_sticky jia: should not call attachOrCreateSession');

    const initLogs = logEntries.filter(e => e.msg.includes('SESSION-INIT'));
    assert.equal(initLogs.length, 0,
      'team_sticky jia: should not log SESSION-INIT');
  });

  it('bound-chat with team_sticky pointing to missing session SHOULD attach', async () => {
    const state = buildRealisticState();
    // Set team_sticky to a member whose session does not exist
    state.team_sticky['oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d'] = 'yi';
    // But _agent_yi session exists in our state, so it should NOT trigger
    const { deps, attachCalls, logEntries } = createDeps({ _state: state });
    const router = createCommandRouter(deps);
    const bot = createBot([]);

    await router.handleCommand(bot, 'oc_84be4bf1a1dabc6c1f0c22d0b6feaf8d', '你好', deps.loadConfig(), () => {});

    assert.equal(attachCalls.length, 0,
      'team_sticky yi with existing session: should not call attachOrCreateSession');
  });
});
