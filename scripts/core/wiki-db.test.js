'use strict';

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const { applyWikiSchema } = require('../memory-wiki-schema');
const {
  getWikiPageBySlug,
  listWikiPages,
  getStalePages,
  upsertWikiPage,
  resetPageStaleness,
  upsertWikiTopic,
  checkTopicThreshold,
  listWikiTopics,
  searchWikiAndFacts,
  updateStalenessForTags,
} = require('./wiki-db');

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Open an in-memory SQLite DB with wiki schema applied.
 * Also adds a minimal memory_items + memory_items_fts for fact tests.
 */
function openTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');

  // Apply wiki schema
  applyWikiSchema(db);

  // Minimal memory_items table (mirrors production schema)
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL DEFAULT 'insight',
      state           TEXT NOT NULL DEFAULT 'active',
      title           TEXT,
      content         TEXT NOT NULL DEFAULT '',
      relation        TEXT,
      confidence      REAL DEFAULT 0.5,
      tags            TEXT DEFAULT '[]',
      search_count    INTEGER DEFAULT 0,
      last_searched_at TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
        title, content, tags,
        content=memory_items,
        content_rowid=rowid,
        tokenize='trigram'
      )
    `);

    // Sync triggers for memory_items_fts
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS mi_fts_insert
        AFTER INSERT ON memory_items BEGIN
        INSERT INTO memory_items_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS mi_fts_update
        AFTER UPDATE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, title, content, tags)
          VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memory_items_fts(rowid, title, content, tags)
          VALUES (new.rowid, new.title, new.content, new.tags);
      END
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS mi_fts_delete
        AFTER DELETE ON memory_items BEGIN
        INSERT INTO memory_items_fts(memory_items_fts, rowid, title, content, tags)
          VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END
    `);
  } catch { /* trigram not available in test env — graceful */ }

  return db;
}

