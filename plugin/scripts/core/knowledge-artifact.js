'use strict';

const crypto = require('node:crypto');
const yaml = require('../resolve-yaml');

const SCHEMA_VERSION = 1;
const KINDS = new Set(['decision', 'playbook']);
const STATUSES = new Set(['draft', 'active', 'stale', 'superseded', 'retired']);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeText(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trimEnd() + '\n';
}

function normalizeCanonicalKey(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

function normalizeEvidenceIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].sort();
}

function contentHash(body) {
  return sha256(normalizeText(body));
}

function evidenceMembershipHash(evidenceIds) {
  return sha256(JSON.stringify(normalizeEvidenceIds(evidenceIds)));
}

function stableArtifactId(kind, canonicalKey) {
  const normalizedKind = String(kind || '').trim().toLowerCase();
  const key = normalizeCanonicalKey(canonicalKey);
  if (!KINDS.has(normalizedKind) || !key) throw new Error('kind and canonical_key are required');
  return `ka_${normalizedKind}_${sha256(`${normalizedKind}|${key}`).slice(0, 16)}`;
}

function parseArtifactMarkdown(markdown) {
  const source = String(markdown || '');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new Error('artifact frontmatter is required');
  const meta = yaml.load(match[1]) || {};
  return { meta, body: normalizeText(source.slice(match[0].length)) };
}

function validateArtifact({ meta, body }, { requireHashes = true } = {}) {
  const errors = [];
  const required = ['id', 'kind', 'canonical_key', 'project_key', 'status', 'revision', 'created_at', 'updated_at', 'generator_version'];
  for (const field of required) if (meta[field] === undefined || meta[field] === null || meta[field] === '') errors.push(`missing ${field}`);
  if (Number(meta.schema_version) !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!KINDS.has(String(meta.kind))) errors.push('invalid kind');
  if (!STATUSES.has(String(meta.status))) errors.push('invalid status');
  if (!Number.isInteger(Number(meta.revision)) || Number(meta.revision) < 1) errors.push('revision must be a positive integer');
  if (normalizeCanonicalKey(meta.canonical_key) !== String(meta.canonical_key || '')) errors.push('canonical_key is not normalized');
  const evidenceIds = normalizeEvidenceIds(meta.evidence_ids);
  if (String(meta.status) === 'active' && evidenceIds.length === 0) errors.push('active artifact requires evidence_ids');
  const expectedContentHash = contentHash(body);
  const expectedMembershipHash = evidenceMembershipHash(evidenceIds);
  if (requireHashes && meta.content_hash !== expectedContentHash) errors.push('content_hash mismatch');
  if (requireHashes && meta.evidence_membership_hash !== expectedMembershipHash) errors.push('evidence_membership_hash mismatch');
  return { ok: errors.length === 0, errors, evidenceIds, expectedContentHash, expectedMembershipHash };
}

function serializeArtifact(meta, body) {
  const evidenceIds = normalizeEvidenceIds(meta.evidence_ids);
  const normalized = {
    schema_version: SCHEMA_VERSION,
    id: meta.id || stableArtifactId(meta.kind, meta.canonical_key),
    kind: meta.kind,
    title: String(meta.title || '').trim(),
    canonical_key: normalizeCanonicalKey(meta.canonical_key),
    project_key: normalizeCanonicalKey(meta.project_key),
    status: meta.status || 'draft',
    revision: Number(meta.revision) || 1,
    evidence_ids: evidenceIds,
    evidence_membership_hash: evidenceMembershipHash(evidenceIds),
    content_hash: contentHash(body),
    supersedes: normalizeEvidenceIds(meta.supersedes),
    legacy_refs: normalizeEvidenceIds(meta.legacy_refs),
    previous_hash: meta.previous_hash || null,
    change_reason: meta.change_reason || null,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    generator_version: meta.generator_version,
    protected: meta.protected === true,
  };
  return `---\n${yaml.dump(normalized, { lineWidth: -1 }).trim()}\n---\n${normalizeText(body)}`;
}

module.exports = {
  KINDS,
  SCHEMA_VERSION,
  STATUSES,
  contentHash,
  evidenceMembershipHash,
  normalizeCanonicalKey,
  normalizeEvidenceIds,
  parseArtifactMarkdown,
  serializeArtifact,
  stableArtifactId,
  validateArtifact,
};
