#!/usr/bin/env node

/**
 * memory.js — MetaMe Unified Memory Store (v2)
 *
 * Single table: memory_items (kind: profile|convention|episode|insight)
 * SQLite + FTS5 trigram search, Node.js native (node:sqlite), zero deps.
 *
 * DB: ~/.metame/memory.db
 *
 * v2 API:
 *   saveMemoryItem(item)
 *   searchMemoryItems(query, opts)
 *   promoteItem(id)
 *   archiveItem(id, supersededById?)
 *   bumpSearchCount(id)
 *   readWorkingMemory(agentKey?)
 *   assembleContext({ query, scope, budget })
 *
 * v1 adapters (backward-compatible, route to v2 internally):
 *   saveSession, saveFacts, saveFactLabels,
 *   searchFacts, searchFactsAsync, searchSessions,
 *   recentSessions, stats
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');
const METAME_DIR = path.join(os.homedir(), '.metame');
const WORKING_MEMORY_DIR = path.join(METAME_DIR, 'memory', 'now');

let _db = null;
let _refCount = 0;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  _db = new DatabaseSync(DB_PATH);

  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 3000');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS memory_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'candidate',
      title           TEXT,
      content         TEXT NOT NULL,
      summary         TEXT,
      confidence      REAL DEFAULT 0.5,
      project         TEXT DEFAULT '*',
      scope           TEXT,
      task_key        TEXT,
      session_id      TEXT,
      agent_key       TEXT,
      supersedes_id   TEXT,
      source_type     TEXT,
      source_id       TEXT,
      search_count    INTEGER DEFAULT 0,
      last_searched_at TEXT,
      tags            TEXT DEFAULT '[]',
      created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
        title, content, tags,
        content=memory_items, content_rowid=rowid,
        tokenize='trigram'
      )
    `);
  } catch { /* already exists */ }

  const miTriggers = [
    `CREATE TRIGGER IF NOT EXISTS mi_ai AFTER INSERT ON memory_items BEGIN
       INSERT INTO memory_items_fts(rowid, title, content, tags)
       VALUES (new.rowid, new.title, new.content, new.tags);
     END`,
    `CREATE TRIGGER IF NOT EXISTS mi_ad AFTER DELETE ON memory_items BEGIN
       INSERT INTO memory_items_fts(memory_items_fts, rowid, title, content, tags)
       VALUES ('delete', old.rowid, old.title, old.content, old.tags);
     END`,
    `CREATE TRIGGER IF NOT EXISTS mi_au AFTER UPDATE ON memory_items BEGIN
       INSERT INTO memory_items_fts(memory_items_fts, rowid, title, content, tags)
       VALUES ('delete', old.rowid, old.title, old.content, old.tags);
       INSERT INTO memory_items_fts(rowid, title, content, tags)
       VALUES (new.rowid, new.title, new.content, new.tags);
     END`,
  ];
  for (const t of miTriggers) {
    try { _db.exec(t); } catch { /* trigger may already exist */ }
  }

  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_mi_kind_state ON memory_items(kind, state)'); } catch { }
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_mi_project ON memory_items(project)'); } catch { }
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_mi_scope ON memory_items(scope)'); } catch { }
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_mi_supersedes ON memory_items(supersedes_id)'); } catch { }

  return _db;
}

// ═══════════════════════════════════════════════════════════════════
// v2 Core API
// ═══════════════════════════════════════════════════════════════════

const memoryModel = require('./core/memory-model');

