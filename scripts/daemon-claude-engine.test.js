'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PassThrough } = require('stream');
const { createClaudeEngine } = require('./daemon-claude-engine');

function createEngineWithState(state) {
  return createClaudeEngine({
    fs,
    path,
    spawn: () => { throw new Error('spawn not used in this test'); },
    CLAUDE_BIN: 'claude',
    HOME: os.homedir(),
    CONFIG_FILE: '/tmp/daemon.yaml',
    getActiveProviderEnv: () => ({}),
    activeProcesses: new Map(),
    saveActivePids: () => {},
    messageQueue: new Map(),
    log: () => {},
    yaml: { load: () => ({}) },
    providerMod: null,
    writeConfigSafe: () => {},
    loadConfig: () => ({}),
    loadState: () => state,
    saveState: (next) => {
      Object.assign(state, next);
      state.sessions = next.sessions;
    },
    routeAgent: () => null,
    routeSkill: () => null,
    attachOrCreateSession: () => {},
    normalizeCwd: (p) => path.resolve(String(p || '')),
    isContentFile: () => false,
    sendFileButtons: async () => {},
    findSessionFile: () => null,
    listRecentSessions: () => [],
    getSession: () => null,
    getSessionForEngine: () => null,
    createSession: () => ({ id: 'sid', cwd: '/tmp', started: false, engine: 'claude' }),
    getSessionName: () => '',
    writeSessionName: () => {},
    markSessionStarted: () => {},
    isEngineSessionValid: () => true,
    getCodexSessionSandboxProfile: () => null,
    getCodexSessionPermissionMode: () => null,
    gitCheckpoint: () => {},
    recordTokens: () => {},
    skillEvolution: null,
    touchInteraction: () => {},
    getEngineRuntime: () => ({
      name: 'claude',
      binary: 'claude',
      buildArgs: () => ['-p'],
      buildEnv: () => ({ ...process.env }),
      parseStreamEvent: () => [],
      classifyError: () => null,
      killSignal: 'SIGTERM',
      timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
    }),
  });
}

function createFakeCodexProcess(events) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const proc = {
    stdout,
    stderr,
    stdin,
    pid: 12345,
    kill: () => {},
    on(event, handler) {
      if (event === 'close') {
        setImmediate(() => handler(0));
      }
      return proc;
    },
  };
  setImmediate(() => {
    for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
    stderr.end();
  });
  return proc;
}

