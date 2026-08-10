'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { importWikiAnnotation } = require('./wiki-annotation');

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, summary TEXT, confidence REAL,
      project TEXT, scope TEXT, task_key TEXT, session_id TEXT, agent_key TEXT,
      canonical_key TEXT, supersedes_id TEXT, source_type TEXT, source_id TEXT,
      origin_class TEXT DEFAULT 'primary', provenance_root_id TEXT, relation TEXT,
      search_count INTEGER DEFAULT 0, last_searched_at TEXT, tags TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  db.prepare(`
    INSERT INTO wiki_pages (id,slug,title,content,primary_topic,project_key,projection_hash)
    VALUES ('wp-1','topics/test','Test','generated','test','metame','base-hash')
  `).run();
  return db;
}

function notesFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-annotation-'));
  const file = path.join(dir, 'notes.md');
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

test('plain annotation is stored separately and never writes memory_items', () => {
  const db = fixture();
  const notes = notesFile('Human note: verify this generated page before relying on it.\n');
  const result = importWikiAnnotation({ db, slug: 'topics/test', fromFile: notes.file });
  assert.equal(result.state, 'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n, 0);
  const row = db.prepare('SELECT page_slug,base_projection_hash,status,content FROM wiki_annotations').get();
  assert.equal(row.page_slug, 'topics/test');
  assert.equal(row.base_projection_hash, 'base-hash');
  assert.equal(row.status, 'pending');
  assert.match(row.content, /Human note/);
  db.close();
  fs.rmSync(notes.dir, { recursive: true, force: true });
});

test('pending annotation can later be admitted with an explicit claim key', () => {
  const db = fixture();
  const notes = notesFile('The project policy requires a review before generated Wiki export.');
  const pending = importWikiAnnotation({ db, slug: 'topics/test', fromFile: notes.file });
  assert.equal(pending.state, 'pending');
  const admitted = importWikiAnnotation({
    db,
    slug: 'topics/test',
    fromFile: notes.file,
    claimKey: 'metame.policy.review',
  });
  assert.equal(admitted.state, 'admitted');
  assert.equal(admitted.idempotent, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_items').get().n, 1);
  assert.equal(db.prepare('SELECT claim_key FROM wiki_annotations').get().claim_key, 'metame.policy.review');
  db.close();
  fs.rmSync(notes.dir, { recursive: true, force: true });
});

test('claim-key annotation follows Claim Contract and records candidate lineage', () => {
  const db = fixture();
  const notes = notesFile('The project policy requires a review before generated Wiki export.');
  const result = importWikiAnnotation({
    db,
    slug: 'topics/test',
    fromFile: notes.file,
    claimKey: 'MetaMe.Policy.Review',
  });
  assert.equal(result.state, 'admitted');
  const claim = db.prepare('SELECT state,project,scope,canonical_key,source_type FROM memory_items').get();
  assert.deepEqual({ state: claim.state, project: claim.project, scope: claim.scope, canonical_key: claim.canonical_key, source_type: claim.source_type }, {
    state: 'candidate', project: 'metame', scope: 'metame', canonical_key: 'metame.policy.review', source_type: 'human_annotation',
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_lineage WHERE parent_kind='wiki_annotation'").get().n, 1);
  db.close();
  fs.rmSync(notes.dir, { recursive: true, force: true });
});

test('annotation requires a baseline and rejects traversal', () => {
  const db = fixture();
  db.prepare("UPDATE wiki_pages SET projection_hash=NULL WHERE slug='topics/test'").run();
  const notes = notesFile('A bounded note that should not be admitted without a generated baseline.');
  assert.throws(() => importWikiAnnotation({ db, slug: 'topics/test', fromFile: notes.file }), /baseline/);
  assert.throws(() => importWikiAnnotation({ db, slug: '../topics/test', fromFile: notes.file }), /invalid wiki slug/);
  db.close();
  fs.rmSync(notes.dir, { recursive: true, force: true });
});