function generateMemoryId() {
  return `mi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function saveMemoryItem(item) {
  if (!item || !item.content) throw new Error('saveMemoryItem requires content');
  const db = getDb();
  const id = item.id || generateMemoryId();
  const stmt = db.prepare(`
    INSERT INTO memory_items (id, kind, state, title, content, summary, confidence,
      project, scope, task_key, session_id, agent_key, supersedes_id,
      source_type, source_id, search_count, last_searched_at, tags,
      created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      kind=excluded.kind, state=excluded.state, title=excluded.title,
      content=excluded.content, summary=excluded.summary, confidence=excluded.confidence,
      project=excluded.project, scope=excluded.scope, task_key=excluded.task_key,
      session_id=excluded.session_id, agent_key=excluded.agent_key,
      supersedes_id=excluded.supersedes_id, source_type=excluded.source_type,
      source_id=excluded.source_id, tags=excluded.tags,
      updated_at=datetime('now')
  `);
  stmt.run(
    id,
    item.kind || 'insight',
    item.state || 'candidate',
    item.title || null,
    item.content.slice(0, 10000),
    item.summary || null,
    typeof item.confidence === 'number' ? item.confidence : 0.5,
    item.project || '*',
    item.scope || null,
    item.task_key || null,
    item.session_id || null,
    item.agent_key || null,
    item.supersedes_id || null,
    item.source_type || null,
    item.source_id || null,
    item.search_count || 0,
    item.last_searched_at || null,
    typeof item.tags === 'string' ? item.tags : JSON.stringify(Array.isArray(item.tags) ? item.tags : []),
  );
  return { ok: true, id };
}

function searchMemoryItems(query, { kind = null, scope = null, project = null, state = 'active', limit = 20 } = {}) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (state) { conditions.push('mi.state = ?'); params.push(state); }
  if (kind) { conditions.push('mi.kind = ?'); params.push(kind); }
  if (project && scope) {
    conditions.push(`((mi.scope = ? OR mi.scope = '*') OR (mi.scope IS NULL AND (mi.project = ? OR mi.project = '*')))`);
    params.push(scope, project);
  } else if (scope) {
    conditions.push(`(mi.scope = ? OR mi.scope = '*')`);
    params.push(scope);
  } else if (project) {
    conditions.push(`(mi.project = ? OR mi.project = '*')`);
    params.push(project);
  }

  if (query && query.trim()) {
    const sanitized = query.trim().split(/\s+/)
      .map(t => '"' + t.replace(/"/g, '') + '"').join(' ');
    const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT mi.*, fts.rank AS fts_rank
      FROM memory_items_fts fts
      JOIN memory_items mi ON mi.rowid = fts.rowid
      WHERE memory_items_fts MATCH ? ${where}
      ORDER BY fts.rank
      LIMIT ?
    `;
    try {
      const rows = db.prepare(sql).all(sanitized, ...params, limit);
      if (rows.length > 0) {
        _trackSearch(rows.map(r => r.id));
        return rows;
      }
    } catch { /* FTS error, fall through to LIKE */ }

    const like = '%' + query.trim() + '%';
    conditions.push('(mi.title LIKE ? OR mi.content LIKE ? OR mi.tags LIKE ?)');
    params.push(like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const fallbackSql = `SELECT mi.* FROM memory_items mi ${where} ORDER BY mi.created_at DESC LIMIT ?`;
  const rows = db.prepare(fallbackSql).all(...params, limit);
  if (rows.length > 0) _trackSearch(rows.map(r => r.id));
  return rows;
}

function _trackSearch(ids) {
  if (!ids || ids.length === 0) return;
  try {
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE memory_items SET search_count = search_count + 1, last_searched_at = datetime('now')
       WHERE id IN (${placeholders})`
    ).run(...ids);
  } catch { /* non-fatal */ }
}

function promoteItem(id) {
  const db = getDb();
  db.prepare(`UPDATE memory_items SET state = 'active', updated_at = datetime('now') WHERE id = ?`).run(id);
}

function archiveItem(id, supersededById) {
  const db = getDb();
  if (supersededById) {
    db.prepare(`UPDATE memory_items SET state = 'archived', supersedes_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(supersededById, id);
  } else {
    db.prepare(`UPDATE memory_items SET state = 'archived', updated_at = datetime('now') WHERE id = ?`).run(id);
  }
}

function bumpSearchCount(id) {
  const db = getDb();
  db.prepare(`UPDATE memory_items SET search_count = search_count + 1, last_searched_at = datetime('now') WHERE id = ?`).run(id);
}

function readWorkingMemory(agentKey) {
  try {
    if (!fs.existsSync(WORKING_MEMORY_DIR)) return '';
    if (agentKey) {
      const filePath = path.join(WORKING_MEMORY_DIR, `${agentKey}.md`);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').trim() : '';
    }
    const files = fs.readdirSync(WORKING_MEMORY_DIR).filter(f => f.endsWith('.md'));
    const parts = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(WORKING_MEMORY_DIR, f), 'utf8').trim();
      if (content) parts.push(`[${f.replace('.md', '')}]\n${content}`);
    }
    return parts.join('\n\n');
  } catch { return ''; }
}

