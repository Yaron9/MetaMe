'use strict';

/**
 * daemon-wiki.test.js — Unit tests for daemon-wiki.js command handler
 *
 * Tests the /wiki command dispatch and message formatting.
 * Uses in-memory DB + mock bot to avoid Feishu/LLM dependencies.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { upsertWikiTopic } = require('./core/wiki-db');
const { createWikiCommandHandler } = require('./daemon-wiki');

function buildTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'insight',
      state TEXT NOT NULL DEFAULT 'active',
      title TEXT,
      content TEXT NOT NULL DEFAULT '',
      confidence REAL DEFAULT 0.5,
      search_count INTEGER DEFAULT 0,
      relation TEXT,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  applyWikiSchema(db);
  return db;
}

// Mock bot: captures messages
function makeMockBot() {
  const messages = [];
  return {
    messages,
    sendMessage: async (_chatId, text) => { messages.push(text); },
  };
}

// Fake providers
function makeProviders({ response = 'Wiki content.', fail = false } = {}) {
  return {
    callHaiku: async () => { if (fail) throw new Error('LLM error'); return response; },
    buildDistillEnv: () => ({}),
  };
}

function makeHandler(db, providers) {
  const handler = createWikiCommandHandler({
    getDb: () => db,
    providers,
  });
  return handler;
}

async function send(handler, bot, text) {
  return handler.handleWikiCommand({ bot, chatId: 'chat_test', text });
}

// ── /wiki (list) ──────────────────────────────────────────────────────────────

test('/wiki returns empty state message when no pages exist', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki' });
  assert.equal(handled, true);
  assert.equal(bot.messages.length, 1);
  assert.ok(bot.messages[0].includes('暂无页面'), 'should mention no pages');
  db.close();
});

test('/wiki lists pages when they exist', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'session', { label: 'Session', force: true });
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic, raw_source_count, staleness)
    VALUES ('wp1', 'session', 'Session', 'Content', 'session', 8, 0.1)
  `).run();

  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('Session'), 'should include page title');
  assert.ok(bot.messages[0].includes('session'), 'should include slug');
  db.close();
});

// ── /wiki research ────────────────────────────────────────────────────────────

test('/wiki research returns no-results message when nothing found', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki research nonexistent' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('未找到'), 'should say nothing found');
  db.close();
});

test('/wiki research without query sends usage message', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki research ' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('用法'), 'should show usage');
  db.close();
});

// ── /wiki page ────────────────────────────────────────────────────────────────

test('/wiki page <slug> shows page content', async () => {
  const db = buildTestDb();
  upsertWikiTopic(db, 'memory', { force: true });
  db.prepare(`
    INSERT INTO wiki_pages (id, slug, title, content, primary_topic)
    VALUES ('wp2', 'memory', 'Memory System', 'Memory stores knowledge items.', 'memory')
  `).run();

  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki page memory' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('Memory System'), 'should show title');
  assert.ok(bot.messages[0].includes('Memory stores knowledge'), 'should show content');
  db.close();
});

test('/wiki page with missing slug returns error', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki page nonexistent-slug' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('未找到'), 'should say not found');
  db.close();
});

// ── /wiki pin ─────────────────────────────────────────────────────────────────

test('/wiki pin registers a new topic', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki pin session Session管理' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('已注册') || bot.messages[0].includes('注册'), 'should confirm registration');
  assert.ok(bot.messages[0].includes('session'), 'should mention the tag');

  // Verify in DB
  const topics = db.prepare('SELECT * FROM wiki_topics WHERE tag=?').get('session');
  assert.ok(topics, 'topic should exist in DB');
  assert.equal(topics.label, 'Session管理');
  assert.equal(topics.pinned, 1);
  db.close();
});

test('/wiki pin without args shows usage', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki pin ' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('用法'), 'should show usage');
  db.close();
});

// ── /wiki help / unknown subcommand ───────────────────────────────────────────

test('/wiki help shows command list', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki help' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('research'), 'help should mention research');
  assert.ok(bot.messages[0].includes('sync'), 'help should mention sync');
  db.close();
});

test('unknown /wiki subcommand falls back to help', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/wiki unknowncommand' });
  assert.equal(handled, true);
  assert.ok(bot.messages[0].includes('research') || bot.messages[0].includes('Wiki'), 'should show help or wiki info');
  db.close();
});

test('non-wiki command returns false', async () => {
  const db = buildTestDb();
  const bot = makeMockBot();
  const { handleWikiCommand } = makeHandler(db, makeProviders());

  const handled = await handleWikiCommand({ bot, chatId: 'c1', text: '/sessions' });
  assert.equal(handled, false, 'should not handle /sessions');
  assert.equal(bot.messages.length, 0, 'no message should be sent');
  db.close();
});
