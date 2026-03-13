'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExecCommandHandler } = require('./daemon-exec-commands');
const { createOpsCommandHandler } = require('./daemon-ops-commands');

function makeBot() {
  const sent = [];
  const buttons = [];
  return {
    sent,
    buttons,
    sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    sendButtons: async (_chatId, text, rows) => {
      sent.push(String(text));
      buttons.push(rows);
    },
  };
}

function createState(base = {}) {
  return {
    sessions: {},
    team_sticky: {},
    ...base,
  };
}

describe('daemon exec/ops commands honor logical session routes', () => {
  it('resolves /compact via bound session route', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-compact-'));
    const sessionFile = path.join(tmpDir, 'sid-bound.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: 'user', message: { content: '做 PPT 和分享稿' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '先定大纲' }] } }),
      '',
    ].join('\n'));

    const state = createState({
      sessions: {
        _bound_metame: {
          cwd: tmpDir,
          engines: {
            claude: { id: 'sid-bound', started: true },
          },
        },
      },
    });
    const created = [];
    const bot = makeBot();
    let spawnCalls = 0;

    const { handleExecCommand } = createExecCommandHandler({
      fs,
      path,
      spawn: () => { throw new Error('spawn should not be called'); },
      HOME: os.homedir(),
      checkCooldown: () => ({ ok: true }),
      activeProcesses: new Map(),
      messageQueue: new Map(),
      findTask: () => null,
      checkPrecondition: () => ({ pass: true }),
      buildProfilePreamble: () => '',
      spawnClaudeAsync: async () => {
        spawnCalls += 1;
        if (spawnCalls === 1) return { output: '压缩摘要', error: null };
        return { output: '', error: null };
      },
      recordTokens: () => {},
      loadState: () => state,
      saveState: (next) => {
        state.sessions = next.sessions;
        state.team_sticky = next.team_sticky || {};
      },
      getSession: (id) => state.sessions[id] || null,
      getSessionForEngine: (id, engine) => {
        const raw = state.sessions[id] || null;
        if (!raw) return null;
        if (raw.engines && raw.engines[engine]) return { cwd: raw.cwd, engine, ...raw.engines[engine] };
        if (raw.id) return { cwd: raw.cwd, engine, id: raw.id, started: !!raw.started };
        return null;
      },
      getSessionName: () => 'PPT 分享',
      createSession: (chatId, cwd, name, engine) => {
        created.push({ chatId, cwd, name, engine });
        return { id: 'sid-new', cwd, engine };
      },
      findSessionFile: () => sessionFile,
      loadConfig: () => ({
        projects: { metame: { cwd: tmpDir, engine: 'claude' } },
        feishu: { chat_agent_map: { 'bound-chat': 'metame' } },
      }),
      getDistillModel: () => 'haiku',
      getDefaultEngine: () => 'claude',
    });

    const handled = await handleExecCommand({
      bot,
      chatId: 'bound-chat',
      text: '/compact',
      config: {},
      executeTaskByName: () => ({}),
    });

    assert.equal(handled, true);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { chatId: '_bound_metame', cwd: tmpDir, name: 'PPT 分享 (compacted)', engine: 'claude' });
    assert.match(bot.sent.at(-1), /Compacted!/);
  });

  it('resolves /publish cwd via bound session route', async () => {
    const state = createState({
      sessions: {
        _bound_metame: {
          cwd: '/repo/publish-target',
          engines: {
            claude: { id: 'sid-bound', started: true },
          },
        },
      },
    });
    const bot = makeBot();
    const spawnInvocations = [];

    const { handleExecCommand } = createExecCommandHandler({
      fs,
      path,
      spawn: (bin, args, options) => {
        spawnInvocations.push({ bin, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        process.nextTick(() => {
          child.stdout.emit('data', Buffer.from('+ metame-cli@1.2.3\n'));
          child.emit('close', 0);
        });
        return child;
      },
      HOME: os.homedir(),
      checkCooldown: () => ({ ok: true }),
      activeProcesses: new Map(),
      messageQueue: new Map(),
      findTask: () => null,
      checkPrecondition: () => ({ pass: true }),
      buildProfilePreamble: () => '',
      spawnClaudeAsync: async () => ({ output: '', error: null }),
      recordTokens: () => {},
      loadState: () => state,
      saveState: () => {},
      getSession: (id) => state.sessions[id] || null,
      getSessionForEngine: (id, engine) => {
        const raw = state.sessions[id] || null;
        if (!raw) return null;
        return { cwd: raw.cwd, engine, ...raw.engines[engine] };
      },
      getSessionName: () => null,
      createSession: () => ({ id: 'unused', cwd: '/tmp', engine: 'claude' }),
      findSessionFile: () => null,
      loadConfig: () => ({
        projects: { metame: { cwd: '/repo/publish-target', engine: 'claude' } },
        feishu: { chat_agent_map: { 'bound-chat': 'metame' } },
      }),
      getDistillModel: () => 'haiku',
      getDefaultEngine: () => 'claude',
    });

    const handled = await handleExecCommand({
      bot,
      chatId: 'bound-chat',
      text: '/publish 123456',
      config: {},
      executeTaskByName: () => ({}),
    });

    assert.equal(handled, true);
    assert.equal(spawnInvocations.length, 1);
    assert.equal(spawnInvocations[0].options.cwd, '/repo/publish-target');
    assert.match(bot.sent.at(-1), /Published/);
  });

  it('resolves /undo via sticky team session route', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-undo-'));
    const sessionFile = path.join(tmpDir, 'sid-jia.jsonl');
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-03-13T10:00:00.000Z',
        message: { role: 'user', content: '继续做结构化提纲' },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
      }),
      '',
    ].join('\n'));

    const state = createState({
      team_sticky: { 'team-chat': 'jia' },
      sessions: {
        _agent_jia: {
          cwd: tmpDir,
          engines: {
            codex: { id: 'sid-jia', started: true },
          },
        },
      },
    });
    const bot = makeBot();

    const { handleOpsCommand } = createOpsCommandHandler({
      fs,
      path,
      spawn: () => { throw new Error('spawn should not be called'); },
      execSync: () => { throw new Error('execSync should not be called'); },
      log: () => {},
      loadConfig: () => ({
        projects: {
          jarvis: {
            cwd: '/repo/main',
            engine: 'claude',
            team: [{ key: 'jia', cwd: tmpDir, engine: 'codex' }],
          },
        },
        feishu: { chat_agent_map: { 'team-chat': 'jarvis' } },
      }),
      loadState: () => state,
      messageQueue: new Map(),
      activeProcesses: new Map(),
      getSession: (id) => state.sessions[id] || null,
      getSessionForEngine: (id, engine) => {
        const raw = state.sessions[id] || null;
        if (!raw) return null;
        return { cwd: raw.cwd, engine, ...raw.engines[engine] };
      },
      listCheckpoints: () => [],
      cpDisplayLabel: (v) => v,
      truncateSessionToCheckpoint: () => 0,
      findSessionFile: () => sessionFile,
      clearSessionFileCache: () => {},
      cpExtractTimestamp: () => null,
      gitCheckpoint: () => {},
      cleanupCheckpoints: () => {},
      getNoSleepProcess: () => null,
      setNoSleepProcess: () => {},
      getDefaultEngine: () => 'claude',
    });

    const handled = await handleOpsCommand({
      bot,
      chatId: 'team-chat',
      text: '/undo',
    });

    assert.equal(handled, true);
    assert.equal(bot.buttons.length, 1);
    assert.match(bot.sent[0], /回退到哪条消息之前/);
    assert.doesNotMatch(bot.sent[0], /No active session/);
  });
});
