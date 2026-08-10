#!/usr/bin/env node

'use strict';

const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  DEFAULT_DAYS,
  buildObservabilityResult,
  normalizeDays,
} = require('./core/cognitive-effectiveness');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function allRows(db, table) {
  return tableExists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
}

function scalar(db, sql, fallback = 0) {
  try {
    const row = db.prepare(sql).get();
    const value = row && Object.values(row)[0];
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  } catch {
    return fallback;
  }
}

function countLineageIssues(db) {
  if (!tableExists(db, 'knowledge_artifact_registry') || !tableExists(db, 'knowledge_lineage')) return 0;
  try {
    const missing = scalar(db, `
      SELECT COUNT(*) AS n FROM knowledge_artifact_registry a
       WHERE a.status='active' AND NOT EXISTS (
         SELECT 1 FROM knowledge_lineage l
          WHERE l.child_kind='knowledge_artifact' AND l.child_id=a.artifact_id
       )`);
    const cycles = scalar(db, `
      SELECT COUNT(*) AS n FROM knowledge_lineage
       WHERE child_kind=parent_kind AND child_id=parent_id`);
    return missing + cycles;
  } catch {
    return 0;
  }
}

function countProjectionConflicts(db) {
  if (!tableExists(db, 'wiki_pages')) return 0;
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(wiki_pages)').all().map(row => row.name));
    if (!columns.has('artifact_status')) return 0;
    return scalar(db, "SELECT COUNT(*) AS n FROM wiki_pages WHERE artifact_status='conflict'");
  } catch {
    return 0;
  }
}

function readDroppedCount(db) {
  if (!tableExists(db, 'recall_audit_state')) return 0;
  try {
    return Math.max(0, scalar(db, "SELECT value FROM recall_audit_state WHERE key='dropped_count'"));
  } catch {
    return 0;
  }
}

function collectMemoryObservability({ dbPath = DEFAULT_DB_PATH, days = DEFAULT_DAYS, now } = {}) {
  const normalizedDays = normalizeDays(days);
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const memoryRows = allRows(db, 'memory_items');
    const wikiRows = allRows(db, 'wiki_pages');
    const auditRows = allRows(db, 'recall_audit');
    const sessionSources = allRows(db, 'session_sources');
    const extractionRuns = allRows(db, 'extraction_runs');
    return buildObservabilityResult({
      days: normalizedDays,
      now,
      memoryRows,
      wikiRows,
      auditRows,
      sessionSources,
      extractionRuns,
      auditDropped: readDroppedCount(db),
      lineageIssues: countLineageIssues(db),
      projectionConflicts: countProjectionConflicts(db),
    });
  } catch (error) {
    return buildObservabilityResult({ days: normalizedDays, now, operationalError: error.message });
  } finally {
    try { if (db) db.close(); } catch { /* best effort */ }
  }
}

function parseCliArgs(argv = []) {
  let days = DEFAULT_DAYS;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = String(argv[index]);
    if (arg === '--json') json = true;
    else if (/^--days=/.test(arg)) days = normalizeDays(arg.slice('--days='.length));
    else if (arg === '--days') {
      index++;
      if (index >= argv.length) throw new Error('--days requires a value');
      days = normalizeDays(argv[index]);
    } else if (arg) throw new Error(`unknown option: ${arg}`);
  }
  return { days, json };
}

function formatMetrics(result) {
  const { recall, hygiene, efficiency, inventory, pipeline } = result;
  const states = Object.entries(inventory.by_state).map(([key, value]) => `${key}=${value}`).join(' ');
  const kinds = Object.entries(inventory.by_kind).map(([key, value]) => `${key}=${value}`).join(' ');
  const scopes = Object.entries(inventory.by_scope).map(([key, value]) => `${key}=${value}`).join(' ');
  return [
    `window=${result.window.days}d status=${result.status}`,
    `inventory state[${states || 'empty'}] kind[${kinds || 'empty'}] scope[${scopes || 'empty'}]`,
    `hygiene duplicates=${hygiene.exact_duplicate_groups} conflicts=${hygiene.conflicts} stale=${hygiene.stale} never_consumed=${hygiene.never_consumed}`,
    `recall audit_rows=${recall.audit_rows} unique_traces=${recall.unique_traces} opportunities=${recall.opportunities} injected=${recall.injected} delivered=${recall.delivered} opened=${recall.opened} applied=${recall.applied} validated=${recall.validated} harmful=${recall.harmful} unknown_usage=${recall.unknown_usage} feedback_coverage=${recall.feedback_coverage === null ? 'unknown' : recall.feedback_coverage.toFixed(3)}`,
    `efficiency delivered_items=${efficiency.delivered_items} delivered_chars=${efficiency.delivered_chars} token_count=${efficiency.token_count}`,
    `pipeline session_sources[${Object.entries(pipeline.session_sources).map(([key, value]) => `${key}=${value}`).join(' ') || 'empty'}] extraction_runs[${Object.entries(pipeline.extraction_runs).map(([key, value]) => `${key}=${value}`).join(' ') || 'empty'}] audit_dropped=${pipeline.audit_dropped}`,
  ];
}

function formatStatus(result) {
  return ['MetaMe memory status', ...formatMetrics(result)].join('\n');
}

function formatDoctor(result) {
  const lines = ['MetaMe memory doctor', ...formatMetrics(result)];
  if (result.diagnostics.length === 0) lines.push('diagnostics=none');
  else {
    lines.push('diagnostics:');
    for (const item of result.diagnostics) {
      lines.push(`- [${item.severity}] ${item.code}: ${item.message}${item.recommendation ? ` (${item.recommendation})` : ''}`);
    }
  }
  return lines.join('\n');
}

function exitCode(mode, result) {
  if (mode === 'status') return result.status === 'error' ? 2 : 0;
  return result.status === 'ok' ? 0 : (result.status === 'degraded' ? 1 : 2);
}

function runMemoryCommand(mode, argv = process.argv.slice(2), options = {}) {
  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    if (options.print !== false) console.error(error.message);
    process.exitCode = 2;
    return null;
  }
  const result = collectMemoryObservability({
    dbPath: options.dbPath || DEFAULT_DB_PATH,
    days: parsed.days,
    now: options.now,
  });
  const output = parsed.json ? JSON.stringify(result, null, 2)
    : (mode === 'doctor' ? formatDoctor(result) : formatStatus(result));
  if (options.print !== false) console.log(output);
  process.exitCode = exitCode(mode, result);
  return result;
}

if (require.main === module) runMemoryCommand(process.argv[2] === 'doctor' ? 'doctor' : 'status', process.argv.slice(2));

module.exports = {
  DEFAULT_DB_PATH,
  collectMemoryObservability,
  formatDoctor,
  formatStatus,
  parseCliArgs,
  runMemoryCommand,
  _internal: { allRows, countLineageIssues, countProjectionConflicts, exitCode, formatMetrics, readDroppedCount, tableExists },
};
