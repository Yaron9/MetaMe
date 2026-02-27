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
 *   saveSession({ sessionId, project, scope, summary, keywords, mood })
 *   searchSessions(query, { limit, project, scope })
 *   recentSessions({ limit, project, scope })
 *   getSession(sessionId)
 *   stats()
 *   close()
 */

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

/** Minimal structured logger. level: 'INFO' | 'WARN' | 'ERROR' */
function log(level, msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`${ts} [${level}] ${msg}\n`);
}

// Lazy-init: only open DB when first called
let _db = null;
// Counts external callers that have called acquire() but not yet release().
// Internal helpers (getDb, _trackSearch, etc.) do NOT affect this counter.
let _refCount = 0;

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
      scope      TEXT DEFAULT NULL,
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

  // Backward-compatible migration for old DBs without `scope`
  try { _db.exec('ALTER TABLE sessions ADD COLUMN scope TEXT DEFAULT NULL'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_scope ON sessions(scope)'); } catch {}


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
      scope        TEXT DEFAULT NULL,
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
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_facts_entity_relation ON facts(entity, relation)'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project)'); } catch {}

  // Backward-compatible migration for old DBs without `scope`
  try { _db.exec('ALTER TABLE facts ADD COLUMN scope TEXT DEFAULT NULL'); } catch {}
  try { _db.exec('CREATE INDEX IF NOT EXISTS idx_facts_scope   ON facts(scope)'); } catch {}

  // Search frequency tracking: counts how many times a fact appeared in search results.
  // This is a RELEVANCE PROXY, not a usefulness score — "searched" ≠ "actually helpful".
  // Renamed from recall_count (was ambiguous). Migration copies existing data forward.
  try { _db.exec('ALTER TABLE facts ADD COLUMN recall_count INTEGER DEFAULT 0'); } catch {}
  try { _db.exec('ALTER TABLE facts ADD COLUMN search_count INTEGER DEFAULT 0'); } catch {}
  try { _db.exec('ALTER TABLE facts ADD COLUMN last_searched_at TEXT'); } catch {}
  // One-time migration: copy recall_count → search_count for existing rows
  try { _db.exec('UPDATE facts SET search_count = recall_count WHERE recall_count > 0 AND search_count = 0'); } catch {}

  // conflict_status: 'OK' (default) | 'CONFLICT' — set by _detectConflict for non-stateful relations
  try { _db.exec("ALTER TABLE facts ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'OK'"); } catch {}

  return _db;
}

/**
 * Save a distilled session summary.
 *
 * @param {object} opts
 * @param {string} opts.sessionId  - Claude session ID (unique key)
 * @param {string} opts.project    - Project key (e.g. 'metame', 'desktop')
 * @param {string|null} [opts.scope] - Stable workspace scope ID (e.g. proj_<hash>)
 * @param {string} opts.summary    - Distilled summary text
 * @param {string} [opts.keywords] - Comma-separated keywords for search boost
 * @param {string} [opts.mood]     - User mood/sentiment detected
 * @param {number} [opts.tokenCost] - Approximate token cost of the session
 * @returns {{ ok: boolean, id: string }}
 */
