'use strict';

/**
 * Host-neutral Project Context Manifest contract.
 *
 * This module deliberately has no database, filesystem, Host, or MCP
 * dependencies.  Adapters provide trusted access context and edge modules
 * provide candidate assets; the core decides what can be projected.
 */

const crypto = require('node:crypto');
const { isCanonicalClaim } = require('./claim-contract');
const { classifyOrigin } = require('./knowledge-eligibility');

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 8;
const MAX_MANIFEST_CHARS = 1200;
const MAX_CONTEXT_CHARS = 4000;
const ACCESS_TRUSTS = Object.freeze(['managed', 'registered', 'direct-hook']);
const MANIFEST_TYPES = Object.freeze(['policy', 'claim', 'synthesis']);
const TYPE_PRIORITY = Object.freeze({ policy: 0, claim: 1, synthesis: 2 });
const PRIVATE_SCOPES = new Set(['private', 'agent', 'working', 'working-memory', 'profile']);

function text(value) {
  return String(value ?? '').normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

function oneLine(value) {
  return text(value).replace(/\s+/gu, ' ').trim();
}

function iso(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeScopes(value) {
  const values = Array.isArray(value) ? value : value ? [value] : ['project'];
  return [...new Set(values.map(oneLine).filter(Boolean))].sort();
}

function normalizeAccessContext(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const trust = ACCESS_TRUSTS.includes(oneLine(source.trust)) ? oneLine(source.trust) : 'untrusted';
  const trusted = ACCESS_TRUSTS.includes(trust);
  const project = oneLine(source.project) || null;
  const agentId = trusted ? (oneLine(source.agent_id || source.agentId) || null) : null;
  const principal = trusted ? (oneLine(source.principal) || null) : null;
  return Object.freeze({
    principal,
    project,
    agent_id: agentId,
    scopes: normalizeScopes(source.scopes),
    host: oneLine(source.host) || null,
    trust: trusted ? trust : 'untrusted',
  });
}

/**
 * Resolve a request against a trusted binding. Request fields are selectors,
 * never authority: a caller cannot change a managed project or agent by
 * putting another value in MCP arguments.
 */
function resolveAccessContext({ trustedContext = null, request = {} } = {}) {
  const trusted = trustedContext && typeof trustedContext === 'object'
    ? normalizeAccessContext(trustedContext)
    : null;
  const requested = request && typeof request === 'object' ? request : {};
  if (trusted && trusted.trust !== 'untrusted') {
    return trusted;
  }
  return normalizeAccessContext({
    project: requested.project,
    host: requested.host,
    scopes: ['project'],
    trust: 'untrusted',
  });
}

function accessIdentity(access = {}) {
  const normalized = normalizeAccessContext(access);
  return JSON.stringify({
    principal: normalized.principal,
    agent_id: normalized.agent_id,
  });
}

function isTrustedAccess(access = {}) {
  return ACCESS_TRUSTS.includes(oneLine(access.trust));
}

function recordProject(record = {}) {
  return oneLine(record.project ?? record.project_key ?? record.projectKey);
}

function recordScope(record = {}) {
  return oneLine(record.scope ?? record.scope_key ?? record.scopeKey);
}

function recordAgent(record = {}) {
  return oneLine(record.agent_key ?? record.agentId ?? record.agent_id);
}

function recordType(record = {}) {
  const explicit = oneLine(record.type || record.asset_type).toLowerCase();
  if (MANIFEST_TYPES.includes(explicit)) return explicit;
  if (record.kind === 'policy' || record.policy === true) return 'policy';
  if (isCanonicalClaim(record)) return 'claim';
  if (['decision', 'playbook', 'project_dossier', 'synthesis'].includes(oneLine(record.kind).toLowerCase())) return 'synthesis';
  if (['decision', 'playbook', 'project_dossier'].includes(oneLine(record.page_kind).toLowerCase())) return 'synthesis';
  return null;
}

function isExpired(record, now) {
  const expiresAt = record.expires_at ?? record.expiresAt;
  if (expiresAt === null || expiresAt === undefined || expiresAt === '') return false;
  const expiry = new Date(expiresAt).getTime();
  const current = now instanceof Date ? now.getTime() : new Date(now || Date.now()).getTime();
  // A malformed explicit expiry is unsafe to treat as timeless context.
  if (!Number.isFinite(expiry) || !Number.isFinite(current)) return true;
  return expiry <= current;
}

function isStale(record = {}) {
  return record.stale === true
    || record.is_stale === true
    || ['stale', 'superseded', 'retired', 'archived'].includes(oneLine(record.status || record.artifact_status).toLowerCase())
    || oneLine(record.freshness).toLowerCase() === 'stale'
    || Number(record.staleness) >= 0.3;
}

function isPrivateRecord(record, access) {
  const scope = recordScope(record).toLowerCase();
  if (record.private === true || record.visibility === 'private' || PRIVATE_SCOPES.has(scope)) return true;
  const agent = recordAgent(record);
  if (!agent) return false;
  return !isTrustedAccess(access) || agent !== oneLine(access.agent_id);
}

function projectMatches(record, access, type) {
  const project = recordProject(record).toLowerCase();
  const requested = oneLine(access.project).toLowerCase();
  if (!requested) return false;
  if (type === 'synthesis') return project === requested || project === '*';
  // A canonical Claim may be project-local or global (`*`/legacy empty
  // project). Policies follow the same project/global rule; synthesis stays
  // project-bound because a dossier/playbook is not a global Claim.
  return project === requested || project === '*' || !project;
}

function scopeMatches(record, access) {
  const scope = recordScope(record).toLowerCase();
  if (!scope || scope === '*' || scope === oneLine(access.project).toLowerCase()) return true;
  if (PRIVATE_SCOPES.has(scope)) return false;
  if (scope === 'global' && ['*', ''].includes(recordProject(record))) return true;
  const scopes = normalizeScopes(access.scopes);
  return scopes.includes(scope) || (scopes.includes('project') && scope === 'project');
}

function acceptedPolicy(record) {
  const status = oneLine(record.status || record.artifact_status || record.state).toLowerCase();
  return record.accepted === true
    || record.accepted_at
    || status === 'accepted'
    || (status === 'active' && record.accepted !== false);
}

function eligibleRecord(record = {}, access = {}, { now = new Date() } = {}) {
  const type = recordType(record);
  if (!type || !isTrustedOrProjectAccess(access) || !projectMatches(record, access, type)) return false;
  if (isPrivateRecord(record, access) || !scopeMatches(record, access) || isExpired(record, now)) return false;
  const lifecycle = oneLine(record.lifecycle || record.kind || record.page_kind).toLowerCase();
  if (record.candidate === true || record.is_candidate === true || record.conflict === true
    || record.is_conflict === true || ['candidate', 'conflict', 'episode', 'profile'].includes(lifecycle)) return false;
  if (type === 'policy') return acceptedPolicy(record) && !isStale(record);
  if (type === 'claim') {
    if (oneLine(record.state).toLowerCase() !== 'active') return false;
    if (oneLine(record.kind).toLowerCase() === 'profile' || oneLine(record.task_key || record.taskKey)) return false;
    if (!isCanonicalClaim(record) || classifyOrigin(record) !== 'primary') return false;
    return record.has_unresolved_conflict !== true
      && record.hasUnresolvedConflict !== true
      && !isStale(record);
  }
  const status = oneLine(record.status || record.artifact_status || record.state).toLowerCase();
  return status === 'active' && !isStale(record);
}

function isTrustedOrProjectAccess(access = {}) {
  return !!oneLine(access.project);
}

function assetId(record, type) {
  return oneLine(record.id || record.asset_id || record.slug || record.artifact_id || record.canonical_key)
    || `${type}:${sha256(oneLine(record.content || record.summary || record.title))}`.slice(0, 80);
}

function assetSummary(record) {
  return oneLine(record.summary || record.excerpt || record.content || record.value || record.body || record.title);
}

function sourceFingerprint(record, type = recordType(record) || 'asset') {
  const explicit = oneLine(record.source_fingerprint || record.sourceFingerprint || record.fingerprint);
  if (explicit) return explicit;
  const revision = oneLine(record.revision || record.artifact_revision || record.source_hash || record.source_membership_hash || record.content_digest);
  const id = assetId(record, type);
  return `${type}:${id}:${revision || sha256(assetSummary(record))}`;
}

function provenanceRef(record) {
  return oneLine(record.provenance_ref || record.provenanceRef || record.provenance_root_id || record.source_id || record.source_path)
    || null;
}

function normalizeManifestEntry(record, type = recordType(record)) {
  const id = assetId(record, type);
  const summary = assetSummary(record);
  return {
    id,
    type,
    summary,
    scope: recordScope(record) || recordProject(record) || null,
    updated_at: iso(record.updated_at || record.updatedAt || record.modified_at || record.created_at, null),
    expires_at: iso(record.expires_at || record.expiresAt, null),
    provenance_ref: provenanceRef(record),
    source_fingerprint: sourceFingerprint(record, type),
  };
}

function compareEntries(left, right) {
  const priority = (TYPE_PRIORITY[left.type] ?? 99) - (TYPE_PRIORITY[right.type] ?? 99);
  if (priority) return priority;
  const leftTime = left.updated_at || '';
  const rightTime = right.updated_at || '';
  if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);
  return left.id.localeCompare(right.id);
}

function selectManifestEntries(assets = [], access = {}, options = {}) {
  const now = options.now || new Date();
  const candidates = [];
  for (const record of Array.isArray(assets) ? assets : []) {
    if (!record || !eligibleRecord(record, access, { now })) continue;
    const type = recordType(record);
    const entry = normalizeManifestEntry(record, type);
    candidates.push(entry);
  }
  const ordered = candidates.sort((left, right) => (
    compareEntries(left, right)
    || left.source_fingerprint.localeCompare(right.source_fingerprint)
    || left.summary.localeCompare(right.summary)
  ));
  const unique = new Map();
  for (const entry of ordered) {
    const key = `${entry.type}:${entry.id}`;
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()].slice(0, Number.isInteger(options.maxEntries)
    ? Math.max(0, Math.min(MAX_ENTRIES, options.maxEntries)) : MAX_ENTRIES);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function revisionPayload({ project, access, entries } = {}) {
  const normalized = normalizeAccessContext(access);
  return {
    schema_version: SCHEMA_VERSION,
    project: oneLine(project) || null,
    access_identity: accessIdentity(normalized),
    scopes: normalizeScopes(normalized.scopes),
    entries: (entries || []).map(entry => ({
      id: entry.id,
      type: entry.type,
      source_fingerprint: entry.source_fingerprint,
      summary: entry.summary,
      expires_at: entry.expires_at || null,
    })),
  };
}

function manifestRevision(input = {}) {
  return sha256(JSON.stringify(revisionPayload(input)));
}

function manifestEnvelope({ project, generatedAt, expiresAt, entries, access } = {}) {
  const ordered = [...(entries || [])];
  return {
    schema_version: SCHEMA_VERSION,
    project: oneLine(project) || null,
    generated_at: iso(generatedAt, new Date().toISOString()),
    expires_at: iso(expiresAt, null),
    revision: manifestRevision({ project, access, entries: ordered }),
    budget_chars: MAX_MANIFEST_CHARS,
    entries: ordered,
  };
}

function manifestJson(manifest) {
  return JSON.stringify(manifest);
}

function truncate(value, max) {
  const source = oneLine(value);
  if (source.length <= max) return source;
  if (max <= 1) return source.slice(0, max);
  // Keep the suffix ASCII: NFKC normalization expands U+2026 to three dots,
  // which would otherwise make the post-rendered budget drift by two chars.
  if (max <= 3) return source.slice(0, max);
  return `${source.slice(0, max - 3).trimEnd()}...`;
}

function fitManifestEntries(entries, base, maxChars) {
  const fitted = entries.map(entry => ({ ...entry }));
  const build = () => manifestJson({ ...base, entries: fitted });
  while (build().length > maxChars) {
    const index = fitted.reduce((best, entry, i, all) => (
      !all[best] || entry.summary.length > all[best].summary.length ? i : best
    ), 0);
    if (!fitted[index] || fitted[index].summary.length <= 1) {
      fitted.pop();
      if (fitted.length === 0 || build().length <= maxChars) break;
      continue;
    }
    fitted[index] = { ...fitted[index], summary: truncate(fitted[index].summary, fitted[index].summary.length - 1) };
  }
  return fitted;
}

function buildManifest({ assets = [], access = {}, now = new Date(), expiresAt = null, maxEntries, maxChars } = {}) {
  const normalizedAccess = normalizeAccessContext(access);
  const project = normalizedAccess.project;
  const limit = Number.isInteger(maxChars) ? Math.max(0, Math.min(MAX_MANIFEST_CHARS, maxChars)) : MAX_MANIFEST_CHARS;
  const selected = project ? selectManifestEntries(assets, normalizedAccess, { now, maxEntries }) : [];
  const provisional = manifestEnvelope({
    project,
    generatedAt: now,
    expiresAt,
    entries: selected,
    access: normalizedAccess,
  });
  const entries = fitManifestEntries(selected, { ...provisional, revision: '0'.repeat(64) }, limit)
    .map(entry => ({ ...entry }));
  return manifestEnvelope({
    project,
    generatedAt: now,
    expiresAt,
    entries,
    access: normalizedAccess,
  });
}

function manifestRenderedChars(manifest) {
  return manifest ? manifestJson(manifest).length : 0;
}

function manifestFingerprints(manifest = {}) {
  return new Set((Array.isArray(manifest.entries) ? manifest.entries : [])
    .map(entry => oneLine(entry && entry.source_fingerprint)).filter(Boolean));
}

function itemFingerprint(item = {}) {
  const explicit = oneLine(item.source_fingerprint || item.sourceFingerprint || item.fingerprint);
  if (explicit) return explicit;
  const source = item.source && typeof item.source === 'object' ? item.source : {};
  const sourceType = oneLine(source.kind || source.type);
  const sourceId = oneLine(source.id || source.slug || source.sessionId || source.ref);
  if (sourceType || sourceId) return `${sourceType || 'source'}:${sourceId || sha256(item.text)}`;
  return `text:${sha256(item.text || '')}`;
}

function dedupeJitItems(items = [], manifest = {}) {
  const seen = manifestFingerprints(manifest);
  const output = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item) continue;
    const value = typeof item === 'string' ? { text: item } : { ...item };
    const sourceFingerprintValue = itemFingerprint(value);
    if (!oneLine(value.text) || seen.has(sourceFingerprintValue)) continue;
    seen.add(sourceFingerprintValue);
    output.push({ ...value, source_fingerprint: sourceFingerprintValue });
  }
  return output;
}

