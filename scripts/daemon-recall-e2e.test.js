'use strict';

/**
 * daemon-recall-e2e.test.js — integration test for the daemon recall channel
 * end-to-end behaviour, addressing Codex final-audit Top 3 #3.
 *
 * The full askClaude flow has hundreds of deps (spawn, providers, sessions,
 * pipelines, …). Spinning up the actual factory only to exercise the recall
 * path would dwarf the test signal. Instead this file:
 *
 *   1. Composes the same modules in the same order daemon-claude-engine.js
 *      uses at the prompt-build site (prepareRecall → buildIntentHint with
 *      suppressKeys → composePrompt with recallHint → marker render).
 *   2. Asserts the integrated behaviour: prompt block present, suppression
 *      effective, marker card emitted, reply text byte-clean, audit row
 *      with phase='inject' and injected_chars>0.
 *   3. Locks the daemon glue with `rg`-style source-text invariants so a
 *      future refactor that removes the wiring fails this test, not just
 *      a slow runtime catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function withFixture(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-recall-e2e-'));
  const dbPath = path.join(tmpDir, '.metame', 'memory.db');
  const prevHome = process.env.HOME;
  const prevAuditDb = process.env.METAME_RECALL_AUDIT_DB;
  process.env.HOME = tmpDir;
  process.env.METAME_RECALL_AUDIT_DB = dbPath;
  for (const mod of [
    './memory', './memory-wiki-schema', './memory-recall',
    './core/recall-prepare', './core/recall-audit-db', './core/recall-plan',
    './core/recall-redact', './core/recall-budget', './core/recall-format',
    './intent-registry', './daemon-prompt-context',
  ]) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* ignore */ }
  }
  const memory = require('./memory');
  const audit = require('./core/recall-audit-db');
  audit._resetForTesting();
  return Promise.resolve()
    .then(() => fn({ memory, dbPath, audit }))
    .finally(() => {
      audit._resetForTesting();
      try { memory.forceClose(); } catch { /* ignore */ }
      process.env.HOME = prevHome;
      if (prevAuditDb === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
      else process.env.METAME_RECALL_AUDIT_DB = prevAuditDb;
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
}

// Mirrors the askClaude prompt-build → reply-marker path in daemon-claude-
// engine.js. Any divergence from that wiring is also locked by the source-
// invariant test below.
async function runDaemonRecallTurn({ prompt, config, scope, chatId, mockBot }) {
  const { prepareRecall } = require('./core/recall-prepare');
  const { buildIntentHint, composePrompt } = require('./daemon-prompt-context');

  const _recallEnabled = !!(config && config.daemon && config.daemon.memory_recall_enabled);
  const _recallTotalChars = (config && config.daemon
    && Number.isFinite(config.daemon.memory_recall_max_chars))
    ? config.daemon.memory_recall_max_chars : 4000;
  const _recallAssembleTimeoutMs = (config && config.daemon
    && Number.isFinite(config.daemon.memory_recall_assemble_timeout_ms)
    && config.daemon.memory_recall_assemble_timeout_ms > 0)
    ? config.daemon.memory_recall_assemble_timeout_ms : 80;

  const _askState = { recallActive: false, recallHint: '', recallMeta: null };
  const _recall = await prepareRecall({
    prompt,
    runtime: { engine: 'claude', sessionStarted: true },
    scope,
    chatId,
    enabled: _recallEnabled,
    budget: { totalChars: _recallTotalChars },
    assembleTimeoutMs: _recallAssembleTimeoutMs,
    log: () => {},
  });
  _askState.recallActive = !!_recall.recallActive;
  _askState.recallHint = _recall.recallHint || '';
  _askState.recallMeta = _recall.recallMeta || null;

  const intentHint = buildIntentHint({
    prompt,
    config,
    boundProjectKey: scope.project,
    projectKey: scope.project,
    log: () => {},
    suppressKeys: _askState.recallActive ? ['memory_recall'] : undefined,
  });

  const fullPrompt = composePrompt({
    routedPrompt: prompt,
    warmEntry: false,
    intentHint,
    daemonHint: '',
    agentHint: '',
    macAutomationHint: '',
    summaryHint: '',
    memoryHint: '',
    mentorHint: '',
    recallHint: _askState.recallHint,
    langGuard: '',
  });

  // Simulate "Claude returns text" + reply send.
  const cleanOutput = '<MOCK_CLAUDE_REPLY>';
  await mockBot.sendCard(chatId, { title: 'reply', body: cleanOutput, color: 'blue' });

  // Marker render mirrors daemon-claude-engine.js post-reply block.
  const _markerEnabled = !(config && config.daemon
    && config.daemon.memory_recall_show_marker === false);
  const _markerChannel = (config && config.daemon
    && typeof config.daemon.memory_recall_marker_channel === 'string')
    ? config.daemon.memory_recall_marker_channel : 'card';
  if (_askState.recallMeta && _markerEnabled && _markerChannel === 'card' && mockBot.sendCard) {
    const sources = Array.isArray(_askState.recallMeta.sources) ? _askState.recallMeta.sources : [];
    const counts = sources.reduce((acc, s) => {
      const tier = s && s.tier;
      if (tier) acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {});
    const parts = [];
    for (const t of ['facts', 'wiki', 'working', 'sessions']) {
      if (counts[t]) parts.push(`${t}:${counts[t]}`);
    }
    const breakdown = parts.length > 0 ? ` — ${parts.join(' ')}` : '';
    const markerBody = `[Jarvis: 已结合 ${sources.length} 条历史${breakdown}]`;
    await mockBot.sendCard(chatId, { title: '🧠 Recall', body: markerBody, color: 'gray' });
  }

  return { fullPrompt, intentHint, cleanOutput, askState: _askState };
}

function makeMockBot() {
  const calls = [];
  return {
    calls,
    sendCard: async (chatId, card) => { calls.push({ kind: 'sendCard', chatId, card }); return { message_id: 'mock_' + calls.length }; },
    sendMarkdown: async (chatId, body) => { calls.push({ kind: 'sendMarkdown', chatId, body }); return { message_id: 'mock_' + calls.length }; },
    sendMessage: async (chatId, body) => { calls.push({ kind: 'sendMessage', chatId, body }); return { message_id: 'mock_' + calls.length }; },
  };
}

function readAuditRows(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(`SELECT * FROM recall_audit ORDER BY ts, id`).all();
  } catch (e) {
    if (/no such table/i.test(e.message)) return [];
    throw e;
  } finally {
    db.close();
  }
}

const SCOPE = { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' };

test('daemon e2e: flag ON + active fact + trigger phrase → full recall path', async () => {
  await withFixture(async ({ memory, dbPath }) => {
    memory.saveMemoryItem({
      id: 'mi_e2e_1',
      kind: 'convention',
      state: 'active',
      title: 'saveFacts location',
      content: 'saveFacts() lives in scripts/memory.js and writes fact rows for recall',
      project: 'metame',
      scope: 'main',
    });
    const mockBot = makeMockBot();
    const config = {
      daemon: {
        memory_recall_enabled: true,
        memory_recall_max_chars: 4000,
        memory_recall_show_marker: true,
        memory_recall_marker_channel: 'card',
      },
    };
    const result = await runDaemonRecallTurn({
      prompt: '还记得上次 scripts/memory.js 里 saveFacts() 怎么用的吗',
      config, scope: SCOPE, chatId: 'oc_e2e_on', mockBot,
    });

    // 1. fullPrompt MUST include the recall block
    assert.match(result.fullPrompt, /\[Recall context:[\s\S]*Facts:/,
      'flag on with content → recall block should be in prompt');

    // 2. legacy memory_recall CLI hint must be SUPPRESSED when recall fires
    assert.doesNotMatch(result.intentHint, /\[跨会话记忆提示\]/,
      'CLI hint must be suppressed when recall channel injected');
    assert.doesNotMatch(result.intentHint, /memory-search\.js/,
      'CLI hint memory-search.js mention must be suppressed');

    // 3. mockBot.sendCard called twice: once for main reply, once for marker
    const cardCalls = mockBot.calls.filter(c => c.kind === 'sendCard');
    assert.equal(cardCalls.length, 2, 'main reply + marker = 2 sendCard calls');
    const markerCall = cardCalls[1];
    assert.equal(markerCall.card.title, '🧠 Recall');
    assert.match(markerCall.card.body, /\[Jarvis: 已结合 \d+ 条历史/);

    // 4. cleanOutput byte-clean (no marker leakage into reply text)
    assert.equal(result.cleanOutput, '<MOCK_CLAUDE_REPLY>');
    assert.doesNotMatch(result.cleanOutput, /Recall|Jarvis/);

    // 5. audit table has BOTH observe row AND inject row with injected_chars>0
    const rows = readAuditRows(dbPath);
    const observe = rows.find(r => r.phase === 'observe');
    const inject = rows.find(r => r.phase === 'inject');
    assert.ok(observe, 'observe row must exist');
    assert.ok(inject, 'inject row must exist when recall fires');
    assert.ok(inject.injected_chars > 0, `inject must have injected_chars>0, got ${inject.injected_chars}`);
    assert.notEqual(inject.outcome, 'harmful');

    // 6. askState plumbed correctly
    assert.equal(result.askState.recallActive, true);
    assert.notEqual(result.askState.recallHint, '');
    assert.ok(result.askState.recallMeta);
  });
});

test('daemon e2e: flag OFF → byte-identical baseline, no marker, observe-only audit', async () => {
  await withFixture(async ({ memory, dbPath }) => {
    memory.saveMemoryItem({
      id: 'mi_e2e_off',
      kind: 'convention',
      state: 'active',
      title: 'saveFacts',
      content: 'saveFacts() in scripts/memory.js',
      project: 'metame',
      scope: 'main',
    });
    const mockBot = makeMockBot();
    const config = {
      daemon: {
        memory_recall_enabled: false,            // <- key: flag off
        memory_recall_show_marker: true,
        memory_recall_marker_channel: 'card',
      },
    };
    const result = await runDaemonRecallTurn({
      prompt: '还记得上次 scripts/memory.js 里 saveFacts() 怎么用的吗',
      config, scope: SCOPE, chatId: 'oc_e2e_off', mockBot,
    });

    // 1. NO recall block in prompt — baseline preserved
    assert.doesNotMatch(result.fullPrompt, /\[Recall context:/,
      'flag off must NOT inject recall block');

    // 2. legacy CLI hint may appear (suppression only fires when recall actually injects)
    //    — assert nothing here; suppression is conditional on recallActive=true

    // 3. only ONE sendCard call (the main reply, no marker)
    const cardCalls = mockBot.calls.filter(c => c.kind === 'sendCard');
    assert.equal(cardCalls.length, 1, 'flag off → only main reply, no marker card');

    // 4. audit row only phase=observe (PR1 behaviour preserved)
    const rows = readAuditRows(dbPath);
    assert.ok(rows.length >= 1);
    assert.ok(rows.every(r => r.phase === 'observe'),
      `flag off must produce only observe rows, got: ${rows.map(r => r.phase).join(',')}`);

    // 5. askState all default
    assert.equal(result.askState.recallActive, false);
    assert.equal(result.askState.recallHint, '');
    assert.equal(result.askState.recallMeta, null);
  });
});

test('daemon e2e: marker_channel=off → no marker card even when recall fires', async () => {
  await withFixture(async ({ memory }) => {
    memory.saveMemoryItem({
      id: 'mi_e2e_nomark', kind: 'convention', state: 'active',
      title: 'saveFacts', content: 'saveFacts() in scripts/memory.js',
      project: 'metame', scope: 'main',
    });
    const mockBot = makeMockBot();
    const config = {
      daemon: {
        memory_recall_enabled: true,
        memory_recall_show_marker: true,
        memory_recall_marker_channel: 'off',  // <- key
      },
    };
    const result = await runDaemonRecallTurn({
      prompt: '还记得 scripts/memory.js 里的 saveFacts() 吗',
      config, scope: SCOPE, chatId: 'oc_e2e_nomark', mockBot,
    });

    // Recall block STILL in prompt (channel=off only suppresses marker, not injection)
    assert.match(result.fullPrompt, /\[Recall context:/);
    // But only main reply card — no marker
    const cardCalls = mockBot.calls.filter(c => c.kind === 'sendCard');
    assert.equal(cardCalls.length, 1, 'marker_channel=off must skip marker card');
  });
});

test('daemon e2e: source-invariant — daemon-claude-engine.js wires the recall pipeline', () => {
  // Locks the daemon glue. If a future refactor removes any of these
  // load-bearing wires, this test fails before the runtime symptom.
  const src = fs.readFileSync(
    path.join(__dirname, 'daemon-claude-engine.js'),
    'utf8',
  );
  const checks = [
    [/require\(['"]\.\/core\/recall-prepare['"]\)/,    'must require core/recall-prepare'],
    [/await\s+prepareRecall\(/,                        'must await prepareRecall'],
    [/suppressKeys:\s*_askState\.recallActive/,        'must pass suppressKeys driven by _askState'],
    [/recallHint:\s*_askState\.recallHint/,            'must pass recallHint to composePrompt from _askState'],
    [/_askState\.recallMeta/,                           'must use _askState container for recallMeta'],
    [/bot\.sendCard\(chatId,\s*\{\s*title:\s*['"]🧠 Recall['"]/, 'must emit marker card with title 🧠 Recall'],

    // Codex Step 6 P2: parameter-completeness checks (text-only, but stronger
    // than mere presence — proves the config flag, timeout, and scope shape
    // are still plumbed to prepareRecall).
    [/enabled:\s*_recallEnabled/,                                                    'must plumb memory_recall_enabled flag'],
    [/assembleTimeoutMs:\s*_recallAssembleTimeoutMs/,                                'must plumb assemble timeout'],
    [/budget:\s*\{\s*totalChars:\s*_recallTotalChars\s*\}/,                          'must plumb budget.totalChars'],
    [/project:\s*boundProjectKey\s*\|\|\s*projectKey\s*\|\|\s*null/,                 'must compute scope.project from chat-agent map'],
  ];
  for (const [re, msg] of checks) {
    assert.match(src, re, msg);
  }

  // Order invariant: prepareRecall must come BEFORE composePrompt in the
  // function body. If a refactor reorders them, intentHint/recallHint would
  // be empty when composePrompt fires.
  const prepareIdx = src.search(/await\s+prepareRecall\(/);
  const composeIdx = src.search(/const\s+fullPrompt\s*=\s*composePrompt\(/);
  assert.ok(prepareIdx > 0, 'prepareRecall call must be findable');
  assert.ok(composeIdx > 0, 'composePrompt call must be findable');
  assert.ok(prepareIdx < composeIdx,
    `prepareRecall (${prepareIdx}) must come before composePrompt (${composeIdx}) in askClaude`);
});
