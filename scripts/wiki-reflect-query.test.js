'use strict';

require('./test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { queryRawFacts, queryRelatedTopics, queryTopicEvidence, queryTopicResearch } = require('./wiki-reflect-query');
const { upsertDocSource } = require('./core/wiki-db');
const { mkdtempForTest } = require('./test-support/test-utils');

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
      project   TEXT,
      scope     TEXT,
      task_key  TEXT,
      canonical_key TEXT,
      source_type TEXT,
      source_id TEXT,
      tags      TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  return db;
}

function insertFact(db, {
  id, tag, state = 'active', relation = null, searchCount = 0, confidence = 0.5,
  project = null, kind = 'insight', canonicalKey = `wiki.${id}`, taskKey = null,
}) {
  db.prepare(`
    INSERT INTO memory_items (id, kind, state, content, relation, search_count, confidence, tags, project, task_key, canonical_key)
    VALUES (?, ?, ?, 'fact content', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, kind, state, relation, searchCount, confidence, JSON.stringify([tag]), project, taskKey, canonicalKey);
}

test('queryTopicEvidence resolves normalized aliases and retains project semantics', () => {
  const db = buildTestDb();
  insertFact(db, { id: 'upper', tag: 'Ｓｔｅｐ３', project: 'MetaMe' });
  insertFact(db, { id: 'lower', tag: 'step3', project: 'metame' });
  insertFact(db, { id: 'semantic', tag: 'step3-2', project: 'MetaMe' });
  insertFact(db, { id: 'episode', tag: 'step3', project: 'MetaMe', kind: 'episode' });
  const rows = queryTopicEvidence(db, ['Step3']);
  assert.deepEqual(rows.map(row => row.id).sort(), ['lower', 'upper']);
  assert.equal(rows.find(row => row.id === 'upper').project, 'MetaMe');
  db.close();
});

test('queryTopicResearch requires exact aliases across two facts and two documents', () => {
  const db = buildTestDb();
  for (const [index, slug] of ['paper-a', 'paper-b'].entries()) {
    upsertDocSource(db, {
      filePath: `/tmp/${slug}.md`, fileHash: `h${index}`, mtimeMs: index + 1, sizeBytes: 10,
      fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: `t${index}`,
      title: index === 0 ? null : `Paper ${index + 1}`, slug,
    });
  }
  const docs = db.prepare('SELECT id, slug FROM doc_sources ORDER BY slug').all();
  db.prepare(`INSERT INTO research_entities (id, entity_type, name, aliases) VALUES ('e1','concept','Lithology','["岩性"]')`).run();
  for (const [index, doc] of docs.entries()) {
    const factId = `pf${index}`;
    db.prepare(`INSERT INTO paper_facts (id, doc_source_id, fact_type, evidence_text) VALUES (?,?,'claim',?)`).run(factId, doc.id, `evidence ${index}`);
    db.prepare(`INSERT INTO fact_entity_links (fact_id, entity_id, role) VALUES (?,'e1','subject')`).run(factId);
  }
  const research = queryTopicResearch(db, ['岩性']);
  assert.equal(research.length, 2);
  assert.equal(research[0].title, research[0].slug, 'missing document title falls back to slug');
  assert.deepEqual(queryTopicResearch(db, ['lithologies']), []);
  db.close();
});

test('queryRelatedTopics uses same-project active atomic co-occurrence with a two-fact floor', () => {
  const db = buildTestDb();
  const { upsertWikiTopic } = require('./core/wiki-db');
  upsertWikiTopic(db, 'step3', { force: true });
  upsertWikiTopic(db, 'workflow', { force: true });
  upsertWikiTopic(db, 'noise', { force: true });
  for (const [id, tags] of [['r1', ['step3', 'workflow']], ['r2', ['Step3', 'workflow']], ['r3', ['step3', 'noise']]]) {
    db.prepare(`INSERT INTO memory_items (id,kind,state,content,tags,project,canonical_key) VALUES (?,'insight','active','fact',?,'MetaMe',?)`).run(id, JSON.stringify(tags), `wiki.${id}`);
  }
  assert.deepEqual(queryRelatedTopics(db, ['step3']).map(row => row.slug), ['workflow']);
  db.close();
});

test('queryRawFacts returns totalCount=0 when no facts exist', () => {
  const db = buildTestDb();
  const { totalCount, facts } = queryRawFacts(db, 'missing-tag');
  assert.equal(totalCount, 0);
  assert.equal(facts.length, 0);
  db.close();
});

test('queryRawFacts counts active and candidate raw facts only (not derived)', () => {
  const db = buildTestDb();

  insertFact(db, { id: 'f1', tag: 'session' });
  insertFact(db, { id: 'f2', tag: 'session' });
  insertFact(db, { id: 'f3', tag: 'session', relation: 'synthesized_insight' }); // derived, excluded
  insertFact(db, { id: 'f4', tag: 'session', state: 'candidate' });               // candidate, included for first build

  const { totalCount, facts } = queryRawFacts(db, 'session');
  assert.equal(totalCount, 3, 'should count active/candidate non-derived facts');
  assert.equal(facts.length, 3);
  db.close();
});

test('queryRawFacts excludes task Episodes and legacy null-key rows from Wiki evidence', () => {
  const db = buildTestDb();
  insertFact(db, { id: 'canonical', tag: 'boundary' });
  insertFact(db, { id: 'task-episode', tag: 'boundary', kind: 'episode', canonicalKey: null, taskKey: 'session-1' });
  insertFact(db, { id: 'legacy-null', tag: 'boundary', canonicalKey: null });
  const { totalCount, facts } = queryRawFacts(db, 'boundary');
  assert.equal(totalCount, 1);
  assert.deepEqual(facts.map(row => row.id), ['canonical']);
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

test('queryRawFacts never folds capsule Markdown back into evidence', () => {
  const db = buildTestDb();
  const tmpDir = mkdtempForTest('wiki-test-');

  try {
    fs.writeFileSync(path.join(tmpDir, 'session-management.md'),
      '---\ntitle: Session\n---\nSessions are managed by the engine.\nMore details here.');
    fs.writeFileSync(path.join(tmpDir, 'model-switching.md'),
      'Model switching content.');

    const { capsuleExcerpts } = queryRawFacts(db, 'session', { capsulesDir: tmpDir });
    assert.equal(capsuleExcerpts, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  db.close();
});

test('queryRawFacts ignores capsule frontmatter and body', () => {
  const db = buildTestDb();
  const tmpDir = mkdtempForTest('wiki-test-');

  try {
    fs.writeFileSync(path.join(tmpDir, 'session.md'),
      '---\ntitle: Session\ntype: capsule\n---\nActual body content here.');

    const { capsuleExcerpts } = queryRawFacts(db, 'session', { capsulesDir: tmpDir });
    assert.equal(capsuleExcerpts, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  db.close();
});