function renderJitItems(items = []) {
  return items.map(item => oneLine(item.text)).filter(Boolean).join('\n');
}

function fitJitItems(items, budget) {
  const kept = [];
  let used = 0;
  for (const item of items) {
    const value = oneLine(item.text);
    if (!value) continue;
    const separator = kept.length > 0 ? 1 : 0;
    const room = budget - used - separator;
    if (room <= 0) break;
    if (value.length <= room) {
      kept.push({ ...item, text: value });
      used += separator + value.length;
      continue;
    }
    if (room > 1) kept.push({ ...item, text: truncate(value, room) });
    break;
  }
  return { items: kept, text: renderJitItems(kept), chars: renderJitItems(kept).length };
}

function composeContext({ manifest, jit = [], totalChars = MAX_CONTEXT_CHARS } = {}) {
  const safeTotal = Number.isFinite(totalChars) && totalChars >= 0
    ? Math.floor(totalChars) : MAX_CONTEXT_CHARS;
  const manifestText = manifest ? manifestJson(manifest) : '';
  const manifestChars = manifestText.length;
  const remaining = Math.max(0, safeTotal - manifestChars);
  const deduped = dedupeJitItems(jit, manifest || {});
  const fitted = fitJitItems(deduped, Math.max(0, remaining - (deduped.length > 0 ? 1 : 0)));
  return {
    manifest: manifest || null,
    manifest_text: manifestText,
    jit: fitted.items,
    jit_text: fitted.text,
    text: [manifestText, fitted.text].filter(Boolean).join('\n'),
    manifest_chars: manifestChars,
    jit_chars: fitted.chars,
    chars: manifestChars + (fitted.text ? fitted.text.length + 1 : 0),
    remaining_chars: Math.max(0, safeTotal - manifestChars - (fitted.text ? fitted.text.length + 1 : 0)),
    source_fingerprints: fitted.items.map(item => item.source_fingerprint),
  };
}

