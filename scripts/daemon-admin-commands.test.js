'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createAdminCommandHandler } = require('./daemon-admin-commands');
const taskEnvelope = require('./daemon-task-envelope');

function createHandler(getAllTasksImpl, overrides = {}) {
  return createAdminCommandHandler({
    fs: require('fs'),
    yaml: { load: () => ({}), dump: () => '' },
    execSync: () => '',
    BRAIN_FILE: '/tmp/brain.yaml',
    CONFIG_FILE: '/tmp/config.yaml',
    DISPATCH_LOG: '/tmp/dispatch.log',
    providerMod: null,
    loadConfig: () => ({}),
    backupConfig: () => {},
    writeConfigSafe: () => {},
    restoreConfig: () => false,
    getSession: () => null,
    getAllTasks: getAllTasksImpl,
    dispatchTask: () => ({ success: true }),
    log: () => {},
    skillEvolution: null,
    taskBoard: null,
    taskEnvelope: null,
    ...overrides,
  });
}

describe('daemon-admin-commands /tasks', () => {
  it('renders interval and fixed-time schedules for mobile task list', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(() => ({
      general: [
        { name: 'memory-extract', interval: '4h', enabled: true },
      ],
      project: [
        {
          name: 'morning-brief',
          at: '09:00',
          days: 'weekdays',
          enabled: true,
          _project: { key: 'writer', icon: '✍️', name: 'Writer' },
        },
      ],
    }));

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-1',
      text: '/tasks',
      config: {},
      state: {
        tasks: {
          'memory-extract': { status: 'success' },
          'morning-brief': { status: 'never_run' },
        },
      },
    });

    assert.equal(res.handled, true);
    assert.equal(sent.length, 1);
    const body = sent[0];
    assert.match(body, /memory-extract \(every 4h\) success/);
    assert.match(body, /morning-brief \(at 09:00 weekdays\) never_run/);
  });
});

describe('daemon-admin-commands /TeamTask', () => {
  it('creates team task via /TeamTask create', async () => {
    const sent = [];
    const dispatchCalls = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskEnvelope,
        taskBoard: {
          listScopeParticipants: () => ['planner'],
        },
        dispatchTask: (target, packet) => {
          dispatchCalls.push({ target, packet });
          return { success: true };
        },
      }
    );

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-2',
      text: '/TeamTask create coder 重构登录流程 --scope epic_auth',
      config: {
        projects: {
          coder: { name: 'Coder' },
        },
      },
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].target, 'coder');
    assert.equal(dispatchCalls[0].packet.payload.task_envelope.scope_id, 'epic_auth');
    assert.match(sent[0], /已创建 TeamTask 并派发/);
    assert.match(sent[0], /查看: \/TeamTask t_/);
  });

  it('shows usage when /TeamTask create is missing payload', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(() => ({ general: [], project: [] }), { taskEnvelope });
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-2b',
      text: '/TeamTask create',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /用法: \/TeamTask create <agent> <目标>/);
  });

  it('lists team tasks via /TeamTask', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskBoard: {
          listRecentTasks: () => [
            {
              task_id: 't_20260225_abc123',
              scope_id: 'epic_auth',
              status: 'running',
              from_agent: 'user',
              to_agent: 'coder',
              goal: '重构登录流程',
            },
          ],
        },
      }
    );

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-3',
      text: '/TeamTask',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /TeamTask \(最近10条\)/);
    assert.match(sent[0], /查看详情: \/TeamTask <task_id>/);
    assert.match(sent[0], /续跑: \/TeamTask resume <task_id>/);
  });

  it('renders detail via /TeamTask <task_id>', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskBoard: {
          getTask: () => ({
            task_id: 't_20260225_xyz789',
            scope_id: 'epic_auth',
            status: 'running',
            priority: 'normal',
            from_agent: 'planner',
            to_agent: 'coder',
            task_kind: 'team',
            goal: '重构登录流程',
            definition_of_done: ['提交可运行代码'],
            artifacts: ['src/login.js'],
          }),
          listTaskEvents: () => [],
          listScopeTasks: () => [],
          listScopeParticipants: () => ['planner', 'coder'],
        },
      }
    );

    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-3b',
      text: '/TeamTask t_20260225_xyz789',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /🧩 TeamTask: t_20260225_xyz789/);
    assert.match(sent[0], /Scope: epic_auth/);
    assert.match(sent[0], /参与者: planner, coder/);
  });

  it('resumes task via /TeamTask resume <task_id>', async () => {
    const sent = [];
    const dispatchCalls = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskEnvelope,
        taskBoard: {
          getTask: () => ({
            task_id: 't_20260225_resume1',
            scope_id: 'epic_auth',
            status: 'queued',
            priority: 'normal',
            from_agent: 'planner',
            to_agent: 'coder',
            task_kind: 'team',
            goal: '重构登录流程',
            definition_of_done: [],
            inputs: {},
            artifacts: [],
            owned_paths: [],
            created_at: '2026-02-25T00:00:00.000Z',
          }),
          listScopeParticipants: () => ['planner', 'coder'],
          appendTaskEvent: () => {},
        },
        dispatchTask: (target, packet) => {
          dispatchCalls.push({ target, packet });
          return { success: true };
        },
      }
    );
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-3c',
      text: '/TeamTask resume t_20260225_resume1',
      config: {
        projects: {
          coder: { name: 'Coder' },
        },
      },
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].target, 'coder');
    assert.match(sent[0], /已续跑 TeamTask: t_20260225_resume1/);
  });

  it('shows usage when /TeamTask resume is missing task id', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskBoard: {
          getTask: () => null,
        },
      }
    );
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-3d',
      text: '/TeamTask resume',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /用法: \/TeamTask resume <task_id>/);
  });

  it('does not handle legacy /task command', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(() => ({ general: [], project: [] }));
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };
    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-4',
      text: '/task',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, false);
    assert.equal(sent.length, 0);
  });

  it('does not accept legacy /dispatch task syntax', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(() => ({ general: [], project: [] }));
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };
    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-5',
      text: '/dispatch task coder 重构登录流程',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /\/TeamTask create <agent> <目标>/);
    assert.doesNotMatch(sent[0], /\/dispatch task/);
  });
});

