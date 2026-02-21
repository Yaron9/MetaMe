#!/usr/bin/env node

/**
 * memory.js — MetaMe Lightweight Session Memory
 *
 * SQLite + FTS5 keyword search, Node.js native (node:sqlite), zero deps.
 * Stores distilled session summaries for cross-session recall.
 *
 * DB: ~/.metame/memory.db
 *
 * API:
 *   saveSession({ sessionId, project, summary, keywords, mood })
 *   searchSessions(query, { limit, project })
 *   recentSessions({ limit, project })
 *   getSession(sessionId)
 *   stats()
 *   close()
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

// Lazy-init: only open DB when first called
let _db = null;

function getDb() {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  _db = new DatabaseSync(DB_PATH);

  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 3000');

  // Core table
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      project    TEXT NOT NULL,
      summary    TEXT NOT NULL,
      keywords   TEXT DEFAULT '',
      mood       TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      token_cost INTEGER DEFAULT 0
    )
  `);

  // FTS5 index for keyword search over summary + keywords
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        summary, keywords, project,
        content='sessions',
        content_rowid='rowid',
        tokenize='trigram'
      )
    `);
  } catch {
    // FTS table may already exist with different schema on upgrade
  }

  // Triggers to keep FTS in sync
  const triggers = [
    `CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
       INSERT INTO sessions_fts(rowid, summary, keywords, project)
       VALUES (new.rowid, new.summary, new.keywords, new.project);
     END`,
    `CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
       INSERT INTO sessions_fts(sessions_fts, rowid, summary, keywords, project)
       VALUES ('delete', old.rowid, old.summary, old.keywords, old.project);
     END`,
    `CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
       INSERT INTO sessions_fts(sessions_fts, rowid, summary, keywords, project)
       VALUES ('delete', old.rowid, old.summary, old.keywords, old.project);
       INSERT INTO sessions_fts(rowid, summary, keywords, project)
       VALUES (new.rowid, new.summary, new.keywords, new.project);
     END`,
  ];
  for (const t of triggers) {
    try { _db.exec(t); } catch { /* trigger may already exist */ }
  }


  // ── Facts table: atomic knowledge triples ──
  _db.exec(`
    CREATE TABLE IF NOT EXISTS facts (
      id           TEXT PRIMARY KEY,
      entity       TEXT NOT NULL,
      relation     TEXT NOT NULL,
      value        TEXT NOT NULL,
      confidence   TEXT NOT NULL DEFAULT 'medium',
      source_type  TEXT NOT NULL DEFAULT 'session',
      source_id    TEXT,
      project      TEXT NOT NULL DEFAULT '*',
      tags         TEXT DEFAULT '[]',
      created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      superseded_by TEXT
    )
  `);

  // FTS5 index for facts (separate from sessions_fts, zero compatibility risk)
  try {
    _db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        entity, relation, value, tags,
        content='facts',
        content_rowid='rowid',
        tokenize='trigram'
      )
    `);
  } catch { /* already exists */ }

  // Triggers to keep facts_fts in sync
  const factTriggers = [
    `CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
       INSERT INTO facts_fts(rowid, entity, relation, value, tags)
       VALUES (new.rowid, new.entity, new.relation, new.value, new.tags);
     END`,
    `CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
       INSERT INTO facts_fts(facts_fts, rowid, entity, relation, value, tags)
       VALUES ('delete', old.rowid, old.entity, old.relation, old.value, old.tags);
     END`,
    `CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
       INSERT INTO facts_fts(facts_fts, rowid, entity, relation, value, tags)
       VALUES ('delete', old.rowid, old.entity, old.relation, old.value, old.tags);
       INSERT INTO facts_fts(rowid, entity, relation, value, tags)
       VALUES (new.rowid, new.entity, new.relation, new.value, new.tags);
     END`,
  ];
  for (const t of factTriggers) {
    try { _db.exec(t); } catch { /* trigger may already exist */ }
  }

  // Indexes
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_facts_entity  ON facts(entity)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project)'); } catch {}

  return _db;
}

/**
 * Save a distilled session summary.
 *
 * @param {object} opts
 * @param {string} opts.sessionId  - Claude session ID (unique key)
 * @param {string} opts.project    - Project key (e.g. 'metame', 'desktop')
 * @param {string} opts.summary    - Distilled summary text
 * @param {string} [opts.keywords] - Comma-separated keywords for search boost
 * @param {string} [opts.mood]     - User mood/sentiment detected
 * @param {number} [opts.tokenCost] - Approximate token cost of the session
 * @returns {{ ok: boolean, id: string }}
 */
function saveSession({ sessionId, project, summary, keywords = '', mood = '', tokenCost = 0 }) {
  if (!sessionId || !project || !summary) {
    throw new Error('saveSession requires sessionId, project, summary');
  }
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, project, summary, keywords, mood, token_cost)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      summary = excluded.summary,
      keywords = excluded.keywords,
      mood = excluded.mood,
      token_cost = excluded.token_cost
  `);
  stmt.run(sessionId, project, summary.slice(0, 10000), keywords.slice(0, 1000), mood.slice(0, 100), tokenCost);
  return { ok: true, id: sessionId };
}

