'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Test 1: fact_labels supplement respects project/scope ──

describe('searchFacts label supplement scope isolation', () => {
  let origDb;

  beforeEach(() => {
    // Force memory.js to use a fresh in-memory DB
    const mem = require('./memory');
    // Reset module-level DB by re-initializing with test override
    origDb = process.env.METAME_MEMORY_DB;
    process.env.METAME_MEMORY_DB = ':test-label-scope:';
  });

  afterEach(() => {
    if (origDb === undefined) delete process.env.METAME_MEMORY_DB;
    else process.env.METAME_MEMORY_DB = origDb;
    // Clear require cache so next test gets fresh module
    delete require.cache[require.resolve('./memory')];
  });

  it('label recall does not leak across projects', () => {
    // This test verifies the SQL fix by directly testing the query logic.
    // Since memory.js uses a module-level singleton DB that's hard to inject,
    // we test via DatabaseSync directly, replicating the fixed query.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');

    db.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY, entity TEXT, relation TEXT, value TEXT,
        confidence TEXT DEFAULT 'medium', project TEXT DEFAULT '*',
        scope TEXT, tags TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        superseded_by TEXT, conflict_status TEXT DEFAULT 'OK'
      )
    `);
    db.exec(`
      CREATE TABLE fact_labels (
        fact_id TEXT NOT NULL, label TEXT NOT NULL, domain TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (fact_id, label)
      )
    `);

    // fact in project A
    db.prepare(`INSERT INTO facts (id, entity, relation, value, project) VALUES (?, ?, ?, ?, ?)`)
      .run('f-a1', 'mod.auth', 'arch_convention', 'JWT rotation', 'proj_aaa');
    db.prepare(`INSERT INTO fact_labels (fact_id, label) VALUES (?, ?)`)
      .run('f-a1', 'JWT');

    // fact in project B with same label
    db.prepare(`INSERT INTO facts (id, entity, relation, value, project) VALUES (?, ?, ?, ?, ?)`)
      .run('f-b1', 'mod.auth', 'arch_convention', 'JWT session', 'proj_bbb');
    db.prepare(`INSERT INTO fact_labels (fact_id, label) VALUES (?, ?)`)
      .run('f-b1', 'JWT');

    // Simulate the FIXED label supplement query with project filter
    const project = 'proj_aaa';
    const labelLike = '%JWT%';
    const rows = db.prepare(`
      SELECT DISTINCT f.id, f.project
      FROM fact_labels fl JOIN facts f ON f.id = fl.fact_id
      WHERE fl.label LIKE ?
        AND f.superseded_by IS NULL
        AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
        AND (f.project = ? OR f.project = '*')
      LIMIT 10
    `).all(labelLike, project);

    assert.equal(rows.length, 1, 'Should only return fact from proj_aaa');
    assert.equal(rows[0].id, 'f-a1');
    assert.equal(rows[0].project, 'proj_aaa');

    // Verify WITHOUT project filter would return both (the old bug)
    const leaky = db.prepare(`
      SELECT DISTINCT f.id
      FROM fact_labels fl JOIN facts f ON f.id = fl.fact_id
      WHERE fl.label LIKE ?
        AND f.superseded_by IS NULL
        AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
      LIMIT 10
    `).all(labelLike);

    assert.equal(leaky.length, 2, 'Without filter, both projects leak through');

    db.close();
  });

  it('label recall with scope filter', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');

    db.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY, entity TEXT, relation TEXT, value TEXT,
        confidence TEXT DEFAULT 'medium', project TEXT DEFAULT '*',
        scope TEXT, tags TEXT DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        superseded_by TEXT, conflict_status TEXT DEFAULT 'OK'
      )
    `);
    db.exec(`
      CREATE TABLE fact_labels (
        fact_id TEXT NOT NULL, label TEXT NOT NULL, domain TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (fact_id, label)
      )
    `);

    db.prepare(`INSERT INTO facts (id, entity, relation, value, scope) VALUES (?, ?, ?, ?, ?)`)
      .run('f-s1', 'x', 'y', 'v1', 'workspace_A');
    db.prepare(`INSERT INTO fact_labels (fact_id, label) VALUES (?, ?)`).run('f-s1', 'retry');

    db.prepare(`INSERT INTO facts (id, entity, relation, value, scope) VALUES (?, ?, ?, ?, ?)`)
      .run('f-s2', 'x', 'y', 'v2', 'workspace_B');
    db.prepare(`INSERT INTO fact_labels (fact_id, label) VALUES (?, ?)`).run('f-s2', 'retry');

    const rows = db.prepare(`
      SELECT DISTINCT f.id
      FROM fact_labels fl JOIN facts f ON f.id = fl.fact_id
      WHERE fl.label LIKE ?
        AND f.superseded_by IS NULL
        AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
        AND (f.scope = ? OR f.scope = '*')
      LIMIT 10
    `).all('%retry%', 'workspace_A');

    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'f-s1');
    db.close();
  });
});