describe('daemon-admin-commands /mentor', () => {
  it('toggles mentor and adjusts level/mode', async () => {
    const sent = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-mentor-cmd-'));
    const configFile = path.join(tmpDir, 'daemon.yaml');
    const yaml = require('js-yaml');
    const initial = { daemon: { model: 'opus' } };
    fs.writeFileSync(configFile, yaml.dump(initial), 'utf8');

    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        yaml,
        CONFIG_FILE: configFile,
        loadConfig: () => yaml.load(fs.readFileSync(configFile, 'utf8')) || {},
        writeConfigSafe: (cfg) => fs.writeFileSync(configFile, yaml.dump(cfg), 'utf8'),
      }
    );
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    let res = await handleAdminCommand({
      bot, chatId: 'mobile-user-mentor', text: '/mentor on', config: {}, state: { tasks: {}, budget: { tokens_used: 0 } },
    });
    assert.equal(res.handled, true);
    assert.match(sent[sent.length - 1], /enabled/i);

    res = await handleAdminCommand({
      bot, chatId: 'mobile-user-mentor', text: '/mentor level 9', config: {}, state: { tasks: {}, budget: { tokens_used: 0 } },
    });
    assert.equal(res.handled, true);
    assert.match(sent[sent.length - 1], /9 \(intense\)/i);

    res = await handleAdminCommand({
      bot, chatId: 'mobile-user-mentor', text: '/mentor status', config: {}, state: { tasks: {}, budget: { tokens_used: 0 } },
    });
    assert.equal(res.handled, true);
    assert.match(sent[sent.length - 1], /Mentor: ON/);
    assert.match(sent[sent.length - 1], /Mode: intense/);

    const finalCfg = yaml.load(fs.readFileSync(configFile, 'utf8')) || {};
    assert.equal(finalCfg.daemon.mentor.enabled, true);
    assert.equal(finalCfg.daemon.mentor.friction_level, 9);
    assert.equal(finalCfg.daemon.mentor.mode, 'intense');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
