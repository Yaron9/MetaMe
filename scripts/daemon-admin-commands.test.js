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
    assert.equal(dispatchCalls[0].packet.source_chat_id, 'mobile-user-2');
    assert.equal(dispatchCalls[0].packet.source_sender_key, 'user');
    assert.match(sent[0], /已创建 TeamTask 并提交派发/);
    assert.match(sent[0], /回执会在目标端真正接收后返回/);
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
    assert.equal(dispatchCalls[0].packet.source_chat_id, 'mobile-user-3c');
    assert.equal(dispatchCalls[0].packet.source_sender_key, 'planner');
    assert.match(sent[0], /已续跑 TeamTask: t_20260225_resume1/);
    assert.match(sent[0], /回执会在目标端真正接收后返回/);
  });

  it('auto-resumes the unique recent TeamTask on strong natural-language rework intent', async () => {
    const sent = [];
    const dispatchCalls = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskEnvelope,
        taskBoard: {
          listRecentTasks: () => [
            {
              task_id: 't_20260312_auto1',
              scope_id: 'epic_auth',
              status: 'done',
              priority: 'normal',
              from_agent: 'user',
              to_agent: 'coder',
              task_kind: 'team',
              goal: '修复登录流程',
              inputs: { source_chat_id: 'mobile-user-auto' },
              participants: ['user', 'coder'],
              updated_at: new Date().toISOString(),
            },
          ],
          listScopeParticipants: () => ['user', 'coder'],
          appendTaskEvent: () => {},
        },
        dispatchTask: (target, packet) => {
          dispatchCalls.push({ target, packet });
          return {
            success: true,
            id: 'd_auto_001',
            task_id: packet.payload.task_envelope.task_id,
            scope_id: packet.payload.task_envelope.scope_id,
          };
        },
      }
    );
    const bot = {
      sendMessage: async (_chatId, text) => { sent.push(String(text)); },
    };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-auto',
      text: '继续上次那个任务，接着改',
      config: {
        projects: {
          coder: { name: 'Coder', icon: '🛠' },
        },
      },
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].target, 'coder');
    assert.equal(dispatchCalls[0].packet.payload.task_envelope.task_id, 't_20260312_auto1');
    assert.match(sent[0], /已自动续跑最近的 TeamTask: t_20260312_auto1/);
    assert.match(sent[1], /📮 Dispatch 回执/);
  });

  it('does not auto-resume when multiple recent TeamTasks match the same chat', async () => {
    const sent = [];
    const dispatchCalls = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        taskBoard: {
          listRecentTasks: () => [
            {
              task_id: 't_20260312_multi1',
              scope_id: 'epic_auth',
              status: 'done',
              from_agent: 'user',
              to_agent: 'coder',
              task_kind: 'team',
              goal: '修复登录流程',
              inputs: { source_chat_id: 'mobile-user-multi' },
              participants: ['user', 'coder'],
              updated_at: new Date().toISOString(),
            },
            {
              task_id: 't_20260312_multi2',
              scope_id: 'epic_payment',
              status: 'done',
              from_agent: 'user',
              to_agent: 'coder',
              task_kind: 'team',
              goal: '修复支付流程',
              inputs: { source_chat_id: 'mobile-user-multi' },
              participants: ['user', 'coder'],
              updated_at: new Date().toISOString(),
            },
          ],
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
      chatId: 'mobile-user-multi',
      text: '继续上次那个任务',
      config: {
        projects: {
          coder: { name: 'Coder', icon: '🛠' },
        },
      },
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.equal(dispatchCalls.length, 0);
    assert.match(sent[0], /最近有多条候选任务/);
    assert.match(sent[0], /t_20260312_multi1/);
    assert.match(sent[0], /t_20260312_multi2/);
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

describe('daemon-admin-commands distill model controls', () => {
  function createProviderStub() {
    let model = 'haiku';
    return {
      getDistillModel: () => model,
      setDistillModel: (next) => {
        const raw = String(next || '').trim();
        if (!raw) throw new Error('蒸馏模型不能为空。');
        if (raw.toLowerCase() === '5.1mini') {
          model = 'gpt-5.1-codex-mini';
          return;
        }
        if (!/^[a-zA-Z0-9._-]{2,80}$/.test(raw)) throw new Error('无效蒸馏模型');
        model = raw;
      },
    };
  }

  it('shows current model via /distill-model', async () => {
    const sent = [];
    const providerStub = createProviderStub();
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      { providerMod: providerStub }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-distill-1',
      text: '/distill-model',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /当前蒸馏模型: haiku/);
  });

  it('updates model via /distill-model <name>', async () => {
    const sent = [];
    const providerStub = createProviderStub();
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      { providerMod: providerStub }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-distill-2',
      text: '/distill-model 5.1mini',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /gpt-5.1-codex-mini/);
  });

  it('updates model via strict natural-language intent', async () => {
    const sent = [];
    const providerStub = createProviderStub();
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      { providerMod: providerStub }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-distill-3',
      text: '把蒸馏模型改成 5.1mini',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /已按自然语言请求更新蒸馏模型/);
    assert.match(sent[0], /gpt-5.1-codex-mini/);
  });

  it('does not trigger on unrelated distill chat', async () => {
    const sent = [];
    const providerStub = createProviderStub();
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      { providerMod: providerStub }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-distill-4',
      text: '蒸馏这个想法我觉得挺好',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, false);
    assert.equal(sent.length, 0);
    assert.equal(providerStub.getDistillModel(), 'haiku');
  });

  it('does not trigger when model is only mentioned without set intent', async () => {
    const sent = [];
    const providerStub = createProviderStub();
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      { providerMod: providerStub }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-distill-5',
      text: '今天蒸馏总结里提到了 gpt-5-mini，先不用改',
      config: {},
      state: { tasks: {} },
    });

    assert.equal(res.handled, false);
    assert.equal(sent.length, 0);
    assert.equal(providerStub.getDistillModel(), 'haiku');
  });
});

