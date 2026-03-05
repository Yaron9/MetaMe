'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const reflect = require('./memory-nightly-reflect');

describe('memory-nightly-reflect Step4', () => {
  it('queryHotFacts excludes synthesized and capsule relations', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE facts (
        id TEXT PRIMARY KEY,
        entity TEXT,
        relation TEXT,
        value TEXT,
        confidence TEXT,
        search_count INTEGER,
        created_at TEXT,
        superseded_by TEXT,
        conflict_status TEXT
      )
    `);

    const ins = db.prepare(`
      INSERT INTO facts (id, entity, relation, value, confidence, search_count, created_at, superseded_by, conflict_status)
      VALUES (?, ?, ?, ?, 'high', ?, datetime('now'), NULL, 'OK')
    `);
    ins.run('1', 'a.b', 'arch_convention', 'v1', 5);
    ins.run('2', 'a.b', 'synthesized_insight', 'v2', 5);
    ins.run('3', 'a.b', 'knowledge_capsule', 'v3', 5);
    ins.run('4', 'a.b', 'bug_lesson', 'v4', 5);
    ins.run('5', 'a.b', 'project_milestone', 'v5', 5);

    const rows = reflect._private.queryHotFacts(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].relation, 'arch_convention');
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