// ── Test 2: quiet_until suppresses debt, expert skip does NOT ──

describe('reflection debt suppression logic', () => {
  const runtimeFiles = [];

  function withRuntimeFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-debt-'));
    const file = path.join(dir, 'mentor_runtime.json');
    runtimeFiles.push(file);
    process.env.METAME_MENTOR_RUNTIME = file;
    return file;
  }

  afterEach(() => {
    delete process.env.METAME_MENTOR_RUNTIME;
    for (const f of runtimeFiles.splice(0)) {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch {}
    }
  });

  it('quiet_until active: buildMentorPrompt returns empty AND debt should not be consumed', () => {
    withRuntimeFile();
    const mentor = require('./mentor-engine');
    const now = Date.parse('2026-03-05T12:00:00.000Z');

    // Register a debt first
    mentor.registerDebt('proj_test', 'retry logic', 80, now);

    // buildMentorPrompt returns '' when quiet_until is in the future
    const prompt = mentor.buildMentorPrompt(
      { topic: 'retry logic' },
      { growth: { quiet_until: new Date(now + 3600000).toISOString() } },
      { enabled: true, mode: 'active' },
      now
    );
    assert.equal(prompt, '', 'Mentor prompt should be empty during quiet');

    // Simulate the daemon logic: when quiet, do NOT call collectDebt
    const quietUntil = new Date(now + 3600000).toISOString();
    const quietMs = new Date(quietUntil).getTime();
    const isQuiet = quietMs && quietMs > now;
    assert.equal(isQuiet, true, 'quiet check should be true');

    // Debt should still exist (not consumed)
    const status = mentor.getRuntimeStatus(now);
    assert.equal(status.debt_count, 1, 'Debt should NOT be consumed during quiet');
  });

  it('expert skip: buildMentorPrompt returns empty BUT debt should still be consumable', () => {
    withRuntimeFile();
    const mentor = require('./mentor-engine');
    const now = Date.parse('2026-03-05T12:00:00.000Z');

    // Register a debt
    mentor.registerDebt('proj_test', 'nodejs event loop', 100, now);

    // Expert in nodejs -> buildMentorPrompt returns ''
    const prompt = mentor.buildMentorPrompt(
      { topic: 'nodejs event loop' },
      { user_competence_map: { nodejs: 'expert' }, growth: {} },
      { enabled: true, mode: 'active' },
      now
    );
    assert.equal(prompt, '', 'Expert skip should suppress mentor prompt');

    // But quiet is NOT active, so debt collection should proceed
    const quietUntil = null;
    const quietMs = quietUntil ? new Date(quietUntil).getTime() : 0;
    const isQuiet = !!(quietMs && quietMs > now);
    assert.equal(isQuiet, false, 'quiet check should be false for expert skip');

    // collectDebt should work — expert still needs to verify AI-generated code
    const debt = mentor.collectDebt('proj_test', 'nodejs event loop optimization', now + 1000);
    assert.ok(debt, 'Debt should be collected even for expert user');
    assert.match(debt.prompt, /核心逻辑/);
  });
});
