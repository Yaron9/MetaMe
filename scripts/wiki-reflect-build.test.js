'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { upsertWikiTopic, getWikiPageBySlug } = require('./core/wiki-db');
const { buildWikiPage } = require('./wiki-reflect-build');

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

test('buildWikiPage returns null when LLM fails', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { force: true });

  const result = await buildWikiPage(db, TOPIC, QUERY_RESULT, {
    allowedSlugs: [],
    providers: makeProviders({ shouldFail: true }),
  });

  assert.equal(result, null, 'should return null on LLM failure');

  // DB should not have any wiki page
  const page = getWikiPageBySlug(db, 'session');
  assert.equal(page, null, 'no wiki page should be written on LLM failure');
  db.close();
});

test('buildWikiPage returns null on empty LLM response', async () => {
  const db = buildTestDb();

  const result = await buildWikiPage(db, TOPIC, QUERY_RESULT, {
    allowedSlugs: [],
    providers: makeProviders({ response: '  ' }),
  });

  assert.equal(result, null, 'should return null on empty LLM response');
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
