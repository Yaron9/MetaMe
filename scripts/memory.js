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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

module.exports = { saveSession, searchSessions, recentSessions, getSession, stats, close, DB_PATH };