function saveSession({ sessionId, project, scope = null, summary, keywords = '', mood = '', tokenCost = 0 }) {
  if (!sessionId || !project || !summary) {
    throw new Error('saveSession requires sessionId, project, summary');
  }
  const normalizedProject = project === '*' ? '*' : String(project || 'unknown');
  const normalizedScope = normalizedProject === '*'
    ? '*'
    : (scope && typeof scope === 'string' ? scope : null);
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO sessions (id, project, scope, summary, keywords, mood, token_cost)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      scope = excluded.scope,
      summary = excluded.summary,
      keywords = excluded.keywords,
      mood = excluded.mood,
      token_cost = excluded.token_cost
  `);
  stmt.run(
    sessionId,
    normalizedProject,
    normalizedScope,
    summary.slice(0, 10000),
    keywords.slice(0, 1000),
    mood.slice(0, 100),
    tokenCost
  );
  return { ok: true, id: sessionId };
}

// Relations with "current state" semantics: new value replaces old.
// Historical relations (tech_decision, bug_lesson, arch_convention, project_milestone) keep all versions.
const STATEFUL_RELATIONS = new Set(['user_pref', 'config_fact', 'config_change', 'workflow_rule']);

/**
 * Save atomic facts extracted from a session.
 *
 * @param {string} sessionId - Source session ID
 * @param {string} project   - Project key ('metame', 'desktop', '*' for global)
 * @param {Array}  facts     - Array of { entity, relation, value, confidence, tags }
 * @param {object} [opts]
 * @param {string|null} [opts.scope] - Stable workspace scope ID (e.g. proj_<hash>)
 * @returns {{ saved: number, skipped: number, superseded: number }}
 */
function saveFacts(sessionId, project, facts, { scope = null } = {}) {
  if (!Array.isArray(facts) || facts.length === 0) return { saved: 0, skipped: 0, superseded: 0 };
  const db = getDb();
  const normalizedProject = project === '*' ? '*' : String(project || 'unknown');
  const fallbackSessionScope = (() => {
    const sid = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    return sid ? `sess_${sid}` : null;
  })();
  const normalizedScope = normalizedProject === '*'
    ? '*'
    : (scope && typeof scope === 'string' ? scope : (normalizedProject === 'unknown' ? fallbackSessionScope : null));

  let dedupScopeSql = '';
  let dedupScopeParams = [];
  if (normalizedScope === '*') {
    dedupScopeSql = `((scope = '*') OR (scope IS NULL AND project = '*'))`;
  } else if (normalizedScope) {
    dedupScopeSql = `((scope = ?) OR (scope = '*') OR (scope IS NULL AND project IN (?, '*')))`;
    dedupScopeParams = [normalizedScope, normalizedProject];
  } else {
    dedupScopeSql = `(project IN (?, '*'))`;
    dedupScopeParams = [normalizedProject];
  }

  const existsDup = db.prepare(`
    SELECT 1 AS ok
    FROM facts
    WHERE entity = ? AND relation = ? AND substr(value, 1, 50) = ?
      AND ${dedupScopeSql}
    LIMIT 1
  `);

  const insert = db.prepare(`
    INSERT INTO facts (id, entity, relation, value, confidence, source_type, source_id, project, scope, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO NOTHING
  `);

  let saved = 0;
  let skipped = 0;
  let superseded = 0;
  let conflicts = 0;
  const savedFacts = [];
  const batchDedup = new Set();

  for (const f of facts) {
    // Basic validation
    if (!f.entity || !f.relation || !f.value) { skipped++; continue; }
    if (f.value.length < 20 || f.value.length > 300) { skipped++; continue; }

    // Dedup: same entity+relation with similar value prefix
    const dupKey = `${f.entity}::${f.relation}`;
    const prefix = f.value.slice(0, 50);
    const dedupKey = `${dupKey}::${prefix}`;
    const isBatchDup = batchDedup.has(dedupKey);
    const dbDup = existsDup.get(f.entity, f.relation, prefix, ...dedupScopeParams);
    const isDup = isBatchDup || !!(dbDup && dbDup.ok === 1);
    if (isDup) { skipped++; continue; }

    const id = `f-${sessionId.slice(0, 8)}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tags = JSON.stringify(Array.isArray(f.tags) ? f.tags.slice(0, 3) : []);
    try {
      const sourceType = f.source_type || 'session';
      insert.run(id, f.entity, f.relation, f.value.slice(0, 300),
        f.confidence || 'medium', sourceType, sessionId, normalizedProject, normalizedScope, tags);
      batchDedup.add(dedupKey);
      savedFacts.push({ id, entity: f.entity, relation: f.relation, value: f.value,
        project: normalizedProject, scope: normalizedScope, tags: f.tags || [], created_at: new Date().toISOString() });
      saved++;

      // For stateful relations, mark older active facts with same entity::relation as superseded
      if (STATEFUL_RELATIONS.has(f.relation)) {
        let whereSql = '';
        let filterParams = [];
        if (normalizedScope === '*') {
          whereSql = `((scope = '*') OR (scope IS NULL AND project = '*'))`;
        } else if (normalizedScope) {
          whereSql = `((scope = ?) OR (scope IS NULL AND project = ?))`;
          filterParams = [normalizedScope, normalizedProject];
        } else {
          whereSql = `(project IN (?, '*'))`;
          filterParams = [normalizedProject];
        }

        // Fetch the IDs being superseded before running the update (for audit log)
        const db2 = getDb();
        const toSupersede = db2.prepare(
          `SELECT id, value FROM facts
           WHERE entity = ? AND relation = ? AND id != ? AND superseded_by IS NULL
             AND ${whereSql}`
        ).all(f.entity, f.relation, id, ...filterParams);

        const result = db.prepare(
          `UPDATE facts SET superseded_by = ?, updated_at = datetime('now')
           WHERE entity = ? AND relation = ? AND id != ? AND superseded_by IS NULL
             AND ${whereSql}`
        ).run(id, f.entity, f.relation, id, ...filterParams);
        const changes = result.changes || 0;
        superseded += changes;

        // Audit log: append to ~/.metame/memory_supersede_log.jsonl (never mutates, only appends)
        if (changes > 0) {
          _logSupersede(toSupersede, id, f.entity, f.relation, f.value, sessionId);
        }
      } else {
        // Conflict detection for non-stateful relations
        let whereSql = '';
        let filterParams = [];
        if (normalizedScope === '*') {
          whereSql = `((scope = '*') OR (scope IS NULL AND project = '*'))`;
        } else if (normalizedScope) {
          whereSql = `((scope = ?) OR (scope IS NULL AND project = ?))`;
          filterParams = [normalizedScope, normalizedProject];
        } else {
          whereSql = `(project IN (?, '*'))`;
          filterParams = [normalizedProject];
        }
        conflicts += _detectConflict(db, f, id, whereSql, filterParams, sessionId);
      }
    } catch { skipped++; }
  }

  // Async sync to QMD (non-blocking, non-fatal)
  if (savedFacts.length > 0) {
    let qmdClient = null;
    try { qmdClient = require('./qmd-client'); } catch { /* qmd-client not available */ }
    if (qmdClient) qmdClient.upsertFacts(savedFacts);
  }

  if (conflicts > 0) log('WARN', `[MEMORY] ${conflicts} conflict(s) detected`);

  return { saved, skipped, superseded, conflicts };
}

