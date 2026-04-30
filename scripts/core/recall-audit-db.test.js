'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function freshTempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-audit-test-'));
  return path.join(dir, 'memory.db');
}

function withTempDb(fn) {
  const dbPath = freshTempDbPath();
  const prev = process.env.METAME_RECALL_AUDIT_DB;
  process.env.METAME_RECALL_AUDIT_DB = dbPath;
  // Reset module cache so the helper sees the new env value.
  delete require.cache[require.resolve('./recall-audit-db')];
  const audit = require('./recall-audit-db');
  audit._resetForTesting();
  try {
    fn(audit, dbPath);
  } finally {
    audit._resetForTesting();
    if (prev === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
    else process.env.METAME_RECALL_AUDIT_DB = prev;
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('recall-audit-db', async (t) => {
  await t.test('lazy: does not open DB until first recordAudit call', () => {
    withTempDb((audit, dbPath) => {
      assert.equal(fs.existsSync(dbPath), false, 'DB file should not exist before first write');
      audit.recordAudit({ id: 'r1', phase: 'observe', should_recall: 1 });
      assert.equal(fs.existsSync(dbPath), true, 'DB file should exist after first write');
    });
  });

  await t.test('writes observe row with hashed/redacted columns', () => {
    withTempDb((audit, dbPath) => {
      audit.recordAudit({
        id: 'r_obs',
        phase: 'observe',
        chat_id: 'oc_abc',
        project: 'metame',
        scope: 'main',
        should_recall: 1,
        router_reason: 'explicit-history',
        query_hashes: ['sha256:abc123'],
        anchor_labels: ['fn:saveFacts', 'file:scripts/memory.js'],
        modes: ['facts', 'sessions'],
      });

      const db = new DatabaseSync(dbPath);
      const row = db.prepare(`SELECT * FROM recall_audit WHERE id='r_obs'`).get();
      assert.equal(row.phase, 'observe');
      assert.equal(row.should_recall, 1);
      assert.equal(row.router_reason, 'explicit-history');
      assert.equal(row.query_hashes, '["sha256:abc123"]');
      assert.deepEqual(JSON.parse(row.anchor_labels), ['fn:saveFacts', 'file:scripts/memory.js']);
      assert.equal(row.injected_chars, 0);
      assert.equal(row.outcome, 'unknown');
      db.close();
    });
  });

  await t.test('coerces phase enum: anything other than "inject" becomes "observe"', () => {
    withTempDb((audit, dbPath) => {
      audit.recordAudit({ id: 'r_a', phase: 'random' });
      audit.recordAudit({ id: 'r_b', phase: 'inject' });
      const db = new DatabaseSync(dbPath);
      const a = db.prepare(`SELECT phase FROM recall_audit WHERE id='r_a'`).get();
      const b = db.prepare(`SELECT phase FROM recall_audit WHERE id='r_b'`).get();
      assert.equal(a.phase, 'observe');
      assert.equal(b.phase, 'inject');
      db.close();
    });
  });

  await t.test('coerces non-array array fields and bad numbers gracefully', () => {
    withTempDb((audit, dbPath) => {
      audit.recordAudit({
        id: 'r_coerce',
        query_hashes: 'not-an-array',
        anchor_labels: undefined,
        modes: null,
        injected_chars: 'NaN',
      });
      const db = new DatabaseSync(dbPath);
      const row = db.prepare(`SELECT query_hashes, anchor_labels, modes, injected_chars FROM recall_audit WHERE id='r_coerce'`).get();
      assert.equal(row.query_hashes, '[]');
      assert.equal(row.anchor_labels, '[]');
      assert.equal(row.modes, '[]');
      assert.equal(row.injected_chars, 0);
      db.close();
    });
  });

  await t.test('failure swallowed: invalid DB path produces no throw', () => {
    const prev = process.env.METAME_RECALL_AUDIT_DB;
    process.env.METAME_RECALL_AUDIT_DB = '/dev/null/cannot-create-here/memory.db';
    delete require.cache[require.resolve('./recall-audit-db')];
    const audit = require('./recall-audit-db');
    audit._resetForTesting();
    try {
      audit.recordAudit({ id: 'r_swallow', should_recall: 1 });
    } finally {
      audit._resetForTesting();
      if (prev === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
      else process.env.METAME_RECALL_AUDIT_DB = prev;
    }
  });

  await t.test('rejects bad input shapes silently', () => {
    withTempDb((audit, dbPath) => {
      audit.recordAudit(null);
      audit.recordAudit({});
      audit.recordAudit({ id: '' });
      audit.recordAudit({ id: 42 });
      // After a real write, the bad-input writes should NOT have inserted rows.
      audit.recordAudit({ id: 'r_real', should_recall: 1 });
      const db = new DatabaseSync(dbPath);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM recall_audit`).get();
      assert.equal(count.n, 1, 'only the valid row should be inserted');
      db.close();
    });
  });

  await t.test('CHECK constraint failure on bad outcome is also swallowed', () => {
    withTempDb((audit, dbPath) => {
      audit.recordAudit({ id: 'r_bad_outcome', outcome: 'totally-invalid' });
      // No throw. Row is rejected by CHECK; count stays 0.
      const db = new DatabaseSync(dbPath);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM recall_audit`).get();
      assert.equal(count.n, 0);
      db.close();
    });
  });

  await t.test('does not require ../memory (no heavy init)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'recall-audit-db.js'), 'utf8');
    // Strip block + line comments so legitimate documentation references don't match.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /require\s*\(\s*['"]\.\.\/memory['"]\s*\)/, 'must not require ../memory');
    assert.doesNotMatch(code, /require\s*\(\s*['"]\.\.\/memory-wiki-schema['"]\s*\)/, 'must not require ../memory-wiki-schema');
  });
});
