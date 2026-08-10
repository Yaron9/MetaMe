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
const { extractEvidence } = require('../core/canonical-session-analytics');
const {
  createCodexSessionSourceAdapter,
} = require('./codex-session-source-adapter');

const FIXTURE = path.join(__dirname, 'codex-fixtures', 'codex-native-session.jsonl');

function makeHome(prefix = 'metame-codex-source-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRollout(home, sessionId, records, { day = '15', pad = '' } = {}) {
  const dayDir = path.join(home, '.codex', 'sessions', '2026', '07', day);
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, `rollout-2026-07-${day}T08-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n${pad}`, 'utf8');
  return filePath;
}

function readAll(source, ref, request) {
  return (async () => {
    const events = [];
    for await (const event of source.read(ref, request)) events.push(event);
    return events;
  })();
}

function createThreadsDb(home, rows) {
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const db = new DatabaseSync(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      cwd TEXT,
      title TEXT,
      first_user_message TEXT,
      source TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      archived INTEGER DEFAULT 0,
      model_provider TEXT
    )
  `);
  const insert = db.prepare(`
    INSERT INTO threads (id, rollout_path, cwd, title, first_user_message, source, created_at, updated_at, archived, model_provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.rolloutPath,
      row.cwd || '/tmp/metame-codex-fixture',
      row.title || '',
      row.firstUserMessage || '',
      row.source || 'cli',
      row.createdAt || 1784102400,
      row.updatedAt || 1784102405,
      row.archived ? 1 : 0,
      'openai',
    );
  }
  db.close();
  return path.join(codexDir, 'state_5.sqlite');
}

test('Codex adapter uses state_5.sqlite authority and enriches canonical events from history', async () => {
  const home = makeHome();
  const rolloutPath = path.join(home, 'external-rollout.jsonl');
  fs.copyFileSync(FIXTURE, rolloutPath);
  const historyPath = path.join(home, '.codex', 'history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({
    session_id: 'codex-fixture-parent',
    ts: 1784102401,
    text: '从 history 索引补充的用户请求。',
  }) + '\n', 'utf8');
  createThreadsDb(home, [{ id: 'codex-fixture-parent', rolloutPath }]);

  const source = createCodexSessionSourceAdapter({ home, minFileSize: 0 });
  const refs = source.listSessionRefs({ limit: 10 });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].nativeSessionId, 'codex-fixture-parent');
  assert.equal(refs[0].sourceLocator.authority, 'state_5.sqlite');
  assert.equal(refs[0].sourceLocator.rolloutPath, rolloutPath);

  const revision = await source.inspect(refs[0]);
  const input = source.readPathEvents(rolloutPath, refs[0]);
  assert.equal(input.revision.sourceLocator.authority, 'state_5.sqlite');
  assert.equal(revision.classification, 'conversation');
  assert.equal(revision.toolCallCount, 2);
  assert.equal(revision.toolErrorCount, 1);
  const events = await readAll(source, refs[0], { sourceRevision: revision.sourceRevision });
  assert.deepEqual(events.map(event => `${event.actor}:${event.kind}`), [
    'user:message', 'tool:tool_call', 'tool:tool_result', 'tool:tool_call', 'tool:tool_result',
    'assistant:message', 'assistant:message',
  ]);
  assert.equal(events[0].text, '从 history 索引补充的用户请求。');
  assert.equal(events[1].tool, 'exec_command');
  assert.equal(events[2].outcome.error, false);
  assert.equal(events[3].tool, 'apply_patch');
  assert.equal(events[3].provenance.callId, 'call-function-1');
  assert.equal(events[4].tool, 'apply_patch');
  assert.equal(events[4].provenance.callId, 'call-function-1');
  assert.equal(events[4].outcome.exitCode, 1);
  assert.equal(events[4].outcome.error, true);
  const evidence = extractEvidence(events, 3000);
  assert.ok(evidence.tool_traces.some(trace => trace.startsWith('apply_patch ')));
  assert.ok(evidence.key_results.some(result => result.includes('patch rejected')));
  assert.ok(events.every(event => event.engineId === 'codex'));
  assert.ok(events.every(event => event.sourceRevision === revision.sourceRevision));
});

