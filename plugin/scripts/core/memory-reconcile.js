'use strict';

/**
 * Pure planning for memory reconciliation.
 *
 * Reconciliation has intentionally narrow authority: only rows that share a
 * canonical identity and the exact same normalized content may be planned for
 * archival.  Titles, tags, confidence, recency, and text similarity are
 * reporting signals only and never produce a mutation action.
 */

const crypto = require('node:crypto');
const {
  claimContentDigest,
  claimIdentity,
  identityToken,
} = require('./claim-contract');

const PLAN_SCHEMA_VERSION = 1;
const PLAN_TYPE = 'memory-reconcile-plan';
const MAX_PLAN_ROWS = 10000;
const MAX_REPORT_ENTRIES = 5000;
const LIVE_STATES = new Set(['candidate', 'active', 'conflict']);
const CLAIM_KINDS = new Set(['insight', 'convention']);
const STATE_PRIORITY = { active: 0, candidate: 1, conflict: 2 };

function normalizeTitle(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function compareRows(left, right) {
  const stateDelta = (STATE_PRIORITY[String(left.state)] ?? 9) - (STATE_PRIORITY[String(right.state)] ?? 9);
  if (stateDelta !== 0) return stateDelta;
  const leftCreated = String(left.created_at || '');
  const rightCreated = String(right.created_at || '');
  if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
  return String(left.id).localeCompare(String(right.id));
}

function rowIdentity(row) {
  return claimIdentity(row);
}

function rowSnapshot(row) {
  const identity = rowIdentity(row);
  return {
    id: String(row.id),
    kind: String(row.kind || ''),
    state: String(row.state || ''),
    identity,
    content_digest: claimContentDigest(row.content),
  };
}

function isReconcileCandidate(row) {
  return Boolean(row)
    && LIVE_STATES.has(String(row.state || ''))
    && CLAIM_KINDS.has(String(row.kind || '').toLowerCase())
    && !String(row.task_key || '').trim()
    && Boolean(rowIdentity(row));
}

function groupBy(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function capReport(rows, limit = MAX_REPORT_ENTRIES) {
  const result = rows.slice(0, limit);
  return { entries: result, truncated: rows.length > result.length, total: rows.length };
}

function reportGroup(rows, identity = null) {
  return {
    identity: identity || rowIdentity(rows[0]),
    row_ids: rows.map(row => String(row.id)).sort(),
  };
}

function buildReconcilePlan(rows = [], { now = new Date().toISOString(), dbPath = null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('buildReconcilePlan: rows must be an array');
  if (rows.length > MAX_PLAN_ROWS) {
    throw new Error(`reconcile plan exceeds bounded row limit (${MAX_PLAN_ROWS})`);
  }

  const eligible = rows.filter(isReconcileCandidate);
  const identityGroups = groupBy(eligible, row => identityToken(rowIdentity(row)));
  const exactGroups = groupBy(eligible, row => `${identityToken(rowIdentity(row))}:${claimContentDigest(row.content)}`);
  const actions = [];
  const exactReports = [];

  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareRows);
    const survivor = ordered[0];
    const duplicates = ordered.slice(1);
    exactReports.push({
      ...reportGroup(group, rowIdentity(survivor)),
      content_digest: claimContentDigest(survivor.content),
      survivor_id: String(survivor.id),
      duplicate_ids: duplicates.map(row => String(row.id)).sort(),
    });
    for (const duplicate of duplicates) {
      actions.push({
        action: 'archive_exact_duplicate',
        reason: 'exact_normalized_duplicate',
        survivor: rowSnapshot(survivor),
        duplicate: rowSnapshot(duplicate),
        preconditions: [rowSnapshot(survivor), rowSnapshot(duplicate)],
      });
    }
  }

  const conflictReports = [];
  for (const group of identityGroups.values()) {
    const digests = new Set(group.map(row => claimContentDigest(row.content)));
    if (digests.size > 1) {
      conflictReports.push({
        ...reportGroup(group),
        content_digests: [...digests].sort(),
        action: 'review_required',
        reason: 'same_identity_different_content',
      });
    }
  }

  const titleGroups = groupBy(
    rows.filter(row => LIVE_STATES.has(String(row.state || '')) && normalizeTitle(row.title)),
    row => normalizeTitle(row.title),
  );
  const titleReports = [];
  for (const group of titleGroups.values()) {
    if (group.length < 2) continue;
    const exactActionIds = new Set(actions.flatMap(action => [action.survivor.id, action.duplicate.id]));
    const hasNonExactRows = group.some(row => !exactActionIds.has(String(row.id)));
    if (!hasNonExactRows) continue;
    titleReports.push({
      title: String(group[0].title).normalize('NFKC').trim(),
      row_ids: group.map(row => String(row.id)).sort(),
      action: 'review_required',
      reason: 'title_is_display_only',
    });
  }

  const unkeyed = rows
    .filter(row => LIVE_STATES.has(String(row.state || '')) && !rowIdentity(row))
    .map(row => ({ id: String(row.id), state: String(row.state || ''), title: String(row.title || '') }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const invalidRows = rows
    .filter(row => LIVE_STATES.has(String(row.state || ''))
      && CLAIM_KINDS.has(String(row.kind || '').toLowerCase())
      && row.canonical_key
      && !rowIdentity(row))
    .map(row => String(row.id))
    .sort();

  const reports = {
    exact_duplicates: capReport(exactReports),
    semantic_conflicts: capReport(conflictReports),
    title_duplicates: capReport(titleReports),
    unkeyed: capReport(unkeyed),
    invalid_identity: capReport(invalidRows),
  };
  const plan = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_type: PLAN_TYPE,
    generated_at: String(now),
    source: dbPath ? { db_path: String(dbPath) } : {},
    bounded: {
      max_plan_rows: MAX_PLAN_ROWS,
      max_report_entries: MAX_REPORT_ENTRIES,
      scanned_rows: rows.length,
    },
    summary: {
      scanned_rows: rows.length,
      eligible_rows: eligible.length,
      exact_duplicate_groups: exactReports.length,
      exact_duplicate_actions: actions.length,
      semantic_conflict_groups: conflictReports.length,
      title_duplicate_groups: titleReports.length,
      unkeyed_rows: unkeyed.length,
      invalid_identity_rows: invalidRows.length,
    },
    reports,
    actions,
  };
  return attachPlanDigest(plan);
}

function digestInput(plan) {
  const stable = { ...plan };
  delete stable.plan_digest;
  delete stable.generated_at;
  return stable;
}

function computePlanDigest(plan) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(digestInput(plan)), 'utf8')
    .digest('hex');
}

