'use strict';

/**
 * One host-neutral acceptance seam for the cognitive contracts delivered by
 * #24–#28.  Focused tests own edge cases; this fixture only proves that the
 * contracts compose without a Host-specific test harness.
 */

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { applyWikiSchema } = require('./memory-wiki-schema');
const {
  admitClaim, isSynthesisEvidenceEligible, mapClaimStorage, reconcileClaim,
} = require('./core/claim-contract');
const {
  accessIdentity, buildManifest, composeContext, normalizeAccessContext,
  resolveAccessContext, selectManifestEntries,
} = require('./core/context-manifest');
const { deliverProjectContext } = require('./cognitive-context');
const { REQUIRED_TOOLS, inspectCapabilityMatrix, inspectHosts } = require('./core/cognitive-host');
const { createDefaultEngineRegistry, createEngineRegistry } = require('./engines/engine-registry');
const { createEnginePlugin, negotiateCapabilities } = require('./engines/engine-plugin');
const { createExternalAdapterPlugin } = require('./engines/external-adapter-plugin');
const { applyReconcilePlan, main: reconcileMain, readPlanFile } = require('./memory-reconcile');
const { buildReconcilePlan } = require('./core/memory-reconcile');
const { callTool } = require('./metame-mcp-server');
const { exportManagedWikiPage } = require('./wiki-reflect-export');
const { importWikiAnnotation } = require('./wiki-annotation');
const {
  collectMemoryObservability, formatDoctor, formatStatus, runMemoryCommand,
} = require('./memory-observability');
const { validateEvidence } = require('./memory-artifact-projector');

