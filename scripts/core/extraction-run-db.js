'use strict';

const {
  normalizePipelineVersion,
  processingIdentity,
  processingId,
} = require('./session-source-revision');
const {
  ensureSessionSourceSchema,
  getSessionSource,
} = require('./session-source-db');

const EXTRACTION_STATUSES = new Set(['pending', 'leased', 'running', 'completed', 'failed', 'skipped', 'expired']);
const TERMINAL_EXTRACTION_STATUSES = new Set(['completed', 'failed', 'skipped']);
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_ERROR_MESSAGE = 1000;

function dbError(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function tableExists(db, tableName) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
}

function tableColumns(db, tableName) {
  if (!tableExists(db, tableName)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name));
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (tableColumns(db, tableName).has(columnName)) return false;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  return true;
}

function createExtractionRunsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS extraction_runs (
      id                  TEXT PRIMARY KEY,
      session_source_id   TEXT NOT NULL,
      pipeline_version    TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','leased','running','completed','failed','skipped','expired')),
      lease_token         TEXT,
      lease_expires_at    TEXT,
      attempt             INTEGER NOT NULL DEFAULT 0,
      started_at          TEXT,
      completed_at        TEXT,
      error_code          TEXT,
      error_message       TEXT,
      processing_identity TEXT,
      metrics_json        TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_source_id, pipeline_version),
      FOREIGN KEY (session_source_id) REFERENCES session_sources(id)
    )
  `);
}

function ensureExtractionRunSchema(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw dbError('extraction_run_database_required');
  }
  ensureSessionSourceSchema(db);
  createExtractionRunsTable(db);
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

function normalizeExtractionStatus(status) {
  const value = String(status || 'pending').trim().toLowerCase();
  return EXTRACTION_STATUSES.has(value) ? value : 'pending';
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
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE) || null;
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

function hydrateExtractionRun(row) {
  if (!row) return null;
  return {
    ...row,
    metrics: normalizeMetrics(row.metrics_json),
    processing_identity: row.processing_identity || null,
  };
}

function sourceRowForExtraction(db, options) {
  const sourceId = options.sessionSourceId || options.session_source_id || options.sourceId || options.source_id;
  if (sourceId) {
    const row = db.prepare('SELECT * FROM session_sources WHERE id=?').get(String(sourceId)) || null;
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
  ensureExtractionRunSchema(db);
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
  ensureExtractionRunSchema(db);
  options = normalizeExtractionInput(options, pipelineVersion, extras);
  const parsed = extractionOptions(db, options);
  const now = normalizeNow(options.now);
  db.prepare(`
    INSERT INTO extraction_runs (
      id, session_source_id, pipeline_version, status, processing_identity, metrics_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', ?, '{}', ?, ?)
    ON CONFLICT(session_source_id, pipeline_version) DO NOTHING
  `).run(parsed.runId, parsed.sourceId, parsed.pipelineVersion, parsed.identity, now, now);
  const row = getExtractionRun(db, {
    sessionSourceId: parsed.sourceId,
    pipelineVersion: parsed.pipelineVersion,
  });
  if (row && !row.processing_identity) row.processing_identity = parsed.identity;
  return row;
}

function claimExtractionLease(db, options = {}, pipelineVersion = null, extras = {}) {
  ensureExtractionRunSchema(db);
  options = normalizeExtractionInput(options, pipelineVersion, extras);
  const parsed = extractionOptions(db, options);
  const now = normalizeNow(options.now);
  const leaseMs = normalizeLeaseMs(options.leaseMs ?? options.lease_ms);
  const current = ensureExtractionRun(db, { ...options, sessionSourceId: parsed.sourceId, now });
  if (TERMINAL_EXTRACTION_STATUSES.has(current.status) && current.status !== 'failed') {
    return { ok: true, claimed: false, terminal: true, reason: 'ALREADY_TERMINAL', run: current };
  }
  const expiry = current.lease_expires_at ? Date.parse(current.lease_expires_at) : NaN;
  const active = (current.status === 'leased' || current.status === 'running')
    && Number.isFinite(expiry) && expiry > Date.parse(now);
  if (active && current.lease_token && current.lease_token !== (options.leaseToken || options.lease_token)) {
    return { ok: false, claimed: false, terminal: false, reason: 'LEASE_HELD', run: current };
  }
  const attempt = Number.isSafeInteger(Number(current.attempt)) && Number(current.attempt) >= 0
    ? Number(current.attempt) + 1
    : 1;
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
  if (!result.changes) {
    return { ok: false, claimed: false, terminal: false, reason: 'LEASE_RACE', run: getExtractionRun(db, current.id) };
  }
  const run = hydrateExtractionRun(db.prepare('SELECT * FROM extraction_runs WHERE id=?').get(current.id));
  run.processing_identity = parsed.identity;
  return { ok: true, claimed: true, terminal: false, reason: 'LEASE_ACQUIRED', leaseToken: token, run };
}

function renewExtractionLease(db, options = {}) {
  ensureExtractionRunSchema(db);
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
  ensureExtractionRunSchema(db);
  const input = typeof options === 'string' ? { runId: options } : options;
  const run = getExtractionRun(db, input.runId || input.run_id || input);
  if (!run) return { ok: false, changed: 0, reason: 'EXTRACTION_RUN_NOT_FOUND', run: null };
  const token = input.leaseToken || input.lease_token;
  if (run.lease_token && run.lease_token !== token) return { ok: false, changed: 0, reason: 'LEASE_TOKEN_MISMATCH', run };
  const result = db.prepare(`
    UPDATE extraction_runs SET status='running', updated_at=?
     WHERE id=? AND status='leased'
  `).run(normalizeNow(input.now), run.id);
  return {
    ok: result.changes > 0 || run.status === 'running',
    changed: result.changes || 0,
    run: getExtractionRun(db, run.id),
  };
}

function terminalRunOptions(db, options, result = {}) {
  const input = typeof options === 'string' ? { runId: options } : { ...(options || {}), ...(result || {}) };
  const run = input.runId || input.run_id
    ? getExtractionRun(db, String(input.runId || input.run_id))
    : getExtractionRun(db, input);
  if (!run) throw dbError('extraction_run_not_found');
  return { input, run };
}

function completeExtractionRun(db, options, result = {}) {
  ensureExtractionRunSchema(db);
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
  ensureExtractionRunSchema(db);
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
  ensureExtractionRunSchema(db);
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
  ensureExtractionRunSchema(db);
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

function findExtractionRuns(db, {
  sessionSourceId = null,
  pipelineVersion = null,
  status = null,
  limit = 100,
} = {}) {
  ensureExtractionRunSchema(db);
  const clauses = [];
  const params = [];
  if (sessionSourceId) { clauses.push('session_source_id = ?'); params.push(sessionSourceId); }
  if (pipelineVersion) { clauses.push('pipeline_version = ?'); params.push(pipelineVersion); }
  if (status) { clauses.push('status = ?'); params.push(normalizeExtractionStatus(status)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return db.prepare(`
    SELECT * FROM extraction_runs ${where} ORDER BY created_at ASC, id ASC LIMIT ?
  `).all(...params, safeLimit).map(hydrateExtractionRun);
}

module.exports = {
  ensureExtractionRunSchema,
  ensureExtractionRun,
  getExtractionRun,
  findExtractionRuns,
  claimExtractionLease,
  renewExtractionLease,
  markExtractionRunRunning,
  completeExtractionRun,
  failExtractionRun,
  skipExtractionRun,
  recoverExpiredExtractionLeases,
};
