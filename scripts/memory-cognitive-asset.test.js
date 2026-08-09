'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

test('legacy memory DB migrates supersedes_id and direct fact opens exclude episodes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-cognitive-asset-'));
  const metameDir = path.join(root, '.metame');
  fs.mkdirSync(metameDir);
  const dbPath = path.join(metameDir, 'memory.db');
  const seed = new DatabaseSync(dbPath);
  seed.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, title TEXT,
      content TEXT NOT NULL, summary TEXT, confidence REAL, project TEXT, scope TEXT,
      task_key TEXT, session_id TEXT, agent_key TEXT, source_type TEXT, source_id TEXT,
      origin_class TEXT, provenance_root_id TEXT, search_count INTEGER, last_searched_at TEXT,
      tags TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO memory_items VALUES
      ('fact1','insight','active','Fact','current value',NULL,0.9,'metame',NULL,NULL,NULL,NULL,'manual','s1','primary',NULL,0,NULL,'[]',datetime('now'),datetime('now')),
      ('episode1','episode','active','Session','session summary',NULL,0.7,'metame',NULL,NULL,'session1',NULL,'session','session1','primary',NULL,0,NULL,'[]',datetime('now'),datetime('now'));
    CREATE VIRTUAL TABLE memory_items_fts USING fts5(
      title, content, tags, content=memory_items, content_rowid=rowid, tokenize='trigram'
    );
    INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild');
  `);
  seed.close();

  const originalHomedir = os.homedir;
  os.homedir = () => root;
  delete require.cache[require.resolve('./memory')];
  const memory = require('./memory');
  try {
    memory.acquire();
    assert.equal(memory.getCognitiveAsset('fact', 'fact1', { project: 'metame' }).id, 'fact1');
    assert.equal(memory.getCognitiveAsset('fact', 'episode1', { project: 'metame' }), null);
    const probe = new DatabaseSync(dbPath);
    assert.ok(probe.prepare('PRAGMA table_info(memory_items)').all().some(column => column.name === 'supersedes_id'));
    probe.close();
  } finally {
    memory.forceClose();
    os.homedir = originalHomedir;
    delete require.cache[require.resolve('./memory')];
    fs.rmSync(root, { recursive: true, force: true });
  }
});
