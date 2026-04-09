'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createAgentId,
  ensureAgentLayer,
  ensureClaudeMdSoulImport,
  repairAgentLayer,
  buildAgentContextForEngine,
  buildMemorySnapshotContent,
  selectSnapshotContext,
  refreshMemorySnapshot,
} = require('./agent-layer');

describe('agent-layer', () => {
  it('creates stable agent metadata and project views', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-workspace-'));

    try {
      const agentId = createAgentId({ projectKey: 'review_bot', agentName: 'Review Bot' });
      const result = ensureAgentLayer({
        agentId,
        projectKey: 'review_bot',
        agentName: 'Review Bot',
        workspaceDir: workspace,
        engine: 'codex',
        aliases: ['reviewer'],
        homeDir: home,
      });

      assert.equal(result.agentId, 'review_bot');
      assert.equal(fs.existsSync(result.paths.yaml), true);
      assert.equal(fs.existsSync(result.paths.soul), true);
      assert.equal(fs.existsSync(result.paths.memory), true);
      assert.equal(fs.existsSync(path.join(workspace, 'SOUL.md')), true);
      assert.equal(fs.existsSync(path.join(workspace, 'MEMORY.md')), true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('ensureClaudeMdSoulImport prepends @SOUL.md to existing CLAUDE.md', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-workspace-'));
    try {
      const claudeMd = path.join(workspace, 'CLAUDE.md');

      // No CLAUDE.md → skipped (not created)
      assert.equal(ensureClaudeMdSoulImport(workspace), 'skipped');
      assert.equal(fs.existsSync(claudeMd), false);

      // CLAUDE.md exists without @SOUL.md → prepended
      fs.writeFileSync(claudeMd, '# Project Instructions\n\nDo stuff.', 'utf8');
      assert.equal(ensureClaudeMdSoulImport(workspace), 'prepended');
      const content = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(content.startsWith('@SOUL.md'), 'CLAUDE.md must start with @SOUL.md');
      assert.match(content, /# Project Instructions/);

      // Second call → idempotent
      assert.equal(ensureClaudeMdSoulImport(workspace), 'already-present');
      assert.equal(fs.readFileSync(claudeMd, 'utf8'), content, 'file must not change on second call');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('ensureAgentLayer prepends @SOUL.md to existing CLAUDE.md in workspace', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-workspace-'));
    try {
      // Pre-create CLAUDE.md (simulates existing project)
      fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Role\n\nBe helpful.', 'utf8');

      ensureAgentLayer({
        agentId: 'helper',
        projectKey: 'helper',
        agentName: 'Helper',
        workspaceDir: workspace,
        engine: 'claude',
        homeDir: home,
      });

      const content = fs.readFileSync(path.join(workspace, 'CLAUDE.md'), 'utf8');
      assert.ok(content.startsWith('@SOUL.md'), 'CLAUDE.md must start with @SOUL.md after ensureAgentLayer');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('both engines: agentHint contains memory only, never soul', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-home-'));
    try {
      const result = ensureAgentLayer({
        agentId: 'researcher',
        projectKey: 'researcher',
        agentName: 'Researcher',
        engine: 'claude',
        homeDir: home,
      });
      fs.writeFileSync(result.paths.soul, '# Soul\nResearch mode', 'utf8');
      fs.writeFileSync(result.paths.memory, '# Memory Snapshot\nLong-term focus', 'utf8');

      for (const engine of ['claude', 'codex']) {
        const ctx = buildAgentContextForEngine({ agent_id: 'researcher' }, engine, home);
        assert.equal(ctx.soul, '', `${engine}: soul must be empty in agentHint (loaded via CLAUDE.md/@SOUL.md or AGENTS.md)`);
        assert.match(ctx.hint, /Agent memory snapshot/, `${engine}: memory must be in hint`);
        assert.match(ctx.hint, /Long-term focus/, `${engine}: memory content must be present`);
        assert.doesNotMatch(ctx.hint, /Research mode/, `${engine}: soul must NOT appear in agentHint`);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('repairAgentLayer is idempotent and creates soul layer for legacy projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-workspace-'));
    try {
      const project = { cwd: workspace, name: 'Legacy Agent' };
      const result = repairAgentLayer('legacy_agent', project, home);

      assert.ok(result, 'repairAgentLayer must return a result');
      assert.equal(result.agentId, 'legacy_agent');
      assert.equal(fs.existsSync(result.paths.soul), true);
      assert.equal(fs.existsSync(result.paths.memory), true);
      assert.equal(fs.existsSync(path.join(workspace, 'SOUL.md')), true);
      assert.equal(fs.existsSync(path.join(workspace, 'MEMORY.md')), true);

      // Second call must not overwrite existing soul
      fs.writeFileSync(result.paths.soul, '# Custom Soul', 'utf8');
      repairAgentLayer('legacy_agent', project, home);
      assert.equal(fs.readFileSync(result.paths.soul, 'utf8'), '# Custom Soul');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('buildMemorySnapshotContent and refreshMemorySnapshot update the file', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-agent-home-'));
    try {
      const result = ensureAgentLayer({
        agentId: 'snapshot_test',
        projectKey: 'snapshot_test',
        agentName: 'SnapshotTest',
        engine: 'claude',
        homeDir: home,
      });

      const sessions = [{ created_at: '2025-01-01', summary: 'Worked on feature X', keywords: 'feature' }];
      const facts = [{ relation: 'prefers', value: 'TypeScript' }];
      const content = buildMemorySnapshotContent(sessions, facts);

      assert.match(content, /近期会话摘要/);
      assert.match(content, /Worked on feature X/);
      assert.match(content, /TypeScript/);

      const ok = refreshMemorySnapshot('snapshot_test', content, home);
      assert.equal(ok, true);
      assert.equal(fs.readFileSync(result.paths.memory, 'utf8'), content);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('selectSnapshotContext prefers matching project hints before global fallback', () => {
    const memoryApi = {
      recentSessions({ project }) {
        if (project === 'metame') return [{ created_at: '2025-01-02', summary: 'MetaMe session', keywords: 'metame' }];
        return [];
      },
      recentFacts({ project }) {
        if (project === 'metame') return [{ relation: 'rule', value: 'Prefer scripts/ as source of truth' }];
        return [{ relation: 'global', value: 'fallback should not be used here' }];
      },
    };

    const result = selectSnapshotContext(memoryApi, {
      projectHints: ['metame', 'MetaMe', 'metame_ops'],
      sessionLimit: 5,
      factLimit: 10,
    });

    assert.equal(result.matchedProject, 'metame');
    assert.equal(result.usedFallback, false);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.facts.length, 1);
    assert.match(result.sessions[0].summary, /MetaMe session/);
  });

  it('selectSnapshotContext falls back to global memory when project-scoped recall is empty', () => {
    const memoryApi = {
      recentSessions({ project }) {
        return project ? [] : [{ created_at: '2025-01-03', summary: 'Global session', keywords: 'global' }];
      },
      recentFacts({ project }) {
        return project ? [] : [{ relation: 'fact', value: 'Global fact' }];
      },
    };

    const result = selectSnapshotContext(memoryApi, {
      projectHints: ['metame', 'daemon'],
      sessionLimit: 5,
      factLimit: 10,
    });

    assert.equal(result.matchedProject, null);
    assert.equal(result.usedFallback, true);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.facts.length, 1);
    assert.match(result.facts[0].value, /Global fact/);
  });
});