test('Codex fallback discovers rollout files when state_5.sqlite is unavailable', () => {
  const home = makeHome();
  const sessionId = 'codex-fallback-session';
  const rolloutPath = writeRollout(home, sessionId, [
    { type: 'session_meta', payload: { id: sessionId, cwd: '/tmp/fallback' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fallback source' }] } },
  ], { pad: 'x'.repeat(1200) });
  const source = createCodexSessionSourceAdapter({ home });
  const refs = source.listSessionRefs({ limit: 10 });
  assert.deepEqual(refs.map(ref => ref.nativeSessionId), [sessionId]);
  assert.equal(refs[0].sourceLocator.authority, 'rollout-fallback');
  assert.equal(source.resolveSessionRefPath(refs[0]), rolloutPath);
});

test('Codex revisions include history changes and cursor resumes only new history evidence', async () => {
  const home = makeHome();
  const sessionId = 'codex-growing-session';
  const rolloutPath = writeRollout(home, sessionId, [
    { type: 'session_meta', timestamp: '2026-07-15T08:00:00.000Z', payload: { id: sessionId, cwd: '/tmp/growing' } },
    { type: 'response_item', timestamp: '2026-07-15T08:00:01.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'initial result' }] } },
  ]);
  const historyPath = path.join(home, '.codex', 'history.jsonl');
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.writeFileSync(historyPath, JSON.stringify({ session_id: sessionId, ts: 1784102401, text: 'first history message' }) + '\n', 'utf8');
  const source = createCodexSessionSourceAdapter({ home, minFileSize: 0 });
  const ref = source.listSessionRefs({ limit: 1 })[0];
  const first = await source.inspect(ref);
  const firstEvents = await readAll(source, ref, { sourceRevision: first.sourceRevision });
  assert.equal(firstEvents.filter(event => event.actor === 'user').length, 1);
  fs.appendFileSync(historyPath, JSON.stringify({ session_id: sessionId, ts: 1784102402, text: 'second history message' }) + '\n', 'utf8');
  const grown = await source.inspect(ref);
  assert.notEqual(grown.sourceRevision, first.sourceRevision);
  const resumed = await readAll(source, ref, {
    sourceRevision: grown.sourceRevision,
    cursor: first.cursor,
  });
  assert.deepEqual(resumed.filter(event => event.actor === 'user').map(event => event.text), ['second history message']);
  await assert.rejects(readAll(source, ref, { sourceRevision: first.sourceRevision }), /session_source_revision_mismatch/);
  void rolloutPath;
});

test('Codex subagent ownership is projected and suppressible', () => {
  const home = makeHome();
  const parentId = 'codex-parent-session';
  const childId = 'codex-child-session';
  const parentPath = writeRollout(home, parentId, [
    { type: 'session_meta', payload: { id: parentId, cwd: '/tmp/owner' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'parent work' }] } },
  ], { day: '16' });
  const childPath = writeRollout(home, childId, [
    { type: 'session_meta', payload: { id: childId, cwd: '/tmp/owner', source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child work' }] } },
  ], { day: '16' });
  const source = createCodexSessionSourceAdapter({ home, minFileSize: 0 });
  const refs = source.listSessionRefs({ includeSubagents: true, suppressOwnedSubagents: false, limit: 10 });
  assert.equal(refs.length, 2);
  const child = refs.find(ref => ref.nativeSessionId === childId);
  assert.equal(child.parentNativeSessionId, parentId);
  const ownedSuppressed = source.listSessionRefs({ includeSubagents: true, suppressOwnedSubagents: true, limit: 10 });
  assert.deepEqual(ownedSuppressed.map(ref => ref.nativeSessionId), [parentId]);
  void parentPath;
  void childPath;
});

test('Codex source integrates with the generic ingestion substrate and reprocesses pipeline versions', async () => {
  const home = makeHome();
  const sessionId = 'codex-ingestion-session';
  const rolloutPath = writeRollout(home, sessionId, [
    { type: 'session_meta', payload: { id: sessionId, cwd: '/tmp/ingestion' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ingest this source' }] } },
  ]);
  const source = createCodexSessionSourceAdapter({ home, minFileSize: 0 });
  const db = new DatabaseSync(':memory:');
  applyWikiSchema(db);
  const options = {
    db,
    adapter: source,
    engineId: 'codex',
    pipelineVersion: 'canonical-session-v1',
    now: '2026-08-01T00:00:00Z',
  };
  const first = await ingestDiscoveredSessions(options);
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, true);
  const second = await ingestDiscoveredSessions(options);
  assert.equal(second.length, 1);
  assert.equal(second[0].skipped, true);
  const replayed = await ingestDiscoveredSessions({ ...options, pipelineVersion: 'canonical-session-v2' });
  assert.equal(replayed[0].ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM extraction_runs').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_sources WHERE engine_id = ?').get('codex').count, 1);
  void rolloutPath;
  db.close();
});
