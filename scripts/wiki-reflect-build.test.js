'use strict';

require('./test-support/env-setup');
const { test, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { upsertWikiTopic, getWikiPageBySlug } = require('./core/wiki-db');
const { buildWikiPage, buildFallbackWikiContent } = require('./wiki-reflect-build');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  applyWikiSchema(db);
  return db;
}

// Build a fake providers object
function makeProviders({ response = 'Generated wiki content.', shouldFail = false } = {}) {
  return {
    callHaiku: async (_prompt, _env, _timeout, _opts) => {
      if (shouldFail) throw new Error('LLM timeout');
      return response;
    },
    buildDistillEnv: () => ({}),
  };
}

const TOPIC = { tag: 'session', slug: 'session', label: 'Session Management' };
const QUERY_RESULT = {
  totalCount: 12,
  facts: [
    { id: 'f1', title: 'Session init', content: 'Sessions start when user sends /cd', confidence: 0.9, search_count: 5 },
    { id: 'f2', title: 'Session resume', content: 'Use /resume to list sessions', confidence: 0.8, search_count: 3 },
  ],
  capsuleExcerpts: 'Background context about session handling.',
};

test('buildWikiPage writes page to DB and returns result', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { force: true });

  const result = await buildWikiPage(db, TOPIC, QUERY_RESULT, {
    allowedSlugs: ['session'],
    providers: makeProviders({ response: 'Sessions are managed by daemon.js.' }),
  });

  assert.ok(result !== null, 'should return result on success');
  assert.equal(result.slug, 'session');
  assert.ok(result.content.includes('Sessions are managed'), 'content should match LLM output');
  assert.deepEqual(result.rawSourceIds, ['f1', 'f2']);
  assert.equal(result.strippedLinks.length, 0, 'no links stripped from clean content');

  const page = getWikiPageBySlug(db, 'session');
  assert.ok(page, 'wiki_pages row should exist');
  assert.equal(page.primary_topic, 'session');
  assert.equal(page.raw_source_count, 12);
  assert.equal(page.staleness, 0.0, 'staleness should be reset to 0 after build');
  assert.equal(page.new_facts_since_build, 0);
  assert.ok(page.last_built_at, 'last_built_at should be set');
  db.close();
});

test('buildWikiPage returns null when LLM throws (retry scheduled by caller)', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { force: true });

  const result = await buildWikiPage(db, TOPIC, QUERY_RESULT, {
    allowedSlugs: [],
    providers: makeProviders({ shouldFail: true }),
  });

  assert.strictEqual(result, null, 'LLM failure must return null so caller can enqueue retry');
  assert.strictEqual(getWikiPageBySlug(db, 'session'), null, 'no DB row should be written on LLM failure');
  db.close();
});

test('buildWikiPage returns null when LLM response is empty (retry scheduled by caller)', async () => {
  const db = buildTestDb();

  const result = await buildWikiPage(db, TOPIC, QUERY_RESULT, {
    allowedSlugs: [],
    providers: makeProviders({ response: '  ' }),
  });

  assert.strictEqual(result, null, 'empty LLM response must return null so caller can enqueue retry');
  db.close();
});

test('buildWikiPage strips illegal [[wikilinks]] from content', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { force: true });

  const response = 'Sessions use [[session]] and [[unknown-slug]] for tracking.';
  const result = await buildWikiPage(db, TOPIC, QUERY_RESULT, {
    allowedSlugs: ['session'], // 'unknown-slug' is NOT allowed
    providers: makeProviders({ response }),
  });

  assert.ok(result !== null);
  assert.deepEqual(result.strippedLinks, ['unknown-slug'], 'stripped links should be reported');
  assert.ok(!result.content.includes('[[unknown-slug]]'), 'illegal link should be stripped');
  assert.ok(result.content.includes('[[session]]'), 'valid link should be kept');
  db.close();
});