function assembleContext({ query, scope = {}, budget } = {}) {
  const items = searchMemoryItems(query, {
    state: 'active',
    project: scope.project,
    scope: scope.workspace,
    limit: 50,
  });
  const working = readWorkingMemory(scope.agent);
  const ranked = memoryModel.rankMemoryItems(items, query, {
    project: scope.project,
    scope: scope.workspace,
    task: scope.task,
    session: scope.session,
    agent: scope.agent,
  });
  const allocated = memoryModel.allocateBudget(ranked, budget);
  const blocks = memoryModel.assemblePromptBlocks(allocated);
  blocks.working = working;
  return blocks;
}

// ═══════════════════════════════════════════════════════════════════
// v1 Adapters — backward-compatible API routing to v2 memory_items
// External callers (extract, reflect, engine, search CLI) work unchanged.
// ═══════════════════════════════════════════════════════════════════

function _parseTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

const CONVENTION_RELATIONS = new Set([
  'bug_lesson', 'arch_convention', 'workflow_rule', 'config_fact', 'config_change',
]);

function saveSession({ sessionId, project, scope = null, summary, keywords = '' }) {
  if (!sessionId || !project || !summary) {
    throw new Error('saveSession requires sessionId, project, summary');
  }
  const tags = keywords ? keywords.split(',').map(k => k.trim()).filter(Boolean) : [];
  return saveMemoryItem({
    id: `mi_ses_${sessionId}`,
    kind: 'episode',
    state: 'active',
    title: summary.slice(0, 80),
    content: summary,
    confidence: 0.7,
    project: project === '*' ? '*' : String(project || 'unknown'),
    scope: scope || null,
    session_id: sessionId,
    source_type: 'session',
    source_id: sessionId,
    tags,
  });
}