/**
 * Increment search_count and last_searched_at for a list of fact IDs.
 * Semantics: "this fact appeared in search results" — NOT "this fact was useful".
 * High search_count = frequently retrieved. Low/zero = candidate for pruning.
 * Non-fatal; called after each successful search.
 */
function _trackSearch(ids) {
  if (!ids || ids.length === 0) return;
  try {
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE facts SET search_count = search_count + 1, last_searched_at = datetime('now')
       WHERE id IN (${placeholders})`
    ).run(...ids);
  } catch { /* non-fatal */ }
}

const SUPERSEDE_LOG = path.join(os.homedir(), '.metame', 'memory_supersede_log.jsonl');
const CONFLICT_LOG  = path.join(os.homedir(), '.metame', 'memory_conflict_log.jsonl');

/**
 * Append supersede operations to audit log (append-only, never mutated).
 * Each line: { ts, new_id, new_value_prefix, entity, relation, superseded: [{id, value_prefix}], session_id }
 * Use this to investigate accidental overwrites or replay if needed.
 */
function _logSupersede(oldFacts, newId, entity, relation, newValue, sessionId) {
  if (!oldFacts || oldFacts.length === 0) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      entity,
      relation,
      new_id: newId,
      new_value: newValue.slice(0, 80),
      session_id: sessionId,
      superseded: oldFacts.map(f => ({ id: f.id, value: f.value.slice(0, 80) })),
    };
    fs.appendFileSync(SUPERSEDE_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

/**
 * Detect value conflicts for non-stateful facts.
 *
 * When a new fact (entity, relation) already has an active record whose value
 * differs significantly from the incoming value, both are flagged CONFLICT.
 * "Significant difference" = trimmed values are not equal AND neither contains
 * the other as a substring (handles minor rewording and prefix matches).
 *
 * @param {object} db            - DatabaseSync instance
 * @param {object} fact          - The newly-inserted fact { entity, relation, value }
 * @param {string} newId         - Row ID of the newly-inserted fact
 * @param {string} whereSql      - Scope WHERE clause (reused from saveFacts)
 * @param {Array}  filterParams  - Bind params for whereSql
 * @param {string} sessionId     - Source session ID (for audit log)
 * @returns {number} Number of conflicts detected (0 or more)
 */
function _detectConflict(db, fact, newId, whereSql, filterParams, sessionId) {
  try {
    const existing = db.prepare(
      `SELECT id, value FROM facts
       WHERE entity = ? AND relation = ? AND id != ? AND superseded_by IS NULL
         AND (conflict_status IS NULL OR conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
         AND ${whereSql}`
    ).all(fact.entity, fact.relation, newId, ...filterParams);

    if (existing.length === 0) return 0;

    const newVal = fact.value.trim();
    let conflictCount = 0;

    const conflicting = [];
    for (const row of existing) {
      const oldVal = row.value.trim();
      // Skip if values are equivalent or one contains the other
      if (oldVal === newVal) continue;
      if (oldVal.includes(newVal) || newVal.includes(oldVal)) continue;

      // Mark existing record as CONFLICT
      db.prepare(
        `UPDATE facts SET conflict_status = 'CONFLICT', updated_at = datetime('now') WHERE id = ?`
      ).run(row.id);

      conflicting.push({ id: row.id, value: row.value.slice(0, 80) });
      conflictCount++;
    }

    if (conflictCount > 0) {
      // Mark the new fact as CONFLICT too
      db.prepare(
        `UPDATE facts SET conflict_status = 'CONFLICT', updated_at = datetime('now') WHERE id = ?`
      ).run(newId);

      // Audit log (append-only, never mutated)
      try {
        const entry = {
          ts: new Date().toISOString(),
          entity: fact.entity,
          relation: fact.relation,
          new_id: newId,
          new_value: fact.value.slice(0, 80),
          session_id: sessionId,
          conflicting,
        };
        fs.appendFileSync(CONFLICT_LOG, JSON.stringify(entry) + '\n', 'utf8');
      } catch { /* non-fatal */ }
    }

    return conflictCount;
  } catch { return 0; }
}

/**
 * Scope filter semantics (new + legacy):
 * - New rows: prefer `scope` exact match or global scope '*'
 * - Legacy rows (scope NULL): fallback to project match or project='*'
 */
function _matchesFactScope(row, project, scope) {
  if (!row) return false;
  const rowScope = row.scope === undefined ? null : row.scope;
  if (scope) {
    if (rowScope === scope || rowScope === '*') return true;
    if (rowScope === null) {
      if (!project) return false;
      return row.project === project || row.project === '*';
    }
    return false;
  }
  if (project) return row.project === project || row.project === '*';
  return true;
}

/**
 * Search facts: QMD hybrid search (if available) → FTS5 → LIKE fallback.
 *
 * @param {string} query          - Search keywords / natural language
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.project] - Filter by project (also always includes '*')
 * @param {string} [opts.scope]   - Stable workspace scope (also includes global '*')
 * @returns {Promise<Array>|Array} Fact objects
 */
async function searchFactsAsync(query, { limit = 5, project = null, scope = null } = {}) {
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
          `SELECT id, entity, relation, value, confidence, project, scope, tags, created_at
           FROM facts WHERE id IN (${placeholders}) AND superseded_by IS NULL
           AND (conflict_status IS NULL OR conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))`
        ).all(...ids);

        // Apply project/scope filter
        if (project || scope) {
          rows = rows.filter(r => _matchesFactScope(r, project, scope));
        }

        // Preserve QMD ranking order
        const idOrder = new Map(ids.map((id, i) => [id, i]));
        rows.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));

        if (rows.length > 0) {
          _trackSearch(rows.map(r => r.id));
          return rows.slice(0, limit);
        }
      }
    } catch { /* QMD failed, fall through to FTS5 */ }
  }

  return searchFacts(query, { limit, project, scope });
}

/**
 * Search facts by keyword (FTS5 + LIKE fallback). Synchronous.
 *
 * @param {string} query          - Search keywords
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.project] - Filter by project (also always includes '*')
 * @param {string} [opts.scope]   - Stable workspace scope (also includes global '*')
 * @returns {Array<{ id, entity, relation, value, confidence, project, scope, tags, created_at }>}
 */
function searchFacts(query, { limit = 5, project = null, scope = null } = {}) {
  if (!query || !query.trim()) return [];
  const db = getDb();

  const sanitized = query.trim().split(/\s+/)
    .map(t => '"' + t.replace(/"/g, '') + '"').join(' ');

  // FTS5 path
  try {
    let sql, params;
    if (scope && project) {
      sql = `
        SELECT f.id, f.entity, f.relation, f.value, f.confidence, f.project, f.scope, f.tags, f.created_at, rank
        FROM facts_fts fts JOIN facts f ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ?
          AND ((f.scope = ? OR f.scope = '*') OR (f.scope IS NULL AND (f.project = ? OR f.project = '*')))
          AND f.superseded_by IS NULL
          AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
        ORDER BY rank LIMIT ?
      `;
      params = [sanitized, scope, project, limit];
    } else if (scope) {
      sql = `
        SELECT f.id, f.entity, f.relation, f.value, f.confidence, f.project, f.scope, f.tags, f.created_at, rank
        FROM facts_fts fts JOIN facts f ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ? AND (f.scope = ? OR f.scope = '*') AND f.superseded_by IS NULL
          AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
        ORDER BY rank LIMIT ?
      `;
      params = [sanitized, scope, limit];
    } else if (project) {
      sql = `
        SELECT f.id, f.entity, f.relation, f.value, f.confidence, f.project, f.scope, f.tags, f.created_at, rank
        FROM facts_fts fts JOIN facts f ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ? AND (f.project = ? OR f.project = '*') AND f.superseded_by IS NULL
          AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
        ORDER BY rank LIMIT ?
      `;
      params = [sanitized, project, limit];
    } else {
      sql = `
        SELECT f.id, f.entity, f.relation, f.value, f.confidence, f.project, f.scope, f.tags, f.created_at, rank
        FROM facts_fts fts JOIN facts f ON f.rowid = fts.rowid
        WHERE facts_fts MATCH ? AND f.superseded_by IS NULL
          AND (f.conflict_status IS NULL OR f.conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
        ORDER BY rank LIMIT ?
      `;
      params = [sanitized, limit];
    }
    const ftsResults = db.prepare(sql).all(...params);
    if (ftsResults.length > 0) {
      _trackSearch(ftsResults.map(r => r.id));
      return ftsResults;
    }
  } catch { /* FTS error, fall through */ }

  // LIKE fallback
  const like = '%' + query.trim() + '%';
  const likeSql = scope && project
    ? `SELECT id, entity, relation, value, confidence, project, scope, tags, created_at
       FROM facts WHERE (entity LIKE ? OR value LIKE ? OR tags LIKE ?)
       AND ((scope = ? OR scope = '*') OR (scope IS NULL AND (project = ? OR project = '*')))
       AND superseded_by IS NULL
       AND (conflict_status IS NULL OR conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
       ORDER BY created_at DESC LIMIT ?`
    : scope
      ? `SELECT id, entity, relation, value, confidence, project, scope, tags, created_at
       FROM facts WHERE (entity LIKE ? OR value LIKE ? OR tags LIKE ?)
       AND (scope = ? OR scope = '*') AND superseded_by IS NULL
       AND (conflict_status IS NULL OR conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
       ORDER BY created_at DESC LIMIT ?`
      : project
        ? `SELECT id, entity, relation, value, confidence, project, scope, tags, created_at
       FROM facts WHERE (entity LIKE ? OR value LIKE ? OR tags LIKE ?)
       AND (project = ? OR project = '*') AND superseded_by IS NULL
       AND (conflict_status IS NULL OR conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
       ORDER BY created_at DESC LIMIT ?`
        : `SELECT id, entity, relation, value, confidence, project, scope, tags, created_at
       FROM facts WHERE (entity LIKE ? OR value LIKE ? OR tags LIKE ?)
       AND superseded_by IS NULL
       AND (conflict_status IS NULL OR conflict_status NOT IN ('ARCHIVED', 'CONFLICT'))
       ORDER BY created_at DESC LIMIT ?`;
  const likeResults = scope && project
    ? db.prepare(likeSql).all(like, like, like, scope, project, limit)
    : scope
      ? db.prepare(likeSql).all(like, like, like, scope, limit)
      : project
        ? db.prepare(likeSql).all(like, like, like, project, limit)
        : db.prepare(likeSql).all(like, like, like, limit);
  if (likeResults.length > 0) _trackSearch(likeResults.map(r => r.id));
  return likeResults;
}

/**
 * Search sessions by keyword (FTS5 match).
 *
 * @param {string} query         - Search query (FTS5 syntax supported)
 * @param {object} [opts]
 * @param {number} [opts.limit=5] - Max results
 * @param {string} [opts.project] - Filter by project
 * @param {string} [opts.scope] - Stable workspace scope (also includes global '*')
 * @returns {Array<{ id, project, scope, summary, keywords, mood, created_at, rank }>}
 */
function searchSessions(query, { limit = 5, project = null, scope = null } = {}) {
  if (!query || !query.trim()) return [];
  const db = getDb();

  // Sanitize: wrap each term in quotes to prevent FTS5 syntax errors
  const sanitized = query.trim().split(/\s+/).map(t => '"' + t.replace(/"/g, '') + '"').join(' ');

  let sql, params;
  if (scope && project) {
    sql = `
      SELECT s.id, s.project, s.scope, s.summary, s.keywords, s.mood, s.created_at, s.token_cost, rank
      FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
      WHERE sessions_fts MATCH ?
        AND ((s.scope = ? OR s.scope = '*') OR (s.scope IS NULL AND (s.project = ? OR s.project = '*')))
      ORDER BY rank LIMIT ?
    `;
    params = [sanitized, scope, project, limit];
  } else if (scope) {
    sql = `
      SELECT s.id, s.project, s.scope, s.summary, s.keywords, s.mood, s.created_at, s.token_cost, rank
      FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
      WHERE sessions_fts MATCH ? AND (s.scope = ? OR s.scope = '*')
      ORDER BY rank LIMIT ?
    `;
    params = [sanitized, scope, limit];
  } else if (project) {
    sql = `
      SELECT s.id, s.project, s.scope, s.summary, s.keywords, s.mood, s.created_at, s.token_cost, rank
      FROM sessions_fts f JOIN sessions s ON s.rowid = f.rowid
      WHERE sessions_fts MATCH ? AND s.project = ?
      ORDER BY rank LIMIT ?
    `;
    params = [sanitized, project, limit];
  } else {
    sql = `
      SELECT s.id, s.project, s.scope, s.summary, s.keywords, s.mood, s.created_at, s.token_cost, rank
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
  const likeSql = scope && project
    ? `SELECT id, project, scope, summary, keywords, mood, created_at, token_cost
       FROM sessions
       WHERE (summary LIKE ? OR keywords LIKE ?)
         AND ((scope = ? OR scope = '*') OR (scope IS NULL AND (project = ? OR project = '*')))
       ORDER BY created_at DESC LIMIT ?`
    : scope
      ? `SELECT id, project, scope, summary, keywords, mood, created_at, token_cost
       FROM sessions
       WHERE (summary LIKE ? OR keywords LIKE ?)
         AND (scope = ? OR scope = '*')
       ORDER BY created_at DESC LIMIT ?`
      : project
        ? `SELECT id, project, scope, summary, keywords, mood, created_at, token_cost
       FROM sessions
       WHERE (summary LIKE ? OR keywords LIKE ?) AND project = ?
       ORDER BY created_at DESC LIMIT ?`
        : `SELECT id, project, scope, summary, keywords, mood, created_at, token_cost
       FROM sessions
       WHERE (summary LIKE ? OR keywords LIKE ?)
       ORDER BY created_at DESC LIMIT ?`;
  return scope && project
    ? db.prepare(likeSql).all(likeParam, likeParam, scope, project, limit)
    : scope
      ? db.prepare(likeSql).all(likeParam, likeParam, scope, limit)
      : project
        ? db.prepare(likeSql).all(likeParam, likeParam, project, limit)
        : db.prepare(likeSql).all(likeParam, likeParam, limit);
}

/**
 * Get most recent sessions.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=3] - Max results
 * @param {string} [opts.project] - Filter by project
 * @param {string} [opts.scope] - Stable workspace scope (also includes global '*')
 * @returns {Array<{ id, project, scope, summary, keywords, mood, created_at }>}
 */
function recentSessions({ limit = 3, project = null, scope = null } = {}) {
  const db = getDb();
  if (scope && project) {
    return db.prepare(
      `SELECT id, project, scope, summary, keywords, mood, created_at, token_cost
       FROM sessions
       WHERE ((scope = ? OR scope = '*') OR (scope IS NULL AND (project = ? OR project = '*')))
       ORDER BY created_at DESC LIMIT ?`
    ).all(scope, project, limit);
  }
  if (scope) {
    return db.prepare(
      `SELECT id, project, scope, summary, keywords, mood, created_at, token_cost
       FROM sessions
       WHERE (scope = ? OR scope = '*')
       ORDER BY created_at DESC LIMIT ?`
    ).all(scope, limit);
  }
  if (project) {
    return db.prepare(
      'SELECT id, project, scope, summary, keywords, mood, created_at, token_cost FROM sessions WHERE project = ? ORDER BY created_at DESC LIMIT ?'
    ).all(project, limit);
  }
  return db.prepare(
    'SELECT id, project, scope, summary, keywords, mood, created_at, token_cost FROM sessions ORDER BY created_at DESC LIMIT ?'
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
  const factsRow = db.prepare('SELECT COUNT(*) as count FROM facts WHERE superseded_by IS NULL').get();
  let dbSizeKB = 0;
  try { dbSizeKB = Math.round(fs.statSync(DB_PATH).size / 1024); } catch { /* */ }
  return { count: row.count, facts: factsRow.count, dbSizeKB, oldestDate: row.oldest || null, newestDate: row.newest || null };
}

/**
 * Close the database connection (for clean shutdown).
 */
/**
 * Acquire a reference. Call once per logical "session" (e.g. per task run).
 * Ensures DB is open and increments the ref count.
 * Must be paired with a matching release() call.
 */
function acquire() {
  _refCount++;
  getDb(); // ensure DB is initialised
}

/**
 * Release a reference. When the last caller releases, the DB is closed.
 * Safe to call even if acquire() was never called (no-op when _refCount <= 0).
 */
function release() {
  if (_refCount > 0) _refCount--;
  if (_refCount === 0 && _db) { _db.close(); _db = null; }
}

/**
 * Backwards-compatible alias. Equivalent to release().
 * External callers that previously called close() continue to work correctly.
 */
function close() { release(); }

/** Force-close regardless of ref count. Only call on process exit. */
function forceClose() {
  _refCount = 0;
  if (_db) { _db.close(); _db = null; }
}

module.exports = { saveSession, saveFacts, searchFacts, searchFactsAsync, searchSessions, recentSessions, getSession, stats, acquire, release, close, forceClose, DB_PATH };
