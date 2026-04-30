'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withFreshMemoryHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-recall-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  delete require.cache[require.resolve('./memory')];
  delete require.cache[require.resolve('./memory-wiki-schema')];
  delete require.cache[require.resolve('./memory-recall')];
  const memory = require('./memory');
  const { assembleRecallContext } = require('./memory-recall');
  return Promise.resolve()
    .then(() => fn(memory, assembleRecallContext))
    .finally(() => {
      try { memory.forceClose(); } catch { /* ignore */ }
      process.env.HOME = prevHome;
      delete require.cache[require.resolve('./memory')];
      delete require.cache[require.resolve('./memory-wiki-schema')];
      delete require.cache[require.resolve('./memory-recall')];
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

const TRUE_PLAN = (overrides = {}) => ({
  shouldRecall: true,
  reason: 'explicit-history',
  anchors: ['file:scripts/memory.js', 'fn:saveFacts'],
  modes: ['facts', 'sessions', 'wiki', 'working'],
  hintBudget: 1600,
  ...overrides,
});

const SCOPE = { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' };

test('assembleRecallContext: shouldRecall=false → empty result', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    const result = await assembleRecallContext({
      plan: { shouldRecall: false, reason: '', anchors: [], modes: [], hintBudget: 0 },
      scope: SCOPE,
    });
    assert.equal(result.text, '');
    assert.deepEqual(result.sources, []);
    assert.equal(result.truncated, false);
    assert.equal(result.recallMeta, null);
    assert.equal(result.wikiDropped, false);
  });
});

test('assembleRecallContext: missing plan → empty result', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    const result = await assembleRecallContext({});
    assert.equal(result.text, '');
    assert.equal(result.recallMeta, null);
  });
});

test('assembleRecallContext: empty DB → empty result with wikiDropped=false', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    const result = await assembleRecallContext({ plan: TRUE_PLAN(), scope: SCOPE });
    assert.equal(result.text, '');
    assert.equal(result.recallMeta, null);
  });
});

test('assembleRecallContext: facts mode populates from active memory_items', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    memory.saveMemoryItem({
      id: 'mi_recall_fact_1',
      kind: 'convention',
      state: 'active',
      title: 'saveFacts · location',
      content: 'saveFacts lives in scripts memory module',
      project: 'metame',
      scope: 'main',
    });
    // Anchors match the indexed content terms.
    const plan = TRUE_PLAN({ anchors: ['fn:saveFacts'], modes: ['facts'] });
    const result = await assembleRecallContext({ plan, scope: SCOPE });
    assert.notEqual(result.text, '', 'recall block should not be empty');
    assert.match(result.text, /\[Recall context:[\s\S]*Facts:/);
    assert.ok(result.breakdown.facts > 0);
    assert.equal(result.wikiDropped, false);
    assert.equal(result.recallMeta.modes.length, 1);
  });
});

test('assembleRecallContext: forces trackSearch=false (no search_count bump on facts)', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    memory.saveMemoryItem({
      id: 'mi_track_1',
      kind: 'convention',
      state: 'active',
      title: 'tracked',
      content: 'archiveItem invariant',
      project: 'metame',
      scope: 'main',
    });
    const before = memory.searchMemoryItems('archiveItem', { trackSearch: false });
    await assembleRecallContext({ plan: TRUE_PLAN({ modes: ['facts'] }), scope: SCOPE });
    const after = memory.searchMemoryItems('archiveItem', { trackSearch: false });
    // search_count delta must be 0 across all rows.
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      assert.equal(after[i].search_count, before[i].search_count, 'recall must not bump search_count');
    }
  });
});

test('assembleRecallContext: wikiDropped=true when FTS hits but topic_tags do not overlap scope', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    // Force memory.js to open + apply schema.
    memory.acquire();
    // Now insert wiki page via the same DB path. saveFacts content includes
    // the anchor term so FTS will match.
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(process.env.HOME, '.metame', 'memory.db');
    const aux = new DatabaseSync(dbPath);
    aux.prepare(
      `INSERT INTO wiki_pages (id, slug, title, content, primary_topic, topic_tags) VALUES ('wp_recall_1','recall-test','saveFacts behavior','saveFacts and other helpers live in scripts','testing','["unrelated-tag","other-tag"]')`
    ).run();
    aux.close();

    const result = await assembleRecallContext({
      plan: TRUE_PLAN({ anchors: ['fn:saveFacts'], modes: ['wiki'] }),
      scope: SCOPE,
    });
    // FTS finds the page; topic_tags don't overlap scope → wikiDropped=true.
    assert.equal(result.wikiDropped, true);
  });
});

test('assembleRecallContext: wiki tier kept when topic_tags overlap', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    memory.acquire();
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(process.env.HOME, '.metame', 'memory.db');
    const aux = new DatabaseSync(dbPath);
    aux.prepare(
      `INSERT INTO wiki_pages (id, slug, title, content, primary_topic, topic_tags) VALUES ('wp_recall_2','recall-test-2','saveFacts location','saveFacts is in memory.js','testing','["metame","jarvis"]')`
    ).run();
    aux.close();

    const result = await assembleRecallContext({
      plan: TRUE_PLAN({ anchors: ['fn:saveFacts'], modes: ['wiki'] }),
      scope: SCOPE,
    });
    // overlap exists ("metame" is in scope.project) → wikiDropped=false.
    assert.equal(result.wikiDropped, false);
  });
});

test('assembleRecallContext: working mode populates from working memory file', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    // Write a working memory file for the agent.
    const dir = path.join(process.env.HOME, '.metame', 'memory', 'now');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jarvis.md'), 'current task: review PR1\n\nwip: assemble recall context\n\nblocked: nothing\n');

    const result = await assembleRecallContext({
      plan: TRUE_PLAN({ modes: ['working'] }),
      scope: SCOPE,
    });
    assert.notEqual(result.text, '');
    assert.match(result.text, /Working memory:/);
    assert.ok(result.breakdown.working > 0);
  });
});

test('assembleRecallContext: recallMeta carries plan + breakdown but no raw transcripts', async () => {
  await withFreshMemoryHome(async (memory, assembleRecallContext) => {
    memory.saveMemoryItem({
      id: 'mi_meta_1',
      kind: 'insight',
      state: 'active',
      title: 'saveFacts decision',
      content: 'saveFacts decision rationale captured here',
      project: 'metame',
      scope: 'main',
    });
    const plan = TRUE_PLAN({ anchors: ['fn:saveFacts'], modes: ['facts'] });
    const result = await assembleRecallContext({ plan, scope: SCOPE });
    assert.ok(result.recallMeta, 'recallMeta should not be null when results found');
    assert.equal(result.recallMeta.reason, plan.reason);
    assert.deepEqual(result.recallMeta.anchors, plan.anchors);
    assert.deepEqual(result.recallMeta.modes, ['facts']);
    assert.ok(typeof result.recallMeta.totalUsed === 'number');
    assert.ok(typeof result.recallMeta.chars === 'number');
  });
});

test('assembleRecallContext: search/budget/format module isolation (no daemon imports)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'memory-recall.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['./daemon-claude-engine', './daemon-prompt-context', './intent-registry', './hooks/intent-memory-recall']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*\\)`);
    assert.doesNotMatch(code, re, `memory-recall must not require ${banned}`);
  }
});
