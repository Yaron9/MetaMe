'use strict';

/**
 * Claim Contract v1.
 *
 * This module intentionally contains no database or filesystem access.  It is
 * the decision boundary between extracted assertions and the memory mutation
 * layer: normalize the proposed identity/content, classify the admission
 * outcome, and answer whether a row can be used by a synthesis.
 */

const crypto = require('node:crypto');

const CANONICAL_KEY_MAX_LENGTH = 160;
const CANONICAL_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/u;
const CLAIM_LIFECYCLES = new Set(['task', 'project', 'global']);
const CLAIM_KINDS = new Set(['convention', 'insight']);
const CLAIM_STATES = new Set(['candidate', 'active', 'conflict', 'archived']);

function normalizeCanonicalKey(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).normalize('NFKC').trim().toLowerCase();
  if (!normalized || normalized.length > CANONICAL_KEY_MAX_LENGTH) return null;
  return CANONICAL_KEY_PATTERN.test(normalized) ? normalized : null;
}

function validateCanonicalKey(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return { valid: true, value: null, reason: 'missing' };
  }
  const normalized = String(value).normalize('NFKC').trim().toLowerCase();
  if (!normalized) return { valid: true, value: null, reason: 'missing' };
  if (normalized.length > CANONICAL_KEY_MAX_LENGTH) {
    return { valid: false, value: null, reason: 'too_long' };
  }
  if (!CANONICAL_KEY_PATTERN.test(normalized)) {
    return { valid: false, value: null, reason: 'invalid_syntax' };
  }
  return { valid: true, value: normalized, reason: null };
}

function normalizeClaimContent(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/gu, ''))
    .join('\n')
    .trim();
}

function claimContentDigest(value) {
  return crypto.createHash('sha256')
    .update(normalizeClaimContent(value), 'utf8')
    .digest('hex');
}

function normalizeIdentityPart(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  const normalized = String(value).normalize('NFKC').trim();
  return normalized || fallback;
}

function claimIdentity(record = {}) {
  const canonicalKey = normalizeCanonicalKey(record.canonical_key ?? record.canonicalKey);
  if (!canonicalKey) return null;
  return {
    canonical_key: canonicalKey,
    project: normalizeIdentityPart(record.project, '*'),
    scope: normalizeIdentityPart(record.scope, null),
  };
}

function identityToken(identity) {
  if (!identity) return null;
  return JSON.stringify([identity.canonical_key, identity.project, identity.scope]);
}

function sameClaimIdentity(left, right) {
  return identityToken(claimIdentity(left)) === identityToken(claimIdentity(right));
}

function normalizeLifecycle(value) {
  const lifecycle = String(value || '').trim().toLowerCase();
  return CLAIM_LIFECYCLES.has(lifecycle) ? lifecycle : 'task';
}

function hasTaskKey(record = {}) {
  return String(record.task_key ?? record.taskKey ?? '').trim().length > 0;
}

function isTaskLocalClaim(record = {}) {
  const lifecycle = record.lifecycle === undefined || record.lifecycle === null
    ? null
    : normalizeLifecycle(record.lifecycle);
  return lifecycle === 'task'
    || String(record.kind || '').toLowerCase() === 'episode'
    || hasTaskKey(record);
}

function claimKind(record = {}) {
  return CLAIM_KINDS.has(String(record.kind || '').toLowerCase())
    ? String(record.kind).toLowerCase()
    : 'insight';
}

/**
 * Apply the storage mapping from Claim Contract v1 without writing it.
 * Unknown lifecycle is deliberately task-local (fail closed).
 */
function mapClaimStorage(record = {}, { sessionSourceId = null } = {}) {
  const lifecycle = normalizeLifecycle(record.lifecycle);
  const key = lifecycle === 'task' ? null : normalizeCanonicalKey(record.canonical_key ?? record.canonicalKey);
  const sourceId = record.source_id ?? record.sourceId ?? sessionSourceId ?? null;
  const taskKey = record.task_key ?? record.taskKey ?? sourceId ?? record.session_id ?? record.sessionId ?? null;
  if (lifecycle === 'task') {
    return {
      ...record,
      lifecycle,
      kind: 'episode',
      state: 'active',
      canonical_key: null,
      task_key: taskKey,
    };
  }
  return {
    ...record,
    lifecycle,
    kind: claimKind(record),
    state: 'candidate',
    canonical_key: key,
    task_key: null,
    project: lifecycle === 'global' ? '*' : normalizeIdentityPart(record.project, 'unknown'),
    scope: lifecycle === 'global' ? '*' : normalizeIdentityPart(record.scope, null),
  };
}