/**
 * Save atomic facts extracted from a session.
 *
 * @param {string} sessionId - Source session ID
 * @param {string} project   - Project key ('metame', 'desktop', '*' for global)
 * @param {Array}  facts     - Array of { entity, relation, value, confidence, tags }
 * @returns {{ saved: number, skipped: number }}
 */
function saveFacts(sessionId, project, facts) {
  if (!Array.isArray(facts) || facts.length === 0) return { saved: 0, skipped: 0 };
  const db = getDb();

  // Load existing facts for dedup check
  const existing = db.prepare(
    "SELECT entity, relation, value FROM facts WHERE project IN (?, '*')"
  ).all(project);

  const insert = db.prepare(`
    INSERT INTO facts (id, entity, relation, value, confidence, source_type, source_id, project, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'session', ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `);

  let saved = 0;
  let skipped = 0;
  const savedFacts = [];

  for (const f of facts) {
    // Basic validation
    if (!f.entity || !f.relation || !f.value) { skipped++; continue; }
    if (f.value.length < 20 || f.value.length > 300) { skipped++; continue; }

    // Dedup: same entity+relation with similar value prefix
    const dupKey = `${f.entity}::${f.relation}`;
    const prefix = f.value.slice(0, 50);
    const isDup = existing.some(e =>
      `${e.entity}::${e.relation}` === dupKey && e.value.slice(0, 50) === prefix
    );
    if (isDup) { skipped++; continue; }

    const id = `f-${sessionId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tags = JSON.stringify(Array.isArray(f.tags) ? f.tags.slice(0, 3) : []);
    try {
      insert.run(id, f.entity, f.relation, f.value.slice(0, 300),
        f.confidence || 'medium', sessionId, project === '*' ? '*' : project, tags);
      savedFacts.push({ id, entity: f.entity, relation: f.relation, value: f.value,
        project: project === '*' ? '*' : project, tags: f.tags || [], created_at: new Date().toISOString() });
      saved++;
    } catch { skipped++; }
  }

  // Async sync to QMD (non-blocking, non-fatal)
  if (savedFacts.length > 0) {
    let qmdClient = null;
    try { qmdClient = require('./qmd-client'); } catch { /* qmd-client not available */ }
    if (qmdClient) qmdClient.upsertFacts(savedFacts);
  }

  return { saved, skipped };
}

/**
 * Search facts: QMD hybrid search (if available) → FTS5 → LIKE fallback.
 *
 * @param {string} query          - Search keywords / natural language
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.project] - Filter by project (also always includes '*')
 * @returns {Promise<Array>|Array} Fact objects
 */
async function searchFactsAsync(query, { limit = 5, project = null } = {}) {
  // Try QMD hybrid search first
  let qmdClient = null;
  try { qmdClient = require('./qmd-client'); } catch { /* not available */ }

  if (qmdClient && qmdClient.isAvailable()) {
    try {
      const ids = await qmdClient.search(query, limit * 2); // fetch extra for project filter
      if (ids && ids.length > 0) {
        const db = getDb();
        const placeholders = ids.map(() => '?').join(',');
        let rows = db.prepare(
          `SELECT id, entity, relation, value, confidence, project, tags, created_at
           FROM facts WHERE id IN (${placeholders}) AND superseded_by IS NULL`
        ).all(...ids);

        // Apply project filter
        if (project) {
          rows = rows.filter(r => r.project === project || r.project === '*');
        }

        // Preserve QMD ranking order
        const idOrder = new Map(ids.map((id, i) => [id, i]));
        rows.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));

        if (rows.length > 0) return rows.slice(0, limit);
      }
    } catch { /* QMD failed, fall through to FTS5 */ }
  }

  return searchFacts(query, { limit, project });
}

/**
 * Search facts by keyword (FTS5 + LIKE fallback). Synchronous.
 *
 * @param {string} query          - Search keywords
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.project] - Filter by project (also always includes '*')
 * @returns {Array<{ id, entity, relation, value, confidence, project, tags, created_at }>}
 */
function searchFacts(query, { limit = 5, project = null } = {}) {
  if (!query || !query.trim()) return [];
  const db = getDb();

  const sanitized = query.trim().split(/\s+/)
    .map(t => '"' + t.replace(/"/g, '') + '"').join(' ');

  // FTS5 path
  try {
    let sql, params;
    if (project) {
      sql = `
        SELECT f.id, f.entity, f.relation, f.value, f.confidence, f.project, f.tags, f.created_at, rank
        FROM facts_fts fts JOIN facts f ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ? AND (f.project = ? OR f.project = '*') AND f.superseded_by IS NULL
        ORDER BY rank LIMIT ?
      `;
      params = [sanitized, project, limit];
    } else {
      sql = `
        SELECT f.id, f.entity, f.relation, f.value, f.confidence, f.project, f.tags, f.created_at, rank
        FROM facts_fts fts JOIN facts f ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ? AND f.superseded_by IS NULL
        ORDER BY rank LIMIT ?
      `;
      params = [sanitized, limit];
    }
    const ftsResults = db.prepare(sql).all(...params);
    if (ftsResults.length > 0) return ftsResults;
  } catch { /* FTS error, fall through */ }

  // LIKE fallback
  const like = '%' + query.trim() + '%';
  const likeSql = project
    ? `SELECT id, entity, relation, value, confidence, project, tags, created_at
       FROM facts WHERE (entity LIKE ? OR value LIKE ? OR tags LIKE ?)
       AND (project = ? OR project = '*') AND superseded_by IS NULL
       ORDER BY created_at DESC LIMIT ?`
    : `SELECT id, entity, relation, value, confidence, project, tags, created_at
       FROM facts WHERE (entity LIKE ? OR value LIKE ? OR tags LIKE ?)
       AND superseded_by IS NULL
       ORDER BY created_at DESC LIMIT ?`;
  return project
    ? db.prepare(likeSql).all(like, like, like, project, limit)
    : db.prepare(likeSql).all(like, like, like, limit);
}

/**
 * Search sessions by keyword (FTS5 match).
 *
 * @param {string} query         - Search query (FTS5 syntax supported)
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.project] - Filter by project
 * @returns {Array<{ id, project, summary, keywords, mood, created_at, rank }>}
 */
function searchSessions(query, { limit = 5, project = null } = {}) {
  if (!query || !query.trim()) return [];
  const db = getDb();

  // Sanitize: wrap each term in quotes to prevent FTS5 syntax errors
  const sanitized = query.trim().split(/\s+/).map(t => '"' + t.replace(/"/g, '') + '"').join(' ');

  let sql, params;
  if (project) {
    sql = `
      SELECT s.id, s.project, s.summary, s.keywords, s.mood, s.created_at, s.token_cost, rank
      FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
      WHERE sessions_fts MATCH ? AND s.project = ?
      ORDER BY rank LIMIT ?
    `;
    params = [sanitized, project, limit];
  } else {
    sql = `
      SELECT s.id, s.project, s.summary, s.keywords, s.mood, s.created_at, s.token_cost, rank
      FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
      WHERE sessions_fts MATCH ?
      ORDER BY rank LIMIT ?
    `;
    params = [sanitized, limit];
  }

  // Try FTS first, fall back to LIKE if FTS errors OR returns 0 (e.g. short CJK queries < 3 chars)
  let ftsResults = [];
  try { ftsResults = db.prepare(sql).all(...params); } catch { /* FTS syntax error */ }
  if (ftsResults.length > 0) return ftsResults;

  // LIKE fallback (handles short CJK terms like "飞书" that trigram can't match)
  const likeParam = '%' + query.trim() + '%';
  const likeSql = project
    ? 'SELECT id, project, summary, keywords, mood, created_at, token_cost FROM sessions WHERE (summary LIKE ? OR keywords LIKE ?) AND project = ? ORDER BY created_at DESC LIMIT ?'
    : 'SELECT id, project, summary, keywords, mood, created_at, token_cost FROM sessions WHERE (summary LIKE ? OR keywords LIKE ?) ORDER BY created_at DESC LIMIT ?';
  return project
    ? db.prepare(likeSql).all(likeParam, likeParam, project, limit)
    : db.prepare(likeSql).all(likeParam, likeParam, limit);
}

/**
 * Get most recent sessions.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=3] - Max results
 * @param {string} [opts.project] - Filter by project
 * @returns {Array<{ id, project, summary, keywords, mood, created_at }>}
 */
function recentSessions({ limit = 3, project = null } = {}) {
  const db = getDb();
  if (project) {
    return db.prepare(
      'SELECT id, project, summary, keywords, mood, created_at, token_cost FROM sessions WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    ).all(project, limit);
  }
  return db.prepare(
    'SELECT id, project, summary, keywords, mood, created_at, token_cost FROM sessions ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

/**
 * Get a single session by ID.
 * @param {string} sessionId
 * @returns {object|null}
 */
function getSession(sessionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) || null;
}

/**
 * Get total memory stats.
 * @returns {{ count, dbSizeKB, oldestDate, newestDate }}
 */
function stats() {
  const db = getDb();
  const row = db.prepare('SELECT COUNT(*) as count, MIN(created_at) as oldest, MAX(created_at) as newest FROM sessions').get();
  let dbSizeKB = 0;
  try { dbSizeKB = Math.round(fs.statSync(DB_PATH).size / 1024); } catch { /* */ }
  return { count: row.count, dbSizeKB, oldestDate: row.oldest || null, newestDate: row.newest || null };
}

/**
 * Close the database connection (for clean shutdown).
 */
function close() {
  if (_db) { _db.close(); _db = null; }
}

module.exports = { saveSession, saveFacts, searchFacts, searchFactsAsync, searchSessions, recentSessions, getSession, stats, close, DB_PATH };
