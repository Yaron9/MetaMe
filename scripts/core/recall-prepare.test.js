'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function withFreshHomeAndAudit(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-prepare-'));
  const dbPath = path.join(tmpDir, 'memory.db');
  const prevHome = process.env.HOME;
  const prevAuditDb = process.env.METAME_RECALL_AUDIT_DB;
  process.env.HOME = tmpDir;
  process.env.METAME_RECALL_AUDIT_DB = dbPath;

  // Reset every cached module so the new HOME / audit DB takes effect.
  for (const mod of [
    './recall-prepare', './recall-audit-db', './recall-plan', './recall-redact',
    '../memory-recall', '../memory', '../memory-wiki-schema',
  ]) {
    try { delete require.cache[require.resolve(mod)]; } catch { /* ignore */ }
  }
  const audit = require('./recall-audit-db');
  audit._resetForTesting();
  const memory = require('../memory');
  const { prepareRecall } = require('./recall-prepare');

  return Promise.resolve()
    .then(() => fn(prepareRecall, memory, dbPath))
    .finally(() => {
      audit._resetForTesting();
      try { memory.forceClose(); } catch { /* ignore */ }
      process.env.HOME = prevHome;
      if (prevAuditDb === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
      else process.env.METAME_RECALL_AUDIT_DB = prevAuditDb;
      for (const mod of [
        './recall-prepare', './recall-audit-db', './recall-plan', './recall-redact',
        '../memory-recall', '../memory', '../memory-wiki-schema',
      ]) {
        try { delete require.cache[require.resolve(mod)]; } catch { /* ignore */ }
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
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

const RUNTIME = { engine: 'claude', sessionStarted: true };
const SCOPE = { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' };

test('prepareRecall: enabled=false → only observe row, no inject', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    const result = await prepareRecall({
      prompt: '上次我们讨论过 daemon 的崩溃 scripts/memory.js',
      runtime: RUNTIME, scope: SCOPE, chatId: 'oc_1', enabled: false,
    });
    assert.equal(result.recallActive, false);
    assert.equal(result.recallHint, '');
    assert.equal(result.recallMeta, null);
    assert.ok(result.plan && result.plan.shouldRecall === true);
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'observe');
  });
});

test('prepareRecall: enabled=true + shouldRecall=false → only observe row', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    const result = await prepareRecall({
      prompt: 'hello world',
      runtime: RUNTIME, scope: SCOPE, chatId: 'oc_2', enabled: true,
    });
    assert.equal(result.recallActive, false);
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'observe');
    assert.equal(rows[0].should_recall, 0);
  });
});

test('prepareRecall: enabled=true + shouldRecall=true + empty DB → only observe (no usable text)', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    // "还记得吗" alone fires explicit-history trigger; no anchors/content in DB.
    const result = await prepareRecall({
      prompt: '还记得吗 那个 saveFacts',
      runtime: RUNTIME, scope: SCOPE, chatId: 'oc_3', enabled: true,
    });
    assert.equal(result.plan.shouldRecall, true, 'sanity: prompt should trigger');
    // Empty DB → assembleRecallContext returns empty text → no inject path.
    assert.equal(result.recallActive, false);
    assert.equal(result.recallHint, '');
    assert.equal(result.recallMeta, null);
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'observe');
    assert.equal(rows[0].should_recall, 1);
  });
});

test('prepareRecall: enabled=true + shouldRecall=true + content present → observe + inject', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, memory, dbPath) => {
    memory.saveMemoryItem({
      id: 'mi_prepare_1',
      kind: 'convention',
      state: 'active',
      title: 'saveFacts location',
      content: 'saveFacts() lives in scripts/memory.js and writes fact rows',
      project: 'metame',
      scope: 'main',
    });

    // Two anchors: file:scripts/memory.js + fn:saveFacts. Both substrings
    // appear in indexed content so FTS surfaces the seeded fact.
    const result = await prepareRecall({
      prompt: '还记得 scripts/memory.js 里的 saveFacts() 怎么用的吗',
      runtime: RUNTIME, scope: SCOPE, chatId: 'oc_4', enabled: true,
    });
    assert.equal(result.recallActive, true);
    assert.notEqual(result.recallHint, '');
    assert.match(result.recallHint, /\[Recall context:[\s\S]*Facts:/);
    assert.ok(result.recallMeta);
    assert.ok(typeof result.recallMeta.chars === 'number');

    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 2);
    const observe = rows.find(r => r.phase === 'observe');
    const inject  = rows.find(r => r.phase === 'inject');
    assert.ok(observe && inject);
    assert.equal(inject.should_recall, 1);
    assert.ok(inject.injected_chars > 0);
    assert.equal(inject.truncated, 0);
    // Source refs should reference the seeded fact id.
    const refs = JSON.parse(inject.source_refs);
    assert.ok(Array.isArray(refs) && refs.length >= 1);
    assert.match(refs[0], /^id:mi_prepare_1/);
  });
});