describe('daemon-admin-commands /engine', () => {
  it('updates bound agent engine/model when switching engine inside a bound chat', async (t) => {
    const sent = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-engine-cmd-'));
    t.after(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    const configFile = path.join(tmpDir, 'daemon.yaml');
    const yaml = require('js-yaml');
    const initial = {
      feishu: {
        chat_agent_map: {
          'chat-personal': 'personal',
        },
      },
      projects: {
        personal: {
          name: '小美',
          engine: 'claude',
          model: 'sonnet',
        },
      },
      daemon: {
        models: {
          codex: 'gpt-5.4',
        },
      },
    };
    fs.writeFileSync(configFile, yaml.dump(initial), 'utf8');
    const providerStub = {
      getActiveName: () => 'anthropic',
      setActive: () => { throw new Error('missing openai'); },
      getDistillModel: () => 'gpt-5.1-codex-mini',
      setDistillModel: () => {},
      setEngine: () => {},
    };
    const loadCfg = () => yaml.load(fs.readFileSync(configFile, 'utf8')) || {};
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        yaml,
        CONFIG_FILE: configFile,
        providerMod: providerStub,
        loadConfig: loadCfg,
        writeConfigSafe: (cfg) => fs.writeFileSync(configFile, yaml.dump(cfg), 'utf8'),
        getDefaultEngine: () => 'claude',
        setDefaultEngine: () => {},
        getDistillModel: () => 'gpt-5.1-codex-mini',
      }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'chat-personal',
      text: '/engine codex',
      config: loadCfg(),
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    const nextCfg = loadCfg();
    assert.equal(nextCfg.projects.personal.engine, 'codex');
    assert.equal(nextCfg.projects.personal.model, 'gpt-5.4');
    assert.match(sent[0], /已同步当前 Agent: personal/);
    assert.match(sent[0], /Codex 认证: 使用 `codex login` 或 OPENAI_API_KEY/);
    assert.doesNotMatch(sent[0], /Provider: anthropic/);
  });

  it('shows effective bound agent engine in /engine status', async () => {
    const sent = [];
    const cfg = {
      feishu: {
        chat_agent_map: {
          'chat-personal': 'personal',
        },
      },
      projects: {
        personal: {
          name: '小美',
          engine: 'claude',
          model: 'sonnet',
        },
      },
      daemon: {
        models: {
          codex: 'gpt-5.4',
        },
      },
    };
    const providerStub = {
      getActiveName: () => 'anthropic',
    };
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        providerMod: providerStub,
        getDefaultEngine: () => 'codex',
        getDistillModel: () => 'gpt-5.1-codex-mini',
      }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'chat-personal',
      text: '/engine',
      config: cfg,
      state: { tasks: {} },
    });

    assert.equal(res.handled, true);
    assert.match(sent[0], /引擎: claude/);
    assert.match(sent[0], /当前 chat 绑定 Agent: personal/);
    assert.match(sent[0], /当前 chat 已绑定 Agent；切换时会同步更新该 Agent 的 engine\/model/);
  });
});

