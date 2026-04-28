'use strict';

const crypto = require('crypto');

const VALID_ENGINES = new Set(['claude', 'codex', 'unknown']);
const VALID_STATUSES = new Set(['indexed', 'summarized', 'extracted', 'error', 'archived']);

function normalizeEngine(engine) {
  const value = String(engine || 'unknown').trim().toLowerCase();
  return VALID_ENGINES.has(value) ? value : 'unknown';
}

function normalizeStatus(status) {
  const value = String(status || 'indexed').trim().toLowerCase();
  return VALID_STATUSES.has(value) ? value : 'indexed';
}

function stableId({ engine, sessionId, sourceHash }) {
  const seed = `${normalizeEngine(engine)}:${String(sessionId || '').trim()}:${String(sourceHash || '').trim()}`;
  return `ss_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function requireSessionSource(source) {
  if (!source || typeof source !== 'object') throw new Error('session source is required');
  const sessionId = String(source.sessionId || source.session_id || '').trim();
  if (!sessionId) throw new Error('session source requires sessionId');
  const sourceHash = String(source.sourceHash || source.source_hash || '').trim();
  if (!sourceHash) throw new Error('session source requires sourceHash');
  return { sessionId, sourceHash };
}

function upsertSessionSource(db, source) {
  const { sessionId, sourceHash } = requireSessionSource(source);
  const engine = normalizeEngine(source.engine);
  const id = stableId({ engine, sessionId, sourceHash });
  const status = normalizeStatus(source.status);

  db.prepare(`
    INSERT INTO session_sources (
      id, engine, session_id, project, scope, agent_key, cwd,
      source_path, source_hash, source_size, first_ts, last_ts,
      message_count, tool_call_count, tool_error_count,
      status, error_message, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(engine, session_id, source_hash) DO UPDATE SET
      project=excluded.project,
      scope=excluded.scope,
      agent_key=excluded.agent_key,
      cwd=excluded.cwd,
      source_path=excluded.source_path,
      source_size=excluded.source_size,
      first_ts=excluded.first_ts,
      last_ts=excluded.last_ts,
      message_count=excluded.message_count,
      tool_call_count=excluded.tool_call_count,
      tool_error_count=excluded.tool_error_count,
      status=excluded.status,
      error_message=excluded.error_message,
      updated_at=datetime('now')
  `).run(
    id,
    engine,
    sessionId,
    source.project || '*',
    source.scope || null,
    source.agentKey || source.agent_key || null,
    source.cwd || null,
    source.sourcePath || source.source_path || null,
    sourceHash,
    Number(source.sourceSize || source.source_size || 0) || 0,
    source.firstTs || source.first_ts || null,
    source.lastTs || source.last_ts || null,
    Number(source.messageCount || source.message_count || 0) || 0,
    Number(source.toolCallCount || source.tool_call_count || 0) || 0,
    Number(source.toolErrorCount || source.tool_error_count || 0) || 0,
    status,
    source.errorMessage || source.error_message || null,
  );

  return { ok: true, id };
}

function getSessionSource(db, { engine = 'unknown', sessionId, sourceHash }) {
  if (!sessionId || !sourceHash) return null;
  return db.prepare(`
    SELECT * FROM session_sources
    WHERE engine = ? AND session_id = ? AND source_hash = ?
    LIMIT 1
  `).get(normalizeEngine(engine), String(sessionId), String(sourceHash)) || null;
}

function findSessionSources(db, { project = null, scope = null, engine = null, limit = 20 } = {}) {
  const clauses = [];
  const params = [];
  if (project) { clauses.push('(project = ? OR project = ?)'); params.push(project, '*'); }
  if (scope) { clauses.push('(scope = ? OR scope IS NULL)'); params.push(scope); }
  if (engine) { clauses.push('engine = ?'); params.push(normalizeEngine(engine)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(`
    SELECT * FROM session_sources
    ${where}
    ORDER BY COALESCE(last_ts, updated_at, created_at) DESC
    LIMIT ?
  `).all(...params, Number(limit) || 20);
}

function markSessionSourceStatus(db, id, status, errorMessage = null) {
  if (!id) return { ok: false, changed: 0 };
  const normalized = normalizeStatus(status);
  const result = db.prepare(`
    UPDATE session_sources
    SET status = ?, error_message = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(normalized, errorMessage || null, id);
  return { ok: true, changed: result.changes || 0 };
}

module.exports = {
  upsertSessionSource,
  getSessionSource,
  findSessionSources,
  markSessionSourceStatus,
  _internal: { normalizeEngine, normalizeStatus, stableId },
};