function deliveryKey({ host, nativeSessionId, project, accessIdentity: identity, revision } = {}) {
  return sha256(JSON.stringify({
    host: oneLine(host) || null,
    native_session_id: oneLine(nativeSessionId) || null,
    project: oneLine(project) || null,
    access_identity: identity || null,
    revision: oneLine(revision) || null,
  }));
}

function compareAndSetDelivery(ledger = {}, key, metadata = {}) {
  const current = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {};
  const safeKey = oneLine(key);
  if (!safeKey) return { delivered: false, ledger: { ...current }, key: null };
  if (Object.prototype.hasOwnProperty.call(current, safeKey)) {
    return { delivered: false, ledger: { ...current }, key: safeKey };
  }
  const next = {
    ...current,
    [safeKey]: {
      revision: oneLine(metadata.revision) || null,
      project: oneLine(metadata.project) || null,
      delivered_at: iso(metadata.delivered_at || metadata.deliveredAt, new Date().toISOString()),
    },
  };
  return { delivered: true, ledger: next, key: safeKey };
}

module.exports = {
  ACCESS_TRUSTS,
  MANIFEST_TYPES,
  MAX_CONTEXT_CHARS,
  MAX_ENTRIES,
  MAX_MANIFEST_CHARS,
  SCHEMA_VERSION,
  TYPE_PRIORITY,
  accessIdentity,
  buildManifest,
  compareAndSetDelivery,
  composeContext,
  dedupeJitItems,
  deliveryKey,
  eligibleRecord,
  isTrustedAccess,
  manifestFingerprints,
  manifestJson,
  manifestRenderedChars,
  manifestRevision,
  normalizeAccessContext,
  normalizeManifestEntry,
  recordType,
  resolveAccessContext,
  revisionPayload,
  selectManifestEntries,
  sourceFingerprint,
  _internal: {
    acceptedPolicy,
    assetId,
    assetSummary,
    compareEntries,
    fitJitItems,
    fitManifestEntries,
    isExpired,
    isPrivateRecord,
    isStale,
    normalizeScopes,
    projectMatches,
    recordAgent,
    recordProject,
    recordScope,
    sha256,
    text,
    truncate,
  },
};
