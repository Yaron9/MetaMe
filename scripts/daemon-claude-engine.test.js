'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
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

function createDelayedCodexProcess(events, closeDelayMs = 50) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const closeHandlers = [];
  const proc = {
    stdout,
    stderr,
    stdin,
    pid: 12346,
    kill: () => {},
    on(event, handler) {
      if (event === 'close') closeHandlers.push(handler);
      return proc;
    },
  };
  setImmediate(() => {
    for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
    stdout.end();
    stderr.end();
    setTimeout(() => {
      for (const handler of closeHandlers) handler(0);
    }, closeDelayMs);
  });
  return proc;
}

function createPersistentClaudeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new EventEmitter();
  stdin.destroy = () => {};
  const proc = new EventEmitter();
  proc.writeCount = 0;
  proc.failWriteOn = 0;
  proc.emitErrorOnWrite = 0;
  proc.writeErrorMessage = 'warm stdin failure';
  stdin.write = () => {
    proc.writeCount += 1;
    if (proc.failWriteOn && proc.writeCount === proc.failWriteOn) {
      throw new Error(proc.writeErrorMessage);
    }
    if (proc.emitErrorOnWrite && proc.writeCount === proc.emitErrorOnWrite) {
      setImmediate(() => stdin.emit('error', new Error(proc.writeErrorMessage)));
    }
    return true;
  };
  stdin.end = () => {};
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 4242;
  proc.killed = false;
  proc.exitCode = null;
  proc.killSignals = [];
  proc.kill = (signal) => { proc.killSignals.push(signal); };
  proc.emitSuccess = () => {
    stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 }, session_id: 'warm-session' })}\n`);
  };
  proc.finish = (code = 0) => {
    proc.exitCode = code;
    proc.emit('close', code);
  };
  return proc;
}

function createTimeoutTestProcess(outputLines = []) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 9898;
  proc.killed = false;
  proc.exitCode = null;
  proc.killSignals = [];
  proc.kill = (signal) => {
    proc.killSignals.push(signal);
    proc.killed = true;
    setImmediate(() => {
      proc.exitCode = 1;
      proc.emit('close', 1);
    });
  };
  if (outputLines.length > 0) {
    setImmediate(() => {
      for (const line of outputLines) stdout.write(`${line}\n`);
    });
  }
  return proc;
}

function createStreamingStdinFailureProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new EventEmitter();
  stdin.write = () => true;
  stdin.end = () => {};
  stdin.destroy = () => {};
  const proc = new EventEmitter();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = stdin;
  proc.pid = 9797;
  proc.killSignals = [];
  proc.kill = (signal) => { proc.killSignals.push(signal); };
  proc.finish = (code = 1) => {
    proc.exitCode = code;
    proc.emit('close', code);
  };
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

  it('resolves streaming timeout defaults with a one-hour hard ceiling', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.deepEqual(
      engine._private.resolveStreamingTimeouts({}),
      {
        idleMs: 5 * 60 * 1000,
        toolMs: 25 * 60 * 1000,
        ceilingMs: 60 * 60 * 1000,
      }
    );
  });

  it('preserves explicit zero-valued streaming timeout overrides', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.deepEqual(
      engine._private.resolveStreamingTimeouts({ idleMs: 0, toolMs: 0, ceilingMs: 0 }),
      { idleMs: 0, toolMs: 0, ceilingMs: 0 }
    );
  });

  it('formats immediate timeout windows without rewriting them to one minute', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.equal(engine._private.formatTimeoutWindowLabel(0, 'idle'), '立即');
    assert.equal(engine._private.formatTimeoutWindowLabel(0, 'tool'), '立即');
    assert.equal(engine._private.formatTimeoutWindowLabel(60 * 1000, 'idle'), '1 分钟');
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

  it('tracks the initial ack card immediately so topic replies can route before final output', async () => {
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

    const testFs = { ...fs, appendFileSync: () => {}, mkdirSync: () => {}, writeFileSync: () => {} };
    const engine = createClaudeEngine({
      fs: testFs,
      path,
      spawn: () => createDelayedCodexProcess([
        { type: 'item.completed', item: { type: 'agent_message', text: '甲正在处理中' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ], 80),
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

    const pending = engine.askClaude(bot, '_agent_jia', '继续安装', {
      projects: {
        jia: { cwd: '/tmp/agent-jia', name: 'Jarvis · 甲', engine: 'codex' },
      },
    }, false, 'ou_admin');

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(state.msg_sessions['msg-card'].logicalChatId, '_agent_jia');
    assert.equal(state.msg_sessions['msg-card'].agentKey, 'jia');
    assert.equal(state.msg_sessions['msg-card'].cwd, '/tmp/agent-jia');
    assert.ok(!('id' in state.msg_sessions['msg-card']), 'ack mapping should be route-only before runtime session stabilizes');

    const result = await pending;
    assert.equal(result.ok, true);
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

  it('extracts the base agent key from topic virtual chat ids', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.equal(
      engine._private.projectKeyFromVirtualChatId('_agent_bing::thread:oc_topic_1:om_root_1'),
      'bing'
    );
    assert.equal(
      engine._private.projectKeyFromVirtualChatId('_agent_bing'),
      'bing'
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

  it('clears stale stdin error listeners when reusing a warm Claude process', async () => {
    const state = { sessions: {} };
    const child = createPersistentClaudeProcess();
    let spawnCount = 0;
    let storedWarm = null;
    let releaseWarmCount = 0;
    const warmPool = {
      buildStreamMessage(input) { return input; },
      storeWarm(_key, proc) { storedWarm = proc; },
      releaseWarm() { releaseWarmCount += 1; },
    };

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => {
        spawnCount += 1;
        return child;
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
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: true, engine: 'claude' }),
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => {
          const event = JSON.parse(line);
          if (event.type === 'result' && event.subtype === 'success') {
            return [{
              type: 'done',
              result: event.result,
              usage: event.usage,
              sessionId: event.session_id,
            }];
          }
          return [];
        },
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 2000 },
      }),
    });

    const firstPromise = engine.spawnClaudeStreaming(
      ['-p'],
      'first-input',
      '/tmp',
      null,
      1000,
      'chat-warm',
      '',
      '',
      null,
      null,
      { persistent: true, warmPool, warmSessionKey: 'warm-key' }
    );
    child.emitSuccess();
    const first = await firstPromise;
    assert.equal(first.error, null);
    assert.equal(spawnCount, 1);
    assert.equal(storedWarm, child);
    assert.equal(child.stdin.listenerCount('error'), 1);
    assert.equal(child.stdout.listenerCount('data'), 1);
    assert.equal(child.stderr.listenerCount('data'), 1);
    assert.equal(child.listenerCount('close'), 1);
    assert.equal(child.listenerCount('error'), 1);

    child.emitErrorOnWrite = 2;
    const secondPromise = engine.spawnClaudeStreaming(
      ['-p'],
      'second-input',
      '/tmp',
      null,
      1000,
      'chat-warm',
      '',
      '',
      null,
      null,
      { persistent: true, warmChild: child, warmPool, warmSessionKey: 'warm-key' }
    );
    assert.equal(child.stdin.listenerCount('error'), 1);
    assert.equal(child.stdout.listenerCount('data'), 1);
    assert.equal(child.stderr.listenerCount('data'), 1);
    assert.equal(child.listenerCount('close'), 1);
    assert.equal(child.listenerCount('error'), 1);
    await new Promise((resolve) => setImmediate(resolve));
    child.finish(1);
    const second = await secondPromise;
    assert.equal(second.error, 'warm stdin failure');
    assert.equal(spawnCount, 1);
    assert.deepEqual(child.killSignals, ['SIGTERM']);
    assert.equal(releaseWarmCount, 1);
  });

  it('reports tool stalls differently from idle stalls on the streaming path', async () => {
    const state = { sessions: {} };
    const toolProc = createTimeoutTestProcess([JSON.stringify({ type: 'tool_use', toolName: 'Bash', toolInput: { command: 'sleep 1' } })]);
    const idleProc = createTimeoutTestProcess([]);
    let spawnSeq = 0;

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => {
        spawnSeq += 1;
        return spawnSeq === 1 ? toolProc : idleProc;
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
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: true, engine: 'claude' }),
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => {
          const event = JSON.parse(line);
          return [event];
        },
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 20, toolMs: 60, ceilingMs: 0 },
      }),
    });

    const toolResult = await engine.spawnClaudeStreaming(['-p'], 'tool', '/tmp', null, 1000, 'chat-tool');
    const idleResult = await engine.spawnClaudeStreaming(['-p'], 'idle', '/tmp', null, 1000, 'chat-idle');

    assert.match(toolResult.error, /工具执行.*超时/);
    assert.match(idleResult.error, /无输出/);
    assert.deepEqual(toolProc.killSignals, ['SIGTERM']);
    assert.deepEqual(idleProc.killSignals, ['SIGTERM']);
  });

  it('delivers distinct timeout messages through askClaude for tool stalls and idle stalls', async () => {
    const state = { sessions: {} };
    let spawnSeq = 0;
    const toolProc = createTimeoutTestProcess([JSON.stringify({ type: 'tool_use', toolName: 'Bash', toolInput: { command: 'sleep 1' } })]);
    const idleProc = createTimeoutTestProcess([]);
    const sent = [];

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => {
        spawnSeq += 1;
        return spawnSeq === 1 ? toolProc : idleProc;
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
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: () => null,
      createSession: (chatId, cwd, _name, engineName) => {
        const created = { id: `${chatId}-sid`, cwd, engine: engineName, started: false };
        state.sessions[chatId] = created;
        return created;
      },
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => [JSON.parse(line)],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 20, toolMs: 60, ceilingMs: 0 },
      }),
    });

    const bot = {
      sendTyping: async () => {},
      sendMessage: async (_chatId, text) => {
        sent.push(String(text));
        return { message_id: `msg-${sent.length}` };
      },
      sendMarkdown: async (_chatId, text) => {
        sent.push(String(text));
        return { message_id: `md-${sent.length}` };
      },
      sendCard: async (_chatId, card) => {
        sent.push(String((card && card.body) || ''));
        return { message_id: `card-${sent.length}` };
      },
      editMessage: async () => true,
      deleteMessage: async () => true,
    };

    const toolResult = await engine.askClaude(bot, 'tool-chat', 'tool prompt', {}, false, 'ou_admin');
    const idleResult = await engine.askClaude(bot, 'idle-chat', 'idle prompt', {}, false, 'ou_admin');

    assert.equal(toolResult.ok, false);
    assert.equal(idleResult.ok, false);
    assert.ok(sent.some((text) => /工具执行.*超时/.test(text)));
    assert.ok(sent.some((text) => /无输出/.test(text)));
  });

  it('fails fast on streaming stdin errors without waiting for close', async () => {
    const state = { sessions: {} };
    const activeProcesses = new Map();
    const proc = createStreamingStdinFailureProcess();

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => proc,
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
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: true, engine: 'claude' }),
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: () => [],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 0 },
      }),
    });

    const promise = engine.spawnClaudeStreaming(['-p'], 'stdin-fail', '/tmp', null, 1000, 'chat-stdin');
    proc.stdin.emit('error', new Error('stream failed'));
    const result = await promise;

    assert.equal(result.error, 'stream failed');
    assert.deepEqual(proc.killSignals, ['SIGTERM']);
    assert.equal(activeProcesses.has('chat-stdin'), false);

    proc.finish(1);
  });

  it('preserves collected streaming state on stdin failure', async () => {
    const state = { sessions: {} };
    const activeProcesses = new Map();
    const proc = createStreamingStdinFailureProcess();

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => proc,
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
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: true, engine: 'claude' }),
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => [JSON.parse(line)],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 0 },
      }),
    });

    const promise = engine.spawnClaudeStreaming(['-p'], 'stdin-fail', '/tmp/file.txt', null, 1000, 'chat-stdin');
    proc.stdout.write(`${JSON.stringify({ type: 'session', sessionId: 'sess-1' })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: 'text', text: 'partial output' })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: 'tool_use', toolName: 'Write', toolInput: { file_path: '/tmp/out.txt' } })}\n`);
    proc.stdin.emit('error', new Error('stream failed'));
    const result = await promise;

    assert.equal(result.error, 'stream failed');
    assert.equal(result.output, 'partial output');
    assert.deepEqual(result.files, ['/tmp/out.txt']);
    assert.deepEqual(result.toolUsageLog, [{ tool: 'Write', context: 'out.txt' }]);
    assert.equal(result.sessionId, 'sess-1');
    assert.equal(activeProcesses.has('chat-stdin'), false);

    proc.finish(1);
  });

  it('absorbs buffered unterminated streaming events before failing fast on stdin error', async () => {
    const state = { sessions: {} };
    const activeProcesses = new Map();
    const proc = createStreamingStdinFailureProcess();

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => proc,
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
      loadConfig: () => ({}),
      loadState: () => state,
      saveState: () => {},
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: true, engine: 'claude' }),
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => [JSON.parse(line)],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: 0 },
      }),
    });

    const promise = engine.spawnClaudeStreaming(['-p'], 'stdin-fail', '/tmp/file.txt', null, 1000, 'chat-buffered');
    proc.stdout.write(`${JSON.stringify({ type: 'session', sessionId: 'sess-buffered' })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: 'text', text: 'live output' })}\n`);
    proc.stdout.write(`${JSON.stringify({ type: 'tool_use', toolName: 'Write', toolInput: { file_path: '/tmp/buffered.txt' } })}\n`);
    proc.stdout.write(JSON.stringify({ type: 'tool_result' }));
    proc.stdout.write(`\n${JSON.stringify({ type: 'done', result: 'ignored fallback', usage: { input_tokens: 1, output_tokens: 2 } })}`);
    proc.stdout.write(`\n${JSON.stringify({ type: 'text', text: 'buffered tail' })}`);
    proc.stdin.emit('error', new Error('buffered fail'));
    const result = await promise;

    assert.equal(result.error, 'buffered fail');
    assert.equal(result.output, 'live output\n\nbuffered tail');
    assert.deepEqual(result.files, ['/tmp/buffered.txt']);
    assert.deepEqual(result.toolUsageLog, [{ tool: 'Write', context: 'buffered.txt' }]);
    assert.deepEqual(result.usage, { input_tokens: 1, output_tokens: 2 });
    assert.equal(result.sessionId, 'sess-buffered');
    assert.equal(activeProcesses.has('chat-buffered'), false);

    proc.finish(1);
  });

  it('does not re-arm watchdog timers when buffered events are absorbed during close cleanup', async () => {
    const state = { sessions: {} };
    const activeProcesses = new Map();
    const proc = createStreamingStdinFailureProcess();
    const logs = [];

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: () => proc,
      CLAUDE_BIN: 'claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses,
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: (...args) => { logs.push(args.join(' ')); },
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
      sendFileButtons: async () => [],
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: () => null,
      getSessionForEngine: () => null,
      createSession: () => ({ id: 'sid', cwd: '/tmp', started: true, engine: 'claude' }),
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
      getEngineRuntime: () => ({
        name: 'claude',
        binary: 'claude',
        buildArgs: () => ['-p'],
        buildEnv: () => ({ ...process.env }),
        parseStreamEvent: (line) => [JSON.parse(line)],
        classifyError: () => null,
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 10, toolMs: 10, ceilingMs: 0 },
      }),
    });

    const promise = engine.spawnClaudeStreaming(['-p'], 'close-buffered', '/tmp/file.txt', null, 1000, 'chat-close-buffered');
    proc.stdout.write(JSON.stringify({ type: 'tool_use', toolName: 'Write', toolInput: { file_path: '/tmp/late.txt' } }));
    proc.finish(0);
    const result = await promise;

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(result.error, null);
    assert.deepEqual(result.files, ['/tmp/late.txt']);
    assert.deepEqual(result.toolUsageLog, [{ tool: 'Write', context: 'late.txt' }]);
    assert.deepEqual(proc.killSignals, []);
    assert.equal(logs.some((entry) => entry.includes('timeout for chatId chat-close-buffered')), false);
  });
});

// ---------------------------------------------------------------------------
// Auto-sync: daemon picks up newer CLI sessions from same project directory
// ---------------------------------------------------------------------------
describe('auto-sync: session switch when CLI session is newer', () => {
  const BASE_MTIME = 1_700_000_000_000; // arbitrary baseline ms epoch

  function createAutoSyncEngine({ listRecentSessionsOverride, findSessionFileOverride, hasWarmOverride, sessionId = 'old-session-id', sessionChatId = '_bound_metame' } = {}) {
    const state = {
      sessions: {
        [sessionChatId]: {
          cwd: '/tmp/autosync-project',
          engines: {
            claude: {
              id: sessionId,
              started: true,
            },
          },
        },
      },
    };

    // Capture all saveState calls so we can verify auto-sync patch fired
    // (the spawn will overwrite with its own session id, so we track intermediate saves)
    const saveHistory = [];

    const testFs = {
      ...fs,
      appendFileSync: () => {},
      mkdirSync: () => {},
      writeFileSync: () => {},
      statSync: (p) => {
        if (p && p.includes(sessionId)) return { mtimeMs: BASE_MTIME };
        return fs.statSync(p);
      },
    };

    const engine = createClaudeEngine({
      fs: testFs,
      path,
      spawn: () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new PassThrough();
        const proc = {
          stdout, stderr, stdin, pid: 55001,
          kill: () => {},
          on(event, handler) {
            if (event === 'close') setImmediate(() => handler(0));
            return proc;
          },
        };
        setImmediate(() => {
          stdout.write('{"kind":"session","id":"spawned-new"}\n');
          stdout.write('{"kind":"assistant","text":"ok"}\n');
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
      loadConfig: () => ({ projects: { metame: { cwd: '/tmp/autosync-project', name: 'MetaMe' } } }),
      loadState: () => state,
      saveState: (next) => {
        const snap = next.sessions && next.sessions[sessionChatId] && next.sessions[sessionChatId].engines;
        if (snap && snap.claude) saveHistory.push(snap.claude.id);
        Object.assign(state, next);
        state.sessions = next.sessions;
      },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '')),
      isContentFile: () => false,
      sendFileButtons: async () => [],
      findSessionFile: findSessionFileOverride || ((sid) => `/tmp/.sessions/${sid}.jsonl`),
      listRecentSessions: listRecentSessionsOverride || (() => []),
      getSession: (id) => state.sessions[id] || null,
      getSessionForEngine: (id, eng) => {
        const raw = state.sessions[id];
        if (!raw) return null;
        const slot = raw.engines && raw.engines[eng];
        return slot ? { cwd: raw.cwd, engine: eng, logicalChatId: id, ...slot } : null;
      },
      createSession: () => ({ id: 'fresh', cwd: '/tmp/autosync-project', started: false, engine: 'claude', logicalChatId: sessionChatId }),
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
        timeouts: { idleMs: 500, toolMs: 500, ceilingMs: 2000 },
      }),
      warmPool: {
        acquireWarm: () => null,
        storeWarm: () => {},
        releaseWarm: () => {},
        hasWarm: hasWarmOverride || (() => false),
        _pool: new Map(),
      },
    });

    return { engine, state, saveHistory };
  }

  const bot = {
    sendTyping: async () => {},
    sendMessage: async () => ({ message_id: 'msg-autosync' }),
    sendMarkdown: async () => ({ message_id: 'msg-autosync-md' }),
    sendCard: async () => ({ message_id: 'msg-autosync-card' }),
    editMessage: async () => true,
    deleteMessage: async () => true,
  };

  it('switches to a newer CLI session when daemon is idle', async () => {
    const { engine, saveHistory } = createAutoSyncEngine({
      listRecentSessionsOverride: () => [
        { sessionId: 'new-session-id', fileMtime: BASE_MTIME + 120_000 }, // 2 min newer
      ],
    });

    const notifMessages = [];
    const spyBot = {
      ...bot,
      sendMessage: async (chatId, text) => { notifMessages.push({ chatId, text }); return { message_id: 'msg-autosync' }; },
    };

    await engine.askClaude(spyBot, '_bound_metame', 'hello', {
      projects: { metame: { cwd: '/tmp/autosync-project' } },
      feishu: { allowed_chat_ids: [] },
    }, false, 'ou_admin');

    // Auto-sync must have patched state to new-session-id at some point during the call
    assert.ok(saveHistory.includes('new-session-id'), `expected auto-sync patch to new-session-id; saveHistory=${JSON.stringify(saveHistory)}`);
    // Notification must have been sent to the user
    const syncNotif = notifMessages.find(m => m.text && m.text.includes('new-ses'));
    assert.ok(syncNotif, 'bot.sendMessage should be called with the auto-sync notification');
  });

  it('does not switch when warm process exists', async () => {
    const { engine, saveHistory } = createAutoSyncEngine({
      hasWarmOverride: () => true, // warm pool has a live process
      listRecentSessionsOverride: () => [
        { sessionId: 'new-session-id', fileMtime: BASE_MTIME + 120_000 },
      ],
    });

    await engine.askClaude(bot, '_bound_metame', 'hello', {
      projects: { metame: { cwd: '/tmp/autosync-project' } },
      feishu: { allowed_chat_ids: [] },
    }, false, 'ou_admin');

    assert.ok(!saveHistory.includes('new-session-id'), 'session should NOT switch when warm process exists');
  });

  it('does not switch for agent chats (_agent_ prefix)', async () => {
    const { engine, saveHistory } = createAutoSyncEngine({
      sessionId: 'old-agent-sess',
      sessionChatId: '_agent_jia',
      listRecentSessionsOverride: () => [
        { sessionId: 'new-agent-sess', fileMtime: BASE_MTIME + 120_000 },
      ],
    });

    await engine.askClaude(bot, '_agent_jia', 'hello', {
      projects: { jia: { cwd: '/tmp/autosync-project', engine: 'claude' } },
      feishu: { allowed_chat_ids: [] },
    }, false, 'ou_admin');

    assert.ok(!saveHistory.includes('new-agent-sess'), 'should NOT auto-sync agent chats');
  });

  it('does not switch when mtime gap is less than 60 seconds', async () => {
    const { engine, saveHistory } = createAutoSyncEngine({
      listRecentSessionsOverride: () => [
        { sessionId: 'barely-newer', fileMtime: BASE_MTIME + 30_000 }, // only 30s newer
      ],
    });

    await engine.askClaude(bot, '_bound_metame', 'hello', {
      projects: { metame: { cwd: '/tmp/autosync-project' } },
      feishu: { allowed_chat_ids: [] },
    }, false, 'ou_admin');

    assert.ok(!saveHistory.includes('barely-newer'), 'should NOT switch for sessions < 60s newer');
  });
});
