'use strict';

const crypto = require('node:crypto');
const {
  SESSION_SOURCE_PROTOCOL_VERSION,
  normalizeEngineId,
  normalizePipelineVersion,
  serializeCursor,
  processingIdentity,
  processingId,
} = require('./session-source-revision');

// These values are retained for compatibility with the existing memory
// extractor.  Universal source adapters may use any valid Engine ID; the
// legacy `normalizeEngine` helper intentionally remains strict for callers
// that used it as an allowlist.
const VALID_ENGINES = new Set(['claude', 'codex', 'agy', 'pi', 'unknown']);
const VALID_STATUSES = new Set(['indexed', 'summarized', 'extracted', 'error', 'archived']);
const EXTRACTION_STATUSES = new Set(['pending', 'leased', 'running', 'completed', 'failed', 'skipped', 'expired']);
const TERMINAL_EXTRACTION_STATUSES = new Set(['completed', 'failed', 'skipped']);
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
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

function normalizeExtractionStatus(status) {
  const value = String(status || 'pending').trim().toLowerCase();
  return EXTRACTION_STATUSES.has(value) ? value : 'pending';
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
      first_ts                 TEXT,
      last_ts                  TEXT,
      message_count            INTEGER DEFAULT 0,
      tool_call_count          INTEGER DEFAULT 0,
      tool_error_count         INTEGER DEFAULT 0,
      adapter_protocol_version INTEGER NOT NULL DEFAULT 1,
      discovery_cursor         TEXT,
      last_ingested_sequence   INTEGER DEFAULT 0,
      parent_native_session_id TEXT,
      classification           TEXT DEFAULT 'conversation',
      source_state              TEXT NOT NULL DEFAULT 'present',
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
    'last_ts', 'message_count', 'tool_call_count', 'tool_error_count', 'status', 'error_message',
    'created_at', 'updated_at',
  ];
  const expression = column => legacyColumns.has(column) ? column : 'NULL';
  const select = [
    expression('id'), expression('engine'), expression('engine'), expression('session_id'), expression('session_id'),
    expression('project'), expression('scope'), expression('agent_key'), expression('cwd'), expression('source_path'),
    expression('source_path'), expression('source_hash'), expression('source_size'),
    expression('first_ts'), expression('last_ts'), expression('message_count'), expression('tool_call_count'),
    expression('tool_error_count'), expression('status'), expression('error_message'), expression('created_at'),
    expression('updated_at'),
  ];
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
 * Apply the additive source/extraction schema to any existing cognitive DB.
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
  // Backfill aliases after an ALTER migration.  Existing rows remain fully
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_runs (
      id                TEXT PRIMARY KEY,
      session_source_id TEXT NOT NULL,
      pipeline_version  TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','leased','running','completed','failed','skipped','expired')),
      lease_token       TEXT,
      lease_expires_at  TEXT,
      attempt           INTEGER NOT NULL DEFAULT 0,
      started_at        TEXT,
      completed_at      TEXT,
      error_code        TEXT,
      error_message     TEXT,
      processing_identity TEXT,
      metrics_json      TEXT NOT NULL DEFAULT '{}',
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_source_id, pipeline_version),
      FOREIGN KEY (session_source_id) REFERENCES session_sources(id)
    )
  `);
  for (const [column, definition] of [
    ['lease_token', 'TEXT'],
    ['lease_expires_at', 'TEXT'],
    ['attempt', 'INTEGER NOT NULL DEFAULT 0'],
    ['started_at', 'TEXT'],
    ['completed_at', 'TEXT'],
    ['error_code', 'TEXT'],
    ['error_message', 'TEXT'],
    ['processing_identity', 'TEXT'],
    ['metrics_json', "TEXT NOT NULL DEFAULT '{}'"],
    ['created_at', "TEXT NOT NULL DEFAULT (datetime('now'))"],
    ['updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))"],
  ]) {
    addColumnIfMissing(db, 'extraction_runs', column, definition);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_runs_status ON extraction_runs(status, lease_expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_extraction_runs_source ON extraction_runs(session_source_id, pipeline_version)');
  return true;
}

function encodeCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor === 'string') return cursor;
  return serializeCursor(cursor);
}

function decodeCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (!/^[\[{]/.test(text)) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function normalizeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeNow(value) {
  if (value instanceof Date) return value.toISOString();
  if (value !== undefined && value !== null) {
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    throw dbError('timestamp_invalid', String(value));
  }
  return new Date().toISOString();
}

function addMilliseconds(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function normalizeLeaseMs(value) {
  const ms = Number(value === undefined ? DEFAULT_LEASE_MS : value);
  if (!Number.isFinite(ms) || ms <= 0) throw dbError('extraction_lease_duration_invalid');
  return Math.min(Math.floor(ms), 24 * 60 * 60 * 1000);
}

function normalizeErrorCode(value) {
  const code = String(value || 'EXTRACTION_FAILED').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return code.slice(0, 80) || 'EXTRACTION_FAILED';
}

function normalizeErrorMessage(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE) || null;
}

function normalizeMetrics(value) {
  if (value === null || value === undefined) return {};
  const metrics = typeof value === 'string' ? (() => {
    try { return JSON.parse(value); } catch { return {}; }
  })() : value;
  if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) return {};
  try { return JSON.parse(JSON.stringify(metrics)); } catch { return {}; }
}

function metricsJson(value) {
  return JSON.stringify(normalizeMetrics(value));
}

function hydrateSourceRow(row) {
  if (!row) return null;
  return {
    ...row,
    engine_id: row.engine_id || row.engine,
    native_session_id: row.native_session_id || row.session_id,
    source_revision: row.source_revision || row.source_hash,
    source_locator: row.source_locator || row.source_path || null,
    discovery_cursor_value: decodeCursor(row.discovery_cursor),
  };
}

function hydrateExtractionRun(row) {
  if (!row) return null;
  const metrics = normalizeMetrics(row.metrics_json);
  return {
    ...row,
    metrics,
    processing_identity: row.processing_identity || null,
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
    ? encodeCursor(source.sourceLocator)
    : source.source_locator !== undefined
      ? encodeCursor(source.source_locator)
      : sourcePath;
  const cursor = encodeCursor(source.discoveryCursor || source.discovery_cursor);
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

function getSessionSource(db, { engine = null, engineId = null, sessionId = null, nativeSessionId = null, sourceHash = null, sourceRevision = null } = {}) {
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

function findSessionSources(db, { project = null, scope = null, engine = null, engineId = null, sessionId = null, sourceState = null, limit = 20 } = {}) {
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

function sourceRowForExtraction(db, options) {
  const sourceId = options.sessionSourceId || options.session_source_id || options.sourceId || options.source_id;
  if (sourceId) {
    const row = hydrateSourceRow(db.prepare('SELECT * FROM session_sources WHERE id=?').get(String(sourceId)) || null);
    if (!row) throw dbError('session_source_not_found', String(sourceId));
    return row;
  }
  const row = getSessionSource(db, options);
  if (!row) throw dbError('session_source_not_found');
  return row;
}

function normalizeExtractionInput(options, pipelineVersion = null, extras = {}) {
  if (typeof options !== 'string') return options || {};
  if (typeof pipelineVersion === 'string' && pipelineVersion.trim()) {
    return { sessionSourceId: options, pipelineVersion, ...extras };
  }
  if (pipelineVersion && typeof pipelineVersion === 'object') {
    return { runId: options, ...pipelineVersion };
  }
  return { runId: options, ...extras };
}

function extractionOptions(db, options = {}) {
  if (!options || typeof options !== 'object') throw dbError('extraction_run_options_required');
  const source = sourceRowForExtraction(db, options);
  const pipelineVersion = normalizePipelineVersion(options.pipelineVersion || options.pipeline_version);
  const identityInput = {
    engineId: source.engine_id || source.engine,
    nativeSessionId: source.native_session_id || source.session_id,
    sourceHash: source.source_hash,
    pipelineVersion,
  };
  return {
    source,
    sourceId: source.id,
    pipelineVersion,
    identity: processingIdentity(identityInput),
    runId: options.runId || options.run_id || processingId(identityInput),
  };
}

function getExtractionRun(db, options = {}, pipelineVersion = null) {
  ensureSessionSourceSchema(db);
  options = normalizeExtractionInput(options, pipelineVersion);
  if (typeof options === 'string') {
    return hydrateExtractionRun(db.prepare('SELECT * FROM extraction_runs WHERE id=?').get(options) || null);
  }
  if (options && (options.runId || options.run_id)) {
    return hydrateExtractionRun(db.prepare('SELECT * FROM extraction_runs WHERE id=?').get(String(options.runId || options.run_id)) || null);
  }
  const parsed = extractionOptions(db, options);
  return hydrateExtractionRun(db.prepare(`
    SELECT * FROM extraction_runs WHERE session_source_id=? AND pipeline_version=? LIMIT 1
  `).get(parsed.sourceId, parsed.pipelineVersion) || null);
}

function ensureExtractionRun(db, options = {}, pipelineVersion = null, extras = {}) {
  ensureSessionSourceSchema(db);
  options = normalizeExtractionInput(options, pipelineVersion, extras);
  const parsed = extractionOptions(db, options);
  const now = normalizeNow(options.now);
  db.prepare(`
    INSERT INTO extraction_runs (
      id, session_source_id, pipeline_version, status, processing_identity, metrics_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', ?, '{}', ?, ?)
    ON CONFLICT(session_source_id, pipeline_version) DO NOTHING
  `).run(parsed.runId, parsed.sourceId, parsed.pipelineVersion, parsed.identity, now, now);
  const row = getExtractionRun(db, parsed.sourceId ? {
    sessionSourceId: parsed.sourceId,
    pipelineVersion: parsed.pipelineVersion,
  } : options);
  if (row && !row.processing_identity) row.processing_identity = parsed.identity;
  return row;
}

function claimExtractionLease(db, options = {}, pipelineVersion = null, extras = {}) {
  options = normalizeExtractionInput(options, pipelineVersion, extras);
  const parsed = extractionOptions(db, options);
  const now = normalizeNow(options.now);
  const leaseMs = normalizeLeaseMs(options.leaseMs ?? options.lease_ms);
  const current = ensureExtractionRun(db, { ...options, sessionSourceId: parsed.sourceId, now });
  if (TERMINAL_EXTRACTION_STATUSES.has(current.status) && current.status !== 'failed') {
    return { ok: true, claimed: false, terminal: true, reason: 'ALREADY_TERMINAL', run: current };
  }
  const expiry = current.lease_expires_at ? Date.parse(current.lease_expires_at) : NaN;
  const active = (current.status === 'leased' || current.status === 'running') && Number.isFinite(expiry) && expiry > Date.parse(now);
  if (active && current.lease_token && current.lease_token !== (options.leaseToken || options.lease_token)) {
    return { ok: false, claimed: false, terminal: false, reason: 'LEASE_HELD', run: current };
  }
  const attempt = normalizeInteger(current.attempt, 0) + 1;
  const token = String(options.leaseToken || options.lease_token || `${parsed.runId}:lease:${attempt}`);
  const result = db.prepare(`
    UPDATE extraction_runs
       SET status = 'leased', lease_token = ?, lease_expires_at = ?, attempt = ?, started_at = COALESCE(started_at, ?),
           completed_at = NULL, error_code = NULL, error_message = NULL, updated_at = ?
     WHERE id = ?
       AND status NOT IN ('completed','skipped')
       AND (
         status NOT IN ('leased','running')
         OR lease_expires_at IS NULL
         OR lease_expires_at <= ?
         OR lease_token = ?
       )
  `).run(token, addMilliseconds(now, leaseMs), attempt, now, now, current.id, now, token);
  if (!result.changes) return { ok: false, claimed: false, terminal: false, reason: 'LEASE_RACE', run: getExtractionRun(db, current.id) };
  const run = hydrateExtractionRun(db.prepare('SELECT * FROM extraction_runs WHERE id=?').get(current.id));
  run.processing_identity = parsed.identity;
  return { ok: true, claimed: true, terminal: false, reason: 'LEASE_ACQUIRED', leaseToken: token, run };
}

function renewExtractionLease(db, options = {}) {
  ensureSessionSourceSchema(db);
  const runId = String(options.runId || options.run_id || '');
  const token = String(options.leaseToken || options.lease_token || '');
  if (!runId || !token) return { ok: false, changed: 0, reason: 'LEASE_CREDENTIALS_REQUIRED' };
  const now = normalizeNow(options.now);
  const result = db.prepare(`
    UPDATE extraction_runs
       SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND lease_token = ? AND status IN ('leased','running')
  `).run(addMilliseconds(now, normalizeLeaseMs(options.leaseMs ?? options.lease_ms)), now, runId, token);
  return { ok: result.changes > 0, changed: result.changes || 0, run: getExtractionRun(db, runId) };
}

function markExtractionRunRunning(db, options = {}) {
  ensureSessionSourceSchema(db);
  const input = typeof options === 'string' ? { runId: options } : options;
  const run = getExtractionRun(db, input.runId || input.run_id || input);
  if (!run) return { ok: false, changed: 0, reason: 'EXTRACTION_RUN_NOT_FOUND', run: null };
  const token = input.leaseToken || input.lease_token;
  if (run.lease_token && run.lease_token !== token) return { ok: false, changed: 0, reason: 'LEASE_TOKEN_MISMATCH', run };
  const result = db.prepare(`
    UPDATE extraction_runs SET status='running', updated_at=?
     WHERE id=? AND status='leased'
  `).run(normalizeNow(input.now), run.id);
  return { ok: result.changes > 0 || run.status === 'running', changed: result.changes || 0, run: getExtractionRun(db, run.id) };
}

function terminalRunOptions(db, options, result = {}) {
  const input = typeof options === 'string' ? { runId: options } : { ...(options || {}), ...(result || {}) };
  let run = null;
  if (input.runId || input.run_id) run = getExtractionRun(db, String(input.runId || input.run_id));
  else run = getExtractionRun(db, input);
  if (!run) throw dbError('extraction_run_not_found');
  return { input, run };
}

function completeExtractionRun(db, options, result = {}) {
  ensureSessionSourceSchema(db);
  options = normalizeExtractionInput(options);
  const { input, run } = terminalRunOptions(db, options, result);
  if (run.status === 'completed') return { ok: true, changed: 0, idempotent: true, run };
  const token = input.leaseToken || input.lease_token;
  if ((run.lease_token && run.lease_token !== token) || ((run.status === 'leased' || run.status === 'running') && !token)) {
    return { ok: false, changed: 0, reason: 'LEASE_TOKEN_MISMATCH', run };
  }
  const now = normalizeNow(input.now);
  const updated = db.prepare(`
    UPDATE extraction_runs
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL, completed_at = ?,
           error_code = NULL, error_message = NULL, metrics_json = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed','skipped')
  `).run(now, metricsJson(input.metrics), now, run.id);
  const finalRun = getExtractionRun(db, run.id);
  return { ok: updated.changes > 0 || finalRun.status === 'completed', changed: updated.changes || 0, run: finalRun };
}

function failExtractionRun(db, options, result = {}) {
  ensureSessionSourceSchema(db);
  options = normalizeExtractionInput(options);
  const { input, run } = terminalRunOptions(db, options, result);
  if (run.status === 'failed') return { ok: true, changed: 0, idempotent: true, run };
  const token = input.leaseToken || input.lease_token;
  if ((run.lease_token && run.lease_token !== token) || ((run.status === 'leased' || run.status === 'running') && !token)) {
    return { ok: false, changed: 0, reason: 'LEASE_TOKEN_MISMATCH', run };
  }
  const now = normalizeNow(input.now);
  const errorCode = normalizeErrorCode(input.errorCode || input.error_code || input.code);
  const errorMessage = normalizeErrorMessage(input.errorMessage || input.error_message || input.message);
  const updated = db.prepare(`
    UPDATE extraction_runs
       SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, completed_at = ?,
           error_code = ?, error_message = ?, metrics_json = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed','skipped')
  `).run(now, errorCode, errorMessage, metricsJson(input.metrics), now, run.id);
  const finalRun = getExtractionRun(db, run.id);
  return { ok: updated.changes > 0 || finalRun.status === 'failed', changed: updated.changes || 0, run: finalRun };
}

function skipExtractionRun(db, options, result = {}) {
  ensureSessionSourceSchema(db);
  options = normalizeExtractionInput(options);
  const { input, run } = terminalRunOptions(db, options, result);
  if (TERMINAL_EXTRACTION_STATUSES.has(run.status)) return { ok: true, changed: 0, idempotent: true, run };
  const now = normalizeNow(input.now);
  const updated = db.prepare(`
    UPDATE extraction_runs
       SET status = 'skipped', lease_token = NULL, lease_expires_at = NULL, completed_at = ?,
           error_code = NULL, error_message = NULL, metrics_json = ?, updated_at = ?
     WHERE id = ? AND status NOT IN ('completed','failed','skipped')
  `).run(now, metricsJson(input.metrics), now, run.id);
  return { ok: updated.changes > 0, changed: updated.changes || 0, run: getExtractionRun(db, run.id) };
}

function recoverExpiredExtractionLeases(db, options = {}) {
  ensureSessionSourceSchema(db);
  const now = normalizeNow(options.now);
  const result = db.prepare(`
    UPDATE extraction_runs
       SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
           error_code = CASE WHEN error_code IS NULL THEN 'LEASE_EXPIRED' ELSE error_code END,
           updated_at = ?
     WHERE status IN ('leased','running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).run(now, now);
  return { ok: true, recovered: result.changes || 0 };
}

function findExtractionRuns(db, { sessionSourceId = null, pipelineVersion = null, status = null, limit = 100 } = {}) {
  ensureSessionSourceSchema(db);
  const clauses = [];
  const params = [];
  if (sessionSourceId) { clauses.push('session_source_id = ?'); params.push(sessionSourceId); }
  if (pipelineVersion) { clauses.push('pipeline_version = ?'); params.push(pipelineVersion); }
  if (status) { clauses.push('status = ?'); params.push(normalizeExtractionStatus(status)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return db.prepare(`SELECT * FROM extraction_runs ${where} ORDER BY created_at ASC, id ASC LIMIT ?`).all(...params, safeLimit).map(hydrateExtractionRun);
}

module.exports = {
  VALID_ENGINES,
  VALID_STATUSES,
  EXTRACTION_STATUSES,
  TERMINAL_EXTRACTION_STATUSES,
  ensureSessionSourceSchema,
  upsertSessionSource,
  saveSessionSource: upsertSessionSource,
  upsertSourceRevision: upsertSessionSource,
  recordSessionSource: upsertSessionSource,
  getSessionSource,
  findSessionSources,
  getHistoricalSessionSources: findSessionSources,
  markSessionSourceStatus,
  markSessionSourceMissing,
  updateSessionSourceProgress,
  ensureExtractionRun,
  getExtractionRun,
  findExtractionRuns,
  claimExtractionLease,
  acquireExtractionLease: claimExtractionLease,
  claimExtractionRun: claimExtractionLease,
  renewExtractionLease,
  renewLease: renewExtractionLease,
  markExtractionRunRunning,
  startExtractionRun: markExtractionRunRunning,
  completeExtractionRun,
  markExtractionCompleted: completeExtractionRun,
  failExtractionRun,
  markExtractionFailed: failExtractionRun,
  skipExtractionRun,
  recoverExpiredExtractionLeases,
  recoverExtractionLeases: recoverExpiredExtractionLeases,
  reclaimExtractionLeases: recoverExpiredExtractionLeases,
  _internal: {
    addMilliseconds,
    decodeCursor,
    encodeCursor,
    extractionOptions,
    hydrateExtractionRun,
    hydrateSourceRow,
    metricsJson,
    normalizeExtractionInput,
    normalizeEngine,
    normalizeErrorCode,
    normalizeErrorMessage,
    normalizeExtractionStatus,
    normalizeInteger,
    normalizeLeaseMs,
    normalizeNow,
    normalizeSourceEngine,
    normalizeStatus,
    rebuildRestrictedSessionSources,
    requireSessionSource,
    stableId,
    stableSessionSourceId,
    sourceRowForExtraction,
    terminalRunOptions,
  },
};
