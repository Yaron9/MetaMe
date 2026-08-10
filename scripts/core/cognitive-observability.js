'use strict';

/**
 * Pure observability contract for the memory status/doctor commands.
 *
 * The edge command supplies rows read from the existing SQLite tables.  This
 * module deliberately has no database, filesystem, clock, or process exit
 * dependency so recall-report and the memory CLI cannot drift into separate
 * metrics implementations.
 */

const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 365;
const SOURCE_PREFIXES = new Set(['fact', 'wiki', 'session', 'episode', 'skill', 'id']);

function normalizeDays(value = DEFAULT_DAYS) {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim())
    ? Number(value.trim()) : Number(value);
  if (!Number.isInteger(number) || number < MIN_DAYS || number > MAX_DAYS) {
    throw new RangeError(`days must be an integer from ${MIN_DAYS} to ${MAX_DAYS}`);
  }
  return number;
}

function normalizeNow(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed) : new Date();
}

function buildWindow({ days = DEFAULT_DAYS, now } = {}) {
  const normalizedDays = normalizeDays(days);
  const toDate = normalizeNow(now);
  const fromDate = new Date(toDate.getTime() - normalizedDays * 86400000);
  return { days: normalizedDays, from: fromDate.toISOString(), to: toDate.toISOString() };
}

function rowInWindow(row, window) {
  if (!row || !row.ts || !window) return true;
  const timestamp = Date.parse(String(row.ts).replace(' ', 'T') + (String(row.ts).includes('Z') ? '' : 'Z'));
  if (!Number.isFinite(timestamp)) return true;
  return timestamp >= Date.parse(window.from) && timestamp <= Date.parse(window.to);
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function boundedIdentifier(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text || text.length > 160) return '';
  if (!/^[\p{L}\p{N}._:/-]+$/u.test(text)) return '';
  return text;
}

/** Convert a public source descriptor to a bounded opaque audit reference. */
function toBoundedSourceRef(source) {
  if (source && typeof source === 'object') {
    const kind = String(source.kind || source.type || '').toLowerCase();
    const value = source.id || source.slug || source.sessionId || source.session_id;
    if (kind === 'working' || !value) return null;
    const prefix = kind === 'fact' || kind === 'insight' || kind === 'convention' ? 'fact'
      : kind === 'wiki' ? 'wiki'
        : kind === 'episode' || kind === 'session' ? 'session'
          : kind === 'skill' ? 'skill' : '';
    if (!prefix) return null;
    const id = boundedIdentifier(value);
    return id ? `${prefix}:${id}` : null;
  }
  const text = boundedIdentifier(source);
  if (!text) return null;
  const separator = text.indexOf(':');
  if (separator <= 0) return null;
  const prefix = text.slice(0, separator).toLowerCase();
  if (!SOURCE_PREFIXES.has(prefix)) return null;
  const id = boundedIdentifier(text.slice(separator + 1));
  return id ? `${prefix}:${id}` : null;
}

function sourceRefs(row) {
  return [...new Set(parseArray(row && row.source_refs).map(toBoundedSourceRef).filter(Boolean))];
}

function traceValue(row, index) {
  const trace = boundedIdentifier(row && row.trace_id);
  return trace || `__row:${boundedIdentifier(row && row.id) || index}`;
}

