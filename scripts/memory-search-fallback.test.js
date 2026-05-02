'use strict';

/**
 * memory-search-fallback.test.js — verifies the 3-tier progressive
 * degradation in scripts/memory.js searchMemoryItems:
 *
 *   Tier 1 — AND phrase match  (precision-first)
 *   Tier 2 — OR  phrase match  (recall fallback for multi-token queries
 *                               whose AND match returns 0)
 *   Tier 3 — LIKE per-token OR (final safety net + filter when FTS errors)
 *
 * Single-token queries must NOT retry as Tier 2 (would be a redundant
 * identical expression). state/project/scope/kind filters must remain
 * applied across all tiers. trackSearch behaviour must be honoured.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function withFreshMemoryHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-search-fallback-'));
  const prevHome = process.env.HOME;
  process.env.HOME = tmpDir;
  delete require.cache[require.resolve('./memory')];
  delete require.cache[require.resolve('./memory-wiki-schema')];
  const memory = require('./memory');
  try {
    fn(memory, tmpDir);
  } finally {
    try { memory.forceClose(); } catch { /* ignore */ }
    process.env.HOME = prevHome;
    delete require.cache[require.resolve('./memory')];
    delete require.cache[require.resolve('./memory-wiki-schema')];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function inspectCounts(tmpDir, ids) {
  const dbPath = path.join(tmpDir, '.metame', 'memory.db');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`SELECT id, search_count FROM memory_items WHERE id IN (${placeholders})`).all(...ids);
  } finally {
    db.close();
  }
}

function seed(memory) {
  // Row A: contains BOTH tokens — AND will catch this.
  memory.saveMemoryItem({
    id: 'mi_A',
    kind: 'convention',
    state: 'active',
    title: 'A · daemon-claude-engine + askClaude',
    content: 'daemon-claude-engine.js exposes askClaude as the entry point',
    project: 'metame',
    scope: 'main',
  });
  // Row B: contains ONLY one token — AND would exclude, OR should include.
  memory.saveMemoryItem({
    id: 'mi_B',
    kind: 'convention',
    state: 'active',
    title: 'B · askClaude usage',
    content: 'askClaude is called once per turn from the message pipeline',
    project: 'metame',
    scope: 'main',
  });
  // Row C: contains ONLY the other token — same shape as B.
  memory.saveMemoryItem({
    id: 'mi_C',
    kind: 'insight',
    state: 'active',
    title: 'C · daemon-claude-engine internals',
    content: 'daemon-claude-engine.js wires the spawn helper to providers',
    project: 'metame',
    scope: 'main',
  });
  // Row D: archived — must NEVER appear regardless of tier.
  memory.saveMemoryItem({
    id: 'mi_D',
    kind: 'convention',
    state: 'archived',
    title: 'D · old daemon-claude-engine note',
    content: 'archived row mentioning daemon-claude-engine and askClaude',
    project: 'metame',
    scope: 'main',
  });
}

test('Tier 1 (AND): precise multi-token returns AND-matching rows only', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    const rows = memory.searchMemoryItems('daemon-claude-engine askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const ids = rows.map(r => r.id).sort();
    // mi_A has both tokens. mi_B/mi_C have only one each.
    // Tier 1 AND should return mi_A only (precision-first).
    assert.deepEqual(ids, ['mi_A']);
  });
});