describe('daemon-claude-engine private helpers', () => {
  it('serializes session patches in order', async () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    const p1 = engine._private.patchSessionSerialized('chat1', (cur) => ({
      ...cur,
      order: [...(cur.order || []), 'a'],
    }));
    const p2 = engine._private.patchSessionSerialized('chat1', (cur) => ({
      ...cur,
      order: [...(cur.order || []), 'b'],
    }));

    await Promise.all([p1, p2]);
    assert.deepEqual(state.sessions.chat1.order, ['a', 'b']);
  });

  it('tracks message ids returned by file delivery helpers', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const session = {
      id: 'sid-file',
      cwd: '/tmp/agent-jia',
      engine: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      permissionMode: 'danger-full-access',
    };

    engine.trackMsgSession('msg-main-1', session, 'jia');
    engine.trackMsgSession('msg-file-1', session, 'jia');

    assert.equal(state.msg_sessions['msg-main-1'].agentKey, 'jia');
    assert.equal(state.msg_sessions['msg-file-1'].agentKey, 'jia');
    assert.equal(state.msg_sessions['msg-file-1'].id, 'sid-file');
    assert.equal(state.msg_sessions['msg-file-1'].sandboxMode, 'danger-full-access');
    assert.equal(state.msg_sessions['msg-file-1'].approvalPolicy, 'never');
  });

  it('keeps reply mappings beyond the old 200-entry cap', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const session = {
      id: 'sid-file',
      cwd: '/tmp/agent-jia',
      engine: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      permissionMode: 'danger-full-access',
    };

    for (let i = 0; i < 260; i++) {
      engine.trackMsgSession(`msg-${i}`, session, 'jia');
    }

    assert.equal(Object.keys(state.msg_sessions).length, 260);
    assert.equal(state.msg_sessions['msg-0'].agentKey, 'jia');
    assert.ok(state.msg_sessions['msg-0'].touchedAt > 0);
  });

  it('retains recently touched old reply mappings when pruning', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const session = {
      id: 'sid-file',
      cwd: '/tmp/agent-jia',
      engine: 'codex',
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      permissionMode: 'danger-full-access',
    };

    for (let i = 0; i < 5000; i++) {
      engine.trackMsgSession(`msg-${i}`, session, 'jia');
    }
    engine.trackMsgSession('msg-0', session, 'jia');
    engine.trackMsgSession('msg-overflow', session, 'jia');

    assert.ok(state.msg_sessions['msg-0'], 'recently touched old mapping should survive pruning');
    assert.ok(!state.msg_sessions['msg-1'], 'least recently touched mapping should be evicted first');
    assert.ok(state.msg_sessions['msg-overflow']);
  });

  it('stores route-only reply mapping for fresh codex virtual-agent replies before thread observation stabilizes', async () => {
    const state = {
      sessions: {
        _agent_jia: {
          cwd: '/tmp/agent-jia',
          engines: {
            codex: {
              id: 'fresh-local-placeholder',
              started: false,
              runtimeSessionObserved: false,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
          },
        },
      },
    };

    // Use a write-blocking fs wrapper so logRawSessionDiary does not pollute
    // the real ~/.metame/sessions/ directory during tests.
    const testFs = { ...fs, appendFileSync: () => {}, mkdirSync: () => {}, writeFileSync: () => {} };

    const engine = createClaudeEngine({
      fs: testFs,
      path,
      spawn: () => createFakeCodexProcess([
        { type: 'item.completed', item: { type: 'agent_message', text: '甲的首轮回复' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]),
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        projects: {
          jia: { cwd: '/tmp/agent-jia', name: 'Jarvis · 甲', engine: 'codex' },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, logicalChatId: chatId, ...slot } : null;
      },
      createSession: () => ({ id: 'fresh-local-placeholder', cwd: '/tmp/agent-jia', engine: 'codex', logicalChatId: '_agent_jia', started: false, runtimeSessionObserved: false }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: () => null,
      getCodexSessionPermissionMode: () => null,
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-send' }),
      sendMarkdown: async () => ({ message_id: 'msg-md' }),
      sendCard: async () => ({ message_id: 'msg-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, '_agent_jia', '你吃西瓜？', {
      projects: {
        jia: { cwd: '/tmp/agent-jia', name: 'Jarvis · 甲', engine: 'codex' },
      },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    const tracked = Object.values(state.msg_sessions || {}).find(entry =>
      entry && entry.logicalChatId === '_agent_jia' && entry.agentKey === 'jia'
    );
    assert.equal(tracked.cwd, '/tmp/agent-jia');
    assert.equal(tracked.engine, 'codex');
    assert.equal(tracked.logicalChatId, '_agent_jia');
    assert.equal(tracked.agentKey, 'jia');
    assert.equal(tracked.sandboxMode, 'danger-full-access');
    assert.equal(tracked.approvalPolicy, 'never');
    assert.equal(tracked.permissionMode, 'danger-full-access');
    assert.ok(tracked.touchedAt > 0);
  });

  it('forces bound chats back to configured cwd even when stored session cwd is polluted', async () => {
    const state = {
      sessions: {
        _bound_paper_rev: {
          cwd: 'D:\\MetaMe',
          engines: {
            claude: {
              id: 'sid-paper-old',
              started: true,
            },
          },
        },
      },
    };
    const validateCalls = [];
    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const proc = {
          stdout,
          stderr,
          stdin,
          pid: 43210,
          kill: () => {},
          on(event, handler) {
            if (event === 'close') setImmediate(() => handler(0));
            return proc;
          },
        };
        setImmediate(() => {
          stdout.write('{"kind":"session","id":"sid-paper-new"}\n');
          stdout.write('{"kind":"assistant","text":"paper ok"}\n');
          stdout.end();
          stderr.end();
        });
        return proc;
      },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        feishu: {
          chat_agent_map: {
            oc_paper: 'paper_rev',
          },
        },
        projects: {
          paper_rev: {
            cwd: 'E:\\paper\\paper30-reloading',
            name: '小W-研究生',
            engine: 'claude',
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
        state.msg_sessions = next.msg_sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, logicalChatId: chatId, ...slot } : null;
      },
      createSession: () => ({ id: 'sid-paper-fresh', cwd: 'E:\\paper\\paper30-reloading', started: false, engine: 'claude', logicalChatId: '_bound_paper_rev' }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: (engineName, sessionId, cwd) => {
        validateCalls.push({ engineName, sessionId, cwd });
        return true;
      },
      getCodexSessionSandboxProfile: () => null,
      getCodexSessionPermissionMode: () => null,
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'claude',
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => {
          const raw = JSON.parse(line);
          if (raw.kind === 'session') return [{ type: 'session', sessionId: raw.id }];
          if (raw.kind === 'assistant') return [{ type: 'assistant', text: raw.text }];
          return [];
        },
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-paper' }),
      sendMarkdown: async () => ({ message_id: 'msg-paper-md' }),
      sendCard: async () => ({ message_id: 'msg-paper-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, 'oc_paper', '继续', {
      feishu: { chat_agent_map: { oc_paper: 'paper_rev' } },
      projects: {
        paper_rev: { cwd: 'E:\\paper\\paper30-reloading', name: '小W-研究生', engine: 'claude' },
      },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    assert.equal(validateCalls[0].cwd, path.resolve('E:\\paper\\paper30-reloading'));
    assert.equal(state.sessions._bound_paper_rev.cwd, path.resolve('E:\\paper\\paper30-reloading'));
    const tracked = Object.values(state.msg_sessions || {}).find(entry =>
      entry && entry.logicalChatId === '_bound_paper_rev' && entry.cwd === path.resolve('E:\\paper\\paper30-reloading')
    );
    assert.ok(tracked);
  });

  it('does not reuse the previous reply card for a fresh idle turn', async () => {
    const state = {
      sessions: {
        _bound_digital_me: {
          cwd: '/tmp/digital-me',
          engines: {
            codex: {
              id: 'thread-dm-1',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
          },
        },
      },
    };
    const logs = [];
    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => createFakeCodexProcess([
        { type: 'item.completed', item: { type: 'agent_message', text: '在。' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]),
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: (level, msg) => logs.push({ level, msg: String(msg) }),
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        projects: {
          digital_me: { cwd: '/tmp/digital-me', name: 'Digital Me', engine: 'codex' },
        },
        feishu: {
          chat_agent_map: {
            oc_digital_me: 'digital_me',
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, logicalChatId: chatId, ...slot } : null;
      },
      createSession: () => ({ id: 'thread-dm-1', cwd: '/tmp/digital-me', engine: 'codex', logicalChatId: '_bound_digital_me', started: false, runtimeSessionObserved: true }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: () => ({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }),
      getCodexSessionPermissionMode: () => 'danger-full-access',
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    let cardSeq = 0;
    const sendCardIds = [];
    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: `msg-${++cardSeq}` }),
      sendMarkdown: async () => ({ message_id: `md-${++cardSeq}` }),
      sendCard: async () => {
        const id = `card-${++cardSeq}`;
        sendCardIds.push(id);
        return { message_id: id };
      },
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const config = {
      projects: {
        digital_me: { cwd: '/tmp/digital-me', name: 'Digital Me', engine: 'codex' },
      },
      feishu: {
        chat_agent_map: {
          oc_digital_me: 'digital_me',
        },
      },
    };

    const first = await engine.askClaude(bot, 'oc_digital_me', '哈咯', config, false, 'ou_admin');
    const second = await engine.askClaude(bot, 'oc_digital_me', '帮帮忙', config, false, 'ou_admin');

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(sendCardIds.length, 2);
    assert.ok(!logs.some(entry => entry.msg.includes('Reusing paused card')), 'fresh idle turn should not reuse paused card');
  });

  it('decides codex resume fallback retry correctly', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.equal(engine._private.shouldRetryCodexResumeFallback({
      runtimeName: 'codex',
      wasResumeAttempt: true,
      output: '',
      error: 'resume failed',
      errorCode: 'EXEC_FAILURE',
      failureKind: 'expired',
      canRetry: true,
    }), true);

    assert.equal(engine._private.shouldRetryCodexResumeFallback({
      runtimeName: 'codex',
      wasResumeAttempt: true,
      output: '',
      error: 'resume failed',
      errorCode: 'EXEC_FAILURE',
      failureKind: 'expired',
      canRetry: false,
    }), false);

    assert.equal(engine._private.shouldRetryCodexResumeFallback({
      runtimeName: 'codex',
      wasResumeAttempt: true,
      output: '',
      error: 'Stopped by user',
      errorCode: 'INTERRUPTED_USER',
      failureKind: 'user-stop',
      canRetry: true,
    }), false);
  });

  it('classifies interrupted codex resume separately from expired sessions', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    const interrupted = engine._private.classifyCodexResumeFailure('Stopped by user', 'EXEC_FAILURE');
    assert.equal(interrupted.kind, 'interrupted');
    assert.match(interrupted.userMessage, /后台刚刚重启|执行被中断/);
    assert.match(interrupted.retryPromptPrefix, /interrupted by a daemon restart/i);

    const userStop = engine._private.classifyCodexResumeFailure('Stopped by user', 'INTERRUPTED_USER');
    assert.equal(userStop.kind, 'user-stop');
    assert.match(userStop.userMessage, /停止动作中断/);

    const shutdown = engine._private.classifyCodexResumeFailure('Stopped by user', 'INTERRUPTED_RESTART');
    assert.equal(shutdown.kind, 'interrupted');
    assert.match(shutdown.userMessage, /自动恢复到同一条会话/);

    const transport = engine._private.classifyCodexResumeFailure(
      'stream disconnected before completion: error sending request for url',
      'EXEC_FAILURE'
    );
    assert.equal(transport.kind, 'transport');
    assert.match(transport.userMessage, /网络\/传输中断|优先重试同一条会话/);
    assert.match(transport.retryPromptPrefix, /transient transport error/i);

    const expired = engine._private.classifyCodexResumeFailure('resume failed: thread not found', 'EXEC_FAILURE');
    assert.equal(expired.kind, 'expired');
    assert.match(expired.userMessage, /session 已过期/);
    assert.match(expired.retryPromptPrefix, /session expired/i);
  });

  it('enforces codex resume retry window by chat id', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const key = 'chat-resume-window';
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      assert.equal(engine._private.canRetryCodexResume(key), true);
      engine._private.markCodexResumeRetried(key, 'expired');
      assert.equal(engine._private.canRetryCodexResume(key, 'expired'), false);
      assert.equal(engine._private.canRetryCodexResume(key, 'interrupted'), true);
      now += engine._private.CODEX_RESUME_RETRY_WINDOW_MS + 1;
      assert.equal(engine._private.canRetryCodexResume(key, 'expired'), true);
    } finally {
      Date.now = originalNow;
    }
  });

  it('formats codex ENOENT into actionable hint', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const msg = engine._private.formatEngineSpawnError({ code: 'ENOENT', message: 'spawn codex ENOENT' }, { name: 'codex' });
    assert.match(msg, /Codex CLI 未安装/);
    assert.match(msg, /@openai\/codex/);
  });

  it('adapts daemon hint wrapper for non-claude engines', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const src = '\n\n[System hints - DO NOT mention these to user:\n1. keep\n]';
    const out = engine._private.adaptDaemonHintForEngine(src, 'codex');
    assert.match(out, /System hints \(internal/);
    assert.equal(out.trim().endsWith(']'), false);
  });

  it('preserves codex session continuity when permission mode mismatches', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    assert.equal(
      engine._private.codexNeedsFallbackForRequestedPermissions(
        { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      true
    );
    assert.equal(
      engine._private.codexNeedsFallbackForRequestedPermissions(
        { sandboxMode: 'danger-full-access', sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      false
    );
  });

  it('treats codex sandbox aliases as the same permission profile', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    assert.equal(
      engine._private.sameCodexPermissionProfile(
        { sandboxMode: 'writable', approvalPolicy: 'unknown', permissionMode: 'writable' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      true
    );
  });

  it('detects when a codex thread must migrate to satisfy higher requested permissions', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    assert.equal(
      engine._private.codexNeedsFallbackForRequestedPermissions(
        { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      true
    );
    assert.equal(
      engine._private.codexNeedsFallbackForRequestedPermissions(
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      false
    );
  });

  it('builds a fallback bridge prompt that preserves conversation continuity for any virtual chat id', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const prompt = engine._private.buildCodexFallbackBridgePrompt({
      fullPrompt: '请继续修复权限问题',
      previousSessionId: '019ce0f7-dead-beef',
      previousProfile: { sandboxMode: 'read-only', approvalPolicy: 'never' },
      requestedProfile: { sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
      recentContext: {
        lastUser: '刚才 business 会话突然只读了',
        lastAssistant: '我正在排查权限恢复链路',
      },
    });

    assert.match(prompt, /continuing the same MetaMe persona conversation on a fresh Codex execution thread/i);
    assert.match(prompt, /Permission migration: read-only\/never -> danger-full-access\/never/);
    assert.match(prompt, /Last user message: 刚才 business 会话突然只读了/);
    assert.match(prompt, /Current user message follows/);
  });

  it('does not treat stale stored codex permission metadata as a forced fresh-session signal when actual runtime matches', () => {
    const state = { sessions: {} };
    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => { throw new Error('spawn not used in this test'); },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: false, engine: 'claude' }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: () => ({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }),
      getCodexSessionPermissionMode: () => 'danger-full-access',
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: () => [],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    assert.equal(
      engine._private.sameCodexPermissionProfile(
        engine._private.getActualCodexPermissionProfile({ id: 'sid-1' }),
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      true
    );
  });

  it('treats lower actual runtime codex privilege as a fallback need instead of a pre-spawn fresh-session signal', () => {
    const state = { sessions: {} };
    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => { throw new Error('spawn not used in this test'); },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: false, engine: 'claude' }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: () => ({ sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' }),
      getCodexSessionPermissionMode: () => 'read-only',
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: () => [],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    assert.equal(
      engine._private.codexNeedsFallbackForRequestedPermissions(
        engine._private.getActualCodexPermissionProfile({ id: 'sid-1' }),
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      true
    );
  });

  it('keeps bound group chats off the virtual agent session namespace', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.equal(
      engine._private.getSessionChatId('oc_5d76f02c21203c5ae1c19fd83c790ba4', 'munger'),
      '_bound_munger'
    );
    assert.equal(
      engine._private.getSessionChatId('_agent_munger', 'munger'),
      '_agent_munger'
    );
  });

  it('keeps claude resume enabled for custom-provider session models', () => {
    const state = { sessions: {} };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-claude-engine-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, `${JSON.stringify({ message: { model: 'gpt-5', cwd: '/tmp/project' } })}\n`, 'utf8');

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => { throw new Error('spawn not used in this test'); },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => sessionFile,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: false, engine: 'claude' }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: () => [],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    assert.deepEqual(
      engine._private.inspectClaudeResumeSession({ started: true, id: 'sid-1' }),
      { shouldResume: true, modelPin: null, reason: '' }
    );
  });

  it('pins resumed claude session back to original model', () => {
    const state = { sessions: {} };
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-claude-engine-'));
    const sessionFile = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(sessionFile, `${JSON.stringify({ message: { model: 'claude-sonnet-4-20250514', cwd: '/tmp/project' } })}\n`, 'utf8');

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => { throw new Error('spawn not used in this test'); },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => sessionFile,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: false, engine: 'claude' }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: () => [],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    assert.deepEqual(
      engine._private.inspectClaudeResumeSession({ started: true, id: 'sid-1' }),
      { shouldResume: true, modelPin: 'sonnet', reason: '' }
    );

    // When configured model is 'sonnet' (same family), no pin needed
    assert.deepEqual(
      engine._private.inspectClaudeResumeSession({ started: true, id: 'sid-1' }, 'sonnet'),
      { shouldResume: true, modelPin: null, reason: '' }
    );

    // When configured model is 'opus' (different family), pin is required
    assert.deepEqual(
      engine._private.inspectClaudeResumeSession({ started: true, id: 'sid-1' }, 'opus'),
      { shouldResume: true, modelPin: 'sonnet', reason: '' }
    );
  });

  it('reads actual codex permission profile from store helper', () => {
    const state = { sessions: {} };
    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => { throw new Error('spawn not used in this test'); },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: false, engine: 'claude' }),
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: () => ({ sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' }),
      getCodexSessionPermissionMode: () => 'read-only',
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: () => [],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    assert.deepEqual(
      engine._private.getActualCodexPermissionProfile({ id: 'thread-1' }),
      { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' }
    );
  });

  it('blocks skill auto-routing for all non-personal bound agents, and macos-local-orchestrator for personal', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    // personal: macos-local-orchestrator is blocked (dangerous local automation)
    assert.equal(
      engine._private.shouldAutoRouteSkill({
        agentMatch: null,
        hasActiveSession: false,
        boundProjectKey: 'personal',
        skillName: 'macos-local-orchestrator',
      }),
      false
    );

    // personal: other skills are allowed
    assert.equal(
      engine._private.shouldAutoRouteSkill({
        agentMatch: null,
        hasActiveSession: false,
        boundProjectKey: 'personal',
        skillName: 'macos-mail-calendar',
      }),
      true
    );

    // non-personal bound agents: ALL skills blocked to prevent hijack
    assert.equal(
      engine._private.shouldAutoRouteSkill({
        agentMatch: null,
        hasActiveSession: false,
        boundProjectKey: 'coder',
        skillName: 'macos-local-orchestrator',
      }),
      false
    );
  });

  it('retries a fresh codex execution thread when the first fresh thread still comes up underprivileged', async () => {
    const state = {
      sessions: {
        _bound_personal: {
          cwd: '/tmp/personal',
          engines: {
            codex: {
              id: 'old-readonly-thread',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'read-only',
              approvalPolicy: 'never',
              permissionMode: 'read-only',
            },
          },
        },
      },
    };
    const spawnCalls = [];
    const createdSessions = [];
    const permissionByThread = {
      'old-readonly-thread': { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' },
      'fresh-thread-1': { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' },
      'fresh-thread-2': { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' },
    };
    let createSeq = 0;
    let spawnSeq = 0;

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: (_cmd, args) => {
        spawnCalls.push(args.slice());
        spawnSeq += 1;
        return createFakeCodexProcess([
          { type: 'thread.started', thread_id: `fresh-thread-${spawnSeq}` },
          { type: 'item.completed', item: { type: 'agent_message', text: `reply-${spawnSeq}` } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        feishu: {
          chat_agent_map: {
            oc_personal: 'personal',
          },
        },
        projects: {
          personal: {
            cwd: '/tmp/personal',
            name: '小美',
            engine: 'codex',
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, ...slot } : null;
      },
      createSession: (chatId, cwd, _name, engineName, meta) => {
        createSeq += 1;
        const created = {
          id: `new-session-${createSeq}`,
          cwd,
          engine: engineName,
          started: false,
          runtimeSessionObserved: false,
          ...(meta || {}),
        };
        createdSessions.push(created);
        state.sessions[chatId] = {
          cwd,
          engines: {
            ...((state.sessions[chatId] && state.sessions[chatId].engines) || {}),
            [engineName]: { ...created },
          },
        };
        return created;
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: (chatId, engineName) => {
        const slot = state.sessions[chatId] && state.sessions[chatId].engines && state.sessions[chatId].engines[engineName];
        if (slot) slot.started = true;
      },
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: (id) => permissionByThread[id] || null,
      getCodexSessionPermissionMode: (id) => (permissionByThread[id] || {}).permissionMode || null,
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-send' }),
      sendMarkdown: async () => ({ message_id: 'msg-md' }),
      sendCard: async () => ({ message_id: 'msg-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, 'oc_personal', '继续处理', {
      feishu: { chat_agent_map: { oc_personal: 'personal' } },
      projects: { personal: { cwd: '/tmp/personal', name: '小美', engine: 'codex' } },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    assert.equal(spawnCalls.length, 2);
    assert.ok(spawnCalls[0].includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(spawnCalls[1].includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(state.sessions._bound_personal.engines.codex.id, 'fresh-thread-2');
    assert.equal(state.sessions._bound_personal.engines.codex.permissionMode, 'danger-full-access');
  });

  it('retries interrupted codex resume on the same logical thread before creating a fresh session', async () => {
    const state = {
      sessions: {
        _bound_personal: {
          cwd: '/tmp/personal',
          engines: {
            codex: {
              id: 'resume-thread-1',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
          },
        },
      },
    };
    const spawnCalls = [];
    const activeProcesses = new Map();
    let createCount = 0;
    let spawnSeq = 0;

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: (_cmd, args) => {
        spawnCalls.push(args.slice());
        spawnSeq += 1;
        if (spawnSeq === 1) {
          const proc = createFakeCodexProcess([]);
          setImmediate(() => {
            const active = activeProcesses.get('oc_personal');
            if (active) {
              active.aborted = true;
              active.abortReason = 'daemon-restart';
            }
          });
          return proc;
        }
        return createFakeCodexProcess([
          { type: 'thread.started', thread_id: 'resume-thread-1' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'reply-recovered' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses,
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        feishu: { chat_agent_map: { oc_personal: 'personal' } },
        projects: { personal: { cwd: '/tmp/personal', name: '小美', engine: 'codex' } },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, ...slot } : null;
      },
      createSession: () => {
        createCount += 1;
        return { id: `new-session-${createCount}`, cwd: '/tmp/personal', started: false, engine: 'codex' };
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: () => ({ sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }),
      getCodexSessionPermissionMode: () => 'danger-full-access',
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-send' }),
      sendMarkdown: async () => ({ message_id: 'msg-md' }),
      sendCard: async () => ({ message_id: 'msg-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, 'oc_personal', '继续处理', {
      feishu: { chat_agent_map: { oc_personal: 'personal' } },
      projects: { personal: { cwd: '/tmp/personal', name: '小美', engine: 'codex' } },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    assert.equal(spawnCalls.length, 2);
    assert.deepEqual(spawnCalls[0].slice(0, 3), ['exec', 'resume', 'resume-thread-1']);
    assert.deepEqual(spawnCalls[1].slice(0, 3), ['exec', 'resume', 'resume-thread-1']);
    assert.equal(createCount, 0);
  });

  it('stabilizes onto a fresh codex thread when observed codex permissions degrade mid-turn', async () => {
    const state = {
      sessions: {
        _bound_personal: {
          cwd: '/tmp/personal',
          engines: {
            codex: {
              id: 'resume-thread-1',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
          },
        },
      },
    };
    const spawnCalls = [];
    const permissionByThread = {
      'fresh-thread-2': { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' },
    };
    let resumeThreadReads = 0;
    let spawnSeq = 0;

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: (_cmd, args) => {
        spawnCalls.push(args.slice());
        spawnSeq += 1;
        if (spawnSeq === 1) {
          return createFakeCodexProcess([
            { type: 'thread.started', thread_id: 'resume-thread-1' },
            { type: 'item.completed', item: { type: 'agent_message', text: 'reply-1' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
          ]);
        }
        return createFakeCodexProcess([
          { type: 'thread.started', thread_id: 'fresh-thread-2' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'reply-2' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        feishu: {
          chat_agent_map: {
            oc_personal: 'personal',
          },
        },
        projects: {
          personal: {
            cwd: '/tmp/personal',
            name: '小美',
            engine: 'codex',
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, ...slot } : null;
      },
      createSession: (chatId, cwd, _name, engineName, meta) => {
        const created = {
          id: 'fresh-session-retry',
          cwd,
          engine: engineName,
          started: false,
          runtimeSessionObserved: false,
          ...(meta || {}),
        };
        state.sessions[chatId] = {
          cwd,
          engines: {
            ...((state.sessions[chatId] && state.sessions[chatId].engines) || {}),
            [engineName]: { ...created },
          },
        };
        return created;
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: (chatId, engineName) => {
        const slot = state.sessions[chatId] && state.sessions[chatId].engines && state.sessions[chatId].engines[engineName];
        if (slot) slot.started = true;
      },
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: (id) => {
        if (id === 'resume-thread-1') {
          resumeThreadReads += 1;
          return resumeThreadReads === 1
            ? { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
            : { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' };
        }
        return permissionByThread[id] || null;
      },
      getCodexSessionPermissionMode: (id) => (permissionByThread[id] || {}).permissionMode || null,
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-send' }),
      sendMarkdown: async () => ({ message_id: 'msg-md' }),
      sendCard: async () => ({ message_id: 'msg-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, 'oc_personal', '继续处理', {
      feishu: { chat_agent_map: { oc_personal: 'personal' } },
      projects: { personal: { cwd: '/tmp/personal', name: '小美', engine: 'codex' } },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    assert.equal(spawnCalls.length, 2);
    assert.ok(spawnCalls[1].includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(state.sessions._bound_personal.engines.codex.id, 'fresh-thread-2');
    assert.equal(state.sessions._bound_personal.engines.codex.permissionMode, 'danger-full-access');
  });

  it('keeps retrying codex stabilization until a fresh full-access thread is observed', async () => {
    const state = {
      sessions: {
        _bound_personal: {
          cwd: '/tmp/personal',
          engines: {
            codex: {
              id: 'resume-thread-1',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
          },
        },
      },
    };
    const spawnCalls = [];
    const permissionByThread = {
      'fresh-thread-3': { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' },
    };
    let spawnSeq = 0;

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: (_cmd, args) => {
        spawnCalls.push(args.slice());
        spawnSeq += 1;
        if (spawnSeq === 1) {
          return createFakeCodexProcess([
            { type: 'thread.started', thread_id: 'resume-thread-1' },
            { type: 'item.completed', item: { type: 'agent_message', text: 'reply-1' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
          ]);
        }
        if (spawnSeq === 2) {
          return createFakeCodexProcess([
            { type: 'thread.started', thread_id: 'fresh-thread-2' },
            { type: 'item.completed', item: { type: 'agent_message', text: 'reply-2' } },
            { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
          ]);
        }
        return createFakeCodexProcess([
          { type: 'thread.started', thread_id: 'fresh-thread-3' },
          { type: 'item.completed', item: { type: 'agent_message', text: 'reply-3' } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        feishu: {
          chat_agent_map: {
            oc_personal: 'personal',
          },
        },
        projects: {
          personal: {
            cwd: '/tmp/personal',
            name: '小美',
            engine: 'codex',
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, ...slot } : null;
      },
      createSession: (chatId, cwd, _name, engineName, meta) => {
        const created = {
          id: `fresh-session-${spawnSeq + 1}`,
          cwd,
          engine: engineName,
          started: false,
          runtimeSessionObserved: false,
          ...(meta || {}),
        };
        state.sessions[chatId] = {
          cwd,
          engines: {
            ...((state.sessions[chatId] && state.sessions[chatId].engines) || {}),
            [engineName]: { ...created },
          },
        };
        return created;
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: (chatId, engineName) => {
        const slot = state.sessions[chatId] && state.sessions[chatId].engines && state.sessions[chatId].engines[engineName];
        if (slot) slot.started = true;
      },
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: (id) => permissionByThread[id] || { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' },
      getCodexSessionPermissionMode: (id) => (permissionByThread[id] || {}).permissionMode || 'read-only',
      getSessionRecentContext: () => null,
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-send' }),
      sendMarkdown: async () => ({ message_id: 'msg-md' }),
      sendCard: async () => ({ message_id: 'msg-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, 'oc_personal', '继续处理', {
      feishu: { chat_agent_map: { oc_personal: 'personal' } },
      projects: { personal: { cwd: '/tmp/personal', name: '小美', engine: 'codex' } },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    assert.equal(spawnCalls.length, 3);
    assert.ok(spawnCalls[1].includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(spawnCalls[2].includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.equal(state.sessions._bound_personal.engines.codex.id, 'fresh-thread-3');
    assert.equal(state.sessions._bound_personal.engines.codex.permissionMode, 'danger-full-access');
  });

  it('bridges recent conversation context into codex stabilization retries', async () => {
    const state = {
      sessions: {
        _bound_personal: {
          cwd: '/tmp/personal',
          engines: {
            codex: {
              id: 'resume-thread-1',
              started: true,
              runtimeSessionObserved: true,
              sandboxMode: 'danger-full-access',
              approvalPolicy: 'never',
              permissionMode: 'danger-full-access',
            },
          },
        },
      },
    };
    const stdinPayloads = [];
    let spawnSeq = 0;

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: (_cmd, _args) => {
        spawnSeq += 1;
        const proc = createFakeCodexProcess([
          { type: 'thread.started', thread_id: spawnSeq === 1 ? 'resume-thread-1' : 'fresh-thread-2' },
          { type: 'item.completed', item: { type: 'agent_message', text: `reply-${spawnSeq}` } },
          { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
        let payload = '';
        proc.stdin.on('data', (chunk) => {
          payload += String(chunk);
        });
        proc.stdin.on('finish', () => {
          stdinPayloads.push(payload);
        });
        return proc;
      },
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => ({
        feishu: {
          chat_agent_map: {
            oc_personal: 'personal',
          },
        },
        projects: {
          personal: {
            cwd: '/tmp/personal',
            name: '小美',
            engine: 'codex',
          },
        },
      }),
      loadState: () => state,
      saveState: (next) => {
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engineName) => {
        const raw = state.sessions[chatId];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[engineName];
        return slot ? { cwd: raw.cwd, engine: engineName, ...slot } : null;
      },
      createSession: (chatId, cwd, _name, engineName, meta) => {
        const created = {
          id: 'fresh-session-retry',
          cwd,
          engine: engineName,
          started: false,
          runtimeSessionObserved: false,
          ...(meta || {}),
        };
        state.sessions[chatId] = {
          cwd,
          engines: {
            ...((state.sessions[chatId] && state.sessions[chatId].engines) || {}),
            [engineName]: { ...created },
          },
        };
        return created;
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: (chatId, engineName) => {
        const slot = state.sessions[chatId] && state.sessions[chatId].engines && state.sessions[chatId].engines[engineName];
        if (slot) slot.started = true;
      },
      isEngineSessionValid: () => true,
      getCodexSessionSandboxProfile: (id) => {
        if (id === 'resume-thread-1') return { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' };
        return { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' };
      },
      getCodexSessionPermissionMode: () => 'danger-full-access',
      getSessionRecentContext: (id) => (id === 'resume-thread-1'
        ? { lastUser: '十', lastAssistant: '收到，已记下“十”。继续讲，我先只记录，不开始执行。' }
        : null),
      gitCheckpoint: () => {},
      gitCheckpointAsync: async () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getDefaultEngine: () => 'codex',
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async () => ({ message_id: 'msg-send' }),
      sendMarkdown: async () => ({ message_id: 'msg-md' }),
      sendCard: async () => ({ message_id: 'msg-card' }),
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const result = await engine.askClaude(bot, 'oc_personal', '加\n十', {
      feishu: { chat_agent_map: { oc_personal: 'personal' } },
      projects: { personal: { cwd: '/tmp/personal', name: '小美', engine: 'codex' } },
    }, false, 'ou_admin');

    assert.equal(result.ok, true);
    assert.equal(stdinPayloads.length, 2);
    assert.match(stdinPayloads[1], /Recent conversation context:/);
    assert.match(stdinPayloads[1], /Last user message: 十/);
    assert.match(stdinPayloads[1], /Last assistant reply: 收到，已记下/);
  });
});
