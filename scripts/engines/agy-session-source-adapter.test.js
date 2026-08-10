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
const { runSessionSourceConformance } = require('./session-source-adapter');
const { createAgySessionSourceAdapter } = require('./agy-session-source-adapter');
const { createDefaultEngineRegistry } = require('./engine-registry');

const FIXTURE = path.join(__dirname, 'agy-fixtures', 'agy-native-session.jsonl');

function makeHome(prefix = 'metame-agy-source-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSession(home, sessionId = 'agy-fixture-session') {
  const agyHome = path.join(home, '.gemini', 'antigravity-cli');
  const transcript = path.join(agyHome, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.copyFileSync(FIXTURE, transcript);
  fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(agyHome, 'conversations', `${sessionId}.pb`), Buffer.from('fixture protobuf marker'));
  fs.mkdirSync(path.join(agyHome, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(agyHome, 'cache', 'last_conversations.json'), JSON.stringify({
    [path.join(home, 'project')]: sessionId,
  }));
  return { agyHome, transcript };
}

async function discoverAll(source, request = {}) {
  const refs = [];
  for await (const ref of source.discover(request)) refs.push(ref);
  return refs;
}

test('agy adapter discovers opaque transcript sources and projects sanitized canonical evidence', async () => {
  const home = makeHome();
  fs.mkdirSync(path.join(home, 'project'));
  writeSession(home);
  const source = createAgySessionSourceAdapter({ home });
  const refs = await discoverAll(source);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].nativeSessionId, 'agy-fixture-session');
  assert.equal(refs[0].cwd, fs.realpathSync(path.join(home, 'project')));
  assert.equal(refs[0].sourceLocator.sessionId, 'agy-fixture-session');
  assert.equal(JSON.stringify(refs[0].sourceLocator).includes(home), false);

  const revision = await source.inspect(refs[0]);
  assert.equal(revision.conversationAvailable, true);
  assert.equal(revision.unknownRecordCount, 1);
  assert.equal(revision.ownership, 'cache');
  const events = [];
  for await (const event of source.read(refs[0], { sourceRevision: revision.sourceRevision })) events.push(event);
  assert.deepEqual(events.map(event => `${event.actor}:${event.kind}`), [
    'user:message', 'tool:tool_call', 'tool:tool_result', 'assistant:message',
    'tool:tool_result', 'tool:tool_result', 'tool:tool_result', 'tool:tool_result',
    'tool:tool_result', 'tool:tool_result',
  ]);
  assert.equal(events[1].tool, 'run_command');
  assert.equal(events[2].tool, 'Bash');
  assert.equal(events[2].outcome.exitCode, 0);
  assert.equal(events[4].text.includes('[REDACTED_SECRET]'), true);
  assert.equal(events.some(event => event.text.includes('private planner reasoning')), false);
  assert.equal(events.some(event => event.text.includes('FACTS:START')), false);
  assert.ok(events.every(event => event.engineId === 'agy'));
  assert.ok(events.every(event => event.sourceRevision === revision.sourceRevision));
  assert.ok(events.every(event => !Object.hasOwn(event.provenance || {}, 'thinking')));
  assert.equal(runSessionSourceConformance(source).ok, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy revisions and cursors detect append/change and resume after the prior native record', async () => {
  const home = makeHome();
  const { transcript } = writeSession(home);
  const source = createAgySessionSourceAdapter({ home });
  const ref = (await discoverAll(source))[0];
  const initial = await source.inspect(ref);
  fs.appendFileSync(transcript, `${JSON.stringify({
    type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', step_index: 11,
    created_at: '2026-07-20T08:00:11.000Z', content: 'append evidence',
  })}\n`);
  const grown = await source.inspect(ref);
  assert.notEqual(grown.sourceRevision, initial.sourceRevision);
  const resumed = [];
  for await (const event of source.read(ref, { sourceRevision: grown.sourceRevision, cursor: initial.cursor })) resumed.push(event);
  assert.deepEqual(resumed.map(event => event.text), ['append evidence']);
  await assert.rejects(
    async () => { for await (const _event of source.read(ref, { sourceRevision: initial.sourceRevision })) { /* consume */ } },
    /session_source_.*revision_mismatch/
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy defers an unterminated final JSONL record without losing its cursor position', async () => {
  const home = makeHome();
  const { transcript } = writeSession(home, 'agy-partial');
  const first = { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'first' };
  const second = { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'second' };
  const encodedSecond = JSON.stringify(second);
  const splitAt = Math.floor(encodedSecond.length / 2);
  fs.writeFileSync(transcript, `${JSON.stringify(first)}\n${encodedSecond.slice(0, splitAt)}`);
  const source = createAgySessionSourceAdapter({ home });
  const ref = (await discoverAll(source))[0];
  const partial = await source.inspect(ref);
  assert.equal(partial.partialFinalLine, true);
  assert.equal(partial.cursor.sequence, 1);
  assert.equal((await source.validate(ref)).valid, true);

  fs.appendFileSync(transcript, `${encodedSecond.slice(splitAt)}\n`);
  const complete = await source.inspect(ref);
  assert.equal(complete.partialFinalLine, false);
  const resumed = [];
  for await (const event of source.read(ref, {
    sourceRevision: complete.sourceRevision,
    cursor: partial.cursor,
  })) resumed.push(event);
  assert.deepEqual(resumed.map(event => event.text), ['second']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy discovery applies subagent filters even without project or cwd queries', async () => {
  const home = makeHome();
  writeSession(home, 'agy-parent');
  const child = writeSession(home, 'agy-child');
  fs.writeFileSync(child.transcript, [
    {
      type: 'USER_INPUT', source: 'USER_EXPLICIT', status: 'DONE', content: 'child request',
    },
    {
      type: 'PLANNER_RESPONSE', status: 'DONE', parentSessionId: 'agy-parent', content: 'child answer',
    },
  ].map(record => JSON.stringify(record)).join('\n'));
  const source = createAgySessionSourceAdapter({ home });
  const all = await discoverAll(source, { includeSubagents: true, suppressOwnedSubagents: false });
  assert.deepEqual(all.map(ref => ref.nativeSessionId).sort(), ['agy-child', 'agy-parent']);
  const withoutSubagents = await discoverAll(source, { includeSubagents: false });
  assert.deepEqual(withoutSubagents.map(ref => ref.nativeSessionId), ['agy-parent']);
  const withoutOwnedSubagents = await discoverAll(source, {
    includeSubagents: true,
    suppressOwnedSubagents: true,
  });
  assert.deepEqual(withoutOwnedSubagents.map(ref => ref.nativeSessionId), ['agy-parent']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy discovery cursor replays a stable newest-first snapshot', async () => {
  const home = makeHome();
  const first = writeSession(home, 'agy-old');
  const second = writeSession(home, 'agy-new');
  const oldTime = new Date('2026-07-20T00:00:00.000Z');
  const newTime = new Date('2026-07-21T00:00:00.000Z');
  fs.utimesSync(first.transcript, oldTime, oldTime);
  fs.utimesSync(second.transcript, newTime, newTime);
  const source = createAgySessionSourceAdapter({ home });
  const page = await discoverAll(source, { limit: 1 });
  assert.equal(page[0].nativeSessionId, 'agy-new');
  assert.ok(page[0].discoveryCursor);
  fs.utimesSync(first.transcript, new Date('2026-07-22T00:00:00.000Z'), new Date('2026-07-22T00:00:00.000Z'));
  const next = await discoverAll(source, { limit: 1, cursor: page[0].discoveryCursor });
  assert.deepEqual(next.map(ref => ref.nativeSessionId), ['agy-old']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy discovery excludes PB-only sessions while direct diagnostics stay explicit', async () => {
  const home = makeHome();
  const old = writeSession(home, 'agy-readable-old');
  const newest = writeSession(home, 'agy-readable-new');
  const agyHome = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });
  const pbOnly = path.join(agyHome, 'conversations', 'agy-pb-only.pb');
  fs.writeFileSync(pbOnly, 'fixture protobuf marker');
  const oldTime = new Date('2026-07-20T00:00:00.000Z');
  const newTime = new Date('2026-07-21T00:00:00.000Z');
  fs.utimesSync(old.transcript, oldTime, oldTime);
  fs.utimesSync(newest.transcript, newTime, newTime);
  fs.utimesSync(pbOnly, new Date('2026-07-22T00:00:00.000Z'), new Date('2026-07-22T00:00:00.000Z'));
  const source = createAgySessionSourceAdapter({ home });
  const page = await discoverAll(source, { limit: 1 });
  assert.deepEqual(page.map(ref => ref.nativeSessionId), ['agy-readable-new']);
  assert.ok(page[0].discoveryCursor);
  const replayed = await discoverAll(source, { limit: 1, cursor: page[0].discoveryCursor });
  assert.deepEqual(replayed.map(ref => ref.nativeSessionId), ['agy-readable-old']);
  assert.deepEqual((await discoverAll(source)).map(ref => ref.nativeSessionId), [
    'agy-readable-new', 'agy-readable-old',
  ]);
  const pbRef = {
    engineId: 'agy',
    nativeSessionId: 'agy-pb-only',
    sourceLocator: { sessionId: 'agy-pb-only' },
  };
  const validation = await source.validate(pbRef);
  assert.equal(validation.valid, false);
  assert.match(validation.errorCode, /transcript_missing/);
  await assert.rejects(() => source.inspect(pbRef), /session_source_.*transcript_missing/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy validation reports missing, malformed, oversized and unsafe sources explicitly', async () => {
  const home = makeHome();
  const agyHome = path.join(home, '.gemini', 'antigravity-cli');
  fs.mkdirSync(path.join(agyHome, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(agyHome, 'conversations', 'missing.pb'), 'pb');
  const source = createAgySessionSourceAdapter({ home });
  const missing = await source.validate({ engineId: 'agy', nativeSessionId: 'missing', sourceLocator: { sessionId: 'missing' } });
  assert.equal(missing.valid, false);
  assert.match(missing.errorCode, /transcript_missing/);
  await assert.rejects(
    () => source.inspect({ engineId: 'agy', nativeSessionId: '../escape', sourceLocator: { sessionId: '../escape' } }),
    /session_source_.*locator_invalid/
  );

  const malformed = path.join(agyHome, 'brain', 'malformed', '.system_generated', 'logs');
  fs.mkdirSync(malformed, { recursive: true });
  fs.writeFileSync(path.join(malformed, 'transcript.jsonl'), '{not-json}\n');
  const malformedResult = await source.validate({ engineId: 'agy', nativeSessionId: 'malformed', sourceLocator: { sessionId: 'malformed' } });
  assert.equal(malformedResult.valid, false);
  assert.equal(malformedResult.errorCode, 'SOURCE_MALFORMED');

  const oversized = path.join(agyHome, 'brain', 'oversized', '.system_generated', 'logs');
  fs.mkdirSync(oversized, { recursive: true });
  fs.writeFileSync(path.join(oversized, 'transcript.jsonl'), JSON.stringify({ type: 'USER_INPUT', content: 'x'.repeat(100) }));
  const limited = createAgySessionSourceAdapter({ home, maxFileSize: 20 });
  const limitedResult = await limited.validate({ engineId: 'agy', nativeSessionId: 'oversized', sourceLocator: { sessionId: 'oversized' } });
  assert.equal(limitedResult.valid, false);
  assert.match(limitedResult.errorCode, /transcript_too_large/);

  const cappedDir = path.join(agyHome, 'brain', 'capped', '.system_generated', 'logs');
  fs.mkdirSync(cappedDir, { recursive: true });
  fs.writeFileSync(path.join(cappedDir, 'transcript.jsonl'), [
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'one' },
    { type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'two' },
  ].map(record => JSON.stringify(record)).join('\n'));
  const capped = createAgySessionSourceAdapter({ home, maxEvents: 1 });
  const cappedResult = await capped.validate({ engineId: 'agy', nativeSessionId: 'capped', sourceLocator: { sessionId: 'capped' } });
  assert.equal(cappedResult.valid, false);
  assert.equal(cappedResult.errorCode, 'AGY_EVENT_LIMIT');
  fs.rmSync(home, { recursive: true, force: true });
});

test('agy adapter feeds the shared cognitive ingestion contract without native branches', async () => {
  const home = makeHome();
  writeSession(home);
  const source = createAgySessionSourceAdapter({ home });
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  const results = await ingestDiscoveredSessions({
    db,
    adapter: source,
    pipelineVersion: 'agy-session-source-fixture-v1',
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].revision.nativeSessionId, 'agy-fixture-session');
  assert.ok(results[0].events.length > 0);
  const row = db.prepare('SELECT engine_id, source_path, source_locator, source_hash FROM session_sources').get();
  assert.equal(row.engine_id, 'agy');
  assert.equal(row.source_path, null);
  assert.match(row.source_locator, /sessionId/);
  assert.equal(row.source_hash, results[0].revision.sourceRevision);
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('default built-in registry verifies agy Session Source while base descriptor stays runtime-only', () => {
  const home = makeHome('metame-agy-registry-');
  const registry = createDefaultEngineRegistry({
    normalizeEngineName: value => String(value || '').trim().toLowerCase(),
    agy: { home, binary: process.execPath, nativeBinary: '/opt/test/agy' },
  });
  const plugin = registry.get('agy');
  assert.equal(plugin.descriptor.capabilities.sessionSource.state, 'verified');
  assert.equal(typeof plugin.sessionSource.discover, 'function');
  assert.equal(runSessionSourceConformance(plugin.sessionSource).ok, true);
  fs.rmSync(home, { recursive: true, force: true });
});
