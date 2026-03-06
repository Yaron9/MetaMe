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

function createHarness(initialConfig = {}) {
  let config = clone(initialConfig);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-tools-'));
  const expandPath = (input) => String(input || '').replace(/^~(?=\/|$)/, os.homedir());
  const normalizeCwd = (input) => path.resolve(expandPath(input));

  const tools = createAgentTools({
    fs,
    path,
    HOME: os.homedir(),
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
