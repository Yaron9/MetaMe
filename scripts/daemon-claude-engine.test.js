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

  it('decides codex resume fallback retry correctly', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.equal(engine._private.shouldRetryCodexResumeFallback({
      runtimeName: 'codex',
      wasResumeAttempt: true,
      output: '',
      error: 'resume failed',
      errorCode: 'EXEC_FAILURE',
      canRetry: true,
    }), true);

    assert.equal(engine._private.shouldRetryCodexResumeFallback({
      runtimeName: 'codex',
      wasResumeAttempt: true,
      output: '',
      error: 'resume failed',
      errorCode: 'EXEC_FAILURE',
      canRetry: false,
    }), false);
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
      engine._private.markCodexResumeRetried(key);
      assert.equal(engine._private.canRetryCodexResume(key), false);
      now += engine._private.CODEX_RESUME_RETRY_WINDOW_MS + 1;
      assert.equal(engine._private.canRetryCodexResume(key), true);
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
      engine._private.shouldStartFreshCodexSessionForPermissions(
        { started: true, id: 'sid-1', permissionMode: 'read-only', approvalPolicy: 'never' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      false
    );
    assert.equal(
      engine._private.shouldStartFreshCodexSessionForPermissions(
        { started: true, id: 'sid-1', permissionMode: 'danger-full-access', sandboxMode: 'danger-full-access', approvalPolicy: 'never' },
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
      engine._private.codexPermissionNeedsMigration(
        { sandboxMode: 'read-only', approvalPolicy: 'never', permissionMode: 'read-only' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      true
    );
    assert.equal(
      engine._private.codexPermissionNeedsMigration(
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      false
    );
  });

  it('builds a migration bridge prompt that preserves conversation continuity for any virtual chat id', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    const prompt = engine._private.buildCodexMigrationPrompt({
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

  it('does not force a fresh codex session when stored permission metadata is stale but actual runtime matches', () => {
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
      engine._private.shouldStartFreshCodexSessionForPermissions(
        { started: true, id: 'sid-1', permissionMode: 'read-only', approvalPolicy: null },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      false
    );
  });

  it('does not force a fresh codex session when actual runtime is lower privilege than requested', () => {
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
      engine._private.shouldStartFreshCodexSessionForPermissions(
        { started: true, id: 'sid-1', permissionMode: 'danger-full-access', approvalPolicy: 'never' },
        { sandboxMode: 'danger-full-access', approvalPolicy: 'never', permissionMode: 'danger-full-access' }
      ),
      false
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

  it('skips claude resume when session JSONL was created by non-claude model', () => {
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
      { shouldResume: false, modelPin: null, reason: 'non-claude-session' }
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
      { shouldResume: true, modelPin: 'claude-sonnet-4-20250514', reason: '' }
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

  it('blocks only macos-local-orchestrator auto-routing for personal agent chats', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);

    assert.equal(
      engine._private.shouldAutoRouteSkill({
        agentMatch: null,
        hasActiveSession: false,
        boundProjectKey: 'personal',
        skillName: 'macos-local-orchestrator',
      }),
      false
    );

    assert.equal(
      engine._private.shouldAutoRouteSkill({
        agentMatch: null,
        hasActiveSession: false,
        boundProjectKey: 'personal',
        skillName: 'macos-mail-calendar',
      }),
      true
    );

    assert.equal(
      engine._private.shouldAutoRouteSkill({
        agentMatch: null,
        hasActiveSession: false,
        boundProjectKey: 'coder',
        skillName: 'macos-local-orchestrator',
      }),
      true
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
});
