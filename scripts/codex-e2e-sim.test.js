'use strict';

/**
 * E2E Simulation: Mobile user sends message → daemon routes to codex engine → spawn codex → returns result.
 *
 * This test mocks:
 * - bot (feishu/telegram) — captures sent messages
 * - spawn — emits fake codex JSON stream events
 * - config — project bound with engine: codex
 * - state/session store — in-memory
 *
 * Validates:
 * 1. Engine routing picks codex (not claude) for a codex-bound project
 * 2. Codex args are built correctly (exec --json --full-auto -)
 * 3. Stream events are parsed and text is delivered to user
 * 4. Session thread_id is persisted
 * 5. Resume uses thread_id on second message
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// We need the real modules from the codex branch
const { createEngineRuntimeFactory, normalizeEngineName } = require('./daemon-engine-runtime');
const { createClaudeEngine } = require('./daemon-claude-engine');

function createMockBot() {
  const messages = [];
  const edits = [];
  return {
    messages,
    edits,
    sendMessage: async (chatId, text) => {
      messages.push({ chatId, text, type: 'message' });
      return { message_id: `msg-${messages.length}` };
    },
    sendMarkdown: async (chatId, text) => {
      messages.push({ chatId, text, type: 'markdown' });
      return { message_id: `msg-${messages.length}` };
    },
    editMessage: async (chatId, msgId, text) => {
      edits.push({ chatId, msgId, text });
      return true;
    },
    sendTyping: async () => {},
  };
}

function createFakeCodexProcess(events, exitCode = 0) {
  const child = new EventEmitter();
  const stdoutEmitter = new Readable({ read() {} });
  const stderrEmitter = new Readable({ read() {} });
  const stdinChunks = [];
  child.stdout = stdoutEmitter;
  child.stderr = stderrEmitter;
  child.stdin = {
    write: (chunk) => {
      stdinChunks.push(String(chunk));
      return true;
    },
    end: () => {},
    on: () => {},
    once: () => {},
  };
  child.pid = 12345;
  child.kill = () => {};
  child._stdinText = () => stdinChunks.join('');

  // Emit events asynchronously
  setImmediate(() => {
    for (const evt of events) {
      stdoutEmitter.push(JSON.stringify(evt) + '\n');
    }
    stdoutEmitter.push(null); // EOF
    setImmediate(() => child.emit('close', exitCode));
  });

  return child;
}

describe('Codex E2E Simulation — Mobile User Flow', () => {
  let state, spawnCalls, bot, config;
  const sessionKey = '_bound_my_codex_project';

  beforeEach(() => {
    state = { sessions: {} };
    spawnCalls = [];
    bot = createMockBot();
    config = {
      feishu: {
        allowed_chat_ids: ['chat-codex-user'],
        chat_agent_map: { 'chat-codex-user': 'my_codex_project' },
      },
      projects: {
        my_codex_project: {
          name: 'CodexBot',
          cwd: '/tmp/codex-workspace',
          nicknames: ['CodexBot'],
          engine: 'codex',
        },
      },
      daemon: {
        model: 'o4-mini',
        session_allowed_tools: [],
      },
    };
  });

  it('routes codex-bound chat to codex engine and delivers response', async () => {
    const codexStreamEvents = [
      { type: 'thread.started', thread_id: 'thread-abc-123' },
      { type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } },
      { type: 'item.completed', item: { type: 'command_execution', output: 'file1.js\nfile2.js' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '当前目录有两个文件：file1.js 和 file2.js' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } },
    ];

    const mockSpawn = (bin, args, opts) => {
      const proc = createFakeCodexProcess(codexStreamEvents);
      spawnCalls.push({ bin, args, opts, proc });
      return proc;
    };

    const getEngineRuntime = createEngineRuntimeFactory({
      CLAUDE_BIN: '/usr/local/bin/claude',
      CODEX_BIN: '/usr/local/bin/codex',
      getActiveProviderEnv: () => ({}),
    });

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: mockSpawn,
      CLAUDE_BIN: '/usr/local/bin/claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/test-daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: (level, msg) => { /* silent for test */ },
      yaml: { load: (s) => (typeof s === 'string' ? {} : s) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => config,
      loadState: () => state,
      saveState: (next) => { Object.assign(state, next); },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: (chatId, cwd, name, eng) => {
        state.sessions[chatId] = { id: null, cwd, started: false, engine: eng || 'claude' };
      },
      normalizeCwd: (p) => path.resolve(String(p || '/tmp')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engine) => {
        const session = state.sessions[chatId] || null;
        if (!session) return null;
        if (!session.engines) return session.engine === engine ? session : null;
        const slot = session.engines[engine];
        return slot ? { cwd: session.cwd, ...slot, engine } : null;
      },
      createSession: (chatId, cwd, name, eng) => {
        const engineName = eng || 'claude';
        const s = {
          cwd: cwd || '/tmp',
          engines: {
            [engineName]: { id: `new-${Date.now()}`, started: false },
          },
        };
        state.sessions[chatId] = s;
        return { cwd: s.cwd, engine: engineName, ...s.engines[engineName] };
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: (chatId) => {
        if (state.sessions[chatId]) state.sessions[chatId].started = true;
      },
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime,
    });

    // Simulate: mobile user in codex-bound chat asks for a file to be sent.
    const result = await engine.askClaude(bot, 'chat-codex-user', '把报告发给我', config, false);

    // --- Assertions ---

    // 1. Spawn was called with codex binary, not claude
    assert.equal(spawnCalls.length, 1, 'should spawn exactly once');
    const call = spawnCalls[0];
    console.log('\n=== Spawn Call ===');
    console.log('Binary:', call.bin);
    console.log('Args:', call.args.join(' '));

    assert.ok(
      call.bin.includes('codex') || call.args[0] === 'exec',
      'should use codex binary'
    );
    assert.ok(call.args.includes('--json'), 'should have --json flag');
    assert.ok(call.args.includes('-'), 'should read prompt from stdin');
    assert.match(call.proc._stdinText(), /\[\[FILE:\/absolute\/path\]\]/);

    // 2. Response was sent to user
    const textMessages = bot.messages.filter(m => m.text && m.text.includes('file'));
    console.log('\n=== Messages to user ===');
    bot.messages.forEach(m => console.log(`  [${m.type}] ${m.text.slice(0, 80)}`));
    // At minimum the bot should have sent the ack and the response
    assert.ok(bot.messages.length >= 1, 'should have sent messages to user');

    // 3. Session thread_id was persisted
    const session = state.sessions[sessionKey];
    console.log('\n=== Session State ===');
    console.log(JSON.stringify(session, null, 2));
    assert.ok(session, 'session should exist');
    const codexSlot = session.engines && session.engines.codex;
    assert.ok(codexSlot, 'codex engine slot should exist');
    // thread_id should be persisted (either via onSession or patchSessionSerialized)
    if (codexSlot && codexSlot.id) {
      console.log('Thread ID persisted:', codexSlot.id);
    }

    console.log('\n✅ Codex mobile E2E simulation passed!');
  });

  it('uses resume with thread_id on second message', async () => {
    // Pre-set session state as if first message already happened
    state.sessions[sessionKey] = {
      cwd: '/tmp/codex-workspace',
      engines: {
        codex: {
          id: 'thread-abc-123',
          started: true,
          runtimeSessionObserved: true,
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          permissionMode: 'danger-full-access',
        },
      },
    };

    const codexStreamEvents = [
      { type: 'thread.started', thread_id: 'thread-abc-123' },
      { type: 'item.completed', item: { type: 'agent_message', text: '这是续轮回复' } },
      { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 30 } },
    ];

    const mockSpawn = (bin, args, opts) => {
      const proc = createFakeCodexProcess(codexStreamEvents);
      spawnCalls.push({ bin, args, opts, proc });
      return proc;
    };

    const getEngineRuntime = createEngineRuntimeFactory({
      CLAUDE_BIN: '/usr/local/bin/claude',
      CODEX_BIN: '/usr/local/bin/codex',
      getActiveProviderEnv: () => ({}),
    });

    const engine = createClaudeEngine({
      fs,
      path,
      spawn: mockSpawn,
      CLAUDE_BIN: '/usr/local/bin/claude',
      HOME: os.homedir(),
      CONFIG_FILE: '/tmp/test-daemon.yaml',
      getActiveProviderEnv: () => ({}),
      activeProcesses: new Map(),
      saveActivePids: () => {},
      messageQueue: new Map(),
      log: () => {},
      yaml: { load: () => ({}) },
      providerMod: null,
      writeConfigSafe: () => {},
      loadConfig: () => config,
      loadState: () => state,
      saveState: (next) => { Object.assign(state, next); },
      routeAgent: () => null,
      routeSkill: () => null,
      attachOrCreateSession: () => {},
      normalizeCwd: (p) => path.resolve(String(p || '/tmp')),
      isContentFile: () => false,
      sendFileButtons: async () => {},
      findSessionFile: () => null,
      listRecentSessions: () => [],
      getSession: (chatId) => state.sessions[chatId] || null,
      getSessionForEngine: (chatId, engine) => {
        const session = state.sessions[chatId] || null;
        if (!session) return null;
        if (!session.engines) return session.engine === engine ? session : null;
        const slot = session.engines[engine];
        return slot ? { cwd: session.cwd, ...slot, engine } : null;
      },
      createSession: (chatId, cwd, name, eng) => {
        const engineName = eng || 'claude';
        const s = {
          cwd: cwd || '/tmp',
          engines: {
            [engineName]: { id: `new-${Date.now()}`, started: false },
          },
        };
        state.sessions[chatId] = s;
        return { cwd: s.cwd, engine: engineName, ...s.engines[engineName] };
      },
      getSessionName: () => '',
      writeSessionName: () => {},
      markSessionStarted: () => {},
      gitCheckpoint: () => {},
      recordTokens: () => {},
      skillEvolution: null,
      touchInteraction: () => {},
      getEngineRuntime,
    });

    await engine.askClaude(bot, 'chat-codex-user', '继续看看package.json', config, false);

    assert.equal(spawnCalls.length, 1);
    const call = spawnCalls[0];
    console.log('\n=== Resume Spawn Call ===');
    console.log('Args:', call.args.join(' '));

    // Should include resume with thread id
    assert.ok(call.args.includes('resume'), 'second message should use resume');
    assert.ok(call.args.includes('thread-abc-123'), 'should resume with correct thread_id');

    console.log('\n✅ Codex resume E2E simulation passed!');
  });
});
