'use strict';

require('./test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { ingestDiscoveredSessions } = require('./cognitive-ingestion');
const { createPiSessionSourceAdapter } = require('./engines/pi-session-source-adapter');
const { upsertSessionSource } = require('./core/session-source-db');
const { setItemState } = require('./core/memory-mutate');
const { hybridSearchWiki } = require('./core/hybrid-search');
const { callTool } = require('./metame-mcp-server');

const FIXTURE = path.join(__dirname, 'engines', 'pi-fixtures', 'pi-native-session.jsonl');

function makeRoot(prefix = 'metame-pi-cognitive-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function openCognitiveDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  applyWikiSchema(db);
  db.exec(`
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'candidate',
      title TEXT, content TEXT NOT NULL, summary TEXT, confidence REAL DEFAULT 0.5,
      project TEXT DEFAULT '*', scope TEXT, task_key TEXT, session_id TEXT, agent_key TEXT,
      supersedes_id TEXT, source_type TEXT, source_id TEXT, origin_class TEXT DEFAULT 'primary',
      provenance_root_id TEXT, relation TEXT, search_count INTEGER DEFAULT 0,
      last_searched_at TEXT, tags TEXT DEFAULT '[]', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE VIRTUAL TABLE memory_items_fts USING fts5(
      title, content, tags, content=memory_items, content_rowid=rowid, tokenize='trigram'
    );
    CREATE TRIGGER mi_ai AFTER INSERT ON memory_items BEGIN
      INSERT INTO memory_items_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);
  return db;
}

function writeMemoryItem(db, item) {
  db.prepare(`
    INSERT INTO memory_items (
      id, kind, state, title, content, summary, confidence, project, scope,
      session_id, source_type, source_id, origin_class, provenance_root_id, relation, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id, item.kind, item.state || 'candidate', item.title, item.content,
    item.summary || null, item.confidence ?? 0.5, item.project || '*', item.scope || null,
    item.sessionId || null, item.sourceType || 'session', item.sourceId || null,
    item.originClass || 'primary', item.provenanceRootId || null, item.relation || null,
    JSON.stringify(item.tags || []),
  );
}

function fixtureSource(root) {
  const sessionDir = path.join(root, 'pi-sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(sessionDir, 'pi-fixture.jsonl'));
  return createPiSessionSourceAdapter({ home: path.join(root, 'home'), sessionDir });
}

function memoryDeps(db, audits) {
  return {
    memory: () => ({
      hybridSearchWiki: (query, options) => hybridSearchWiki(db, query, options),
      getCognitiveAsset: (type, id) => {
        if (type !== 'fact') return null;
        return db.prepare(`
          SELECT id, title, content, summary, confidence, project, scope, relation,
                 source_type, source_id, provenance_root_id, updated_at
            FROM memory_items
           WHERE id=? AND kind IN ('fact','insight','convention') AND state='active'
        `).get(id) || null;
      },
    }),
    recordAudit: () => row => audits.push(row),
    planRecall: () => () => ({ shouldRecall: true, reason: 'explicit-mcp', modes: ['facts'] }),
    assembleRecallContext: () => async () => ({ text: '', sources: [] }),
    writeFact: () => () => ({ ok: false, errors: ['not used in this deterministic test'] }),
    skillsDir: '/nonexistent',
    agentsDir: '/nonexistent',
    dbPath: '/nonexistent/memory.db',
  };
}

test('Pi source revision ingestion persists bounded provenance and is revision-idempotent', async () => {
  const root = makeRoot();
  const source = fixtureSource(root);
  const db = openCognitiveDb();
  const first = await ingestDiscoveredSessions({
    db, adapter: source, pipelineVersion: 'pi-cognitive-fixture-v1', includeSubagents: false,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, true);
  assert.ok(first[0].events.some(event => event.kind === 'tool_call'));
  assert.ok(first[0].events.some(event => event.kind === 'checkpoint'));
  const sourceRow = db.prepare('SELECT * FROM session_sources WHERE engine_id=?').get('pi');
  assert.ok(sourceRow);
  assert.equal(sourceRow.native_session_id, 'pi-fixture-session');
  assert.match(sourceRow.source_locator, /configured/);
  assert.equal(JSON.parse(sourceRow.discovery_cursor).sequence > 0, true);

  const replay = await ingestDiscoveredSessions({
    db, adapter: source, pipelineVersion: 'pi-cognitive-fixture-v1', includeSubagents: false,
  });
  assert.equal(replay[0].skipped, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get().n, 1);

  const sessionPath = path.join(root, 'pi-sessions', 'pi-fixture.jsonl');
  fs.appendFileSync(sessionPath, `${JSON.stringify({
    type: 'message', id: 'accepted-tail', parentId: 'info-1', timestamp: '2026-08-01T10:04:00.000Z',
    message: { role: 'user', content: 'A new revision was appended after restart' },
  })}\n`);
  const changed = await ingestDiscoveredSessions({
    db, adapter: source, pipelineVersion: 'pi-cognitive-fixture-v1', includeSubagents: false,
  });
  assert.equal(changed[0].ok, true);
  assert.notEqual(changed[0].revision.sourceRevision, first[0].revision.sourceRevision);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM extraction_runs').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session_sources WHERE engine_id=?').get('pi').n, 2);

  const currentSource = upsertSessionSource(db, {
    engineId: 'pi', nativeSessionId: changed[0].revision.nativeSessionId,
    sourceHash: changed[0].revision.sourceRevision, sourceLocator: changed[0].revision.sourceLocator,
  });
  writeMemoryItem(db, {
    id: 'pi-episode', kind: 'episode', state: 'active', title: 'Pi session episode',
    content: 'Pi native session produced bounded evidence for the accepted fixture result.',
    sessionId: changed[0].revision.nativeSessionId, sourceId: currentSource.id,
    provenanceRootId: `source:${currentSource.id}`,
  });
  writeMemoryItem(db, {
    id: 'pi-candidate', kind: 'insight', state: 'candidate', title: 'Pi · verified result',
    content: 'The Pi fixture result is accepted only after an independent verification step.',
    sessionId: changed[0].revision.nativeSessionId, sourceId: currentSource.id,
    provenanceRootId: `source:${currentSource.id}`, relation: 'observed',
    confidence: 0.7,
  });
  assert.equal(db.prepare("SELECT state FROM memory_items WHERE id='pi-candidate'").get().state, 'candidate');
  setItemState(db, 'pi-candidate', 'active');
  assert.equal(db.prepare("SELECT state FROM memory_items WHERE id='pi-candidate'").get().state, 'active');

  const audits = [];
  const result = await callTool('memory_search', {
    query: 'Pi fixture result accepted', project: changed[0].revision.project,
  }, memoryDeps(db, audits));
  assert.ok(result.results.some(item => item.id === 'pi-candidate'));
  const accepted = result.results.find(item => item.id === 'pi-candidate');
  assert.deepEqual(accepted.provenance, [`source:${currentSource.id}`]);
  assert.equal(audits[0].consumer_stage, 'delivered');
  assert.equal(audits[0].source_refs.includes('fact:pi-candidate'), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE id='pi-candidate'").get().n, 1);
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('Pi assertions remain episode/candidate evidence and do not enter primary fact retrieval before verification', async () => {
  const db = openCognitiveDb();
  writeMemoryItem(db, {
    id: 'pi-unverified', kind: 'insight', state: 'candidate', title: 'Pi · self report',
    content: 'The Pi agent claims that the deployment succeeded, but this is not verified.',
    sourceId: 'ss_pi_revision', provenanceRootId: 'source:ss_pi_revision', relation: 'observed',
  });
  const audits = [];
  const result = await callTool('memory_search', { query: 'deployment succeeded' }, memoryDeps(db, audits));
  assert.equal(result.results.some(item => item.id === 'pi-unverified'), false);
  assert.equal(audits.length, 0);
  db.close();
});
