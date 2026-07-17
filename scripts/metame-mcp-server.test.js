'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TOOLS, callTool, handleMessage } = require('./metame-mcp-server');

function tempDeps(overrides = {}) {
  return {
    memory: () => { throw new Error('memory not stubbed'); },
    planRecall: () => { throw new Error('planRecall not stubbed'); },
    assembleRecallContext: () => { throw new Error('assemble not stubbed'); },
    writeFact: () => { throw new Error('writeFact not stubbed'); },
    skillsDir: '/nonexistent',
    agentsDir: '/nonexistent',
    dbPath: '/nonexistent/memory.db',
    ...overrides,
  };
}

describe('metame-mcp-server protocol', () => {
  it('initialize / tools/list follow MCP shape', async () => {
    const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(init.result.serverInfo.name, 'metame');
    assert.ok(init.result.protocolVersion);

    const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = list.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, ['agent_context', 'memory_recall', 'memory_search', 'memory_write', 'profile_get', 'skill_get', 'skill_list']);
    for (const tool of list.result.tools) {
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  it('notifications are silently ignored, unknown methods error', async () => {
    assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
    const bad = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'no/such' });
    assert.equal(bad.error.code, -32601);
  });

  it('unknown tool is a protocol-level error', async () => {
    await assert.rejects(() => callTool('no_such_tool', {}, tempDeps()), /unknown tool/);
  });
});

describe('metame-mcp-server tools', () => {
  it('memory_search wraps searchFactsAsync with clamped limit', async () => {
    let seen = null;
    const deps = tempDeps({
      memory: () => ({
        searchFactsAsync: async (q, opts) => { seen = { q, opts }; return [{ id: '1', entity: 'A.b', relation: 'config_fact', value: 'c' }]; },
      }),
    });
    const out = await callTool('memory_search', { query: 'daemon', limit: 999 }, deps);
    assert.equal(seen.q, 'daemon');
    assert.equal(seen.opts.limit, 20, 'limit must clamp to 20');
    assert.equal(seen.opts.trackSearch, false, 'external reads must not inflate promotion counters');
    assert.equal(out.results.length, 1);
  });

  it('memory_recall returns no-trigger explanation or assembled hint', async () => {
    const deps = tempDeps({
      planRecall: () => () => ({ shouldRecall: false }),
    });
    const miss = await callTool('memory_recall', { text: '你好' }, deps);
    assert.equal(miss.recalled, false);

    const deps2 = tempDeps({
      planRecall: () => () => ({ shouldRecall: true, reason: 'anchor-match', anchors: [], modes: ['facts'] }),
      assembleRecallContext: () => async () => ({ text: '[Recall context: scripts/memory.js …]', sources: ['fact:1'] }),
    });
    const hit = await callTool('memory_recall', { text: '查 scripts/memory.js' }, deps2);
    assert.equal(hit.recalled, true);
    assert.match(hit.context, /Recall context/);
    assert.deepEqual(hit.sources, ['fact:1']);
  });

  it('memory_write tags source mcp and surfaces validation errors', async () => {
    let written = null;
    const deps = tempDeps({ writeFact: () => (args) => { written = args; return { ok: true, result: { saved: 1, skipped: 0 } }; } });
    const ok = await callTool('memory_write', { entity: 'A.b', relation: 'config_fact', value: 'x'.repeat(30) }, deps);
    assert.equal(ok.saved, true);
    assert.equal(written.sourceType, 'mcp');

    const deps2 = tempDeps({ writeFact: () => () => ({ ok: false, errors: ['value too short'] }) });
    const bad = await callTool('memory_write', { entity: 'A', relation: 'config_fact', value: 'short' }, deps2);
    assert.equal(bad.saved, false);
    assert.deepEqual(bad.errors, ['value too short']);
  });

  it('skill_list/skill_get read the skills directory and sanitize names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skills-'));
    fs.mkdirSync(path.join(dir, 'demo-skill'));
    fs.writeFileSync(path.join(dir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill for unit tests of the MCP surface.\n---\n\n# Demo\nBody.\n', 'utf8');
    fs.mkdirSync(path.join(dir, '_drafts'));
    const deps = tempDeps({ skillsDir: dir });

    const list = await callTool('skill_list', {}, deps);
    assert.equal(list.skills.length, 1, 'draft/underscore dirs excluded');
    assert.equal(list.skills[0].name, 'demo-skill');
    assert.match(list.skills[0].description, /demo skill/i);

    const got = await callTool('skill_get', { name: 'demo-skill' }, deps);
    assert.match(got.content, /# Demo/);
    const traversal = await callTool('skill_get', { name: '../etc' }, deps);
    assert.ok(traversal.error, 'path traversal must not resolve');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('agent_context reads soul + snapshot with id sanitization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-agents-'));
    fs.mkdirSync(path.join(dir, 'jia'));
    fs.writeFileSync(path.join(dir, 'jia', 'soul.md'), '# Soul of jia', 'utf8');
    const deps = tempDeps({ agentsDir: dir });

    const ok = await callTool('agent_context', { agent_id: 'jia' }, deps);
    assert.match(ok.soul, /Soul of jia/);
    const missing = await callTool('agent_context', { agent_id: 'nobody' }, deps);
    assert.ok(missing.error);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tools/call wraps handler errors as tool results, not protocol crashes', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'profile_get', arguments: {} } });
    assert.equal(reply.id, 9);
    assert.ok(reply.result, 'DB-missing must degrade to an in-band tool error');
  });
});
