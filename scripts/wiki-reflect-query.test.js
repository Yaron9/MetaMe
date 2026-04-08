'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { queryRawFacts } = require('./wiki-reflect-query');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id        TEXT PRIMARY KEY,
      kind      TEXT NOT NULL,
      state     TEXT NOT NULL DEFAULT 'active',
      title     TEXT,
      content   TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      search_count INTEGER DEFAULT 0,
      relation  TEXT,
      tags      TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  return db;
}

function insertFact(db, { id, tag, state = 'active', relation = null, searchCount = 0, confidence = 0.5 }) {
  db.prepare(`
    INSERT INTO memory_items (id, kind, state, content, relation, search_count, confidence, tags)
    VALUES (?, 'insight', ?, 'fact content', ?, ?, ?, ?)
  `).run(id, state, relation, searchCount, confidence, JSON.stringify([tag]));
}

test('queryRawFacts returns totalCount=0 when no facts exist', () => {
  const db = buildTestDb();
  const { totalCount, facts } = queryRawFacts(db, 'missing-tag');
  assert.equal(totalCount, 0);
  assert.equal(facts.length, 0);
  db.close();
});

test('queryRawFacts counts active raw facts only (not derived)', () => {
  const db = buildTestDb();

  insertFact(db, { id: 'f1', tag: 'session' });
  insertFact(db, { id: 'f2', tag: 'session' });
  insertFact(db, { id: 'f3', tag: 'session', relation: 'synthesized_insight' }); // derived, excluded
  insertFact(db, { id: 'f4', tag: 'session', state: 'candidate' });               // candidate, excluded

  const { totalCount, facts } = queryRawFacts(db, 'session');
  assert.equal(totalCount, 2, 'should count only active non-derived facts');
  assert.equal(facts.length, 2);
  db.close();
});

test('queryRawFacts excludes knowledge_capsule relation', () => {
  const db = buildTestDb();
  insertFact(db, { id: 'f1', tag: 'model', relation: 'knowledge_capsule' });
  insertFact(db, { id: 'f2', tag: 'model' });

  const { totalCount } = queryRawFacts(db, 'model');
  assert.equal(totalCount, 1);
  db.close();
});

test('queryRawFacts returns top 30 ordered by search_count DESC, confidence DESC', () => {
  const db = buildTestDb();

  // Insert 35 facts with varying search counts
  for (let i = 0; i < 35; i++) {
    insertFact(db, { id: `f${i}`, tag: 'topic', searchCount: i, confidence: 0.5 });
  }

  const { totalCount, facts } = queryRawFacts(db, 'topic');
  assert.equal(totalCount, 35, 'totalCount should be 35 (no LIMIT)');
  assert.equal(facts.length, 30, 'facts should be limited to 30');
  // Top entry should have highest search_count
  assert.equal(facts[0].search_count, 34, 'first fact should have highest search_count');
  db.close();
});

test('queryRawFacts tag matching is case-insensitive', () => {
  const db = buildTestDb();
  insertFact(db, { id: 'f1', tag: 'Session' });
  insertFact(db, { id: 'f2', tag: 'SESSION' });
  insertFact(db, { id: 'f3', tag: 'session' });

  const { totalCount } = queryRawFacts(db, 'session');
  assert.equal(totalCount, 3, 'should match all case variants');
  db.close();
});

test('queryRawFacts returns capsuleExcerpts as empty string when dir missing', () => {
  const db = buildTestDb();
  const { capsuleExcerpts } = queryRawFacts(db, 'session', {
    capsulesDir: '/nonexistent/dir'
  });
  assert.equal(capsuleExcerpts, '', 'should return empty string when capsules dir missing');
  db.close();
});

test('queryRawFacts reads capsule files matching tag', () => {
  const db = buildTestDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));

  try {
    fs.writeFileSync(path.join(tmpDir, 'session-management.md'),
      '---\ntitle: Session\n---\nSessions are managed by the engine.\nMore details here.');
    fs.writeFileSync(path.join(tmpDir, 'model-switching.md'),
      'Model switching content.');

    const { capsuleExcerpts } = queryRawFacts(db, 'session', { capsulesDir: tmpDir });
    assert.ok(capsuleExcerpts.includes('session-management.md'), 'should include matching capsule filename');
    assert.ok(capsuleExcerpts.includes('Sessions are managed'), 'should include capsule content');
    assert.ok(!capsuleExcerpts.includes('model-switching'), 'should not include non-matching capsule');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  db.close();
});

test('queryRawFacts strips frontmatter from capsule excerpts', () => {
  const db = buildTestDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));

  try {
    fs.writeFileSync(path.join(tmpDir, 'session.md'),
      '---\ntitle: Session\ntype: capsule\n---\nActual body content here.');

    const { capsuleExcerpts } = queryRawFacts(db, 'session', { capsulesDir: tmpDir });
    assert.ok(!capsuleExcerpts.includes('---'), 'frontmatter should be stripped');
    assert.ok(capsuleExcerpts.includes('Actual body content'), 'body should be included');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  db.close();
});
