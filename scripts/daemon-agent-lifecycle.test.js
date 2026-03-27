'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  completeAgentCreation,
    resolveCloneParentCwd,
  startNewAgentWizard,
    resetAgentRoleSection,
    readAgentRolePreview,
} = require('./daemon-agent-lifecycle');

describe('daemon-agent-lifecycle helpers', () => {
  it('resolves clone parent cwd from the current bound chat', () => {
    const cwd = resolveCloneParentCwd({
      isClone: true,
      chatId: 'chat-1',
      loadConfig: () => ({
        feishu: { chat_agent_map: { 'chat-1': 'metame' } },
        projects: { metame: { cwd: '/repo/main' } },
      }),
      normalizeCwd: (value) => path.resolve(String(value || '')),
    });

    assert.equal(cwd, path.resolve('/repo/main'));
  });

  it('resets only the agent role section from CLAUDE.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-'));
    const cwd = path.join(dir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      '# Title\n\n## Agent 角色\n你是测试 Agent\n\n## Other\n保留\n',
      'utf8'
    );

    const result = resetAgentRoleSection({ fs, path, cwd });

    assert.equal(result.status, 'reset');
    assert.equal(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), '# Title\n\n## Other\n保留\n');
  });

  it('resets broader role-related headings instead of only a literal section title', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-role-'));
    const cwd = path.join(dir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'CLAUDE.md'),
      '# Title\n\n## 当前职责\n负责代码审查\n\n## Other\n保留\n',
      'utf8'
    );

    const result = resetAgentRoleSection({ fs, path, cwd });

    assert.equal(result.status, 'reset');
    assert.equal(fs.readFileSync(path.join(cwd, 'CLAUDE.md'), 'utf8'), '# Title\n\n## Other\n保留\n');
  });

  it('truncates CLAUDE.md previews for edit flows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-preview-'));
    const cwd = path.join(dir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'a'.repeat(600), 'utf8');

    const preview = readAgentRolePreview({ fs, path, cwd });
    assert.match(preview, /\.\.\.\(已截断\)$/);
    assert.ok(preview.length < 520);
  });

  it('stamps team wizard flows so command TTL handling can expire them', async () => {
    const pendingTeamFlows = new Map();
    const sent = [];

    await startNewAgentWizard({
      bot: { sendMessage: async (_chatId, text) => sent.push(String(text)) },
      chatId: 'chat-1',
      secondArg: 'team',
      pendingTeamFlows,
      pendingAgentFlows: new Map(),
      loadConfig: () => ({ projects: {} }),
      normalizeCwd: (value) => value,
      sendBrowse: async () => {},
      HOME: os.homedir(),
    });

    assert.equal(typeof pendingTeamFlows.get('chat-1').__ts, 'number');
    assert.match(sent[0], /团队创建向导/);
  });

  it('uses unified workspace creation when available for normal /agent new', async () => {
    const sent = [];
    const calls = [];

    await completeAgentCreation({
      bot: { sendMessage: async (_chatId, text) => sent.push(String(text)) },
      chatId: 'chat-1',
      flow: { dir: '/repo/main', name: 'MetaMe', isClone: false, parentCwd: null },
      description: '负责代码审查',
      createWorkspaceAgent: async (input) => {
        calls.push(input);
        return { ok: true, data: { role: { created: true } } };
      },
      doBindAgent: async () => { throw new Error('should not use legacy bind'); },
      mergeAgentRole: async () => { throw new Error('should not use legacy merge'); },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentName, 'MetaMe');
    assert.match(sent[sent.length - 1], /创建完成/);
  });

  it('inherits parent context by reference for clone instead of expanding parent content into child CLAUDE.md', async () => {
    const sent = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-clone-'));
    const parentCwd = path.join(dir, 'parent');
    const childCwd = path.join(dir, 'child');
    fs.mkdirSync(parentCwd, { recursive: true });
    fs.mkdirSync(childCwd, { recursive: true });
    fs.writeFileSync(path.join(parentCwd, 'CLAUDE.md'), '@SOUL.md\n\n## Agent 角色\n父 Agent 设定\n', 'utf8');
    fs.writeFileSync(path.join(parentCwd, 'SOUL.md'), '# Soul\n父 Soul\n', 'utf8');
    fs.writeFileSync(path.join(childCwd, 'SOUL.md'), '# Soul\n子 Soul\n', 'utf8');

    await completeAgentCreation({
      bot: { sendMessage: async (_chatId, text) => sent.push(String(text)) },
      chatId: 'chat-1',
      flow: { dir: childCwd, name: 'Clone', isClone: true, parentCwd },
      description: '专注 Codex 执行',
      createWorkspaceAgent: async (input) => {
        assert.equal(input.roleDescription, '');
        return { ok: true, data: {} };
      },
      doBindAgent: async () => { throw new Error('should not use legacy bind'); },
      mergeAgentRole: async () => { throw new Error('should not use legacy merge'); },
    });

    const childClaude = fs.readFileSync(path.join(childCwd, 'CLAUDE.md'), 'utf8');
    const childSoul = fs.readFileSync(path.join(childCwd, 'SOUL.md'), 'utf8');
    assert.equal(childClaude, '@SOUL.md\n\n## Agent 角色\n父 Agent 设定\n');
    assert.equal(childSoul, '# Soul\n父 Soul\n');
    assert.match(sent[sent.length - 1], /已继承父 Agent 上下文/);
    assert.match(sent[sent.length - 1], /含 Soul/);
  });
});