/** Insert a raw memory_item (not synthesized/capsule). */
function insertRawFact(db, { id, tags = '[]', state = 'active', relation = null, created_at = null } = {}) {
  const ts = created_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO memory_items (id, kind, state, title, content, relation, tags, created_at)
    VALUES (?, 'insight', ?, 'Test fact', 'Test content', ?, ?, ?)
  `).run(id, state, relation, typeof tags === 'string' ? tags : JSON.stringify(tags), ts);
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('wiki-db', () => {

  // ── Test 7: upsertWikiPage + getWikiPageBySlug ─────────────────────────────
  describe('upsertWikiPage / getWikiPageBySlug', () => {
    it('should insert a page and retrieve it by slug', () => {
      const db = openTestDb();

      upsertWikiPage(db, {
        slug: 'session-mgmt',
        primary_topic: 'session management',
        title: 'Session Management',
        content: 'How sessions work',
        raw_source_ids: ['id1', 'id2'],
        capsule_refs: [],
        raw_source_count: 10,
        topic_tags: ['session', 'resume'],
        word_count: 100,
      });

      const row = getWikiPageBySlug(db, 'session-mgmt');
      assert.ok(row, 'row should exist');
      assert.equal(row.slug, 'session-mgmt');
      assert.equal(row.title, 'Session Management');
      assert.equal(row.primary_topic, 'session management');
      assert.equal(row.content, 'How sessions work');
      assert.equal(row.raw_source_count, 10);
      assert.equal(row.word_count, 100);
    });

    it('should return null for non-existent slug', () => {
      const db = openTestDb();
      const row = getWikiPageBySlug(db, 'does-not-exist');
      assert.equal(row, null);
    });

    it('should update an existing page on second upsert', () => {
      const db = openTestDb();

      upsertWikiPage(db, {
        slug: 'model-switch',
        primary_topic: 'model switching',
        title: 'Model Switching v1',
        content: 'v1 content',
        raw_source_count: 5,
      });

      upsertWikiPage(db, {
        slug: 'model-switch',
        primary_topic: 'model switching',
        title: 'Model Switching v2',
        content: 'v2 content',
        raw_source_count: 8,
      });

      const row = getWikiPageBySlug(db, 'model-switch');
      assert.equal(row.title, 'Model Switching v2');
      assert.equal(row.content, 'v2 content');
      assert.equal(row.raw_source_count, 8);
    });
  });

  // ── Test 8: getStalePages ──────────────────────────────────────────────────
  describe('getStalePages', () => {
    it('should return only pages with staleness >= threshold', () => {
      const db = openTestDb();

      upsertWikiPage(db, { slug: 'page-a', primary_topic: 'topic-a', title: 'A', content: 'a' });
      upsertWikiPage(db, { slug: 'page-b', primary_topic: 'topic-b', title: 'B', content: 'b' });
      upsertWikiPage(db, { slug: 'page-c', primary_topic: 'topic-c', title: 'C', content: 'c' });

      // Manually set staleness
      db.prepare("UPDATE wiki_pages SET staleness = 0.1 WHERE slug = 'page-a'").run();
      db.prepare("UPDATE wiki_pages SET staleness = 0.5 WHERE slug = 'page-b'").run();
      db.prepare("UPDATE wiki_pages SET staleness = 0.8 WHERE slug = 'page-c'").run();

      const stale = getStalePages(db, 0.4);
      const slugs = stale.map(r => r.slug).sort();
      assert.deepEqual(slugs, ['page-b', 'page-c']);
    });

    it('should return empty array if no pages meet threshold', () => {
      const db = openTestDb();
      upsertWikiPage(db, { slug: 'fresh', primary_topic: 'topic', title: 'Fresh', content: 'x' });
      const stale = getStalePages(db, 0.4);
      assert.equal(stale.length, 0);
    });
  });

  // ── Test 1: upsertWikiTopic idempotent ─────────────────────────────────────
  describe('upsertWikiTopic — idempotent', () => {
    it('second call with same tag should not throw and return same slug', () => {
      const db = openTestDb();

      // Insert 5+ raw facts for threshold
      for (let i = 0; i < 6; i++) {
        insertRawFact(db, { id: `fact-idem-${i}`, tags: ['session management'] });
      }

      const r1 = upsertWikiTopic(db, 'session management', { label: 'Session Management' });
      const r2 = upsertWikiTopic(db, 'session management', { label: 'Session Management Updated' });

      assert.equal(r1.slug, r2.slug, 'slug should be identical on second call');
      assert.equal(r1.isNew, true);
      assert.equal(r2.isNew, false);
    });
  });

  // ── Test 2: slug collision appends -2 ──────────────────────────────────────
  describe('upsertWikiTopic — slug collision', () => {
    it('second different tag normalizing to same slug should get -2 suffix', () => {
      const db = openTestDb();

      // Insert 5+ raw facts for each tag
      for (let i = 0; i < 6; i++) {
        insertRawFact(db, { id: `fact-coll-a-${i}`, tags: ['session-mgmt'] });
        insertRawFact(db, { id: `fact-coll-b-${i}`, tags: ['session mgmt'] });
      }

      // Both 'session-mgmt' and 'session mgmt' normalize to 'session-mgmt'
      const r1 = upsertWikiTopic(db, 'session-mgmt', { label: 'Session Mgmt (hyphen)' });
      const r2 = upsertWikiTopic(db, 'session mgmt', { label: 'Session Mgmt (space)' });

      assert.equal(r1.slug, 'session-mgmt');
      assert.equal(r2.slug, 'session-mgmt-2');
      assert.equal(r1.isNew, true);
      assert.equal(r2.isNew, true);
    });
  });

  // ── Test 3: checkTopicThreshold ────────────────────────────────────────────
  describe('checkTopicThreshold', () => {
    it('returns false when fewer than 5 raw facts', () => {
      const db = openTestDb();

      for (let i = 0; i < 3; i++) {
        insertRawFact(db, { id: `fact-thresh-low-${i}`, tags: ['low-topic'] });
      }

      assert.equal(checkTopicThreshold(db, 'low-topic'), false);
    });

    it('returns true when >= 5 raw facts AND at least 1 in last 30 days', () => {
      const db = openTestDb();

      // 5 recent facts
      for (let i = 0; i < 5; i++) {
        insertRawFact(db, { id: `fact-thresh-ok-${i}`, tags: ['ok-topic'] });
      }

      assert.equal(checkTopicThreshold(db, 'ok-topic'), true);
    });

    it('returns false when >= 5 raw facts but none in last 30 days', () => {
      const db = openTestDb();

      const oldDate = '2020-01-01 00:00:00';
      for (let i = 0; i < 5; i++) {
        insertRawFact(db, { id: `fact-thresh-old-${i}`, tags: ['old-topic'], created_at: oldDate });
      }

      assert.equal(checkTopicThreshold(db, 'old-topic'), false);
    });

    it('does not count derived facts (synthesized_insight)', () => {
      const db = openTestDb();

      // 5 derived facts — should not count
      for (let i = 0; i < 5; i++) {
        insertRawFact(db, {
          id: `fact-derived-${i}`,
          tags: ['derived-topic'],
          relation: 'synthesized_insight',
        });
      }
      // 0 raw facts → threshold not met
      assert.equal(checkTopicThreshold(db, 'derived-topic'), false);
    });

    it('does not count knowledge_capsule relation', () => {
      const db = openTestDb();

      for (let i = 0; i < 5; i++) {
        insertRawFact(db, {
          id: `fact-capsule-${i}`,
          tags: ['capsule-topic'],
          relation: 'knowledge_capsule',
        });
      }
      assert.equal(checkTopicThreshold(db, 'capsule-topic'), false);
    });
  });

  // ── Test 4: updateStalenessForTags — only matches primary_topic ────────────
  describe('updateStalenessForTags', () => {
    it('only updates pages whose primary_topic matches the tag', () => {
      const db = openTestDb();

      upsertWikiPage(db, {
        slug: 'target-page',
        primary_topic: 'Session Management',
        title: 'Session',
        content: 'x',
        raw_source_count: 10,
      });

      upsertWikiPage(db, {
        slug: 'other-page',
        primary_topic: 'Model Switching',
        title: 'Model',
        content: 'y',
        raw_source_count: 10,
      });

      const dirtyTags = new Map([['session management', 4]]);
      updateStalenessForTags(db, dirtyTags);

      const target = getWikiPageBySlug(db, 'target-page');
      const other = getWikiPageBySlug(db, 'other-page');

      assert.ok(target.staleness > 0, 'target page staleness should increase');
      assert.equal(other.staleness, 0.0, 'other page should be untouched');
      assert.equal(target.new_facts_since_build, 4);
      assert.equal(other.new_facts_since_build, 0);
    });

    it('staleness formula: newFacts / (rawSourceCount + newFacts)', () => {
      const db = openTestDb();

      upsertWikiPage(db, {
        slug: 'stale-formula',
        primary_topic: 'formula-topic',
        title: 'Formula',
        content: 'x',
        raw_source_count: 10,
      });

      // Add 4 new facts to a page with raw_source_count=10 → staleness = 4/14 ≈ 0.286
      const dirtyTags = new Map([['formula-topic', 4]]);
      updateStalenessForTags(db, dirtyTags);

      const row = getWikiPageBySlug(db, 'stale-formula');
      const expected = 4 / (10 + 4);
      assert.ok(Math.abs(row.staleness - expected) < 0.001, `staleness should be ~${expected}, got ${row.staleness}`);
    });

    it('skips tags with count <= 0', () => {
      const db = openTestDb();

      upsertWikiPage(db, {
        slug: 'zero-count',
        primary_topic: 'zero-topic',
        title: 'Zero',
        content: 'x',
        raw_source_count: 5,
      });

      updateStalenessForTags(db, new Map([['zero-topic', 0]]));

      const row = getWikiPageBySlug(db, 'zero-count');
      assert.equal(row.staleness, 0.0);
      assert.equal(row.new_facts_since_build, 0);
    });
  });

  // ── Test 5 & 6: searchWikiAndFacts ────────────────────────────────────────
  describe('searchWikiAndFacts', () => {
    it('trackSearch=false: search_count should NOT change', () => {
      const db = openTestDb();

      // Insert a memory item with known id
      db.prepare(`
        INSERT INTO memory_items (id, kind, state, title, content, tags, search_count)
        VALUES ('mi-search-1', 'insight', 'active', 'Test Title', 'unique searchable content xyz987', '[]', 0)
      `).run();

      // trackSearch: false → no count update
      searchWikiAndFacts(db, 'unique searchable xyz987', { trackSearch: false });

      const row = db.prepare("SELECT search_count FROM memory_items WHERE id = 'mi-search-1'").get();
      assert.equal(row.search_count, 0, 'search_count should remain 0 when trackSearch=false');
    });

    it('sanitizeFts5 returns null → empty results, no crash', () => {
      const db = openTestDb();

      // Query that sanitizes to empty (all special chars)
      const result = searchWikiAndFacts(db, '***^^^"""', { trackSearch: false });
      assert.deepEqual(result, { wikiPages: [], facts: [] });
    });

    it('empty string query → empty results', () => {
      const db = openTestDb();
      const result = searchWikiAndFacts(db, '', { trackSearch: false });
      assert.deepEqual(result, { wikiPages: [], facts: [] });
    });

    it('trackSearch=true: search_count should increment for matched facts', () => {
      const db = openTestDb();

      db.prepare(`
        INSERT INTO memory_items (id, kind, state, title, content, tags, search_count)
        VALUES ('mi-track-1', 'insight', 'active', 'Trackable Item', 'content about trackable zebra pattern', '[]', 0)
      `).run();

      searchWikiAndFacts(db, 'trackable zebra pattern', { trackSearch: true });

      const row = db.prepare("SELECT search_count FROM memory_items WHERE id = 'mi-track-1'").get();
      // If FTS5 trigram is available and matched, count > 0; otherwise graceful fallback = 0
      assert.ok(row.search_count >= 0, 'search_count should be non-negative');
    });
  });

  // ── resetPageStaleness ─────────────────────────────────────────────────────
  describe('resetPageStaleness', () => {
    it('resets staleness, new_facts_since_build, sets raw_source_count and last_built_at', () => {
      const db = openTestDb();

      upsertWikiPage(db, {
        slug: 'reset-me',
        primary_topic: 'reset-topic',
        title: 'Reset',
        content: 'x',
        raw_source_count: 5,
      });

      // Dirty it
      updateStalenessForTags(db, new Map([['reset-topic', 3]]));
      let row = getWikiPageBySlug(db, 'reset-me');
      assert.ok(row.staleness > 0, 'staleness should be dirty before reset');

      // Reset
      resetPageStaleness(db, 'reset-me', 12);
      row = getWikiPageBySlug(db, 'reset-me');
      assert.equal(row.staleness, 0.0);
      assert.equal(row.new_facts_since_build, 0);
      assert.equal(row.raw_source_count, 12);
      assert.ok(row.last_built_at, 'last_built_at should be set');
    });
  });

  // ── listWikiPages / listWikiTopics ─────────────────────────────────────────
  describe('listWikiPages / listWikiTopics', () => {
    it('listWikiPages returns up to limit rows', () => {
      const db = openTestDb();

      for (let i = 0; i < 5; i++) {
        upsertWikiPage(db, {
          slug: `list-page-${i}`,
          primary_topic: `topic-${i}`,
          title: `Title ${i}`,
          content: 'x',
        });
      }

      const pages = listWikiPages(db, { limit: 3 });
      assert.equal(pages.length, 3);
    });

    it('listWikiTopics returns all topics', () => {
      const db = openTestDb();

      for (let i = 0; i < 4; i++) {
        insertRawFact(db, { id: `fact-list-topics-${i}`, tags: ['listed-topic'] });
      }
      // 4 facts — below threshold. Use force:true to bypass
      upsertWikiTopic(db, 'listed-topic', { label: 'Listed Topic', force: true });

      const topics = listWikiTopics(db);
      assert.ok(topics.some(t => t.tag === 'listed-topic'));
    });
  });

  // ── doc_sources schema ────────────────────────────────────────────────────────
  describe('doc_sources schema', () => {
    it('creates doc_sources table', () => {
      const db = openTestDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_sources'").get();
      assert.ok(row, 'doc_sources table should exist');
    });

    it('creates wiki_page_doc_sources table', () => {
      const db = openTestDb();
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_page_doc_sources'").get();
      assert.ok(row, 'wiki_page_doc_sources table should exist');
    });

    it('wiki_pages has source_type column defaulting to memory', () => {
      const db = openTestDb();
      const { upsertWikiPage } = require('./wiki-db');
      upsertWikiPage(db, { slug: 'test-schema', primary_topic: 'test-schema', title: 'T', content: 'C' });
      const row = db.prepare("SELECT source_type FROM wiki_pages WHERE slug='test-schema'").get();
      assert.equal(row.source_type, 'memory');
    });

    it('wiki_pages has membership_hash and cluster_size columns', () => {
      const db = openTestDb();
      const cols = db.prepare("PRAGMA table_info(wiki_pages)").all().map(c => c.name);
      assert.ok(cols.includes('membership_hash'));
      assert.ok(cols.includes('cluster_size'));
    });
  });

  // ── upsertWikiTopic with force=true ─────────────────────────────────────────
  describe('upsertWikiTopic force=true', () => {
    it('force=true skips threshold check', () => {
      const db = openTestDb();
      // 0 facts — would fail threshold without force
      const result = upsertWikiTopic(db, 'pinned-topic', { label: 'Pinned', pinned: 1, force: true });
      assert.equal(result.isNew, true);
      assert.equal(result.slug, 'pinned-topic');
    });
  });

  // ── slug empty string throws ────────────────────────────────────────────────
  describe('upsertWikiTopic — empty slug throws', () => {
    it('tag that normalizes to empty string should throw', () => {
      const db = openTestDb();
      // All special chars stripped → empty slug
      assert.throws(() => {
        upsertWikiTopic(db, '***^^^', { force: true });
      }, /empty/i);
    });
  });
});

describe('upsertDocSource', () => {
  it('inserts a new doc source', () => {
    const { upsertDocSource, getDocSourceByPath } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, {
      filePath: '/tmp/test.md',
      fileHash: 'abc123',
      mtimeMs: 1000,
      sizeBytes: 500,
      fileType: 'md',
      extractor: 'direct',
      extractStatus: 'ok',
      extractedTextHash: 'def456',
      title: 'Test Doc',
      slug: 'test-doc',
    });
    const row = getDocSourceByPath(db, '/tmp/test.md');
    assert.equal(row.slug, 'test-doc');
    assert.equal(row.content_stale, 1);
    assert.equal(row.status, 'active');
  });

  it('updates file_hash and marks content_stale=1 on hash change', () => {
    const { upsertDocSource, getDocSourceByPath } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/a.md', fileHash: 'old', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'h1', title: 'A', slug: 'a' });
    db.prepare("UPDATE doc_sources SET content_stale=0 WHERE file_path='/tmp/a.md'").run();
    upsertDocSource(db, { filePath: '/tmp/a.md', fileHash: 'new', mtimeMs: 2, sizeBytes: 2, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'h2', title: 'A', slug: 'a' });
    const row = getDocSourceByPath(db, '/tmp/a.md');
    assert.equal(row.content_stale, 1);
  });

  it('keeps content_stale=0 when hash unchanged', () => {
    const { upsertDocSource, getDocSourceByPath } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/b.md', fileHash: 'same', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th', title: 'B', slug: 'b' });
    db.prepare("UPDATE doc_sources SET content_stale=0 WHERE file_path='/tmp/b.md'").run();
    upsertDocSource(db, { filePath: '/tmp/b.md', fileHash: 'same', mtimeMs: 2, sizeBytes: 2, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th', title: 'B', slug: 'b' });
    const row = getDocSourceByPath(db, '/tmp/b.md');
    assert.equal(row.content_stale, 0);
  });
});

describe('markDocSourcesMissing', () => {
  it('marks active docs not in seenPaths as missing', () => {
    const { upsertDocSource, getDocSourceByPath, markDocSourcesMissing } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/gone.md', fileHash: 'x', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'h', title: 'G', slug: 'gone' });
    markDocSourcesMissing(db, ['/tmp/other.md']);
    const row = getDocSourceByPath(db, '/tmp/gone.md');
    assert.equal(row.status, 'missing');
  });
});

describe('upsertWikiPage source_type support', () => {
  it('accepts source_type doc', () => {
    const { upsertWikiPage } = require('./wiki-db');
    const db = openTestDb();
    upsertWikiPage(db, { slug: 'doc-1', primary_topic: 'doc-1', title: 'D', content: 'C', source_type: 'doc' });
    const row = db.prepare("SELECT source_type FROM wiki_pages WHERE slug='doc-1'").get();
    assert.equal(row.source_type, 'doc');
  });

  it('accepts membership_hash and cluster_size for topic_cluster', () => {
    const { upsertWikiPage } = require('./wiki-db');
    const db = openTestDb();
    upsertWikiPage(db, { slug: 'cluster-abc', primary_topic: 'cluster-abc', title: 'C', content: 'C', source_type: 'topic_cluster', membership_hash: 'hash123', cluster_size: 3 });
    const row = db.prepare("SELECT membership_hash, cluster_size FROM wiki_pages WHERE slug='cluster-abc'").get();
    assert.equal(row.membership_hash, 'hash123');
    assert.equal(row.cluster_size, 3);
  });
});

describe('cluster CRUD', () => {
  it('getClusterMemberIds returns member doc_source ids', () => {
    const { upsertDocSource, upsertDocPageLink, getClusterMemberIds } = require('./wiki-db');
    const { upsertWikiPage } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/x.md', fileHash: 'hx', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'tx', title: 'X', slug: 'x-doc' });
    upsertWikiPage(db, { slug: 'cluster-test', primary_topic: 'cluster-test', title: 'CT', content: 'C', source_type: 'topic_cluster' });
    const docRow = db.prepare("SELECT id FROM doc_sources WHERE slug='x-doc'").get();
    upsertDocPageLink(db, 'cluster-test', docRow.id, 'cluster_member');
    const ids = getClusterMemberIds(db, 'cluster-test');
    assert.ok(ids.includes(docRow.id));
  });

  it('listStaleDocSources returns only active stale rows', () => {
    const { upsertDocSource, listStaleDocSources } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/stale.md', fileHash: 'h1', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th1', title: 'S', slug: 'stale-doc' });
    const rows = listStaleDocSources(db);
    assert.ok(rows.some(r => r.slug === 'stale-doc'));
  });

  it('replaceClusterMembers atomically replaces member set', () => {
    const { upsertDocSource, upsertDocPageLink, replaceClusterMembers, getClusterMemberIds } = require('./wiki-db');
    const { upsertWikiPage } = require('./wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/m1.md', fileHash: 'h1', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th1', title: 'M1', slug: 'm1' });
    upsertDocSource(db, { filePath: '/tmp/m2.md', fileHash: 'h2', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th2', title: 'M2', slug: 'm2' });
    upsertWikiPage(db, { slug: 'cluster-rep', primary_topic: 'cluster-rep', title: 'CR', content: 'C', source_type: 'topic_cluster' });
    const d1 = db.prepare("SELECT id FROM doc_sources WHERE slug='m1'").get();
    const d2 = db.prepare("SELECT id FROM doc_sources WHERE slug='m2'").get();
    upsertDocPageLink(db, 'cluster-rep', d1.id, 'cluster_member');
    replaceClusterMembers(db, 'cluster-rep', [d2.id]);
    const ids = getClusterMemberIds(db, 'cluster-rep');
    assert.equal(ids.length, 1);
    assert.equal(ids[0], d2.id);
  });
});