function attachPlanDigest(plan) {
  return { ...plan, plan_digest: computePlanDigest(plan) };
}

function sameSnapshot(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  return left.id === right.id
    && left.kind === right.kind
    && left.state === right.state
    && left.content_digest === right.content_digest
    && JSON.stringify(left.identity) === JSON.stringify(right.identity);
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') throw new Error('reconcile plan must be an object');
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) throw new Error('unsupported reconcile plan schema_version');
  if (plan.plan_type !== PLAN_TYPE) throw new Error('invalid reconcile plan type');
  if (!Array.isArray(plan.actions) || !plan.reports || !plan.summary) throw new Error('incomplete reconcile plan');
  if (typeof plan.plan_digest !== 'string' || plan.plan_digest !== computePlanDigest(plan)) {
    throw new Error('reconcile plan digest mismatch');
  }
  if (plan.actions.length > MAX_PLAN_ROWS) throw new Error('reconcile plan actions exceed bounded limit');
  for (const action of plan.actions) {
    if (!action || action.action !== 'archive_exact_duplicate') throw new Error('unsupported reconcile action');
    if (!action.survivor || !action.duplicate || !Array.isArray(action.preconditions)) {
      throw new Error('incomplete reconcile action preconditions');
    }
    if (action.preconditions.length !== 2) throw new Error('reconcile action must have two preconditions');
    if (action.survivor.id === action.duplicate.id) throw new Error('reconcile action cannot archive its survivor');
    const preconditionsById = new Map();
    for (const precondition of action.preconditions) {
      const id = String(precondition && precondition.id);
      if (preconditionsById.has(id)) throw new Error('reconcile action preconditions contain duplicate row IDs');
      preconditionsById.set(id, precondition);
    }
    const survivorPrecondition = preconditionsById.get(String(action.survivor.id));
    const duplicatePrecondition = preconditionsById.get(String(action.duplicate.id));
    if (!survivorPrecondition || !duplicatePrecondition) {
      throw new Error('reconcile action preconditions do not cover both rows');
    }
    if (!sameSnapshot(action.survivor, survivorPrecondition)
      || !sameSnapshot(action.duplicate, duplicatePrecondition)) {
      throw new Error('reconcile action preconditions do not match action snapshots');
    }
    if (action.survivor.content_digest !== action.duplicate.content_digest
      || JSON.stringify(action.survivor.identity) !== JSON.stringify(action.duplicate.identity)) {
      throw new Error('reconcile action is not an exact identity/content duplicate');
    }
  }
  return plan;
}

module.exports = {
  CLAIM_KINDS,
  LIVE_STATES,
  MAX_PLAN_ROWS,
  MAX_REPORT_ENTRIES,
  PLAN_SCHEMA_VERSION,
  PLAN_TYPE,
  buildReconcilePlan,
  claimContentDigest,
  computePlanDigest,
  normalizeTitle,
  rowSnapshot,
  validatePlan,
  _internal: {
    capReport,
    compareRows,
    digestInput,
    groupBy,
    identityGroups: groupBy,
    isReconcileCandidate,
    rowIdentity,
    sameSnapshot,
  },
};