function saveFacts(sessionId, project, facts, { scope = null, source_type = null } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) return { saved: 0, skipped: 0, superseded: 0, savedFacts: [] };
  const normalizedProject = project === '*' ? '*' : String(project || 'unknown');
  let saved = 0;
  let skipped = 0;
  const savedFacts = [];

  for (const f of facts) {
    if (!f.entity || !f.relation || !f.value) { skipped++; continue; }
    if (f.value.length < 20 || f.value.length > 300) { skipped++; continue; }

    const kind = CONVENTION_RELATIONS.has(f.relation) ? 'convention' : 'insight';
    const conf = f.confidence === 'high' ? 0.9 : f.confidence === 'medium' ? 0.7 : 0.4;
    const id = `mi_f_${String(sessionId).slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const tags = Array.isArray(f.tags) ? f.tags.slice(0, 3) : [];

    try {
      saveMemoryItem({
        id,
        kind,
        state: 'candidate',
        title: `${f.entity} \u00b7 ${f.relation}`,
        content: f.value.slice(0, 300),
        confidence: conf,
        project: normalizedProject,
        scope: scope || null,
        session_id: sessionId,
        source_type: f.source_type || source_type || 'session',
        source_id: sessionId,
        tags,
      });
      savedFacts.push({
        id, entity: f.entity, relation: f.relation, value: f.value,
        project: normalizedProject, scope, tags, created_at: new Date().toISOString(),
      });
      saved++;
    } catch { skipped++; }
  }
  return { saved, skipped, superseded: 0, savedFacts };
}

function saveFactLabels() {
  // Labels are now embedded as tags in saveMemoryItem. No-op for backward compat.
  return { saved: 0, skipped: 0 };
}

function searchFacts(query, { limit = 5, project = null, scope = null } = {}) {
  if (!query || !query.trim()) return [];
  const rows = searchMemoryItems(query, {
    state: 'active',
    project: project || null,
    scope: scope || null,
    limit,
  }).filter(r => r.kind === 'insight' || r.kind === 'convention');

  // Map v2 fields back to v1 shape for callers
  return rows.map(r => ({
    id: r.id,
    entity: (r.title || '').split(' \u00b7 ')[0] || r.title || '',
    relation: (r.title || '').split(' \u00b7 ')[1] || '',
    value: r.content,
    confidence: r.confidence >= 0.9 ? 'high' : r.confidence >= 0.6 ? 'medium' : 'low',
    project: r.project,
    scope: r.scope,
    tags: _parseTags(r.tags),
    created_at: r.created_at,
  }));
}

async function searchFactsAsync(query, opts) {
  return searchFacts(query, opts);
}

function searchSessions(query, { limit = 5, project = null, scope = null } = {}) {
  if (!query || !query.trim()) return [];
  return searchMemoryItems(query, {
    kind: 'episode',
    state: 'active',
    project: project || null,
    scope: scope || null,
    limit,
  }).map(r => ({
    id: r.session_id || r.id,
    project: r.project,
    scope: r.scope,
    summary: r.content,
    keywords: r.tags,
    mood: '',
    created_at: r.created_at,
    token_cost: 0,
  }));
}

function recentSessions({ limit = 3, project = null, scope = null } = {}) {
  return searchMemoryItems(null, {
    kind: 'episode',
    state: 'active',
    project: project || null,
    scope: scope || null,
    limit,
  }).map(r => ({
    id: r.session_id || r.id,
    project: r.project,
    scope: r.scope,
    summary: r.content,
    keywords: r.tags,
    mood: '',
    created_at: r.created_at,
    token_cost: 0,
  }));
}

function stats() {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) as count, MIN(created_at) as oldest, MAX(created_at) as newest FROM memory_items WHERE state = 'active'`
  ).get();
  const factsRow = db.prepare(
    `SELECT COUNT(*) as count FROM memory_items WHERE state = 'active' AND kind IN ('insight', 'convention')`
  ).get();
  let dbSizeKB = 0;
  try { dbSizeKB = Math.round(fs.statSync(DB_PATH).size / 1024); } catch { /* */ }
  return { count: row.count, facts: factsRow.count, dbSizeKB, oldestDate: row.oldest || null, newestDate: row.newest || null };
}

// ═══════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════

function acquire() {
  _refCount++;
  getDb();
}

function release() {
  if (_refCount > 0) _refCount--;
  if (_refCount === 0 && _db) { _db.close(); _db = null; }
}

function close() { release(); }

function forceClose() {
  _refCount = 0;
  if (_db) { _db.close(); _db = null; }
}

module.exports = {
  // v2 API
  saveMemoryItem,
  searchMemoryItems,
  promoteItem,
  archiveItem,
  bumpSearchCount,
  readWorkingMemory,
  assembleContext,
  // v1 adapters (backward-compatible)
  saveSession,
  saveFacts,
  saveFactLabels,
  searchFacts,
  searchFactsAsync,
  searchSessions,
  recentSessions,
  stats,
  // lifecycle
  acquire,
  release,
  close,
  forceClose,
  DB_PATH,
};