test('prepareRecall: assembleRecallContext throws → swallow, observe-only', async () => {
  // Monkey-patch memory-recall to throw.
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    // Replace the lazy require target by polluting require.cache.
    const memoryRecallPath = require.resolve('../memory-recall');
    require.cache[memoryRecallPath] = {
      id: memoryRecallPath, filename: memoryRecallPath, loaded: true, children: [], paths: [],
      exports: {
        assembleRecallContext: async () => { throw new Error('synthetic facade error'); },
      },
    };
    let logCalls = 0;
    const result = await prepareRecall({
      prompt: '还记得吗 scripts/memory.js',
      runtime: RUNTIME, scope: SCOPE, chatId: 'oc_5', enabled: true,
      log: () => { logCalls++; },
    });
    assert.equal(result.recallActive, false);
    assert.equal(result.recallHint, '');
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'observe');
    assert.ok(logCalls >= 1, 'log must be called when assemble throws');
  });
});

test('prepareRecall: planRecall throws → returns empty, no rows', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    const planPath = require.resolve('./recall-plan');
    require.cache[planPath] = {
      id: planPath, filename: planPath, loaded: true, children: [], paths: [],
      exports: {
        planRecall: () => { throw new Error('synthetic plan error'); },
      },
    };
    // Reset prepareRecall import so it picks up the mocked plan.
    delete require.cache[require.resolve('./recall-prepare')];
    const { prepareRecall: prep } = require('./recall-prepare');
    let logCalls = 0;
    const result = await prep({
      prompt: 'anything', runtime: RUNTIME, scope: SCOPE, chatId: 'oc_6', enabled: true,
      log: () => { logCalls++; },
    });
    assert.equal(result.recallActive, false);
    const rows = readAuditRows(dbPath);
    // No observe row either, since plan failed before observe write.
    assert.equal(rows.length, 0);
    assert.ok(logCalls >= 1);
  });
});

test('prepareRecall: assembleRecallContext slower than timeout → outcome=harmful inject row, no recall', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    // Monkey-patch memory-recall to simulate a 200ms-slow facade.
    const memoryRecallPath = require.resolve('../memory-recall');
    require.cache[memoryRecallPath] = {
      id: memoryRecallPath, filename: memoryRecallPath, loaded: true, children: [], paths: [],
      exports: {
        assembleRecallContext: () => new Promise((resolve) => {
          setTimeout(() => resolve({ text: '\n\n[recall would have been here]', sources: [], truncated: false, breakdown: { facts: 100, wiki: 0, working: 0, sessions: 0 }, recallMeta: { sources: [], chars: 30 }, wikiDropped: false }), 200);
        }),
      },
    };
    delete require.cache[require.resolve('./recall-prepare')];
    const { prepareRecall: prep } = require('./recall-prepare');

    const t0 = Date.now();
    const result = await prep({
      prompt: '上次我们讨论过 daemon 的崩溃 scripts/memory.js',
      runtime: { engine: 'claude', sessionStarted: true },
      scope: { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' },
      chatId: 'oc_t', enabled: true,
      assembleTimeoutMs: 50, // tight bound — synthetic 200ms must exceed.
    });
    const elapsed = Date.now() - t0;

    // Caller is unblocked well before the synthetic delay completes.
    assert.ok(elapsed < 150, `prepareRecall must return before assemble would finish, got ${elapsed}ms`);
    // Returned result is the empty-result shape — no recall injection.
    assert.equal(result.recallActive, false);
    assert.equal(result.recallHint, '');
    assert.equal(result.recallMeta, null);
    // recall_audit captured BOTH observe (always) AND a timeout-tagged inject row.
    const db = new (require('node:sqlite').DatabaseSync)(dbPath);
    const rows = db.prepare(`SELECT phase, outcome, error_message, injected_chars FROM recall_audit ORDER BY ts, id`).all();
    db.close();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].phase, 'observe');
    assert.equal(rows[1].phase, 'inject');
    assert.equal(rows[1].outcome, 'harmful');
    assert.match(rows[1].error_message, /assemble timeout:50ms/);
    assert.equal(rows[1].injected_chars, 0);
  });
});