describe('daemon-admin-commands /doctor', () => {
  it('does not fail codex-only environments when default engine is codex', async () => {
    const sent = [];
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        execSync: (cmd) => {
          if (String(cmd).includes('claude')) throw new Error('claude not found');
          if (String(cmd).includes('codex')) return '/usr/local/bin/codex\n';
          return '';
        },
        getDefaultEngine: () => 'codex',
      }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-doctor-1',
      text: '/doctor',
      config: {},
      state: { tasks: {}, budget: { tokens_used: 0 } },
    });

    assert.equal(res.handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /默认引擎: codex/);
    assert.match(sent[0], /Codex CLI/);
    assert.doesNotMatch(sent[0], /默认引擎是 codex，但 Codex CLI 不可用/);
  });

  it('accepts custom model names when using custom provider', async (t) => {
    const sent = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-doctor-cfg-'));
    t.after(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    const configFile = path.join(tmpDir, 'daemon.yaml');
    const yaml = require('js-yaml');
    fs.writeFileSync(configFile, yaml.dump({ daemon: { model: 'gpt-5-mini' } }), 'utf8');
    const providerStub = {
      getActiveName: () => 'relay',
      getDistillModel: () => 'gpt-5.1-codex-mini',
    };
    const { handleAdminCommand } = createHandler(
      () => ({ general: [], project: [] }),
      {
        CONFIG_FILE: configFile,
        providerMod: providerStub,
        yaml,
      }
    );
    const bot = { sendMessage: async (_chatId, text) => { sent.push(String(text)); } };

    const res = await handleAdminCommand({
      bot,
      chatId: 'mobile-user-doctor-2',
      text: '/doctor',
      config: {},
      state: { tasks: {}, budget: { tokens_used: 0 } },
    });

    assert.equal(res.handled, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /✅ 模型: gpt-5-mini/);
    assert.match(sent[0], /✅ Provider: relay \(custom\)/);
    assert.doesNotMatch(sent[0], /模型: gpt-5-mini \(无效\)/);
  });
});

describe('daemon-admin-commands /mentor', () => {
  it('toggles mentor and adjusts level/mode', async (t) => {
    const sent = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-mentor-cmd-'));
    t.after(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
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
  });

  it('clears mentor runtime and hides historical status when turned off', async (t) => {
    const sent = [];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-mentor-off-'));
    const runtimeFile = path.join(tmpDir, 'mentor_runtime.json');
    const configFile = path.join(tmpDir, 'daemon.yaml');
    const prevRuntimeEnv = process.env.METAME_MENTOR_RUNTIME;
    const yaml = require('js-yaml');

    t.after(() => {
      if (prevRuntimeEnv === undefined) delete process.env.METAME_MENTOR_RUNTIME;
      else process.env.METAME_MENTOR_RUNTIME = prevRuntimeEnv;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    process.env.METAME_MENTOR_RUNTIME = runtimeFile;
    fs.writeFileSync(runtimeFile, JSON.stringify({
      emotion_breaker_until: Date.now() + 60000,
      debts: [{ project_id: 'proj_x', topic: 'old', expires_at: Date.now() + 60000 }],
      last_fatigue_alert: Date.now(),
      last_pattern_check: Date.now(),
    }, null, 2), 'utf8');
    fs.writeFileSync(configFile, yaml.dump({
      daemon: { model: 'opus', mentor: { enabled: true, friction_level: 5, mode: 'active' } },
    }), 'utf8');

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
      bot, chatId: 'mobile-user-mentor-off', text: '/mentor off', config: {}, state: { tasks: {}, budget: { tokens_used: 0 } },
    });
    assert.equal(res.handled, true);
    assert.match(sent[sent.length - 1], /disabled/i);

    res = await handleAdminCommand({
      bot, chatId: 'mobile-user-mentor-off', text: '/mentor status', config: {}, state: { tasks: {}, budget: { tokens_used: 0 } },
    });
    assert.equal(res.handled, true);
    assert.match(sent[sent.length - 1], /Mentor: OFF/);
    assert.match(sent[sent.length - 1], /Debts: 0/);
    assert.match(sent[sent.length - 1], /Emotion cooldown: 0s/);

    const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    assert.deepEqual(runtime.debts, []);
    assert.equal(runtime.emotion_breaker_until, null);
    assert.equal(runtime.last_fatigue_alert, null);
    assert.equal(runtime.last_pattern_check, null);
  });
});
