'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('../memory-wiki-schema');
const { ingestDiscoveredSessions } = require('../cognitive-ingestion');
const { createClaudeSessionSourceAdapter, redactSecrets } = require('./claude-session-source-adapter');

const FIXTURE_ROOT = path.join(__dirname, 'fixtures');

async function discoverAll(source, request = {}) {
  const refs = [];
  for await (const ref of source.discover(request)) refs.push(ref);
  return refs;
}

test('Claude adapter discovers real JSONL records and projects bounded canonical evidence', async () => {
  const source = createClaudeSessionSourceAdapter({
    projectsRoot: FIXTURE_ROOT,
    maxToolText: 40,
  });
  const refs = await discoverAll(source);
  assert.equal(refs.length, 2);
  const parent = refs.find(ref => ref.nativeSessionId === 'claude-fixture-parent');
  const child = refs.find(ref => ref.nativeSessionId === 'claude-fixture-subagent');
  assert.ok(parent);
  assert.equal(child.parentNativeSessionId, 'claude-fixture-parent');

  const firstRevision = await source.inspect(parent);
  const secondRevision = await source.inspect(parent);
  assert.equal(firstRevision.sourceRevision, secondRevision.sourceRevision);
  assert.equal(firstRevision.classification, 'conversation');

  const events = [];
  for await (const event of source.read(parent, { sourceRevision: firstRevision.sourceRevision })) events.push(event);
  assert.deepEqual(events.map(event => `${event.actor}:${event.kind}`), [
    'user:message', 'tool:tool_call', 'tool:tool_result', 'assistant:message',
    'tool:tool_call', 'tool:tool_result',
  ]);
  assert.ok(events.every(event => event.sourceRevision === firstRevision.sourceRevision));
  assert.ok(events.every(event => !event.text.includes('FACTS:START')));
  assert.ok(events.every(event => !event.text.includes('sk-ant-placeholder')));
  assert.ok(events.find(event => event.kind === 'tool_result').text.length <= 40);
  assert.ok(events.every(event => !Object.hasOwn(event.provenance || {}, 'transcript')));
});

test('Claude adapter recognizes growing revisions and rejects stale reads', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-claude-source-'));
  const sourcePath = path.join(tmpRoot, 'session.jsonl');
  fs.copyFileSync(path.join(FIXTURE_ROOT, 'claude-native-session.jsonl'), sourcePath);
  const source = createClaudeSessionSourceAdapter({ projectsRoot: tmpRoot });
  const ref = (await discoverAll(source))[0];
  const initial = await source.inspect(ref);
  fs.appendFileSync(sourcePath, `${JSON.stringify({ type: 'user', sessionId: 'claude-fixture-parent', timestamp: '2026-07-01T10:01:00.000Z', message: { content: '新增上下文' } })}\n`);
  const grown = await source.inspect(ref);
  assert.notEqual(grown.sourceRevision, initial.sourceRevision);
  await assert.rejects(
    async () => { for await (const _event of source.read(ref, { sourceRevision: initial.sourceRevision })) { /* consume */ } },
    /session_source_revision_mismatch/
  );
});

test('Claude discovery applies its cap after newest-session ordering', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-claude-order-'));
  const writeSession = (name, sessionId) => {
    const filePath = path.join(tmpRoot, name);
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'user', sessionId, message: { content: `session ${sessionId}` } })}\n`);
    return filePath;
  };
  const oldPath = writeSession('a-old.jsonl', 'old-session');
  const newPath = writeSession('z-new.jsonl', 'new-session');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const newTime = new Date('2026-07-02T00:00:00.000Z');
  fs.utimesSync(oldPath, oldTime, oldTime);
  fs.utimesSync(newPath, newTime, newTime);

  const source = createClaudeSessionSourceAdapter({ projectsRoot: tmpRoot });
  const refs = await discoverAll(source, { limit: 1 });
  assert.deepEqual(refs.map(ref => ref.nativeSessionId), ['new-session']);
});

test('Claude adapter redacts prefixed environment secret names', () => {
  const redacted = redactSecrets('OPENAI_API_KEY=example-value AWS_SECRET_ACCESS_KEY:another-value');
  assert.equal(redacted, 'OPENAI_API_KEY=[REDACTED_SECRET] AWS_SECRET_ACCESS_KEY:[REDACTED_SECRET]');
});

test('Claude adapter feeds canonical ingestion with parent attribution and opaque provenance', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyWikiSchema(db);
  const source = createClaudeSessionSourceAdapter({ projectsRoot: FIXTURE_ROOT, maxToolText: 40 });
  const results = await ingestDiscoveredSessions({ db, adapter: source, pipelineVersion: 't15-test' });

  assert.equal(results.length, 1);
  assert.equal(results[0].events.every(event => event.engineId === 'claude'), true);
  assert.equal(results[0].events.every(event => event.sourceRevision === results[0].revision.sourceRevision), true);
  const row = db.prepare('SELECT source_path, source_locator, source_hash, parent_native_session_id FROM session_sources').get();
  assert.equal(row.source_path, null);
  assert.match(row.source_locator, /relativePath/);
  assert.equal(row.source_hash, results[0].revision.sourceRevision);
  assert.equal(row.parent_native_session_id, null);
  db.close();
});