function rowPairs(row, index) {
  const trace = traceValue(row, index);
  const refs = sourceRefs(row);
  const values = refs.length > 0 ? refs : [`__row:${boundedIdentifier(row && row.id) || index}`];
  return {
    trace,
    refs,
    explicit: traceValue(row, index) === boundedIdentifier(row && row.trace_id) && refs.length > 0,
    keys: values.map(ref => `${trace}|${ref}`),
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function addPairs(target, rows, predicate) {
  const metadata = new Map();
  rows.forEach((row, index) => {
    if (!predicate(row)) return;
    const pair = rowPairs(row, index);
    pair.keys.forEach(key => {
      target.add(key);
      const previous = metadata.get(key) || { chars: 0, tokens: 0 };
      metadata.set(key, {
        chars: Math.max(previous.chars, numberOrZero(row.injected_chars)),
        tokens: Math.max(previous.tokens, numberOrZero(row.token_count)),
      });
    });
  });
  return metadata;
}

function aggregateRecall(auditRows = [], window = null) {
  const rows = auditRows.filter(row => rowInWindow(row, window));
  const traces = new Set();
  const opportunityTraces = new Set();
  let missingTraceRows = 0;
  rows.forEach((row, index) => {
    const trace = boundedIdentifier(row && row.trace_id);
    if (trace) traces.add(trace);
    else missingTraceRows++;
    if (Number(row && row.should_recall) === 1) {
      // Legacy audit rows predate trace attribution. Preserve their recall
      // opportunity using a bounded row identity rather than silently
      // deleting demand from the denominator. The missing trace count below
      // keeps coverage degraded so this surrogate is never presented as a
      // real trace.
      opportunityTraces.add(trace || `__row:${boundedIdentifier(row && row.id) || index}`);
    }
  });

  const injected = new Set();
  const delivered = new Set();
  const opened = new Set();
  const applied = new Set();
  const validated = new Set();
  const harmful = new Set();
  const injectedMeta = addPairs(injected, rows, row => row.phase === 'inject'
    && (numberOrZero(row.injected_chars) > 0 || row.outcome === 'injected'));
  const deliveredMeta = addPairs(delivered, rows, row => row.consumer_stage === 'delivered');
  addPairs(opened, rows, row => row.consumer_stage === 'opened');
  addPairs(applied, rows, row => row.consumer_stage === 'applied');
  addPairs(validated, rows, row => row.consumer_stage === 'validated');
  addPairs(harmful, rows, row => row.outcome === 'harmful');

  const feedback = new Set([...applied, ...validated, ...harmful]);
  const observedFeedback = [...feedback].filter(key => delivered.has(key));
  const completeDeliveryCoverage = rows
    .filter(row => row.consumer_stage === 'delivered')
    .every((row, index) => rowPairs(row, index).explicit);
  const unmatchedFeedback = [...feedback].some(key => !delivered.has(key));
  const incompleteCoverage = !completeDeliveryCoverage || unmatchedFeedback;
  const feedbackCoverage = delivered.size === 0 || observedFeedback.length === 0 || incompleteCoverage
    ? null : observedFeedback.length / delivered.size;
  const deliveredUnknown = [...delivered].filter(key => !feedback.has(key)).length;
  const deliveredChars = [...deliveredMeta.values()].reduce((sum, item) => sum + item.chars, 0);
  const tokenCount = [...deliveredMeta.values()].reduce((sum, item) => sum + item.tokens, 0)
    + [...injectedMeta.values()].reduce((sum, item) => sum + item.tokens, 0);
  const missingTokenRows = rows.some(row => row.consumer_stage === 'delivered' && numberOrZero(row.token_count) === 0);

  return {
    audit_rows: rows.length,
    unique_traces: traces.size,
    opportunities: opportunityTraces.size,
    injected: injected.size,
    delivered: delivered.size,
    opened: opened.size,
    applied: applied.size,
    validated: validated.size,
    harmful: harmful.size,
    unknown_usage: deliveredUnknown,
    feedback_coverage: feedbackCoverage,
    delivered_items: delivered.size,
    delivered_chars: deliveredChars,
    token_count: tokenCount,
    missing_trace_rows: missingTraceRows,
    incomplete_delivery_coverage: incompleteCoverage,
    missing_token_data: missingTokenRows,
  };
}

function normalizeContent(value) {
  return String(value || '').normalize('NFC').replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(/[ \t]+$/g, '')).join('\n').trim();
}

function countMap(rows, selector) {
  const result = {};
  for (const row of rows) {
    const key = selector(row) || 'unknown';
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function aggregateInventory(memoryRows = []) {
  return {
    by_state: countMap(memoryRows, row => row.state),
    by_kind: countMap(memoryRows, row => row.kind),
    by_scope: countMap(memoryRows, row => row.scope || row.project),
  };
}

function aggregateHygiene(memoryRows = [], wikiRows = [], auditRows = []) {
  const duplicateGroups = new Set();
  const candidates = new Map();
  for (const row of memoryRows) {
    if (row.state !== 'candidate') continue;
    const content = normalizeContent(row.content);
    if (!content) continue;
    const key = [row.kind || 'unknown', row.project || '*', row.scope || '', content].join('\u0000');
    candidates.set(key, (candidates.get(key) || 0) + 1);
  }
  for (const [key, count] of candidates) if (count > 1) duplicateGroups.add(key);

  const consumed = new Set();
  for (const row of auditRows) for (const ref of sourceRefs(row)) consumed.add(ref);
  let neverConsumed = 0;
  for (const row of memoryRows) {
    if (row.state !== 'active' || !row.id) continue;
    const id = String(row.id);
    if (!['id:', 'fact:', 'insight:', 'convention:'].some(prefix => consumed.has(`${prefix}${id}`))) neverConsumed++;
  }
  const stale = new Set();
  for (const row of memoryRows) {
    if (row.state === 'stale' || row.stale === true || Number(row.staleness) >= 0.3) stale.add(`memory:${row.id}`);
  }
  for (const row of wikiRows) {
    if (row.artifact_status === 'stale' || row.stale === true || Number(row.staleness) >= 0.3) stale.add(`wiki:${row.slug || row.id}`);
  }
  return {
    exact_duplicate_groups: duplicateGroups.size,
    conflicts: memoryRows.filter(row => row.state === 'conflict').length,
    stale: stale.size,
    never_consumed: neverConsumed,
  };
}

function aggregatePipeline(sessionSources = [], extractionRuns = []) {
  return {
    session_sources: countMap(sessionSources, row => row.status || row.source_state),
    extraction_runs: countMap(extractionRuns, row => row.status),
  };
}

function diagnostic(code, severity, message, recommendation = null) {
  return { code, severity, message, ...(recommendation ? { recommendation } : {}) };
}

function diagnoseObservability({ hygiene, recall, pipeline, auditDropped = 0, lineageIssues = 0, projectionConflicts = 0, legacyBaselines = 0, pendingAnnotations = 0 } = {}) {
  const diagnostics = [];
  if (hygiene.conflicts > 0) diagnostics.push(diagnostic('unresolved_conflicts', 'error', `${hygiene.conflicts} unresolved memory conflict(s)`, 'Review and resolve each conflict explicitly.'));
  if (lineageIssues > 0) diagnostics.push(diagnostic('broken_lineage', 'error', `${lineageIssues} broken knowledge lineage record(s)`, 'Repair lineage before relying on derived artifacts.'));
  if (projectionConflicts > 0) diagnostics.push(diagnostic('wiki_projection_conflict', 'error', `${projectionConflicts} managed Wiki projection conflict(s)`, 'Preserve both revisions and review the projection conflict.'));
  if (legacyBaselines > 0) diagnostics.push(diagnostic('legacy_baseline', 'degraded', `${legacyBaselines} legacy projection baseline(s) need review`, 'Adopt or rebuild the baseline explicitly.'));
  if (pendingAnnotations > 0) diagnostics.push(diagnostic('pending_annotations', 'degraded', `${pendingAnnotations} pending human annotation(s)`, 'Review annotations through the normal claim workflow.'));
  if (Number(auditDropped) > 0) diagnostics.push(diagnostic('audit_dropped', 'degraded', `${Number(auditDropped)} recall audit row(s) were dropped`, 'Inspect database contention before tuning recall.'));
  if (recall.feedback_coverage === null) diagnostics.push(diagnostic('insufficient_data', 'degraded', 'Recall feedback coverage is unavailable for the selected window', 'Collect delivered and outcome feedback before judging utilization.'));
  if (recall.missing_trace_rows > 0) diagnostics.push(diagnostic('trace_coverage', 'degraded', `${recall.missing_trace_rows} recall audit row(s) lack a trace ID`, 'Use a shared trace ID for each recall opportunity.'));
  if (recall.incomplete_delivery_coverage) diagnostics.push(diagnostic('trace_source_coverage', 'degraded', 'Some delivered audit rows lack a complete trace/source pair', 'Use a trace ID and bounded source reference for every delivery.'));
  if (recall.missing_token_data) diagnostics.push(diagnostic('token_coverage', 'degraded', 'Some delivered rows have no recorded token count', 'Record token_count when the consuming Host can report it; do not estimate.'));
  const hasPipeline = Object.keys(pipeline.session_sources).length + Object.keys(pipeline.extraction_runs).length > 0;
  if (!hasPipeline) diagnostics.push(diagnostic('pipeline_unavailable', 'degraded', 'Session Source and Extraction Run telemetry is unavailable', 'Run status after the ingestion schema is initialized.'));
  return diagnostics;
}

function resultStatus(diagnostics) {
  if (diagnostics.some(item => item.severity === 'error')) return 'error';
  if (diagnostics.some(item => item.severity === 'degraded')) return 'degraded';
  return 'ok';
}

function buildObservabilityResult({ days = DEFAULT_DAYS, now, auditRows = [], memoryRows = [], wikiRows = [], sessionSources = [], extractionRuns = [], auditDropped = 0, lineageIssues = 0, projectionConflicts = 0, legacyBaselines = 0, pendingAnnotations = 0, operationalError = null } = {}) {
  const window = buildWindow({ days, now });
  const filteredAudit = auditRows.filter(row => rowInWindow(row, window));
  const recall = aggregateRecall(filteredAudit, null);
  const hygiene = aggregateHygiene(memoryRows, wikiRows, filteredAudit);
  const pipeline = aggregatePipeline(sessionSources, extractionRuns);
  const diagnostics = operationalError
    ? [diagnostic('query_failed', 'error', String(operationalError))]
    : diagnoseObservability({ hygiene, recall, pipeline, auditDropped, lineageIssues, projectionConflicts, legacyBaselines, pendingAnnotations });
  return {
    schema_version: 1,
    window,
    status: operationalError ? 'error' : resultStatus(diagnostics),
    inventory: aggregateInventory(memoryRows),
    hygiene,
    recall: {
      audit_rows: recall.audit_rows,
      unique_traces: recall.unique_traces,
      opportunities: recall.opportunities,
      injected: recall.injected,
      delivered: recall.delivered,
      opened: recall.opened,
      applied: recall.applied,
      validated: recall.validated,
      harmful: recall.harmful,
      unknown_usage: recall.unknown_usage,
      feedback_coverage: recall.feedback_coverage,
    },
    efficiency: {
      delivered_items: recall.delivered_items,
      delivered_chars: recall.delivered_chars,
      token_count: recall.token_count,
    },
    pipeline: { ...pipeline, audit_dropped: Number(auditDropped) || 0 },
    diagnostics,
  };
}

module.exports = {
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS,
  aggregateHygiene,
  aggregateInventory,
  aggregatePipeline,
  aggregateRecall,
  buildObservabilityResult,
  buildWindow,
  diagnoseObservability,
  normalizeDays,
  toBoundedSourceRef,
  _internal: { normalizeContent, parseArray, rowInWindow, rowPairs, resultStatus, sourceRefs },
};