test('Tier 2 (OR): when AND empty + multi-token, returns rows matching ANY phrase', () => {
  withFreshMemoryHome((memory) => {
    // Seed without mi_A — so NO row contains both tokens. Forces Tier 1
    // empty, exercises the Tier 2 OR fallback path.
    memory.saveMemoryItem({
      id: 'mi_B', kind: 'convention', state: 'active',
      title: 'B', content: 'askClaude is called once per turn',
      project: 'metame', scope: 'main',
    });
    memory.saveMemoryItem({
      id: 'mi_C', kind: 'insight', state: 'active',
      title: 'C', content: 'daemon-claude-engine wires the spawn helper',
      project: 'metame', scope: 'main',
    });
    memory.saveMemoryItem({
      id: 'mi_D', kind: 'convention', state: 'archived',
      title: 'D', content: 'archived note about daemon-claude-engine and askClaude',
      project: 'metame', scope: 'main',
    });

    const rows = memory.searchMemoryItems('daemon-claude-engine askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const ids = new Set(rows.map(r => r.id));
    // No row has both tokens → Tier 1 AND empty.
    // Tier 2 OR must surface BOTH single-token rows.
    assert.ok(ids.has('mi_B'), 'mi_B has askClaude — surfaced via Tier 2 OR');
    assert.ok(ids.has('mi_C'), 'mi_C has daemon-claude-engine — surfaced via Tier 2 OR');
    // Archived must never appear.
    assert.ok(!ids.has('mi_D'), 'archived row excluded by state filter');
  });
});

test('Tier 2 NOT triggered for single-token queries (would be redundant retry)', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    // Single-token: phrases.join(' ') === phrases.join(' OR ') === '"askClaude"'
    // — no point retrying. Verify result is identical to what Tier 1 would
    // produce (askClaude appears in mi_A and mi_B).
    const rows = memory.searchMemoryItems('askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const ids = new Set(rows.map(r => r.id));
    assert.ok(ids.has('mi_A'));
    assert.ok(ids.has('mi_B'));
    assert.ok(!ids.has('mi_C'));
  });
});

test('Tier 1 wins when both Tier 1 and Tier 2 would match (precision preserved)', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    // Both tokens are in mi_A — AND succeeds, Tier 2 must NOT run.
    // Verify by ensuring the result is precisely the AND set (not mi_B/mi_C).
    const rows = memory.searchMemoryItems('daemon-claude-engine askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const ids = rows.map(r => r.id).sort();
    assert.deepEqual(ids, ['mi_A'], 'Tier 1 result, not the broader OR set');
  });
});

test('state filter applied across all tiers (archived rows excluded)', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    // mi_D is archived but contains both tokens. Even via OR fallback it
    // must be excluded by the state='active' default filter.
    const rows = memory.searchMemoryItems('scripts/daemon-claude-engine.js askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    for (const r of rows) {
      assert.equal(r.state, 'active');
      assert.notEqual(r.id, 'mi_D');
    }
  });
});

test('project/scope filter applied across all tiers', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    // Scope mismatch — should return nothing even via OR.
    const rows = memory.searchMemoryItems('scripts/daemon-claude-engine.js askClaude', {
      project: 'metame', scope: 'no-such-scope', limit: 10, trackSearch: false,
    });
    assert.equal(rows.length, 0);
  });
});

