'use strict';

const crypto = require('node:crypto');

const CANONICAL_SESSION_EVENT_VERSION = 1;
const ACTORS = Object.freeze(['user', 'assistant', 'tool', 'system']);
const KINDS = Object.freeze(['message', 'tool_call', 'tool_result', 'checkpoint']);

const CANONICAL_SESSION_EVENT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://metame.local/schema/canonical-session-event-v1.json',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'eventId', 'engineId', 'nativeSessionId', 'sourceRevision', 'sequence', 'actor', 'kind'],
  properties: {
    version: { const: CANONICAL_SESSION_EVENT_VERSION },
    eventId: { type: 'string', minLength: 1 },
    engineId: { type: 'string', minLength: 1 },
    nativeSessionId: { type: 'string', minLength: 1 },
    sourceRevision: { type: 'string', minLength: 1 },
    sequence: { type: 'integer', minimum: 0 },
    timestamp: { type: ['string', 'null'] },
    actor: { enum: [...ACTORS] },
    kind: { enum: [...KINDS] },
    text: { type: 'string' },
    tool: { type: ['string', 'null'] },
    outcome: {},
    provenance: {},
  },
});

const ACTOR_ALIASES = Object.freeze({
  human: 'user',
  model: 'assistant',
  agent: 'assistant',
  function: 'tool',
});

const KIND_ALIASES = Object.freeze({
  text: 'message',
  response: 'message',
  tool: 'tool_call',
  call: 'tool_call',
  result: 'tool_result',
  state: 'checkpoint',
});

function eventError(code, detail = '') {
  const error = new TypeError(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function cleanString(value, field, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw eventError('canonical_session_event_required', field);
    return null;
  }
  const text = String(value).normalize('NFKC').trim();
  if (!text && required) throw eventError('canonical_session_event_required', field);
  return text || null;
}

function normalizeActor(value) {
  const actor = cleanString(value, 'actor', { required: true }).toLowerCase();
  const normalized = ACTOR_ALIASES[actor] || actor;
  if (!ACTORS.includes(normalized)) throw eventError('canonical_session_event_actor_invalid', actor);
  return normalized;
}

function normalizeKind(value) {
  const kind = cleanString(value, 'kind', { required: true }).toLowerCase();
  const normalized = KIND_ALIASES[kind] || kind;
  if (!KINDS.includes(normalized)) throw eventError('canonical_session_event_kind_invalid', kind);
  return normalized;
}

function normalizeSequence(value) {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw eventError('canonical_session_event_sequence_invalid', String(value));
  }
  return sequence;
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const timestamp = String(value).trim();
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) throw eventError('canonical_session_event_timestamp_invalid', timestamp);
  return new Date(parsed).toISOString();
}

function cloneJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw eventError('canonical_session_event_provenance_invalid');
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

function eventDigest(event) {
  const payload = stableValue({
    version: CANONICAL_SESSION_EVENT_VERSION,
    engineId: event.engineId,
    nativeSessionId: event.nativeSessionId,
    sourceRevision: event.sourceRevision,
    sequence: event.sequence,
    timestamp: event.timestamp,
    actor: event.actor,
    kind: event.kind,
    text: event.text,
    tool: event.tool,
    outcome: event.outcome,
    provenance: event.provenance,
  });
  return `cse_${crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`;
}

function normalizeCanonicalSessionEvent(event, context = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw eventError('canonical_session_event_required');
  }
  const engineId = cleanString(event.engineId || event.engine_id || context.engineId || context.engine_id, 'engineId', { required: true });
  const nativeSessionId = cleanString(
    event.nativeSessionId || event.native_session_id || context.nativeSessionId || context.native_session_id,
    'nativeSessionId',
    { required: true },
  );
  const sourceRevision = cleanString(
    event.sourceRevision || event.source_revision || event.sourceHash || event.source_hash || context.sourceRevision || context.source_hash,
    'sourceRevision',
    { required: true },
  );
  const sequence = normalizeSequence(event.sequence ?? event.seq ?? context.sequence ?? 0);
  let provenance = cloneJson(event.provenance || event.provenanceRef || event.provenance_ref);
  if (event.nativeEventId || event.native_event_id) {
    if (provenance === null) {
      // A native identifier is provenance metadata, not a claim about the
      // evidence. Keep it in the bounded canonical reference field.
      provenance = { nativeEventId: String(event.nativeEventId || event.native_event_id) };
    } else if (typeof provenance === 'object' && !Array.isArray(provenance)) {
      provenance.nativeEventId = String(event.nativeEventId || event.native_event_id);
    }
  }
  const normalized = {
    version: CANONICAL_SESSION_EVENT_VERSION,
    eventId: cleanString(event.eventId || event.event_id, 'eventId') || null,
    engineId,
    nativeSessionId,
    sourceRevision,
    sequence,
    timestamp: normalizeTimestamp(event.timestamp || event.ts || event.createdAt || event.created_at),
    actor: normalizeActor(event.actor || event.role || event.speaker),
    kind: normalizeKind(event.kind || event.type),
    text: event.text === null || event.text === undefined ? '' : String(event.text),
    tool: cleanString(event.tool || event.toolName || event.tool_name, 'tool'),
    outcome: cloneJson(event.outcome),
    provenance,
  };
  normalized.eventId = normalized.eventId || eventDigest(normalized);
  return Object.freeze(normalized);
}

function normalizeCanonicalSessionEvents(events, context = {}) {
  if (events === null || events === undefined) return [];
  if (!Array.isArray(events)) throw eventError('canonical_session_events_array_required');
  return events.map((event, index) => normalizeCanonicalSessionEvent(event, {
    ...context,
    sequence: event && event.sequence !== undefined ? event.sequence : index,
  }));
}

function validateCanonicalSessionEvent(event, context = {}) {
  try {
    const normalized = normalizeCanonicalSessionEvent(event, context);
    return { valid: true, errors: [], event: normalized };
  } catch (error) {
    return {
      valid: false,
      errors: [{ code: error.code || 'canonical_session_event_invalid', message: error.message }],
      event: null,
    };
  }
}

module.exports = {
  ACTORS,
  KINDS,
  CANONICAL_SESSION_EVENT_VERSION,
  CANONICAL_SESSION_EVENT_SCHEMA,
  canonicalSessionEventSchema: CANONICAL_SESSION_EVENT_SCHEMA,
  normalizeCanonicalSessionEvent,
  normalizeCanonicalSessionEvents,
  validateCanonicalSessionEvent,
  canonicalizeSessionEvent: normalizeCanonicalSessionEvent,
  canonicalizeSessionEvents: normalizeCanonicalSessionEvents,
  normalizeCanonicalEvent: normalizeCanonicalSessionEvent,
  normalizeCanonicalEvents: normalizeCanonicalSessionEvents,
  _internal: {
    cleanString,
    eventDigest,
    normalizeActor,
    normalizeKind,
    normalizeSequence,
    normalizeTimestamp,
    stableValue,
  },
};
