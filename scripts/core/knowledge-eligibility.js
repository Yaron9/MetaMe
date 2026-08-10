'use strict';

const PRIMARY_ONLY_CHANNELS = new Set([
  'reflect',
  'wiki_evidence',
  'profile_distill',
  'fact_recall',
  'graph_claim',
  'skill_evidence',
]);
const RELIABLE_FACT_KINDS = new Set(['fact', 'insight', 'convention']);
const CLAIM_ELIGIBILITY_CHANNELS = new Set(['synthesis', 'synthesis_active', 'synthesis_draft']);

const DERIVED_RELATIONS = new Set(['synthesized_insight', 'knowledge_capsule']);
const DERIVED_SOURCE_PREFIXES = ['nightly-reflect-', 'capsule-'];

function normalizeOriginClass(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'derived' ? 'derived' : normalized === 'primary' ? 'primary' : null;
}

function classifyOrigin(record = {}) {
  const explicit = normalizeOriginClass(record.origin_class);
  if (explicit === 'derived') return explicit;
  const relation = String(record.relation || '').trim();
  if (DERIVED_RELATIONS.has(relation)) return 'derived';
  const sourceId = String(record.source_id || '').trim().toLowerCase();
  if (DERIVED_SOURCE_PREFIXES.some(prefix => sourceId.startsWith(prefix))) return 'derived';
  return explicit || 'primary';
}

/**
 * A canonical claim is not reliable while another live row with the same
 * identity is in conflict.  The incumbent remains active by contract, so
 * state='active' alone is not sufficient for recall eligibility.
 */
function unresolvedConflictSql(alias = 'mi') {
  const prefix = alias ? `${alias}.` : '';
  return `NOT EXISTS (
    SELECT 1
      FROM memory_items claim_conflict_peer
     WHERE claim_conflict_peer.id != ${prefix}id
       AND claim_conflict_peer.canonical_key = ${prefix}canonical_key
       AND claim_conflict_peer.project IS ${prefix}project
       AND claim_conflict_peer.scope IS ${prefix}scope
       AND claim_conflict_peer.state = 'conflict'
  )`;
}

function deriveProvenanceRootId(record = {}) {
  const explicit = String(record.provenance_root_id || '').trim();
  if (explicit) return explicit;
  for (const [kind, value] of [
    ['source', record.source_id],
    ['session', record.session_id],
    ['task', record.task_key],
  ]) {
    const normalized = String(value || '').normalize('NFKC').trim();
    if (normalized) return `${kind}:${normalized}`;
  }
  return null;
}

function eligibleFor(channel, record = {}, options = {}) {
  if (CLAIM_ELIGIBILITY_CHANNELS.has(channel)) {
    const { isSynthesisEvidenceEligible } = require('./claim-contract');
    return isSynthesisEvidenceEligible(record, {
      ...options,
      draft: channel === 'synthesis_draft',
    });
  }
  if (!PRIMARY_ONLY_CHANNELS.has(channel)) {
    throw new Error(`unknown knowledge eligibility channel: ${channel}`);
  }
  if (classifyOrigin(record) !== 'primary') return false;
  if (record.state && !['active', 'candidate'].includes(String(record.state))) return false;
  const kind = String(record.kind || '').trim().toLowerCase();
  if (kind && !RELIABLE_FACT_KINDS.has(kind)) return false;
  if (String(record.task_key ?? record.taskKey ?? '').trim()) return false;
  return true;
}

function claimSqlForDb(db, alias = 'mi', { draft = false } = {}) {
  const columns = new Set(db.prepare('PRAGMA table_info(memory_items)').all().map(row => row.name));
  const prefix = alias ? `${alias}.` : '';
  const eligibility = primarySqlForDb(db, alias);
  const checks = [eligibility.sql];
  checks.push(columns.has('canonical_key')
    ? `${prefix}canonical_key IS NOT NULL AND trim(${prefix}canonical_key) != ''`
    : '0');
  checks.push(columns.has('kind') ? `${prefix}kind IN ('insight','convention')` : '0');
  checks.push(columns.has('state')
    ? `${prefix}state IN (${draft ? "'active','candidate'" : "'active'"})`
    : '0');
  checks.push(columns.has('task_key')
    ? `COALESCE(trim(${prefix}task_key), '') = ''`
    : '0');
  if (columns.has('origin_class')) checks.push(`COALESCE(${prefix}origin_class, 'primary') != 'derived'`);
  return { sql: checks.join(' AND '), args: [] };
}

function primarySql(alias = 'mi') {
  const prefix = alias ? `${alias}.` : '';
  return {
    sql: `COALESCE(${prefix}origin_class, 'primary') != 'derived'
      AND COALESCE(${prefix}relation, '') NOT IN ('synthesized_insight','knowledge_capsule')
      AND lower(COALESCE(${prefix}source_id, '')) NOT LIKE 'nightly-reflect-%'
      AND lower(COALESCE(${prefix}source_id, '')) NOT LIKE 'capsule-%'
      AND ${prefix}kind IN ('fact','insight','convention')
      AND COALESCE(trim(${prefix}task_key), '') = ''
      AND ${unresolvedConflictSql(alias)}`,
    args: [],
  };
}

function primarySqlForDb(db, alias = 'mi', table = 'memory_items') {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
  const prefix = alias ? `${alias}.` : '';
  const derivedChecks = [];
  if (columns.has('relation')) {
    derivedChecks.push(`COALESCE(${prefix}relation, '') IN ('synthesized_insight','knowledge_capsule')`);
  }
  if (columns.has('source_id')) {
    derivedChecks.push(`lower(COALESCE(${prefix}source_id, '')) LIKE 'nightly-reflect-%'`);
    derivedChecks.push(`lower(COALESCE(${prefix}source_id, '')) LIKE 'capsule-%'`);
  }
  const inferred = derivedChecks.length > 0
    ? `CASE WHEN ${derivedChecks.join(' OR ')} THEN 'derived' ELSE 'primary' END`
    : "'primary'";
  const checks = [`${inferred} = 'primary'`];
  if (columns.has('origin_class')) checks.unshift(`COALESCE(${prefix}origin_class, 'primary') != 'derived'`);
  if (columns.has('kind')) checks.push(`${prefix}kind IN ('fact','insight','convention')`);
  if (columns.has('task_key')) checks.push(`COALESCE(trim(${prefix}task_key), '') = ''`);
  if (table === 'memory_items'
    && columns.has('id') && columns.has('canonical_key')
    && columns.has('project') && columns.has('scope') && columns.has('state')) {
    checks.push(unresolvedConflictSql(alias));
  }
  return {
    sql: checks.join(' AND '),
    args: [],
  };
}

module.exports = {
  CLAIM_ELIGIBILITY_CHANNELS,
  DERIVED_RELATIONS,
  PRIMARY_ONLY_CHANNELS,
  RELIABLE_FACT_KINDS,
  classifyOrigin,
  deriveProvenanceRootId,
  eligibleFor,
  claimSqlForDb,
  normalizeOriginClass,
  primarySql,
  primarySqlForDb,
  unresolvedConflictSql,
};