test('Tier 3 (LIKE) actually kicks in when FTS errors entirely', () => {
  withFreshMemoryHome((memory, tmpDir) => {
    seed(memory);
    // Force the FTS path to throw by dropping the virtual FTS table. The
    // FTS MATCH on the SQL inside searchMemoryItems will raise, the
    // try/catch falls through to Tier 3 LIKE per-token OR.
    const dbPath = path.join(tmpDir, '.metame', 'memory.db');
    const aux = new DatabaseSync(dbPath);
    // Drop external-content FTS triggers first to avoid cascade errors,
    // then drop the FTS virtual table itself.
    aux.exec('DROP TRIGGER IF EXISTS mi_ai');
    aux.exec('DROP TRIGGER IF EXISTS mi_ad');
    aux.exec('DROP TRIGGER IF EXISTS mi_au');
    aux.exec('DROP TABLE IF EXISTS memory_items_fts');
    aux.close();

    // Force memory module to reopen so the new (FTS-less) DB is used.
    try { memory.forceClose(); } catch { /* ignore */ }

    // Multi-token query — would normally hit Tier 1 / Tier 2 via FTS.
    // With FTS dropped, Tier 1 throws → catch → Tier 3 LIKE per-token OR.
    const rows = memory.searchMemoryItems('daemon-claude-engine askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const ids = new Set(rows.map(r => r.id));
    // Per-token OR LIKE matches every active row that contains at least
    // one of the two tokens — i.e. mi_A (both), mi_B (askClaude),
    // mi_C (daemon-claude-engine).
    assert.ok(ids.has('mi_A'), 'mi_A surfaced via LIKE');
    assert.ok(ids.has('mi_B'), 'mi_B surfaced via LIKE');
    assert.ok(ids.has('mi_C'), 'mi_C surfaced via LIKE');
    // Archived row stays excluded by the state filter that LIKE inherits.
    assert.ok(!ids.has('mi_D'), 'archived row still excluded under LIKE path');
  });
});

test('trackSearch=false honoured across Tier 1 / Tier 2', () => {
  withFreshMemoryHome((memory, tmpDir) => {
    seed(memory);
    const ids = ['mi_A', 'mi_B', 'mi_C'];
    const before = inspectCounts(tmpDir, ids);

    // Tier 1 hit — no bump expected.
    memory.searchMemoryItems('daemon-claude-engine askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const afterT1 = inspectCounts(tmpDir, ids);
    assert.deepEqual(afterT1, before, 'Tier 1 must not bump search_count when trackSearch=false');

    // Tier 2 hit — no bump expected either.
    memory.searchMemoryItems('scripts/daemon-claude-engine.js askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const afterT2 = inspectCounts(tmpDir, ids);
    assert.deepEqual(afterT2, before, 'Tier 2 must not bump search_count when trackSearch=false');
  });
});

test('trackSearch default true: Tier 2 bumps search_count exactly like Tier 1', () => {
  withFreshMemoryHome((memory, tmpDir) => {
    seed(memory);
    const ids = ['mi_A', 'mi_B', 'mi_C'];
    const before = inspectCounts(tmpDir, ids);
    memory.searchMemoryItems('scripts/daemon-claude-engine.js askClaude', {
      project: 'metame', scope: 'main', limit: 10,
    });
    const after = inspectCounts(tmpDir, ids);
    // At least one row's count went up — across multiple rows.
    const bumped = after.filter((row, i) => row.search_count > (before[i] && before[i].search_count));
    assert.ok(bumped.length >= 1, 'default trackSearch=true must bump at least one row via Tier 2');
  });
});

test('searchFacts (post-filtered convention/insight) survives Tier 2 path', () => {
  withFreshMemoryHome((memory) => {
    // Same shape as the OR test above: no row carries both tokens, so
    // Tier 1 AND is empty and Tier 2 OR must surface BOTH single-token rows.
    memory.saveMemoryItem({
      id: 'mi_B', kind: 'convention', state: 'active',
      title: 'B', content: 'askClaude is called once per turn',
      project: 'metame', scope: 'main',
    });
    memory.saveMemoryItem({
      id: 'mi_C', kind: 'insight', state: 'active',
      title: 'C', content: 'daemon-claude-engine wires the spawn helper',
      project: 'metame', scope: 'main',
    });
    const facts = memory.searchFacts('daemon-claude-engine askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    const ids = new Set(facts.map(f => f.id));
    assert.ok(ids.has('mi_B'), 'B is convention — kept');
    assert.ok(ids.has('mi_C'), 'C is insight — kept');
  });
});

test('empty query returns most-recent rows (no FTS path used)', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    const rows = memory.searchMemoryItems('', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    // 3 active rows under matching scope. mi_D archived excluded.
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.state, 'active');
  });
});

test('whitespace-only query treated as empty', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    const rows = memory.searchMemoryItems('   \t  ', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    assert.equal(rows.length, 3);
  });
});

test('quotes in user input are stripped before phrase wrapping (no FTS syntax error)', () => {
  withFreshMemoryHome((memory) => {
    seed(memory);
    // Quotes inside a token would break the FTS5 phrase grammar; the
    // sanitiser must strip them.
    const rows = memory.searchMemoryItems('"daemon-claude-engine" askClaude', {
      project: 'metame', scope: 'main', limit: 10, trackSearch: false,
    });
    // Should still find at least mi_A (Tier 1 with the unquoted tokens).
    assert.ok(rows.length >= 1);
  });
});