function normalizeClaim(record = {}, options = {}) {
  const mapped = mapClaimStorage(record, options);
  const content = normalizeClaimContent(mapped.content);
  const identity = claimIdentity(mapped);
  return {
    ...mapped,
    content,
    canonical_key: identity ? identity.canonical_key : null,
    project: normalizeIdentityPart(mapped.project, '*'),
    scope: normalizeIdentityPart(mapped.scope, null),
    content_digest: claimContentDigest(content),
    identity,
    identity_token: identityToken(identity),
  };
}

function sameClaimContent(left, right) {
  return claimContentDigest(left.content) === claimContentDigest(right.content);
}

function findExplicitSupersession(candidate, matches) {
  const targetId = candidate.supersedes_id || candidate.supersedesId || candidate.supersedes;
  if (!targetId) return null;
  return matches.find(item => String(item.id) === String(targetId)) || null;
}

/**
 * Return a deterministic, side-effect-free admission/reconciliation result.
 * Title, tags, confidence, recency, and search counts are intentionally not
 * consulted for identity or winner selection.
 */
function reconcileClaim(candidate, existing = [], options = {}) {
  const normalized = normalizeClaim(candidate, options);
  if (!normalized.content) {
    return { outcome: 'rejected', action: 'reject', reason: 'empty_content', candidate: normalized };
  }
  if (normalized.lifecycle === 'task') {
    return {
      outcome: 'episode',
      action: 'append_episode',
      reason: 'task_local',
      candidate: normalized,
    };
  }
  if (!normalized.identity) {
    return {
      outcome: 'candidate',
      action: 'append',
      reason: 'missing_or_invalid_canonical_key',
      candidate: normalized,
    };
  }

  const matches = (Array.isArray(existing) ? existing : [])
    .filter(item => sameClaimIdentity(normalized, item));
  const explicit = findExplicitSupersession(normalized, matches);
  if (explicit && options.allowExplicitSupersession === true) {
    return {
      outcome: 'supersede',
      action: 'supersede',
      reason: 'explicit_request',
      existing_id: explicit.id,
      candidate: normalized,
    };
  }

  const exact = matches.find(item => sameClaimContent(normalized, item)
    && CLAIM_STATES.has(String(item.state || 'candidate'))
    && String(item.state || 'candidate') !== 'archived');
  if (exact) {
    return {
      outcome: 'duplicate',
      action: 'merge_lineage',
      reason: 'same_identity_and_content',
      existing_id: exact.id,
      candidate: normalized,
    };
  }

  const liveMatches = matches.filter(item => String(item.state || 'candidate') !== 'archived');
  if (liveMatches.length > 0) {
    return {
      outcome: 'conflict',
      action: 'append_conflict',
      reason: 'same_identity_different_content',
      existing_ids: liveMatches.map(item => item.id),
      candidate: normalized,
    };
  }

  return {
    outcome: 'complementary',
    action: 'append',
    reason: 'no_live_identity_match',
    candidate: normalized,
  };
}

function admitClaim(candidate, existing = [], options = {}) {
  return reconcileClaim(candidate, existing, options);
}

function isCanonicalClaim(record = {}) {
  return CLAIM_KINDS.has(String(record.kind || '').toLowerCase())
    && Boolean(claimIdentity(record));
}

function isSynthesisEvidenceEligible(record = {}, {
  draft = false,
  hasUnresolvedConflict = false,
} = {}) {
  if (!isCanonicalClaim(record) || isTaskLocalClaim(record)) return false;
  if (hasUnresolvedConflict === true
    || record.has_unresolved_conflict === true
    || record.hasUnresolvedConflict === true) return false;
  if (String(record.state || '') === 'conflict') return false;
  const allowedStates = draft ? new Set(['active', 'candidate']) : new Set(['active']);
  if (!allowedStates.has(String(record.state || ''))) return false;
  const { classifyOrigin } = require('./knowledge-eligibility');
  return classifyOrigin(record) === 'primary';
}

function claimEligibility(record = {}, options = {}) {
  return isSynthesisEvidenceEligible(record, options);
}

module.exports = {
  CANONICAL_KEY_MAX_LENGTH,
  CANONICAL_KEY_PATTERN,
  CLAIM_KINDS,
  CLAIM_LIFECYCLES,
  CLAIM_STATES,
  admitClaim,
  admissionDecision: admitClaim,
  claimContentDigest,
  contentDigest: claimContentDigest,
  claimEligibility,
  claimIdentity,
  buildClaimIdentity: claimIdentity,
  findExplicitSupersession,
  identityToken,
  isCanonicalClaim,
  isEligibleForSynthesis: isSynthesisEvidenceEligible,
  isSynthesisEvidenceEligible,
  isTaskLocalClaim,
  mapClaimStorage,
  normalizeCanonicalKey,
  normalizeClaim,
  normalizeClaimContent,
  normalizeContent: normalizeClaimContent,
  normalizeIdentityPart,
  normalizeLifecycle,
  reconcileClaim,
  reconcileClaims: reconcileClaim,
  sameClaimContent,
  sameClaimIdentity,
  validateCanonicalKey,
};
