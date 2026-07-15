'use strict';

const PRIMARY_ONLY_CHANNELS = new Set([
  'reflect',
  'wiki_evidence',
  'profile_distill',
  'fact_recall',
  'graph_claim',
  'skill_evidence',
]);

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

function eligibleFor(channel, record = {}) {
  if (!PRIMARY_ONLY_CHANNELS.has(channel)) {
    throw new Error(`unknown knowledge eligibility channel: ${channel}`);
  }
  if (classifyOrigin(record) !== 'primary') return false;
  if (record.state && !['active', 'candidate'].includes(String(record.state))) return false;
  return true;
}

function primarySql(alias = 'mi') {
  const prefix = alias ? `${alias}.` : '';
  return {
    sql: `COALESCE(${prefix}origin_class, 'primary') != 'derived'
      AND COALESCE(${prefix}relation, '') NOT IN ('synthesized_insight','knowledge_capsule')
      AND lower(COALESCE(${prefix}source_id, '')) NOT LIKE 'nightly-reflect-%'
      AND lower(COALESCE(${prefix}source_id, '')) NOT LIKE 'capsule-%'`,
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
  return {
    sql: checks.join(' AND '),
    args: [],
  };
}

module.exports = {
  DERIVED_RELATIONS,
  PRIMARY_ONLY_CHANNELS,
  classifyOrigin,
  deriveProvenanceRootId,
  eligibleFor,
  normalizeOriginClass,
  primarySql,
  primarySqlForDb,
};
