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
    recordAudit: () => () => {},
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
    assert.deepEqual(names, ['agent_context', 'memory_feedback', 'memory_get', 'memory_recall', 'memory_search', 'memory_write', 'profile_get', 'skill_get', 'skill_list']);
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
  it('memory_search reuses hybrid facts/wiki search with typed budgeted results', async () => {
    let seen = null;
    const audits = [];
    const deps = tempDeps({
      memory: () => ({
        hybridSearchWiki: async (q, opts) => {
          seen = { q, opts };
          return {
            facts: [{ id: '1', title: 'A.b', content: 'current config', project: 'metame' }],
            wikiPages: [{ slug: 'config', title: 'Config guide', excerpt: 'How config works', project_key: 'metame' }],
          };
        },
      }),
      recordAudit: () => row => audits.push(row),
    });
    const out = await callTool('memory_search', { query: 'daemon', limit: 999, project: 'MetaMe', host: 'codex' }, deps);
    assert.equal(seen.q, 'daemon');
    assert.equal(seen.opts.trackSearch, false, 'external reads must not inflate promotion counters');
    assert.deepEqual(seen.opts.scopeKeys, ['metame']);
    assert.deepEqual(out.results.map(item => item.type), ['fact', 'wiki']);
    assert.match(out.trace_id, /^mcp_/);
    assert.equal(audits.length, 2, 'each delivered asset has one auditable event');
    assert.equal(audits[0].consumer_stage, 'delivered');
    assert.equal(audits[0].engine, 'codex');
    assert.deepEqual(audits.map(row => row.source_refs), [['fact:1'], ['wiki:config']]);
  });

  it('memory_search does not record a delivery for an empty result', async () => {
    const audits = [];
    const deps = tempDeps({
      memory: () => ({ hybridSearchWiki: async () => ({ facts: [], wikiPages: [] }) }),
      recordAudit: () => row => audits.push(row),
    });
    const out = await callTool('memory_search', { query: 'nothing' }, deps);
    assert.deepEqual(out.results, []);
    assert.deepEqual(audits, []);
  });

  it('memory_get opens one active asset and records opened audit', async () => {
    const audits = [];
    const deps = tempDeps({
      memory: () => ({ getCognitiveAsset: () => ({ type: 'fact', id: 'f1', content: 'detail' }) }),
      recordAudit: () => row => audits.push(row),
    });
    const out = await callTool('memory_get', { type: 'fact', id: 'f1', trace_id: 'trace-1' }, deps);
    assert.equal(out.found, true);
    assert.equal(out.asset.content, 'detail');
    assert.equal(audits[0].consumer_stage, 'opened');
    assert.equal(audits[0].trace_id, 'trace-1');
  });

  it('memory_get does not let best-effort audit loss block a delivered asset', async () => {
    const deps = tempDeps({
      memory: () => ({ getCognitiveAsset: () => ({ type: 'fact', id: 'f1', content: 'detail' }) }),
      recordAudit: () => () => {},
    });
    const out = await callTool('memory_get', { type: 'fact', id: 'f1', trace_id: 'trace-with-dropped-audit' }, deps);
    assert.equal(out.found, true);
  });

  it('memory_get exposes fact history only when explicitly requested', async () => {
    let options = null;
    const deps = tempDeps({
      memory: () => ({
        getCognitiveAsset: (type, id, received) => {
          options = received;
          return { type: 'fact_history', requested_id: id, versions: [{ id: 'old' }, { id: 'new' }] };
        },
      }),
    });
    const out = await callTool('memory_get', { type: 'fact', id: 'new', history: true, trace_id: 'trace-history' }, deps);
    assert.equal(options.history, true);
    assert.deepEqual(out.asset.versions.map(item => item.id), ['old', 'new']);
  });

  it('memory_recall treats an explicit MCP call as demand', async () => {
    let seenPlan = null;
    const deps = tempDeps({
      planRecall: () => () => ({ shouldRecall: false }),
      assembleRecallContext: () => async ({ plan }) => {
        seenPlan = plan;
        return { text: '[Recall context: prior decision]', sources: [] };
      },
    });
    const explicit = await callTool('memory_recall', { text: 'ordinary search terms' }, deps);
    assert.equal(explicit.recalled, true);
    assert.equal(seenPlan.reason, 'explicit-mcp');

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

  it('memory_feedback records applied/validated evidence without content', async () => {
    const audits = [];
    const deps = tempDeps({ recordAudit: () => row => audits.push(row) });
    const out = await callTool('memory_feedback', {
      trace_id: 'trace-1', stage: 'validated', asset_ids: ['fact:f1'], outcome: 'used', evidence: 'tests-passed',
    }, deps);
    assert.equal(out.recorded, true);
    assert.equal(audits[0].consumer_stage, 'validated');
    assert.deepEqual(audits[0].source_refs, ['fact:f1']);
    assert.equal(audits[0].evidence_class, 'tests-passed');
  });

  it('skill_list/skill_get read the skills directory and sanitize names', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skills-'));
    fs.mkdirSync(path.join(dir, 'demo-skill'));
    fs.writeFileSync(path.join(dir, 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill for unit tests of the MCP surface.\n---\n\n# Demo\nBody.\n', 'utf8');
    fs.mkdirSync(path.join(dir, '_drafts'));
    const audits = [];
    const deps = tempDeps({ skillsDir: dir, recordAudit: () => row => audits.push(row) });

    const list = await callTool('skill_list', {}, deps);
    assert.equal(list.skills.length, 1, 'draft/underscore dirs excluded');
    assert.equal(list.skills[0].name, 'demo-skill');
    assert.match(list.skills[0].description, /demo skill/i);
    assert.match(list.trace_id, /^mcp_/);
    assert.deepEqual(audits[0].source_refs, ['skill:demo-skill']);

    const got = await callTool('skill_get', { name: 'demo-skill', trace_id: list.trace_id }, deps);
    assert.match(got.content, /# Demo/);
    assert.equal(audits[1].consumer_stage, 'opened');
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