test('buildWikiPage resets staleness on an existing stale page', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { force: true });

  // Pre-insert a stale page
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic, staleness, new_facts_since_build, raw_source_count)
    VALUES ('wp_1', 'session', 'Session', 'Old content', 'session', 0.6, 8, 10)
  `).run();

  await buildWikiPage(db, TOPIC, { ...QUERY_RESULT, totalCount: 18 }, {
    allowedSlugs: [],
    providers: makeProviders({ response: 'New content.' }),
  });

  const page = getWikiPageBySlug(db, 'session');
  assert.equal(page.staleness, 0.0, 'staleness should be 0 after rebuild');
  assert.equal(page.new_facts_since_build, 0, 'new_facts_since_build should be 0 after rebuild');
  assert.equal(page.raw_source_count, 18, 'raw_source_count should be updated');
  db.close();
});

test('buildWikiPage uses topic.tag as title when label is missing', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { force: true });

  const topicNoLabel = { tag: 'session', slug: 'session' }; // no label

  const result = await buildWikiPage(db, topicNoLabel, QUERY_RESULT, {
    allowedSlugs: [],
    providers: makeProviders({ response: 'Content.' }),
  });

  assert.ok(result !== null);
  const page = getWikiPageBySlug(db, 'session');
  assert.equal(page.title, 'session', 'should fall back to tag as title');
  db.close();
});

test('buildFallbackWikiContent produces readable markdown from facts', () => {
  const content = buildFallbackWikiContent(TOPIC, QUERY_RESULT);
  assert.match(content, /## 概览/);
  assert.match(content, /## 关键事实/);
  assert.match(content, /Session init/);
});

// ── writeWikiPageWithChunks tests ──────────────────────────────────────────────

function openTestDb() {
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  return db;
}

describe('buildDocWikiPage', () => {
  it('builds a wiki page with source_type=doc and primary link', async () => {
    const { buildDocWikiPage } = require('./wiki-reflect-build');
    const { upsertDocSource } = require('./core/wiki-db');
    const db = openTestDb();

    upsertDocSource(db, {
      filePath: '/tmp/build-test.md',
      fileHash: 'h1', mtimeMs: 1, sizeBytes: 10,
      fileType: 'md', extractor: 'direct', extractStatus: 'ok',
      extractedTextHash: 'th1', title: 'My Doc', slug: 'my-doc',
    });
    const docSrc = db.prepare("SELECT * FROM doc_sources WHERE slug='my-doc'").get();

    const providers = {
      callHaiku: async () => '## My Doc\n\nThis is the doc content here.',
      buildDistillEnv: () => ({}),
    };

    const result = await buildDocWikiPage(db, docSrc, 'Full document text here for the page', {
      allowedSlugs: ['my-doc'],
      providers,
    });

    assert.ok(result, 'should return a result');
    assert.equal(result.slug, 'my-doc');

    const page = db.prepare("SELECT source_type, primary_topic FROM wiki_pages WHERE slug='my-doc'").get();
    assert.equal(page.source_type, 'doc');
    assert.equal(page.primary_topic, 'my-doc');

    const link = db.prepare("SELECT * FROM wiki_page_doc_sources WHERE page_slug='my-doc' AND role='primary'").get();
    assert.ok(link, 'should have wiki_page_doc_sources primary link');
  });

  it('returns null when LLM returns empty content', async () => {
    const { buildDocWikiPage } = require('./wiki-reflect-build');
    const { upsertDocSource } = require('./core/wiki-db');
    const db = openTestDb();

    upsertDocSource(db, {
      filePath: '/tmp/empty-test.md', fileHash: 'h2', mtimeMs: 1, sizeBytes: 5,
      fileType: 'md', extractor: 'direct', extractStatus: 'ok',
      extractedTextHash: 'th2', title: 'Empty', slug: 'empty-doc',
    });
    const docSrc = db.prepare("SELECT * FROM doc_sources WHERE slug='empty-doc'").get();

    const providers = {
      callHaiku: async () => '',  // empty response
      buildDistillEnv: () => ({}),
    };

    const result = await buildDocWikiPage(db, docSrc, 'text', { allowedSlugs: [], providers });
    assert.equal(result, null);
  });
});

describe('buildTopicClusterPage', () => {
  it('builds a cluster page linking to member doc pages', async () => {
    const db = openTestDb();
    const { upsertDocSource } = require('./core/wiki-db');
    const { buildDocWikiPage, buildTopicClusterPage } = require('./wiki-reflect-build');
    const providers = {
      callHaiku: async () => '## Cluster\n\nA synthesis of related documents.',
      buildDistillEnv: () => ({}),
    };

    // Create 3 doc sources + their pages
    const docs = ['alpha', 'beta', 'gamma'];
    const docRows = [];
    for (const name of docs) {
      upsertDocSource(db, { filePath: `/tmp/${name}.md`, fileHash: name, mtimeMs: 1,
        sizeBytes: 10, fileType: 'md', extractor: 'direct', extractStatus: 'ok',
        extractedTextHash: name, title: name, slug: name });
      docRows.push(db.prepare(`SELECT * FROM doc_sources WHERE slug=?`).get(name));
      await buildDocWikiPage(db, docRows.at(-1), `Content of ${name}`, { allowedSlugs: docs, providers });
    }

    const clusterResult = await buildTopicClusterPage(db, docRows, {
      allowedSlugs: docs,
      providers,
      existingClusters: [],
    });

    assert.ok(clusterResult, 'should return a result object');
    assert.ok(clusterResult.slug.startsWith('cluster-'));
    assert.ok(Array.isArray(clusterResult.strippedLinks));
    const page = db.prepare(`SELECT source_type, cluster_size FROM wiki_pages WHERE slug=?`).get(clusterResult.slug);
    assert.equal(page.source_type, 'topic_cluster');
    assert.equal(page.cluster_size, 3);
    const members = db.prepare(`SELECT * FROM wiki_page_doc_sources WHERE page_slug=? AND role='cluster_member'`).all(clusterResult.slug);
    assert.equal(members.length, 3);
  });
});

describe('writeWikiPageWithChunks', () => {
  it('inserts wiki_page with source_type=doc and content_chunks', () => {
    const { writeWikiPageWithChunks } = require('./wiki-reflect-build');
    const db = openTestDb();
    writeWikiPageWithChunks(db, {
      slug: 'test-doc',
      title: 'Test Doc',
      primary_topic: 'test-doc',
      source_type: 'doc',
      staleness: 0.0,
    }, 'Some content for the page that is long enough to chunk properly', { docSourceIds: [] });

    const page = db.prepare("SELECT slug, source_type FROM wiki_pages WHERE slug='test-doc'").get();
    assert.equal(page.source_type, 'doc');
    const chunks = db.prepare("SELECT * FROM content_chunks WHERE page_slug='test-doc'").all();
    assert.ok(chunks.length >= 1);
  });

  it('replaces existing chunks on rebuild', () => {
    const { writeWikiPageWithChunks } = require('./wiki-reflect-build');
    const db = openTestDb();
    writeWikiPageWithChunks(db, { slug: 's', title: 'S', primary_topic: 's', source_type: 'doc', staleness: 0.0 },
      'old content here', { docSourceIds: [] });
    const firstChunks = db.prepare("SELECT id FROM content_chunks WHERE page_slug='s'").all();

    writeWikiPageWithChunks(db, { slug: 's', title: 'S', primary_topic: 's', source_type: 'doc', staleness: 0.0 },
      'completely new and different content here for the second version', { docSourceIds: [] });
    const secondChunks = db.prepare("SELECT id FROM content_chunks WHERE page_slug='s'").all();

    const firstIds = new Set(firstChunks.map(c => c.id));
    assert.ok(secondChunks.every(c => !firstIds.has(c.id)), 'chunks should be replaced (new IDs)');
  });

  it('enqueues embeddings for each chunk', () => {
    const { writeWikiPageWithChunks } = require('./wiki-reflect-build');
    const db = openTestDb();
    writeWikiPageWithChunks(db, { slug: 'emb', title: 'E', primary_topic: 'emb', source_type: 'doc', staleness: 0.0 },
      'content for embedding test', { docSourceIds: [] });
    const queued = db.prepare("SELECT * FROM embedding_queue WHERE item_type='chunk'").all();
    assert.ok(queued.length >= 1);
  });

  it('writes doc_source link when docSourceIds provided', () => {
    const { writeWikiPageWithChunks } = require('./wiki-reflect-build');
    const { upsertDocSource } = require('./core/wiki-db');
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/link.md', fileHash: 'h', mtimeMs: 1, sizeBytes: 1,
      fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th',
      title: 'Link', slug: 'link-doc' });
    const docRow = db.prepare("SELECT id FROM doc_sources WHERE slug='link-doc'").get();

    writeWikiPageWithChunks(db, { slug: 'link-doc', title: 'L', primary_topic: 'link-doc', source_type: 'doc', staleness: 0.0 },
      'linked content', { docSourceIds: [docRow.id], role: 'primary' });

    const link = db.prepare("SELECT * FROM wiki_page_doc_sources WHERE page_slug='link-doc' AND role='primary'").get();
    assert.ok(link, 'should have wiki_page_doc_sources primary link');
  });

  it('commits dossier metadata, scopes, evidence, chunks, and page atomically', () => {
    const { writeWikiPageWithChunks } = require('./wiki-reflect-build');
    const db = openTestDb();
    writeWikiPageWithChunks(db, {
      slug: 'step3/projects/metame', title: 'Step3 · MetaMe', primary_topic: 'step3',
      source_type: 'memory', page_kind: 'project_dossier', project_key: 'metame',
      build_profile: 'local-dossier-v1', source_membership_hash: 'hash-1',
      raw_source_ids: '["m1","m2","m3"]', raw_source_count: 3,
    }, 'project grounded content', {
      scopes: ['metame', 'proj_metame', 'metame'],
      evidence: [
        { evidence_type: 'memory_item', evidence_id: 'm1' },
        { evidence_type: 'memory_item', evidence_id: 'm2' },
      ],
    });
    const page = db.prepare(`SELECT * FROM wiki_pages WHERE slug='step3/projects/metame'`).get();
    assert.equal(page.page_kind, 'project_dossier');
    assert.equal(page.project_key, 'metame');
    assert.equal(page.source_membership_hash, 'hash-1');
    assert.deepEqual(db.prepare('SELECT scope_key FROM wiki_page_scopes WHERE page_slug=? ORDER BY scope_key').all(page.slug).map(row => row.scope_key), ['metame', 'proj_metame']);
    assert.deepEqual(db.prepare('SELECT evidence_id FROM wiki_page_evidence WHERE page_slug=? ORDER BY evidence_id').all(page.slug).map(row => row.evidence_id), ['m1', 'm2']);
  });
});

describe('Hub and project dossier builders', () => {
  it('builds a grounded project dossier and deterministic Hub', async () => {
    const { buildProjectDossier, buildTopicHubPage } = require('./wiki-reflect-build');
    const db = openTestDb();
    const topic = { tag: 'Step3', slug: 'step3', label: 'Step3' };
    const facts = ['1', '2', '3'].map(id => ({
      id, content: `local fact ${id}`, state: 'active', kind: 'insight',
      project: 'MetaMe', scope: 'proj_metame', created_at: '2026-01-01',
    }));
    const providers = {
      buildDistillEnv: () => ({}),
      callHaiku: async () => JSON.stringify({ claims: [{
        section: 'decisions', text: '采用本地投影', evidenceRefs: ['M:1', 'M:2'],
      }] }),
    };
    const dossier = await buildProjectDossier(db, topic, 'metame', facts, { providers });
    assert.equal(dossier.slug, 'step3/projects/metame');
    assert.match(dossier.content, /采用本地投影/);
    const hub = buildTopicHubPage(db, topic, { dossiers: [{ projectKey: 'metame', facts }], sparse: [] });
    assert.match(hub.content, /step3\/projects\/metame/);
    assert.doesNotMatch(hub.content, /local fact/);
    assert.equal(db.prepare(`SELECT page_kind FROM wiki_pages WHERE slug=?`).get(dossier.slug).page_kind, 'project_dossier');
  });

  it('preserves the old dossier when structured output is invalid', async () => {
    const { buildProjectDossier, writeWikiPageWithChunks } = require('./wiki-reflect-build');
    const db = openTestDb();
    const slug = 'step3/projects/metame';
    writeWikiPageWithChunks(db, { slug, title: 'old', primary_topic: 'step3' }, 'old usable content');
    const result = await buildProjectDossier(db, { tag: 'Step3', slug: 'step3' }, 'metame', [
      { id: '1', content: 'fact', state: 'active', kind: 'insight', project: 'MetaMe' },
    ], {
      providers: { buildDistillEnv: () => ({}), callHaiku: async () => '{"claims":[{"section":"decisions","text":"bad","evidenceRefs":["M:404"]}]}' },
    });
    assert.equal(result, null);
    assert.equal(db.prepare('SELECT content FROM wiki_pages WHERE slug=?').get(slug).content, 'old usable content');
  });

  it('retries the whole structured response without JSON repair', async () => {
    const { buildProjectDossier } = require('./wiki-reflect-build');
    const db = openTestDb();
    let calls = 0;
    const result = await buildProjectDossier(db, { tag: 'Step3', slug: 'step3' }, 'metame', [
      { id: '1', content: 'fact', state: 'active', kind: 'insight', project: 'MetaMe' },
    ], {
      providers: {
        buildDistillEnv: () => ({}),
        callHaiku: async () => ++calls === 1 ? 'not json' : '{"claims":[{"section":"current_state","text":"ok","evidenceRefs":["M:1"]}]}',
      },
    });
    assert.equal(calls, 2);
    assert.equal(result.claims[0].text, 'ok');
  });
});
