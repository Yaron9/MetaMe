'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgentTools } = require('./daemon-agent-tools');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createHarness(initialConfig = {}, { home } = {}) {
  let config = clone(initialConfig);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-tools-'));
  const harnessHome = home || os.homedir();
  const expandPath = (input) => String(input || '').replace(/^~(?=\/|$)/, harnessHome);
  const normalizeCwd = (input) => path.resolve(expandPath(input));

  const tools = createAgentTools({
    fs,
    path,
    HOME: harnessHome,
    loadConfig: () => clone(config),
    writeConfigSafe: (next) => { config = clone(next); },
    backupConfig: () => {},
    normalizeCwd,
    expandPath,
    spawnClaudeAsync: async () => ({ output: 'ok', error: null }),
  });

  return {
    tools,
    tempRoot,
    getConfig: () => clone(config),
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
  };
}

describe('daemon-agent-tools engine persistence', () => {
  it('writes engine=codex when creating codex agent', async () => {
    const h = createHarness({ projects: {} });
    try {
      const workspace = path.join(h.tempRoot, 'codex-reviewer');
      fs.mkdirSync(workspace, { recursive: true });

      const res = await h.tools.createNewWorkspaceAgent(
        'codex reviewer',
        workspace,
        '',
        'oc_chat_1',
        { skipChatBinding: true, engine: 'codex' }
      );

      assert.equal(res.ok, true);
      const cfg = h.getConfig();
      assert.equal(cfg.projects.codex_reviewer.engine, 'codex');
      assert.equal(cfg.projects.codex_reviewer.agent_id, 'codex_reviewer');
      assert.equal(fs.existsSync(path.join(workspace, 'SOUL.md')), true);
      assert.equal(fs.existsSync(path.join(workspace, 'MEMORY.md')), true);
    } finally {
      h.cleanup();
    }
  });

  it('does not write engine field for default claude agent', async () => {
    const h = createHarness({ projects: {} });
    try {
      const workspace = path.join(h.tempRoot, 'default-reviewer');
      fs.mkdirSync(workspace, { recursive: true });

      const res = await h.tools.createNewWorkspaceAgent(
        'default reviewer',
        workspace,
        '',
        'oc_chat_2',
        { skipChatBinding: true }
      );

      assert.equal(res.ok, true);
      const cfg = h.getConfig();
      assert.equal(Object.prototype.hasOwnProperty.call(cfg.projects.default_reviewer, 'engine'), false);
      assert.equal(cfg.projects.default_reviewer.agent_id, 'default_reviewer');
    } finally {
      h.cleanup();
    }
  });

  it('keeps default claude path on bind without engine', async () => {
    const h = createHarness({ projects: {} });
    try {
      const workspace = path.join(h.tempRoot, 'bind-default');
      fs.mkdirSync(workspace, { recursive: true });

      const res = await h.tools.bindAgentToChat('oc_chat_3', 'bind default', workspace);

      assert.equal(res.ok, true);
      const cfg = h.getConfig();
      assert.equal(Object.prototype.hasOwnProperty.call(cfg.projects.bind_default, 'engine'), false);
      assert.equal(cfg.projects.bind_default.agent_id, 'bind_default');
    } finally {
      h.cleanup();
    }
  });

  it('writes engine=codex on bind when requested', async () => {
    const h = createHarness({ projects: {} });
    try {
      const workspace = path.join(h.tempRoot, 'bind-codex');
      fs.mkdirSync(workspace, { recursive: true });

      const res = await h.tools.bindAgentToChat('oc_chat_4', 'bind codex', workspace, { engine: 'codex' });

      assert.equal(res.ok, true);
      const cfg = h.getConfig();
      assert.equal(cfg.projects.bind_codex.engine, 'codex');
      assert.equal(cfg.projects.bind_codex.agent_id, 'bind_codex');
    } finally {
      h.cleanup();
    }
  });
});

describe('daemon-agent-tools default workspace derivation', () => {
  it('createNewWorkspaceAgent (skipChatBinding) auto-derives ~/AGI/<name>/ when path omitted', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fakehome-'));
    const h = createHarness({ projects: {} }, { home: fakeHome });
    try {
      const res = await h.tools.createNewWorkspaceAgent(
        'auto agent unit',
        '',                       // <-- no workspaceDir given
        '',
        'oc_chat_auto',
        { skipChatBinding: true }
      );
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const expectedDir = path.join(fakeHome, 'AGI', 'auto agent unit');
      assert.equal(fs.existsSync(expectedDir), true);
      assert.equal(fs.statSync(expectedDir).isDirectory(), true);
      const cfg = h.getConfig();
      assert.equal(cfg.projects.auto_agent_unit.cwd, expectedDir);
    } finally {
      h.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('bindAgentToChat auto-derives default dir when workspace omitted', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fakehome-'));
    const h = createHarness({ projects: {} }, { home: fakeHome });
    try {
      const res = await h.tools.bindAgentToChat('oc_chat_bind_auto', 'auto bind unit', '');
      assert.equal(res.ok, true, `expected ok, got error: ${res.error}`);
      const expectedDir = path.join(fakeHome, 'AGI', 'auto bind unit');
      assert.equal(fs.existsSync(expectedDir), true);
      assert.equal(res.data.cwd, expectedDir);
    } finally {
      h.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('rejects user-supplied path that does not exist (no auto-mkdir for typos)', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-fakehome-'));
    const h = createHarness({ projects: {} }, { home: fakeHome });
    try {
      const typoPath = path.join(fakeHome, 'totally', 'not', 'there');
      const res = await h.tools.bindAgentToChat('oc_chat_typo', 'typo', typoPath);
      assert.equal(res.ok, false);
      assert.match(res.error, /not found/);
    } finally {
      h.cleanup();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