test('prepareRecall: assembleRecallContext within timeout → normal inject row', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    // Monkey-patch memory-recall with a fast (10ms) facade.
    const memoryRecallPath = require.resolve('../memory-recall');
    require.cache[memoryRecallPath] = {
      id: memoryRecallPath, filename: memoryRecallPath, loaded: true, children: [], paths: [],
      exports: {
        assembleRecallContext: () => new Promise((resolve) => {
          setTimeout(() => resolve({
            text: '\n\n[Recall context:\nFacts:\n- mock fact\n]',
            sources: [{ tier: 'facts', kind: 'fact', id: 'mi_x' }],
            truncated: false,
            breakdown: { facts: 30, wiki: 0, working: 0, sessions: 0 },
            recallMeta: { sources: [{ tier: 'facts', id: 'mi_x' }], chars: 30 },
            wikiDropped: false,
          }), 10);
        }),
      },
    };
    delete require.cache[require.resolve('./recall-prepare')];
    const { prepareRecall: prep } = require('./recall-prepare');

    const result = await prep({
      prompt: '上次我们讨论过 daemon 的崩溃 scripts/memory.js',
      runtime: { engine: 'claude', sessionStarted: true },
      scope: { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' },
      chatId: 'oc_ok', enabled: true,
      assembleTimeoutMs: 100,
    });
    assert.equal(result.recallActive, true);
    assert.match(result.recallHint, /\[Recall context:/);
    const db = new (require('node:sqlite').DatabaseSync)(dbPath);
    const rows = db.prepare(`SELECT phase, outcome FROM recall_audit ORDER BY ts, id`).all();
    db.close();
    assert.equal(rows[1].phase, 'inject');
    assert.notEqual(rows[1].outcome, 'harmful');
  });
});

test('prepareRecall: invalid assembleTimeoutMs falls back to default 80ms', async () => {
  await withFreshHomeAndAudit(async (prepareRecall, _memory, dbPath) => {
    // Synthetic 200ms facade.
    const memoryRecallPath = require.resolve('../memory-recall');
    require.cache[memoryRecallPath] = {
      id: memoryRecallPath, filename: memoryRecallPath, loaded: true, children: [], paths: [],
      exports: {
        assembleRecallContext: () => new Promise((resolve) => {
          setTimeout(() => resolve({ text: 'x', sources: [], truncated: false, breakdown: { facts: 1, wiki: 0, working: 0, sessions: 0 }, recallMeta: {}, wikiDropped: false }), 200);
        }),
      },
    };
    delete require.cache[require.resolve('./recall-prepare')];
    const { prepareRecall: prep } = require('./recall-prepare');

    const t0 = Date.now();
    // Pass invalid timeouts — should all fall back to 80ms default and timeout.
    for (const bad of [undefined, 0, -1, NaN, 'abc']) {
      const r = await prep({
        prompt: '还记得吗',
        runtime: { engine: 'claude', sessionStarted: true },
        scope: { project: 'metame' },
        chatId: 'oc_d', enabled: true,
        assembleTimeoutMs: bad,
      });
      assert.equal(r.recallActive, false, `bad timeout ${bad} should fall back, then time out`);
    }
    const elapsed = Date.now() - t0;
    // 5 calls × ~80ms = ~400ms total; well under 5×200ms (1000ms).
    assert.ok(elapsed < 700, `5×default 80ms timeouts should finish under 700ms, got ${elapsed}ms`);
  });
});

test('prepareRecall: pure-ish module — no daemon imports', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recall-prepare.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['../daemon-claude-engine', '../daemon-prompt-context', '../intent-registry']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?['"]\\s*\\)`);
    assert.doesNotMatch(code, re, `recall-prepare must not require ${banned}`);
  }
});
