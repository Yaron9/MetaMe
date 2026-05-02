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

  await t.test('counts dropped writes when prepare().run() throws', () => {
    withTempDb((audit, dbPath) => {
      // Warm up: one valid write opens the DB so we can monkey-patch its prepare.
      audit.recordAudit({ id: 'r_warmup', should_recall: 1 });
      assert.equal(audit.getDroppedCount(), 0, 'baseline drop count is 0');

      const realDb = audit._getDbForTesting();
      assert.ok(realDb, 'cached DB handle exists after warmup');
      const realPrepare = realDb.prepare.bind(realDb);

      // Inject failure: regular 19-? insert throws SQLITE_BUSY-like error;
      // marker insert (different SQL shape) still passes through.
      const REGULAR_INSERT_RE = /INSERT INTO recall_audit\s+\(id, phase, chat_id/;
      realDb.prepare = (sql) => {
        if (REGULAR_INSERT_RE.test(sql)) {
          return {
            run() {
              const e = new Error('SQLITE_BUSY: database is locked');
              e.code = 'SQLITE_BUSY';
              throw e;
            },
          };
        }
        return realPrepare(sql);
      };

      // Drive 99 failures — counter should climb but no marker yet.
      for (let i = 0; i < 99; i++) {
        audit.recordAudit({ id: `r_busy_${i}`, should_recall: 1 });
      }
      assert.equal(audit.getDroppedCount(), 99, 'counter tracks every drop');

      // Verify no marker row written before the 100th drop.
      const probe = new DatabaseSync(dbPath);
      let marker = probe.prepare(
        `SELECT * FROM recall_audit WHERE error_message LIKE 'audit_dropped:%'`
      ).get();
      assert.equal(marker, undefined, 'no marker row before 100th drop');
      probe.close();

      // 100th drop triggers the marker.
      audit.recordAudit({ id: 'r_busy_99', should_recall: 1 });
      assert.equal(audit.getDroppedCount(), 100, 'counter at exactly 100');

      const probe2 = new DatabaseSync(dbPath);
      marker = probe2.prepare(
        `SELECT * FROM recall_audit WHERE error_message LIKE 'audit_dropped:%'`
      ).get();
      assert.ok(marker, 'marker row exists after 100th drop');
      assert.equal(marker.error_message, 'audit_dropped:100');
      assert.equal(marker.outcome, 'harmful');
      assert.equal(marker.phase, 'observe');
      probe2.close();
    });
  });

  await t.test('marker writes again at the 200th drop', () => {
    withTempDb((audit, dbPath) => {
      audit.recordAudit({ id: 'r_warmup', should_recall: 1 });
      const realDb = audit._getDbForTesting();
      const realPrepare = realDb.prepare.bind(realDb);
      const REGULAR_INSERT_RE = /INSERT INTO recall_audit\s+\(id, phase, chat_id/;
      realDb.prepare = (sql) => {
        if (REGULAR_INSERT_RE.test(sql)) {
          return { run() { throw new Error('busy'); } };
        }
        return realPrepare(sql);
      };

      for (let i = 0; i < 200; i++) {
        audit.recordAudit({ id: `r_${i}`, should_recall: 1 });
      }
      assert.equal(audit.getDroppedCount(), 200);

      const probe = new DatabaseSync(dbPath);
      const markers = probe.prepare(
        `SELECT error_message FROM recall_audit
         WHERE error_message LIKE 'audit_dropped:%'
         ORDER BY error_message`
      ).all();
      probe.close();
      assert.equal(markers.length, 2, 'one marker per 100-drop boundary');
      assert.deepEqual(
        markers.map(r => r.error_message).sort(),
        ['audit_dropped:100', 'audit_dropped:200'],
      );
    });
  });

  await t.test('marker write itself failing does not raise or recurse', () => {
    withTempDb((audit) => {
      audit.recordAudit({ id: 'r_warmup', should_recall: 1 });
      const realDb = audit._getDbForTesting();

      // ALL prepare() calls throw — even the marker insert. Verifies
      // _writeDroppedMarker swallows its own failure cleanly.
      realDb.prepare = () => ({
        run() { throw new Error('total contention'); },
      });

      // 100 drops should not throw.
      for (let i = 0; i < 100; i++) {
        audit.recordAudit({ id: `r_${i}`, should_recall: 1 });
      }
      assert.equal(audit.getDroppedCount(), 100);
      // Drive past 100 to make sure the marker-failure path didn't break the loop.
      audit.recordAudit({ id: 'r_extra', should_recall: 1 });
      assert.equal(audit.getDroppedCount(), 101);
    });
  });

  await t.test('drop counter survives daemon restart via marker seed', () => {
    // Simulates Codex Step 7 review finding: in-memory counter restart loses
    // visibility. We persist via the marker rows themselves — on _openDb the
    // module re-reads the highest audit_dropped:N and resumes from there.
    const dbPath = freshTempDbPath();
    const prev = process.env.METAME_RECALL_AUDIT_DB;
    process.env.METAME_RECALL_AUDIT_DB = dbPath;

    // Phase 1: write a marker manually (as if a previous daemon session had
    // already passed the 100-drop boundary), then close everything.
    delete require.cache[require.resolve('./recall-audit-db')];
    let audit = require('./recall-audit-db');
    audit._resetForTesting();
    audit.recordAudit({ id: 'r_warmup', should_recall: 1 });
    const realDb = audit._getDbForTesting();
    realDb.prepare(
      `INSERT INTO recall_audit (id, phase, outcome, error_message, should_recall)
       VALUES (?, 'observe', 'harmful', ?, 0)`
    ).run('audit_dropped_pretest_300', 'audit_dropped:300');
    audit._resetForTesting();

    // Phase 2: simulate restart — fresh module, _droppedCount starts at 0
    // but should immediately seed to 300 from the persisted marker.
    delete require.cache[require.resolve('./recall-audit-db')];
    audit = require('./recall-audit-db');
    audit._resetForTesting();
    assert.equal(audit.getDroppedCount(), 0, 'before any DB open, count is 0');
    // First write opens the DB → seed runs.
    audit.recordAudit({ id: 'r_postrestart', should_recall: 1 });
    assert.equal(
      audit.getDroppedCount(), 300,
      'counter seeded from latest marker on first open after restart',
    );

    // Phase 3: drive 100 more drops — should emit marker at 400, not 100.
    const realDb2 = audit._getDbForTesting();
    const realPrepare2 = realDb2.prepare.bind(realDb2);
    const REGULAR_INSERT_RE = /INSERT INTO recall_audit\s+\(id, phase, chat_id/;
    realDb2.prepare = (sql) => {
      if (REGULAR_INSERT_RE.test(sql)) {
        return { run() { throw new Error('busy'); } };
      }
      return realPrepare2(sql);
    };
    for (let i = 0; i < 100; i++) {
      audit.recordAudit({ id: `r_p2_${i}`, should_recall: 1 });
    }
    assert.equal(audit.getDroppedCount(), 400);
    const probe = new DatabaseSync(dbPath);
    const markers = probe.prepare(
      `SELECT error_message FROM recall_audit
       WHERE error_message LIKE 'audit_dropped:%'
       ORDER BY ts ASC`
    ).all().map(r => r.error_message);
    probe.close();
    assert.deepEqual(markers, ['audit_dropped:300', 'audit_dropped:400']);

    audit._resetForTesting();
    if (prev === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
    else process.env.METAME_RECALL_AUDIT_DB = prev;
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await t.test('seed picks the LATEST marker by ts, not numeric max', () => {
    // Edge case: if old marker says 500 but most recent says 100 (e.g. table
    // wrapped or DB was restored from backup), seed should follow the actual
    // sequence — i.e. the latest row by ts. We assert the SELECT uses ORDER BY
    // ts DESC (which the implementation does).
    const dbPath = freshTempDbPath();
    const prev = process.env.METAME_RECALL_AUDIT_DB;
    process.env.METAME_RECALL_AUDIT_DB = dbPath;

    delete require.cache[require.resolve('./recall-audit-db')];
    let audit = require('./recall-audit-db');
    audit._resetForTesting();
    audit.recordAudit({ id: 'r_warm', should_recall: 1 });
    const realDb = audit._getDbForTesting();
    // Insert two markers, both flushed; second has later ts (sleep tick).
    realDb.prepare(
      `INSERT INTO recall_audit (id, ts, phase, outcome, error_message, should_recall)
       VALUES (?, datetime('now', '-1 hour'), 'observe', 'harmful', ?, 0)`
    ).run('m_old', 'audit_dropped:500');
    realDb.prepare(
      `INSERT INTO recall_audit (id, ts, phase, outcome, error_message, should_recall)
       VALUES (?, datetime('now'), 'observe', 'harmful', ?, 0)`
    ).run('m_new', 'audit_dropped:700');
    audit._resetForTesting();

    delete require.cache[require.resolve('./recall-audit-db')];
    audit = require('./recall-audit-db');
    audit._resetForTesting();
    audit.recordAudit({ id: 'r_again', should_recall: 1 });
    assert.equal(audit.getDroppedCount(), 700, 'seeded from newest marker');

    audit._resetForTesting();
    if (prev === undefined) delete process.env.METAME_RECALL_AUDIT_DB;
    else process.env.METAME_RECALL_AUDIT_DB = prev;
    try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await t.test('_resetForTesting clears drop counter', () => {
    withTempDb((audit) => {
      audit.recordAudit({ id: 'r_warmup', should_recall: 1 });
      const realDb = audit._getDbForTesting();
      realDb.prepare = () => ({ run() { throw new Error('x'); } });
      audit.recordAudit({ id: 'r1', should_recall: 1 });
      audit.recordAudit({ id: 'r2', should_recall: 1 });
      assert.equal(audit.getDroppedCount(), 2);
      audit._resetForTesting();
      assert.equal(audit.getDroppedCount(), 0);
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
