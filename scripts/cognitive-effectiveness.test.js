'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { collectReport, main, render } = require('./cognitive-effectiveness');

test('collectReport audits existing assets against the four-stage consumption chain', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cognitive-audit-'));
  const dbPath = path.join(root, 'memory.db');
  const skillsDir = path.join(root, 'skills');
  fs.mkdirSync(path.join(skillsDir, 'demo'), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE memory_items (id TEXT PRIMARY KEY, kind TEXT, state TEXT);
    CREATE TABLE wiki_pages (slug TEXT PRIMARY KEY, source_type TEXT, artifact_status TEXT);
    CREATE TABLE recall_audit (
      ts TEXT, phase TEXT, should_recall INTEGER, consumer_stage TEXT,
      engine TEXT, consumer_type TEXT, agent_key TEXT
    );
    INSERT INTO memory_items VALUES ('f1','insight','active');
    INSERT INTO memory_items VALUES ('session1','episode','active');
    INSERT INTO wiki_pages VALUES ('w1','memory','active');
    INSERT INTO recall_audit VALUES (datetime('now'),'observe',1,NULL,NULL,NULL,NULL);
    INSERT INTO recall_audit VALUES (datetime('now'),'consume',0,'delivered','codex','mcp',NULL);
    INSERT INTO recall_audit VALUES (datetime('now'),'consume',0,'validated','codex','mcp','acceptance-test');
  `);
  db.close();
  const report = collectReport({ dbPath, skillsDir, days: 30 });
  assert.deepEqual(report.inventory, { facts: 1, wiki: 1, skills: 1 });
  assert.equal(report.broken_stage, 'opening');
  assert.match(render(report), /funnel delivered=1/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('main reports an unavailable database without throwing', () => {
  const previous = process.exitCode;
  const result = main(['--json'], { dbPath: '/missing/metame-memory.db', home: '/missing', skillsDir: '/missing' });
  assert.equal(result.status, 'unavailable');
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;
});
