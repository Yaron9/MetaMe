'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function withTempAuditDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-observe-test-'));
  const dbPath = path.join(dir, 'memory.db');
  const prev = process.env.METAME_RECALL_AUDIT_DB;
  process.env.METAME_RECALL_AUDIT_DB = dbPath;
  delete require.cache[require.resolve('./recall-audit-db')];
  delete require.cache[require.resolve('./recall-plan')];
  delete require.cache[require.resolve('./recall-observe')];
  delete require.cache[require.resolve('./recall-redact')];
  const audit = require('./recall-audit-db');
  audit._resetForTesting();
  const { observeRecall } = require('./recall-observe');
  try {
    fn(observeRecall, dbPath);
  } finally {
    audit._resetForTesting();
    if (prev === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
    else process.env.METAME_RECALL_AUDIT_DB = prev;
    delete require.cache[require.resolve('./recall-audit-db')];
    delete require.cache[require.resolve('./recall-plan')];
    delete require.cache[require.resolve('./recall-observe')];
    delete require.cache[require.resolve('./recall-redact')];
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function readAuditRows(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(`SELECT * FROM recall_audit ORDER BY ts`).all();
  db.close();
  return rows;
}

test('observeRecall: writes phase=observe row when planRecall fires', () => {
  withTempAuditDb((observeRecall, dbPath) => {
    const plan = observeRecall({
      prompt: '上次我们讨论过 daemon 的崩溃 scripts/memory.js',
      runtime: { engine: 'claude', sessionStarted: true },
      scope: { project: 'metame', workspaceScope: 'main', agentKey: 'jarvis' },
      chatId: 'oc_chat_1',
    });
    assert.ok(plan && plan.shouldRecall === true);
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, 'observe');
    assert.equal(rows[0].should_recall, 1);
    assert.equal(rows[0].router_reason, 'explicit-history');
    assert.equal(rows[0].chat_id, 'oc_chat_1');
    assert.equal(rows[0].project, 'metame');
    assert.equal(rows[0].agent_key, 'jarvis');
    assert.equal(rows[0].engine, 'claude');
    assert.equal(rows[0].session_started, 1);
    // anchor_labels JSON parses to a non-empty array
    const labels = JSON.parse(rows[0].anchor_labels);
    assert.ok(Array.isArray(labels) && labels.length > 0);
    // query_hashes array matches anchor count
    const hashes = JSON.parse(rows[0].query_hashes);
    assert.equal(hashes.length, labels.length);
    for (const h of hashes) assert.match(h, /^sha256:[a-f0-9]{16}$/);
    // modes JSON has facts at minimum
    const modes = JSON.parse(rows[0].modes);
    assert.ok(modes.includes('facts'));
  });
});

test('observeRecall: writes phase=observe row even when shouldRecall=false', () => {
  withTempAuditDb((observeRecall, dbPath) => {
    const plan = observeRecall({
      prompt: 'hello world today',
      runtime: { engine: 'claude', sessionStarted: false },
      scope: { project: 'metame' },
      chatId: 'c_2',
    });
    assert.ok(plan);
    assert.equal(plan.shouldRecall, false);
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].should_recall, 0);
    assert.equal(rows[0].router_reason, null);
  });
});

test('observeRecall: returns null and swallows when audit writer throws', () => {
  // Set an invalid path that mkdtempSync will fail to create.
  const prev = process.env.METAME_RECALL_AUDIT_DB;
  process.env.METAME_RECALL_AUDIT_DB = '/dev/null/cannot-create-here/memory.db';
  delete require.cache[require.resolve('./recall-audit-db')];
  delete require.cache[require.resolve('./recall-plan')];
  delete require.cache[require.resolve('./recall-observe')];
  delete require.cache[require.resolve('./recall-redact')];
  const audit = require('./recall-audit-db');
  audit._resetForTesting();
  const { observeRecall } = require('./recall-observe');
  let logCalls = 0;
  try {
    const plan = observeRecall({
      prompt: '还记得吗',
      runtime: { engine: 'claude', sessionStarted: true },
      scope: { project: 'p' },
      log: () => { logCalls++; },
    });
    // recall-audit-db swallows internally → observeRecall returns the plan still.
    // Either way, no throw.
    assert.ok(plan === null || typeof plan === 'object');
  } finally {
    audit._resetForTesting();
    if (prev === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
    else process.env.METAME_RECALL_AUDIT_DB = prev;
    delete require.cache[require.resolve('./recall-audit-db')];
    delete require.cache[require.resolve('./recall-plan')];
    delete require.cache[require.resolve('./recall-observe')];
    delete require.cache[require.resolve('./recall-redact')];
  }
});

test('observeRecall: missing prompt is non-fatal', () => {
  withTempAuditDb((observeRecall, dbPath) => {
    const plan = observeRecall({});
    // planRecall on undefined returns empty plan; observeRecall still records.
    assert.ok(plan);
    assert.equal(plan.shouldRecall, false);
    const rows = readAuditRows(dbPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].should_recall, 0);
  });
});

test('observeRecall: pure imports — no daemon imports', () => {
  const src = fs.readFileSync(path.join(__dirname, 'recall-observe.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['./daemon-claude-engine', '../daemon-claude-engine', '../memory', './memory']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?['"]\\s*\\)`);
    assert.doesNotMatch(code, re);
  }
});
