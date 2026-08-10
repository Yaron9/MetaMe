'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  collectMemoryObservability,
  formatDoctor,
  formatStatus,
  parseCliArgs,
  runMemoryCommand,
} = require('./memory-observability');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-observability-'));
  const dbPath = path.join(root, 'memory.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, kind TEXT, state TEXT, content TEXT, project TEXT, scope TEXT);
    CREATE TABLE wiki_pages (id TEXT, slug TEXT, artifact_status TEXT, staleness REAL);
    CREATE TABLE session_sources (id TEXT, status TEXT);
    CREATE TABLE extraction_runs (id TEXT, status TEXT);
    CREATE TABLE recall_audit_state (key TEXT PRIMARY KEY, value INTEGER);
    CREATE TABLE recall_audit (
      id TEXT PRIMARY KEY, ts TEXT, phase TEXT, should_recall INTEGER, trace_id TEXT,
      source_refs TEXT, injected_chars INTEGER, token_count INTEGER, consumer_stage TEXT, outcome TEXT
    );
    INSERT INTO memory_items VALUES ('f1','convention','active','a durable fact','metame','main');
    INSERT INTO memory_items VALUES ('f2','convention','candidate','duplicate','metame','main');
    INSERT INTO memory_items VALUES ('f3','convention','candidate','duplicate','metame','main');
    INSERT INTO wiki_pages VALUES ('w1','guide','active',0.0);
    INSERT INTO session_sources VALUES ('s1','indexed');
    INSERT INTO extraction_runs VALUES ('x1','completed');
    INSERT INTO recall_audit_state VALUES ('dropped_count',2);
    INSERT INTO recall_audit VALUES
      ('o','2026-08-09T00:00:00Z','observe',1,'trace-1','[]',0,0,NULL,'unknown'),
      ('i','2026-08-09T00:00:00Z','inject',1,'trace-1','["id:f1"]',20,0,NULL,'injected'),
      ('d','2026-08-09T00:00:00Z','consume',0,'trace-1','["id:f1"]',20,0,'delivered','injected');
  `);
  db.close();
  return { root, dbPath };
}

test('memory observability JSON and human formatters share the result model', () => {
  const { root, dbPath } = fixture();
  try {
    const result = collectMemoryObservability({ dbPath, now: '2026-08-10T00:00:00Z' });
    assert.equal(result.schema_version, 1);
    assert.equal(result.window.days, 30);
    assert.equal(result.recall.opportunities, 1);
    assert.equal(result.recall.injected, 1);
    assert.equal(result.recall.delivered, 1);
    assert.equal(result.pipeline.audit_dropped, 2);
    assert.match(formatStatus(result), /audit_rows=3/);
    assert.match(formatDoctor(result), /audit_dropped/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory observability validates --days and doctor exit levels', () => {
  assert.deepEqual(parseCliArgs(['--json', '--days=7']), { days: 7, json: true });
  assert.throws(() => parseCliArgs(['--days=0']), /1 to 365/);
  const previous = process.exitCode;
  const result = runMemoryCommand('doctor', ['--json'], { dbPath: '/missing/memory.db', print: false });
  assert.equal(result.status, 'error');
  assert.equal(process.exitCode, 2);
  process.exitCode = previous;
});
