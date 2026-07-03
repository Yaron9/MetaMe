'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const reflect = require('./memory-nightly-reflect');

describe('memory-nightly-reflect Step4', () => {
  it('queryHotFacts excludes derived relations but keeps extracted fact relations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        title TEXT,
        kind TEXT,
        relation TEXT,
        content TEXT,
        confidence REAL,
        search_count INTEGER,
        created_at TEXT,
        state TEXT DEFAULT 'active'
      )
    `);

    const ins = db.prepare(`
      INSERT INTO memory_items (id, title, kind, relation, content, confidence, search_count, created_at, state)
      VALUES (?, ?, ?, ?, ?, 0.9, ?, datetime('now'), 'active')
    `);
    ins.run('1', 'a.b', 'convention', 'arch_convention', 'v1', 5);
    ins.run('2', 'a.b', 'insight', 'synthesized_insight', 'v2', 5);
    ins.run('3', 'a.b', 'insight', 'knowledge_capsule', 'v3', 5);
    ins.run('4', 'a.b', 'convention', 'bug_lesson', 'v4', 5);
    ins.run('5', 'a.b', 'insight', 'project_milestone', 'v5', 5);

    const rows = reflect._private.queryHotFacts(db);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.relation).sort(), ['arch_convention', 'bug_lesson', 'project_milestone']);
    db.close();
  });

  it('ensureMemoryItemsCompatibility adds relation column for standalone old databases', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        title TEXT,
        kind TEXT,
        content TEXT,
        confidence REAL,
        search_count INTEGER,
        created_at TEXT,
        state TEXT DEFAULT 'active'
      )
    `);
    reflect._private.ensureMemoryItemsCompatibility(db);
    db.prepare(`
      INSERT INTO memory_items (id, title, kind, relation, content, confidence, search_count, created_at, state)
      VALUES ('1', 'a.b', 'convention', 'workflow_rule', 'old database row still works', 0.9, 0, datetime('now'), 'candidate')
    `).run();
    const rows = reflect._private.queryHotFacts(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].relation, 'workflow_rule');
    db.close();
  });

  it('ensureMemoryItemsCompatibility backfills relation from legacy kind values', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        title TEXT,
        kind TEXT,
        content TEXT,
        confidence REAL,
        search_count INTEGER,
        created_at TEXT,
        state TEXT DEFAULT 'active'
      )
    `);
    db.prepare(`
      INSERT INTO memory_items (id, title, kind, content, confidence, search_count, created_at, state)
      VALUES ('legacy_1', 'old.fact1', 'arch_convention', 'legacy fact stored under kind=arch_convention', 0.9, 0, datetime('now'), 'candidate')
    `).run();
    db.prepare(`
      INSERT INTO memory_items (id, title, kind, content, confidence, search_count, created_at, state)
      VALUES ('legacy_2', 'old.fact2', 'bug_lesson', 'legacy bug lesson stored under kind=bug_lesson', 0.9, 0, datetime('now'), 'active')
    `).run();
    db.prepare(`
      INSERT INTO memory_items (id, title, kind, content, confidence, search_count, created_at, state)
      VALUES ('keep_1', 'normal.fact', 'insight', 'normal modern insight row should not be touched', 0.9, 0, datetime('now'), 'active')
    `).run();

    reflect._private.ensureMemoryItemsCompatibility(db);

    const legacy1 = db.prepare(`SELECT kind, relation FROM memory_items WHERE id = 'legacy_1'`).get();
    const legacy2 = db.prepare(`SELECT kind, relation FROM memory_items WHERE id = 'legacy_2'`).get();
    const keep = db.prepare(`SELECT kind, relation FROM memory_items WHERE id = 'keep_1'`).get();

    assert.equal(legacy1.relation, 'arch_convention');
    assert.equal(legacy1.kind, 'convention');
    assert.equal(legacy2.relation, 'bug_lesson');
    assert.equal(legacy2.kind, 'convention');
    assert.equal(keep.relation, null);
    assert.equal(keep.kind, 'insight');

    // Idempotency: running it again leaves rows unchanged.
    reflect._private.ensureMemoryItemsCompatibility(db);
    const legacy1Again = db.prepare(`SELECT kind, relation FROM memory_items WHERE id = 'legacy_1'`).get();
    assert.equal(legacy1Again.relation, 'arch_convention');
    assert.equal(legacy1Again.kind, 'convention');
    db.close();
  });

  it('queryHotFacts includes high-confidence recent facts before or after promotion', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE memory_items (
        id TEXT PRIMARY KEY,
        title TEXT,
        kind TEXT,
        relation TEXT,
        content TEXT,
        confidence REAL,
        search_count INTEGER,
        created_at TEXT,
        state TEXT DEFAULT 'candidate'
      )
    `);

    db.prepare(`
      INSERT INTO memory_items (id, title, kind, relation, content, confidence, search_count, created_at, state)
      VALUES ('1', 'MetaMe.daemon · arch_convention', 'convention', 'arch_convention',
              'high confidence candidate should feed nightly reflect', 0.9, 0, datetime('now'), 'candidate')
    `).run();
    db.prepare(`
      INSERT INTO memory_items (id, title, kind, relation, content, confidence, search_count, created_at, state)
      VALUES ('2', 'MetaMe.deploy · workflow_rule', 'convention', 'workflow_rule',
              'high confidence active fact should still feed nightly reflect after GC promotion', 0.9, 0, datetime('now'), 'active')
    `).run();
    db.prepare(`
      INSERT INTO memory_items (id, title, kind, relation, content, confidence, search_count, created_at, state)
      VALUES ('3', 'MetaMe.daemon · config_fact', 'convention', 'config_fact',
              'low confidence candidate should stay out of nightly reflect', 0.7, 0, datetime('now'), 'candidate')
    `).run();

    const rows = reflect._private.queryHotFacts(db);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.id).sort(), ['1', '2']);
    db.close();
  });

  it('buildSynthesizedFacts emits synthesized_insight facts', () => {
    const facts = reflect._private.buildSynthesizedFacts(
      '2026-03-05',
      [{ title: '架构决策A', content: '这是决策内容，强调边界、回滚策略以及分层解耦原则。' }],
      [{ title: '经验B', content: '这是操作经验，强调异常恢复路径、重试顺序和日志锚点。' }]
    );
    assert.equal(facts.length, 2);
    assert.equal(facts[0].relation, 'synthesized_insight');
    assert.match(facts[0].entity, /^nightly\.reflect\./);
  });
});
