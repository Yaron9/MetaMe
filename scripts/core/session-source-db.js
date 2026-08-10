'use strict';

const crypto = require('node:crypto');
const {
  SESSION_SOURCE_PROTOCOL_VERSION,
  normalizeEngineId,
  serializeCursor,
} = require('./session-source-revision');

const VALID_ENGINES = new Set(['claude', 'codex', 'agy', 'pi', 'unknown']);
const VALID_STATUSES = new Set(['indexed', 'summarized', 'extracted', 'error', 'archived']);
const MAX_ERROR_MESSAGE = 1000;

function dbError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function normalizeEngine(engine) {
  const value = String(engine || 'unknown').trim().toLowerCase();
  return VALID_ENGINES.has(value) ? value : 'unknown';
}

function normalizeSourceEngine(engine) {
  const value = String(engine || 'unknown').trim().toLowerCase();
  try {
    return normalizeEngineId(value);
  } catch {
    return 'unknown';
  }
}

function normalizeStatus(status) {
  const value = String(status || 'indexed').trim().toLowerCase();
  return VALID_STATUSES.has(value) ? value : 'indexed';
}

function normalizeErrorCode(value) {
  const code = String(value || 'EXTRACTION_FAILED').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return code.slice(0, 80) || 'EXTRACTION_FAILED';
}

function normalizeErrorMessage(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE) || null;
}

function stableId({ engine, sessionId, sourceHash }) {
  const seed = `${normalizeEngine(engine)}:${String(sessionId || '').trim()}:${String(sourceHash || '').trim()}`;
  return `ss_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function stableSessionSourceId({ engineId, nativeSessionId, sourceHash }) {
  const seed = JSON.stringify([
    normalizeSourceEngine(engineId),
    String(nativeSessionId || '').trim(),
    String(sourceHash || '').trim(),
  ]);
  return `ss_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

function requireSessionSource(source) {
  if (!source || typeof source !== 'object') throw new Error('session source is required');
  const sessionId = String(
    source.nativeSessionId || source.native_session_id || source.sessionId || source.session_id || '',
  ).trim();
  if (!sessionId) throw new Error('session source requires sessionId');
  const sourceHash = String(
    source.sourceHash || source.source_hash || source.sourceRevision || source.source_revision || '',
  ).trim();
  if (!sourceHash) throw new Error('session source requires sourceHash');
  return { sessionId, sourceHash };
}

function tableExists(db, tableName) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
}

function tableColumns(db, tableName) {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name));
}

function createSessionSourcesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_sources (
      id                       TEXT PRIMARY KEY,
      engine                   TEXT NOT NULL DEFAULT 'unknown'
                               CHECK (length(trim(engine)) > 0),
      engine_id                TEXT NOT NULL DEFAULT 'unknown',
      session_id               TEXT NOT NULL,
      native_session_id        TEXT NOT NULL,
      project                  TEXT DEFAULT '*',
      scope                    TEXT,
      agent_key                TEXT,
      cwd                     TEXT,
      source_path              TEXT,
      source_locator           TEXT,
      source_hash              TEXT NOT NULL,
      source_size              INTEGER DEFAULT 0,
      first_ts                TEXT,
      last_ts                 TEXT,
      message_count           INTEGER DEFAULT 0,
      tool_call_count         INTEGER DEFAULT 0,
      tool_error_count        INTEGER DEFAULT 0,
      adapter_protocol_version INTEGER NOT NULL DEFAULT 1,
      discovery_cursor        TEXT,
      last_ingested_sequence  INTEGER DEFAULT 0,
      parent_native_session_id TEXT,
      classification           TEXT DEFAULT 'conversation',
      source_state             TEXT NOT NULL DEFAULT 'present',
      validation_code          TEXT,
      status                   TEXT DEFAULT 'indexed'
                               CHECK (status IN ('indexed','summarized','extracted','error','archived')),
      error_code               TEXT,
      error_message            TEXT,
      created_at               TEXT DEFAULT (datetime('now')),
      updated_at               TEXT DEFAULT (datetime('now')),
      UNIQUE(engine, session_id, source_hash),
      UNIQUE(engine_id, native_session_id, source_hash)
    )
  `);
}

function rebuildRestrictedSessionSources(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='session_sources'").get();
  const sql = String(row && row.sql || '');
  if (!/CHECK\s*\(\s*engine\s+IN\s*\(/i.test(sql)) return false;

  const legacy = 'session_sources__legacy_t14';
  db.exec('DROP TABLE IF EXISTS session_sources__legacy_t14');
  for (const index of [
    'idx_session_sources_session',
    'idx_session_sources_project',
    'idx_session_sources_agent',
  ]) {
    db.exec(`DROP INDEX IF EXISTS ${index}`);
  }
  db.exec(`ALTER TABLE session_sources RENAME TO ${legacy}`);
  createSessionSourcesTable(db);
  const legacyColumns = tableColumns(db, legacy);
  const insertColumns = [
    'id', 'engine', 'engine_id', 'session_id', 'native_session_id', 'project', 'scope', 'agent_key',
    'cwd', 'source_path', 'source_locator', 'source_hash', 'source_size', 'first_ts',
    'last_ts', 'message_count', 'tool_call_count', 'tool_error_count', 'adapter_protocol_version',
    'discovery_cursor', 'last_ingested_sequence', 'parent_native_session_id', 'classification',
    'source_state', 'validation_code', 'status', 'error_code', 'error_message', 'created_at', 'updated_at',
  ];
  const fallbacks = {
    engine: "'unknown'",
    engine_id: 'engine',
    native_session_id: 'session_id',
    source_locator: 'source_path',
    adapter_protocol_version: '1',
    last_ingested_sequence: '0',
    classification: "'conversation'",
    source_state: "'present'",
  };
  const expression = column => legacyColumns.has(column) ? column : fallbacks[column] || 'NULL';
  const select = insertColumns.map(expression);
  db.exec(`INSERT INTO session_sources (${insertColumns.join(',')}) SELECT ${select.join(',')} FROM ${legacy}`);
  db.exec(`DROP TABLE ${legacy}`);
  return true;
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (tableColumns(db, tableName).has(columnName)) return false;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  return true;
}

/**
 * Apply the additive source schema to any existing cognitive DB.
 * This deliberately does not use PRAGMA user_version: memory.db is shared by
 * multiple subsystems and each subsystem must be safe to initialize alone.
 */
function ensureSessionSourceSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw dbError('session_source_database_required');
  }
  createSessionSourcesTable(db);
  rebuildRestrictedSessionSources(db);
  for (const [column, definition] of [
    ['engine_id', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['native_session_id', "TEXT NOT NULL DEFAULT ''"],
    ['source_locator', 'TEXT'],
    ['adapter_protocol_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['discovery_cursor', 'TEXT'],
    ['last_ingested_sequence', 'INTEGER DEFAULT 0'],
    ['parent_native_session_id', 'TEXT'],
    ['classification', "TEXT DEFAULT 'conversation'"],
    ['source_state', "TEXT NOT NULL DEFAULT 'present'"],
    ['validation_code', 'TEXT'],
    ['error_code', 'TEXT'],
  ]) {
    addColumnIfMissing(db, 'session_sources', column, definition);
  }
  // Backfill aliases after an ALTER migration. Existing rows remain fully
  // readable even when their Engine Plugin is no longer installed.
  db.exec(`UPDATE session_sources
              SET engine_id = CASE WHEN engine_id IS NULL OR engine_id = '' OR engine_id = 'unknown' THEN engine ELSE engine_id END,
                  native_session_id = COALESCE(NULLIF(native_session_id, ''), session_id),
                  source_locator = COALESCE(source_locator, source_path)
            WHERE engine_id IS NULL OR engine_id = '' OR engine_id = 'unknown'
               OR native_session_id IS NULL OR native_session_id = ''
               OR source_locator IS NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_session ON session_sources(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_engine_native ON session_sources(engine_id, native_session_id, source_hash)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_project ON session_sources(project, scope, last_ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_agent ON session_sources(agent_key, last_ts)');
  return true;
}

function encodeCursor(cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (typeof cursor === 'string') return cursor;
  if (typeof cursor === 'number') return `@number:${cursor}`;
  if (typeof cursor === 'boolean') return `@boolean:${cursor}`;
  return serializeCursor(cursor);
}

function decodeCursor(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (text.startsWith('@number:')) return Number(text.slice('@number:'.length));
  if (text.startsWith('@boolean:')) return text.slice('@boolean:'.length) === 'true';
  if (text.startsWith('@string:')) return text.slice('@string:'.length);
  if (!/^[\[{]/.test(text)) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function encodeSourceLocator(locator) {
  if (locator === null || locator === undefined) return null;
  if (typeof locator === 'string') return locator;
  try {
    return `@json:${JSON.stringify(locator)}`;
  } catch {
    throw dbError('session_source_locator_invalid');
  }
}

function decodeSourceLocator(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text.startsWith('@json:')) return value;
  try { return JSON.parse(text.slice('@json:'.length)); } catch { return value; }
}

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function hydrateSourceRow(row) {
  if (!row) return null;
  const storedLocator = row.source_locator !== null && row.source_locator !== undefined
    ? row.source_locator
    : row.source_path;
  const hydratedLocator = storedLocator === null || storedLocator === undefined ? null : storedLocator;
  return {
    ...row,
    engine_id: row.engine_id || row.engine,
    native_session_id: row.native_session_id || row.session_id,
    source_revision: row.source_revision || row.source_hash,
    source_locator: hydratedLocator,
    source_locator_value: decodeSourceLocator(hydratedLocator),
    sourceLocator: decodeSourceLocator(hydratedLocator),
    discovery_cursor_value: decodeCursor(row.discovery_cursor),
  };
}

function upsertSessionSource(db, source) {
  ensureSessionSourceSchema(db);
  const { sessionId, sourceHash } = requireSessionSource(source);
  const engineId = normalizeSourceEngine(source.engineId || source.engine_id || source.engine);
  const id = source.id || stableSessionSourceId({ engineId, nativeSessionId: sessionId, sourceHash });
  const status = normalizeStatus(source.status === 'missing' ? 'error' : source.status);
  const sourceState = source.sourceState || source.source_state || (source.status === 'missing' ? 'missing' : 'present');
  const sourcePath = source.sourcePath || source.source_path || null;
  const sourceLocator = source.sourceLocator !== undefined
    ? encodeSourceLocator(source.sourceLocator)
    : source.source_locator !== undefined
      ? encodeSourceLocator(source.source_locator)
      : sourcePath;
  const cursor = encodeCursor(firstDefined(source.discoveryCursor, source.discovery_cursor));
  db.prepare(`
    INSERT INTO session_sources (
      id, engine, engine_id, session_id, native_session_id, project, scope, agent_key, cwd,
      source_path, source_locator, source_hash, source_size, first_ts, last_ts,
      message_count, tool_call_count, tool_error_count, adapter_protocol_version,
      discovery_cursor, last_ingested_sequence, parent_native_session_id, classification, source_state,
      validation_code, status, error_code, error_message, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(engine, session_id, source_hash) DO UPDATE SET
      engine_id=excluded.engine_id,
      native_session_id=excluded.native_session_id,
      project=excluded.project,
      scope=excluded.scope,
      agent_key=excluded.agent_key,
      cwd=excluded.cwd,
      source_path=excluded.source_path,
      source_locator=excluded.source_locator,
      source_size=excluded.source_size,
      first_ts=excluded.first_ts,
      last_ts=excluded.last_ts,
      message_count=excluded.message_count,
      tool_call_count=excluded.tool_call_count,
      tool_error_count=excluded.tool_error_count,
      adapter_protocol_version=excluded.adapter_protocol_version,
      discovery_cursor=excluded.discovery_cursor,
      last_ingested_sequence=excluded.last_ingested_sequence,
      parent_native_session_id=excluded.parent_native_session_id,
      classification=excluded.classification,
      source_state=excluded.source_state,
      validation_code=excluded.validation_code,
      status=excluded.status,
      error_code=excluded.error_code,
      error_message=excluded.error_message,
      updated_at=datetime('now')
  `).run(
    id,
    engineId,
    engineId,
    sessionId,
    sessionId,
    source.project || '*',
    source.scope || null,
    source.agentKey || source.agent_key || null,
    source.cwd || null,
    sourcePath,
    sourceLocator,
    sourceHash,
    normalizeInteger(source.sourceSize || source.source_size, 0),
    source.firstTs || source.first_ts || null,
    source.lastTs || source.last_ts || null,
    normalizeInteger(source.messageCount || source.message_count, 0),
    normalizeInteger(source.toolCallCount || source.tool_call_count, 0),
    normalizeInteger(source.toolErrorCount || source.tool_error_count, 0),
    normalizeInteger(source.adapterProtocolVersion || source.adapter_protocol_version, SESSION_SOURCE_PROTOCOL_VERSION) || SESSION_SOURCE_PROTOCOL_VERSION,
    cursor,
    normalizeInteger(source.lastIngestedSequence || source.last_ingested_sequence, 0),
    source.parentNativeSessionId || source.parent_native_session_id || null,
    source.classification || 'conversation',
    sourceState,
    source.validationCode || source.validation_code || null,
    status,
    source.errorCode || source.error_code || null,
    source.errorMessage || source.error_message || null,
  );
  return { ok: true, id, processingIdentity: { engineId, nativeSessionId: sessionId, sourceHash } };
}

function getSessionSource(db, {
  engine = null,
  engineId = null,
  sessionId = null,
  nativeSessionId = null,
  sourceHash = null,
  sourceRevision = null,
} = {}) {
  ensureSessionSourceSchema(db);
  const engineValue = normalizeSourceEngine(engineId || engine || 'unknown');
  const sessionValue = String(nativeSessionId || sessionId || '').trim();
  const hashValue = String(sourceRevision || sourceHash || '').trim();
  if (!sessionValue || !hashValue) return null;
  return hydrateSourceRow(db.prepare(`
    SELECT * FROM session_sources
    WHERE engine_id = ? AND native_session_id = ? AND source_hash = ?
    LIMIT 1
  `).get(engineValue, sessionValue, hashValue) || null);
}

function findSessionSources(db, {
  project = null,
  scope = null,
  engine = null,
  engineId = null,
  sessionId = null,
  sourceState = null,
  limit = 20,
} = {}) {
  ensureSessionSourceSchema(db);
  const clauses = [];
  const params = [];
  if (project) { clauses.push('(project = ? OR project = ?)'); params.push(project, '*'); }
  if (scope) { clauses.push('(scope = ? OR scope IS NULL)'); params.push(scope); }
  if (engine || engineId) { clauses.push('engine_id = ?'); params.push(normalizeSourceEngine(engineId || engine)); }
  if (sessionId) { clauses.push('(native_session_id = ? OR session_id = ?)'); params.push(String(sessionId), String(sessionId)); }
  if (sourceState) { clauses.push('source_state = ?'); params.push(String(sourceState)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 1000);
  return db.prepare(`
    SELECT * FROM session_sources
    ${where}
    ORDER BY COALESCE(last_ts, updated_at, created_at) DESC, id ASC
    LIMIT ?
  `).all(...params, safeLimit).map(hydrateSourceRow);
}

function markSessionSourceStatus(db, id, status, errorMessage = null) {
  ensureSessionSourceSchema(db);
  if (!id) return { ok: false, changed: 0 };
  const normalized = normalizeStatus(status);
  const message = typeof errorMessage === 'object' ? errorMessage.message || errorMessage.errorMessage : errorMessage;
  const code = typeof errorMessage === 'object' ? errorMessage.errorCode || errorMessage.error_code : null;
  const result = db.prepare(`
    UPDATE session_sources
       SET status = ?, error_code = COALESCE(?, error_code), error_message = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(normalized, code || null, normalizeErrorMessage(message), id);
  return { ok: true, changed: result.changes || 0 };
}

function markSessionSourceMissing(db, id, errorCode = 'SOURCE_MISSING', errorMessage = 'source is missing') {
  ensureSessionSourceSchema(db);
  const result = db.prepare(`
    UPDATE session_sources
       SET source_state = 'missing', validation_code = ?, status = 'error', error_code = ?,
           error_message = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(normalizeErrorCode(errorCode), normalizeErrorCode(errorCode), normalizeErrorMessage(errorMessage), id);
  return { ok: true, changed: result.changes || 0 };
}

function updateSessionSourceProgress(db, id, progress = {}) {
  ensureSessionSourceSchema(db);
  const result = db.prepare(`
    UPDATE session_sources
       SET discovery_cursor = COALESCE(?, discovery_cursor),
           last_ingested_sequence = COALESCE(?, last_ingested_sequence),
           updated_at = datetime('now')
     WHERE id = ?
  `).run(
    progress.discoveryCursor === undefined && progress.discovery_cursor === undefined
      ? null
      : encodeCursor(progress.discoveryCursor ?? progress.discovery_cursor),
    progress.lastIngestedSequence === undefined && progress.last_ingested_sequence === undefined
      ? null
      : normalizeInteger(progress.lastIngestedSequence ?? progress.last_ingested_sequence, 0),
    id,
  );
  return { ok: true, changed: result.changes || 0 };
}

module.exports = {
  ensureSessionSourceSchema,
  upsertSessionSource,
  getSessionSource,
  findSessionSources,
  markSessionSourceStatus,
  markSessionSourceMissing,
  updateSessionSourceProgress,
  _internal: {
    stableId,
  },
};
