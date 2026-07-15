'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { backfillFactEntityLinks, normalizeEntityName, writeFacts } = require('./wiki-facts');

function openDb() {
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  db.exec('PRAGMA foreign_keys = OFF');
  return db;
}

test('writeFacts atomically creates exact subject/object graph edges', () => {
  const db = openDb();
  const fact = {
    fact_type: 'claim', subject: 'MetaMe', predicate: 'uses', object: 'SQLite',
    evidence_text: 'MetaMe uses SQLite for local persistence.', section: 'method', confidence: 0.9,
  };
  writeFacts(db, 1, [fact]);
  writeFacts(db, 1, [fact]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_facts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM research_entities').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fact_entity_links').get().n, 2);
  assert.deepEqual(db.prepare('SELECT role FROM fact_entity_links ORDER BY role').all().map(row => row.role), ['object', 'subject']);
  db.close();
});

test('backfill is idempotent and binds normalized duplicates to stable canonical entity', () => {
  const db = openDb();
  db.prepare(`INSERT INTO research_entities (id, entity_type, name) VALUES ('ent_old','concept','Skill')`).run();
  db.prepare(`INSERT INTO research_entities (id, entity_type, name) VALUES ('ent_new','concept','skill ')`).run();
  db.prepare(`
    INSERT INTO paper_facts
      (id, doc_source_id, fact_type, subject, object, evidence_text)
    VALUES ('pf_existing', 1, 'claim', 'Ｓｋｉｌｌ', 'Skill', 'same entity on both sides')
  `).run();
  const first = backfillFactEntityLinks(db);
  const second = backfillFactEntityLinks(db);
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  const link = db.prepare(`SELECT entity_id, role FROM fact_entity_links WHERE fact_id='pf_existing'`).get();
  assert.equal(link.entity_id, 'ent_new');
  assert.equal(link.role, 'subject_object');
  assert.equal(normalizeEntityName(' Ｓｋｉｌｌ '), 'skill');
  db.close();
});