const NOW = '2026-08-10T12:00:00.000Z';
const PROJECT = 'metame';
const SCOPE = 'project';

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureDb() {
  const root = tempRoot('cognitive-quality-');
  const dbPath = path.join(root, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, summary TEXT, confidence REAL,
      project TEXT DEFAULT '*', scope TEXT, task_key TEXT, session_id TEXT,
      agent_key TEXT, canonical_key TEXT, supersedes_id TEXT,
      source_type TEXT, source_id TEXT, origin_class TEXT DEFAULT 'primary',
      provenance_root_id TEXT, relation TEXT, search_count INTEGER DEFAULT 0,
      last_searched_at TEXT, tags TEXT DEFAULT '[]', archive_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  return { root, dbPath, db };
}

function closeFixture(fixture) {
  try { fixture.db.close(); } catch { /* already closed */ }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function insertMemory(db, row) {
  const values = {
    id: row.id,
    kind: row.kind || 'convention', state: row.state || 'candidate',
    title: row.title || row.id, content: row.content || '',
    summary: row.summary || null, confidence: row.confidence ?? 0.7,
    project: row.project ?? PROJECT, scope: row.scope ?? SCOPE,
    task_key: row.task_key || null, session_id: row.session_id || null,
    agent_key: row.agent_key || null, canonical_key: row.canonical_key || null,
    supersedes_id: row.supersedes_id || null,
    source_type: row.source_type || 'fixture', source_id: row.source_id || row.id,
    origin_class: row.origin_class || 'primary', provenance_root_id: row.provenance_root_id || `fixture:${row.id}`,
    relation: row.relation || null, search_count: row.search_count || 0,
    last_searched_at: row.last_searched_at || null,
    tags: typeof row.tags === 'string' ? row.tags : JSON.stringify(row.tags || []),
    archive_reason: row.archive_reason || null,
    created_at: row.created_at || NOW, updated_at: row.updated_at || NOW,
  };
  const columns = Object.keys(values);
  db.prepare(`INSERT INTO memory_items (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
    .run(...columns.map(column => values[column]));
}

function claim(overrides = {}) {
  return {
    lifecycle: 'project', kind: 'convention', canonical_key: 'metame.policy.review',
    project: PROJECT, scope: SCOPE,
    content: 'The project policy requires a review before generated export.',
    state: 'candidate', ...overrides,
  };
}

function access(overrides = {}) {
  return normalizeAccessContext({
    principal: 'fixture:principal', project: PROJECT, agent_id: 'fixture-agent',
    scopes: [SCOPE], host: 'fixture', trust: 'managed', ...overrides,
  });
}

function mcpDeps(overrides = {}) {
  return {
    memory: () => ({ hybridSearchWiki: async () => ({ facts: [], wikiPages: [] }) }),
    planRecall: () => () => ({ shouldRecall: false }),
    assembleRecallContext: () => async () => ({ text: '', sources: [] }),
    writeFact: () => ({ ok: false, errors: ['fixture write disabled'] }),
    recordAudit: () => () => {}, skillsDir: '/nonexistent', agentsDir: '/nonexistent',
    dbPath: '/nonexistent/memory.db', ...overrides,
  };
}

function withFreshMemoryHome(callback) {
  const root = tempRoot('cognitive-legacy-');
  const previousHome = process.env.HOME;
  const memoryPath = require.resolve('./memory');
  process.env.HOME = root;
  delete require.cache[memoryPath];
  const memory = require('./memory');
  try {
    return callback(memory, root);
  } finally {
    try { memory.forceClose(); } catch { /* best effort */ }
    delete require.cache[memoryPath];
    process.env.HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function fixtureCognitiveHost() {
  const report = { host: 'fixture', capabilities: { automatic_context: 'verified' } };
  return createEnginePlugin({
    protocolVersion: 1,
    descriptor: {
      id: 'fixture', displayName: 'Fixture Host', vendor: 'metame-test', executableNames: ['fixture'],
      contextProjection: 'fixture', nativeSessionKind: 'fixture-session', configSchemaVersion: 1,
      capabilities: {
        runtime: { state: 'unsupported' }, sessionSource: { state: 'unsupported' },
        cognitiveHost: { state: 'verified' },
      },
    },
    runtime: null, sessionSource: null,
    cognitiveHost: {
      detect: () => report, inspectCapabilities: () => report,
      planInstall: () => ({ supported: true, mode: 'plan-only' }),
      verify: () => ({ ok: true, host: 'fixture' }),
      projectContext: () => ({ state: 'projected', fingerprint: 'fixture:revision' }),
    },
  });
}

test('cognitive quality is host-neutral across lifecycle, authority, recovery, and limits', async () => {
  const fixture = fixtureDb();
  try {
    // Claim matrix: task/duplicate/conflict/complement/supersession and eligibility.
    const active = claim({ id: 'active', state: 'active' });
    const decisions = [
      reconcileClaim({ content: claim().content, lifecycle: 'task', source_id: 'session-1' }).outcome,
      admitClaim(claim({ title: 'different display title' }), [active]).outcome,
      reconcileClaim(claim({ content: 'A different policy value requires explicit review.' }), [active]).outcome,
      reconcileClaim(claim({ canonical_key: 'metame.policy.other' }), [active]).outcome,
      reconcileClaim(claim({ supersedes_id: 'active', content: 'An explicitly selected replacement policy value.' }), [active], { allowExplicitSupersession: true }).outcome,
    ];
    assert.deepEqual(decisions, ['episode', 'duplicate', 'conflict', 'complementary', 'supersede']);
    const taskStorage = mapClaimStorage({ content: 'session-local instruction', source_id: 'session-1' });
    assert.equal(taskStorage.kind, 'episode');
    assert.equal(isSynthesisEvidenceEligible(taskStorage), false);
    assert.equal(isSynthesisEvidenceEligible({ ...active, origin_class: 'primary' }), true);
    assert.equal(isSynthesisEvidenceEligible({ ...active, state: 'candidate' }), false);

    // Reconcile: dry-run/stage are byte-read-only; apply is exact and stale-safe.
    insertMemory(fixture.db, { id: 'winner', state: 'active', canonical_key: 'metame.policy.review', content: claim().content, created_at: '2026-08-10T00:00:00Z' });
    insertMemory(fixture.db, { id: 'duplicate', canonical_key: 'MetaMe.Policy.Review', content: `  ${claim().content}\r\n`, created_at: '2026-08-10T01:00:00Z' });
    insertMemory(fixture.db, { id: 'conflict', state: 'active', canonical_key: 'metame.policy.review', content: 'A conflicting value is retained for explicit review.', created_at: '2026-08-10T02:00:00Z' });
    fixture.db.prepare(`INSERT INTO knowledge_artifact_registry
      (artifact_id,kind,canonical_key,project_key,status,revision,source_path,content_hash,evidence_membership_hash,generator_version)
      VALUES ('artifact-1','playbook','metame.policy.review','metame','active',1,'capsules/review.md','content','membership','fixture')`).run();
    fixture.db.prepare(`INSERT INTO knowledge_lineage
      (child_kind,child_id,parent_kind,parent_id,transform,role)
      VALUES ('knowledge_artifact','artifact-1','memory_item','duplicate','fixture','evidence')`).run();
    const before = crypto.createHash('sha256').update(fs.readFileSync(fixture.dbPath)).digest('hex');
    const dry = reconcileMain(['--dry-run', '--json'], { dbPath: fixture.dbPath, print: false, now: NOW });
    assert.equal(dry.actions.length, 1);
    assert.equal(dry.summary.semantic_conflict_groups, 1);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture.dbPath)).digest('hex'), before);
    const stagedPath = path.join(fixture.root, 'reconcile-plan.json');
    reconcileMain(['--stage', stagedPath], { dbPath: fixture.dbPath, print: false, now: NOW });
    assert.deepEqual(readPlanFile(stagedPath), JSON.parse(fs.readFileSync(stagedPath, 'utf8')));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(fixture.dbPath)).digest('hex'), before);
    const applied = applyReconcilePlan(fixture.db, readPlanFile(stagedPath), { lockPath: path.join(fixture.root, 'reconcile.lock') });
    assert.deepEqual(applied.archived_ids, ['duplicate']);
    assert.deepEqual({ ...fixture.db.prepare(`SELECT state,supersedes_id,archive_reason FROM memory_items WHERE id='duplicate'`).get() }, {
      state: 'archived', supersedes_id: 'winner', archive_reason: 'reconcile_exact_duplicate',
    });
    assert.equal(fixture.db.prepare(`SELECT status FROM knowledge_artifact_registry WHERE artifact_id='artifact-1'`).get().status, 'stale');
    const stale = fixtureDb();
    try {
      insertMemory(stale.db, { id: 'stale-winner', state: 'active', canonical_key: 'metame.stale', content: 'Stable value.' });
      insertMemory(stale.db, { id: 'stale-duplicate', canonical_key: 'metame.stale', content: 'Stable value.' });
      const plan = buildReconcilePlan(stale.db.prepare('SELECT * FROM memory_items').all(), { now: NOW });
      stale.db.prepare(`UPDATE memory_items SET content='Changed after staging.' WHERE id='stale-duplicate'`).run();
      assert.throws(() => applyReconcilePlan(stale.db, plan, { lockPath: path.join(stale.root, 'stale.lock') }), /stale reconcile precondition/);
      assert.equal(stale.db.prepare(`SELECT state FROM memory_items WHERE id='stale-duplicate'`).get().state, 'candidate');
      assert.equal(stale.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_lineage`).get().n, 0);
    } finally { closeFixture(stale); }

    // Manifest authority/budget and idempotent cold-start delivery.
    const trusted = access();
    const assets = [
      { id: 'policy-1', type: 'policy', status: 'accepted', project: PROJECT, scope: SCOPE, summary: 'Review before export.', updated_at: NOW },
      { id: 'claim-1', type: 'claim', kind: 'convention', state: 'active', canonical_key: 'metame.policy.review', project: PROJECT, scope: SCOPE, content: 'Review before export.', updated_at: NOW },
      { id: 'synthesis-1', type: 'synthesis', kind: 'playbook', status: 'active', project_key: PROJECT, summary: 'Export playbook.', updated_at: NOW },
      { id: 'candidate', type: 'claim', kind: 'convention', state: 'candidate', canonical_key: 'metame.candidate', project: PROJECT, scope: SCOPE, content: 'Candidate.' },
      { id: 'legacy', type: 'claim', kind: 'convention', state: 'active', canonical_key: null, project: PROJECT, scope: SCOPE, content: 'Legacy searchable only.' },
      { id: 'private', type: 'claim', kind: 'convention', state: 'active', canonical_key: 'metame.private', project: PROJECT, scope: 'private', agent_key: 'other-agent', content: 'Private.' },
      { id: 'wrong-project', type: 'claim', kind: 'convention', state: 'active', canonical_key: 'other.rule', project: 'other', scope: SCOPE, content: 'Other project.' },
    ];
    const forged = resolveAccessContext({ trustedContext: trusted, request: { project: 'other', agent_id: 'other-agent', host: 'forged' } });
    const manifest = buildManifest({ assets, access: forged, now: new Date(NOW) });
    assert.equal(manifest.project, PROJECT);
    assert.deepEqual(manifest.entries.map(entry => entry.id), ['policy-1', 'claim-1', 'synthesis-1']);
    assert.ok(manifest.entries.length <= 8 && JSON.stringify(manifest).length <= 1200);
    assert.deepEqual(selectManifestEntries(assets, forged).map(entry => entry.id), manifest.entries.map(entry => entry.id));
    const composed = composeContext({ manifest, jit: [{ text: 'duplicate', source_fingerprint: manifest.entries[0].source_fingerprint }, { text: 'JIT detail', source: { kind: 'fact', id: 'jit-1' } }], totalChars: 4000 });
    assert.deepEqual(composed.jit.map(item => item.text), ['JIT detail']);
    const calls = [];
    const adapter = { projectContext(input) { calls.push(input); return { state: 'projected', fingerprint: `fixture:${input.manifest.revision}` }; } };
    const first = deliverProjectContext({ manifest, access: trusted, adapter, host: 'fixture', nativeSessionId: 'fixture-native-1', phase: 'cold_start', ledger: {}, deliveredAt: NOW });
    const warm = deliverProjectContext({ manifest, access: trusted, adapter, host: 'fixture', nativeSessionId: 'fixture-native-1', phase: 'refresh', ledger: first.ledger, deliveredAt: NOW });
    const next = deliverProjectContext({ manifest, access: trusted, adapter, host: 'fixture', nativeSessionId: 'fixture-native-2', phase: 'cold_start', ledger: warm.ledger, deliveredAt: NOW });
    assert.equal(first.delivered, true); assert.equal(warm.state, 'skipped'); assert.equal(next.delivered, true); assert.equal(calls.length, 2);
    const empty = deliverProjectContext({ assets, access: access({ project: null }), adapter, host: 'fixture', nativeSessionId: 'empty' });
    assert.equal(empty.state, 'empty'); assert.deepEqual(empty.manifest.entries, []); assert.equal(accessIdentity(trusted), accessIdentity(forged));

    // MCP explicit demand, JIT hit, and honest empty output.
    let seenPlan;
    const audits = [];
    const emptyRecall = await callTool('memory_recall', { text: 'explicitly ask for a missing project memory', project: PROJECT, host: 'fixture' }, mcpDeps({
      assembleRecallContext: () => async ({ plan, scope }) => { seenPlan = { plan, scope }; return { text: '', sources: [] }; },
      recordAudit: () => row => audits.push(row),
    }));
    assert.equal(emptyRecall.recalled, true); assert.equal(emptyRecall.reason, 'explicit-mcp'); assert.equal(emptyRecall.context, ''); assert.deepEqual(emptyRecall.sources, []); assert.deepEqual(audits, []);
    assert.equal(seenPlan.plan.reason, 'explicit-mcp'); assert.deepEqual(seenPlan.scope, { project: PROJECT, agentKey: null });
    const jitAudit = [];
    const hit = await callTool('memory_recall', { text: 'explicit project lookup' }, mcpDeps({
      planRecall: () => () => ({ shouldRecall: true, reason: 'anchor-match', modes: ['facts'] }),
      assembleRecallContext: () => async () => ({ text: 'bounded JIT context', sources: [{ type: 'fact', id: 'f1' }], truncated: false }),
      recordAudit: () => row => jitAudit.push(row),
    }));
    assert.equal(hit.context, 'bounded JIT context'); assert.deepEqual(hit.sources, [{ type: 'fact', id: 'f1' }]); assert.equal(jitAudit[0].consumer_stage, 'delivered');

    // Wiki projection/annotation authority and status/doctor result schema.
    fixture.db.prepare(`INSERT INTO wiki_pages (id,slug,title,content,primary_topic,project_key,source_type) VALUES ('page-1','topics/review','Review','generated v1','review','metame','memory')`).run();
    const page = { slug: 'topics/review', title: 'Review', topic_tags: '[]', created_at: NOW, last_built_at: NOW, raw_source_count: 1, staleness: 0, source_type: 'memory', project_key: PROJECT };
    const exported = exportManagedWikiPage(fixture.db, page.slug, page, 'generated v1', fixture.root);
    const original = fs.readFileSync(exported.filePath, 'utf8');
    fs.appendFileSync(exported.filePath, '\nHuman correction stays on disk.\n');
    const notesRoot = tempRoot('cognitive-annotation-');
    try {
      const notesPath = path.join(notesRoot, 'review.notes.md');
      fs.writeFileSync(notesPath, 'Human note: verify generated review.\n', 'utf8');
      assert.equal(importWikiAnnotation({ db: fixture.db, slug: page.slug, fromFile: notesPath }).state, 'pending');
      assert.equal(fixture.db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n, 3);
      assert.equal(exportManagedWikiPage(fixture.db, page.slug, page, 'generated v2', fixture.root).classification, 'conflict');
      assert.equal(fs.readFileSync(exported.filePath, 'utf8'), `${original}\nHuman correction stays on disk.\n`);
      assert.equal(fixture.db.prepare('SELECT content FROM wiki_pages WHERE slug=?').get(page.slug).content, 'generated v1');
    } finally { fs.rmSync(notesRoot, { recursive: true, force: true }); }
    insertMemory(fixture.db, { id: 'status-conflict', state: 'conflict', canonical_key: 'metame.status.conflict', content: 'Unresolved conflict.' });
    fixture.db.prepare(`INSERT INTO wiki_pages (id,slug,title,content,primary_topic,artifact_status) VALUES ('wiki-status','topics/status','Status','conflicted','status','conflict')`).run();
    fixture.db.prepare(`INSERT INTO session_sources (id,engine,engine_id,session_id,native_session_id,source_hash,status) VALUES ('source-1','unknown','unknown','session-1','native-1','hash-1','indexed')`).run();
    fixture.db.prepare(`INSERT INTO extraction_runs (id,session_source_id,pipeline_version,status) VALUES ('run-1','source-1','fixture','completed')`).run();
    fixture.db.prepare(`INSERT INTO recall_audit (id,ts,phase,should_recall,trace_id,source_refs,injected_chars,token_count,consumer_stage,outcome) VALUES ('observe-1',?,'observe',1,'trace-1','[]',0,0,NULL,'unknown'), ('delivery-1',?,'consume',0,'trace-1','["fact:active"]',90,0,'delivered','injected')`).run(NOW, NOW);
    const status = collectMemoryObservability({ dbPath: fixture.dbPath, now: NOW });
    assert.deepEqual(Object.keys(status), ['schema_version', 'window', 'status', 'inventory', 'hygiene', 'recall', 'efficiency', 'pipeline', 'diagnostics']);
    assert.equal(status.schema_version, 1); assert.equal(status.status, 'error'); assert.equal(status.recall.opportunities, 1); assert.equal(status.recall.delivered, 1); assert.equal(status.recall.feedback_coverage, null);
    assert.ok(status.diagnostics.some(item => item.code === 'unresolved_conflicts')); assert.ok(status.diagnostics.some(item => item.code === 'wiki_projection_conflict'));
    const previousExitCode = process.exitCode;
    try {
      const statusCommand = runMemoryCommand('status', ['--json'], { dbPath: fixture.dbPath, print: false, now: NOW });
      const doctorCommand = runMemoryCommand('doctor', ['--json'], { dbPath: fixture.dbPath, print: false, now: NOW });
      assert.deepEqual(statusCommand, status);
      assert.deepEqual(doctorCommand, status);
    } finally { process.exitCode = previousExitCode; }
    assert.deepEqual(collectMemoryObservability({ dbPath: fixture.dbPath, now: NOW }), status); assert.match(formatStatus(status), /audit_rows=2/); assert.match(formatDoctor(status), /wiki_projection_conflict/);

    // Legacy null-key recall remains searchable, but cannot enter new artifacts.
    withFreshMemoryHome(memory => {
      memory.saveMemoryItem({ id: 'legacy-null-key', kind: 'convention', state: 'active', title: 'Legacy searchable policy', content: 'Legacy null-key policy remains searchable for compatibility.', project: PROJECT, scope: SCOPE, canonical_key: null, source_type: 'legacy', source_id: 'legacy-source' });
      const rows = memory.searchMemoryItems('legacy null-key policy', { project: PROJECT, scope: SCOPE, trackSearch: false });
      assert.deepEqual(rows.map(row => row.id), ['legacy-null-key']); assert.equal(isSynthesisEvidenceEligible(rows[0]), false); assert.deepEqual(buildManifest({ assets: rows, access: trusted, now: new Date(NOW) }).entries, []);
      const db = new DatabaseSync(memory.DB_PATH, { readOnly: true });
      try { assert.match(validateEvidence(db, [{ file: 'fixture/legacy.md', meta: { status: 'active' }, validation: { evidenceIds: ['legacy-null-key'] } }])[0].error, /ineligible evidence/); } finally { db.close(); }
    });

    // Capability truth: Claude/Codex are detected here; Pi/agy and external
    // adapters do not gain cognitive authority merely by being executable.
    const home = tempRoot('cognitive-host-matrix-');
    try {
      const cwd = path.join(home, 'project'); fs.mkdirSync(cwd, { recursive: true });
      for (const directory of ['.claude/projects', '.codex', '.pi', '.gemini', '.metame']) fs.mkdirSync(path.join(home, directory), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# fixture context\n', 'utf8'); fs.writeFileSync(path.join(home, 'AGENTS.md'), '# fixture context\n', 'utf8');
      const server = path.join(home, '.metame', 'metame-mcp-server.js'); fs.writeFileSync(server, '// fixture MCP endpoint\n', 'utf8');
      fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { metame: { command: 'node', args: [server] } } }));
      fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[mcp_servers.metame]\ncommand = "node"\nargs = ["${server}"]\n`);
      const hosts = inspectCapabilityMatrix({ fs, home, cwd, registry: createDefaultEngineRegistry({ HOME: home, fs, path }), probeServer: () => ({ reachable: true, tools: REQUIRED_TOOLS }) });
      const byHost = Object.fromEntries(hosts.map(host => [host.host, host]));
      assert.equal(byHost.claude.capabilities.mcp, 'verified'); assert.equal(byHost.codex.capabilities.mcp, 'verified'); assert.equal(byHost.claude.capabilities.automatic_context, 'detected'); assert.equal(byHost.codex.capabilities.automatic_context, 'detected');
      assert.equal(byHost.pi.capabilities.mcp, 'unsupported'); assert.equal(byHost.pi.capabilities.automatic_context, 'unsupported');
      assert.equal(byHost.agy.capabilities.mcp, 'unsupported'); assert.equal(byHost.agy.capabilities.automatic_context, 'unsupported');
      assert.deepEqual(inspectHosts({ registry: createEngineRegistry([fixtureCognitiveHost()]), hosts: ['fixture'] }), [{ host: 'fixture', capabilities: { automatic_context: 'verified' } }]);
      const external = createExternalAdapterPlugin({ projectCwd: cwd, manifest: { protocolVersion: 1, engineId: 'fixture-external', displayName: 'Fixture External Host', vendor: 'metame-test', executable: { path: process.execPath, args: [path.join(__dirname, 'engines', 'fixtures', 'external-adapter-cli.js')] }, allowlistedPaths: [process.execPath], allowedProjects: [cwd], capabilities: { probe: false, run: false, cancel: false, 'session.discover': false, 'session.inspect': false, 'session.read': false, shutdown: false } } });
      assert.deepEqual(negotiateCapabilities(external, ['cognitiveHost']).capabilities.cognitiveHost, { state: 'unsupported', supported: false, available: false });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  } finally { closeFixture(fixture); }
});
