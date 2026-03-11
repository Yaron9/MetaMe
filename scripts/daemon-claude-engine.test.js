'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

  it('forces fresh codex session when permission mode mismatches', () => {
    const state = { sessions: {} };
    const engine = createEngineWithState(state);
    assert.equal(
      engine._private.shouldStartFreshCodexSessionForPermissions(
        { started: true, id: 'sid-1', permissionMode: 'read-only' },
        false
      ),
      true
    );
    assert.equal(
      engine._private.shouldStartFreshCodexSessionForPermissions(
        { started: true, id: 'sid-1', permissionMode: 'writable' },
        false
      ),
      false
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

  it('reads actual codex permission mode from store helper', () => {
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

    assert.equal(engine._private.getActualCodexPermissionMode({ id: 'thread-1' }), 'read-only');
  });
});
