'use strict';

const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const Ajv2020 = require('ajv/dist/2020');

/**
 * Public wire contract for an out-of-process Engine Plugin adapter.
 *
 * The transport is intentionally boring: one JSON value per LF-delimited
 * record.  Framing and validation live here so the process client and the
 * fixture adapter cannot accidentally grow two subtly different protocols.
 */
const EXTERNAL_ADAPTER_PROTOCOL_VERSION = 1;
const EXTERNAL_ADAPTER_PROTOCOL_NAME = 'metame.external-adapter';
const EXTERNAL_ADAPTER_OPERATIONS = Object.freeze([
  'probe',
  'run',
  'cancel',
  'session.discover',
  'session.inspect',
  'session.read',
  'shutdown',
]);

const EXTERNAL_ADAPTER_CAPABILITIES = Object.freeze(
  Object.fromEntries(EXTERNAL_ADAPTER_OPERATIONS.map(operation => [operation, operation])),
);

const DEFAULT_EXTERNAL_ADAPTER_LIMITS = Object.freeze({
  maxRecordBytes: 64 * 1024,
  maxBufferedBytes: 64 * 1024,
  maxCorrelationIdLength: 128,
  maxEngineIdLength: 128,
  maxRunIdLength: 256,
  maxSessionIdLength: 256,
  maxPromptBytes: 64 * 1024,
  maxTextBytes: 256 * 1024,
  maxErrorBytes: 4 * 1024,
  maxLocatorBytes: 8 * 1024,
  maxEvents: 2048,
  maxItems: 1024,
  maxStderrBytes: 16 * 1024,
});

const CORRELATION_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
const ENGINE_ID_PATTERN = '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$';
const OPERATION_PATTERN = '^(?:probe|run|cancel|session\\.discover|session\\.inspect|session\\.read|shutdown)$';

const JSON_VALUE_SCHEMA = Object.freeze({
  // Result and opaque locator values are extension points.  The enclosing
  // record is still closed and the byte/field limits are enforced by the
  // encoder/framer below.
  type: ['object', 'array', 'string', 'number', 'boolean', 'null'],
});

const CAPABILITIES_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: Object.fromEntries(EXTERNAL_ADAPTER_OPERATIONS.map(operation => [operation, { type: 'boolean' }])),
});

const SESSION_REF_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['nativeSessionId'],
  properties: {
    engineId: { type: 'string', pattern: ENGINE_ID_PATTERN, maxLength: 128 },
    nativeSessionId: { type: 'string', minLength: 1, maxLength: 256 },
    sourceLocator: JSON_VALUE_SCHEMA,
    project: { type: ['string', 'null'], maxLength: 4096 },
    scope: { type: ['string', 'null'], maxLength: 4096 },
    cwd: { type: ['string', 'null'], maxLength: 4096 },
    parentNativeSessionId: { type: ['string', 'null'], maxLength: 256 },
  },
});

const ERROR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string', pattern: '^[A-Z][A-Z0-9_.-]{1,63}$' },
    message: { type: 'string', minLength: 1, maxLength: 4096 },
    retryable: { type: 'boolean' },
    stage: { type: 'string', maxLength: 64 },
    detail: JSON_VALUE_SCHEMA,
  },
});

const RUN_EVENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: {
      enum: [
        'run_started', 'session_observed', 'message_delta', 'thinking_delta',
        'tool_started', 'tool_updated', 'tool_finished', 'usage_observed',
        'run_completed', 'run_failed',
      ],
    },
    runId: { type: ['string', 'null'], maxLength: 256 },
    engineId: { type: ['string', 'null'], pattern: ENGINE_ID_PATTERN, maxLength: 128 },
    nativeSessionId: { type: ['string', 'null'], maxLength: 256 },
    sequence: { type: ['integer', 'null'], minimum: 0 },
    timestamp: { type: ['string', 'null'], maxLength: 128 },
    text: { type: ['string', 'null'], maxLength: 262144 },
    result: { type: ['string', 'null'], maxLength: 262144 },
    toolName: { type: ['string', 'null'], maxLength: 256 },
    toolInput: JSON_VALUE_SCHEMA,
    toolOutput: JSON_VALUE_SCHEMA,
    usage: JSON_VALUE_SCHEMA,
    error: ERROR_SCHEMA,
    provenance: JSON_VALUE_SCHEMA,
  },
});

const EXTERNAL_ADAPTER_PROTOCOL_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://metame.local/schema/external-adapter-protocol-v1.json',
  title: 'MetaMe external Engine Plugin adapter protocol v1',
  type: 'object',
  oneOf: [
    { $ref: '#/$defs/initialize' },
    { $ref: '#/$defs/initialized' },
    { $ref: '#/$defs/probe' },
    { $ref: '#/$defs/run' },
    { $ref: '#/$defs/cancel' },
    { $ref: '#/$defs/sessionDiscover' },
    { $ref: '#/$defs/sessionInspect' },
    { $ref: '#/$defs/sessionRead' },
    { $ref: '#/$defs/shutdown' },
    { $ref: '#/$defs/response' },
    { $ref: '#/$defs/event' },
    { $ref: '#/$defs/errorRecord' },
  ],
  $defs: {
    correlationId: { type: 'string', pattern: CORRELATION_ID_PATTERN, maxLength: 128 },
    engineId: { type: 'string', pattern: ENGINE_ID_PATTERN, maxLength: 128 },
    operation: { type: 'string', pattern: OPERATION_PATTERN },
    initialize: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'protocolVersion', 'engineId', 'correlationId'],
      properties: {
        type: { const: 'initialize' },
        protocolVersion: { const: EXTERNAL_ADAPTER_PROTOCOL_VERSION },
        engineId: { $ref: '#/$defs/engineId' },
        correlationId: { $ref: '#/$defs/correlationId' },
        requestedCapabilities: { type: 'array', maxItems: 16, uniqueItems: true, items: { $ref: '#/$defs/operation' } },
      },
    },
    initialized: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'protocolVersion', 'engineId', 'correlationId', 'capabilities'],
      properties: {
        type: { const: 'initialized' },
        protocolVersion: { const: EXTERNAL_ADAPTER_PROTOCOL_VERSION },
        engineId: { $ref: '#/$defs/engineId' },
        correlationId: { $ref: '#/$defs/correlationId' },
        capabilities: { $ref: '#/$defs/capabilities' },
        adapterVersion: { type: 'string', maxLength: 128 },
      },
    },
    probe: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId'],
      properties: {
        type: { const: 'probe' },
        correlationId: { $ref: '#/$defs/correlationId' },
        engineId: { $ref: '#/$defs/engineId' },
      },
    },
    run: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId'],
      anyOf: [
        { required: ['input'], properties: { input: { type: 'string' } } },
        { required: ['prompt'], properties: { prompt: { type: 'string' } } },
      ],
      properties: {
        type: { const: 'run' },
        correlationId: { $ref: '#/$defs/correlationId' },
        runId: { type: 'string', minLength: 1, maxLength: 256 },
        input: { type: 'string', maxLength: 65536 },
        prompt: { type: 'string', maxLength: 65536 },
        nativeSessionId: { type: ['string', 'null'], maxLength: 256 },
        metadata: { type: 'object', maxProperties: 32, additionalProperties: true },
      },
    },
    cancel: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId'],
      properties: {
        type: { const: 'cancel' },
        correlationId: { $ref: '#/$defs/correlationId' },
        targetCorrelationId: { $ref: '#/$defs/correlationId' },
        runId: { type: 'string', minLength: 1, maxLength: 256 },
        reason: { type: 'string', maxLength: 256 },
      },
    },
    sessionDiscover: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId'],
      properties: {
        type: { const: 'session.discover' },
        correlationId: { $ref: '#/$defs/correlationId' },
        project: { type: ['string', 'null'], maxLength: 4096 },
        cursor: JSON_VALUE_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 1024 },
      },
    },
    sessionInspect: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId', 'session'],
      properties: {
        type: { const: 'session.inspect' },
        correlationId: { $ref: '#/$defs/correlationId' },
        session: { $ref: '#/$defs/sessionRef' },
      },
    },
    sessionRead: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId', 'session', 'sourceRevision'],
      properties: {
        type: { const: 'session.read' },
        correlationId: { $ref: '#/$defs/correlationId' },
        session: { $ref: '#/$defs/sessionRef' },
        sourceRevision: { type: 'string', minLength: 1, maxLength: 256 },
        cursor: JSON_VALUE_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 2048 },
      },
    },
    shutdown: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId'],
      properties: {
        type: { const: 'shutdown' },
        correlationId: { $ref: '#/$defs/correlationId' },
        reason: { type: 'string', maxLength: 256 },
      },
    },
    sessionRef: SESSION_REF_SCHEMA,
    capabilities: CAPABILITIES_SCHEMA,
    response: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'operation', 'correlationId', 'ok'],
      properties: {
        type: { const: 'response' },
        operation: { $ref: '#/$defs/operation' },
        correlationId: { $ref: '#/$defs/correlationId' },
        ok: { type: 'boolean' },
        result: JSON_VALUE_SCHEMA,
        error: ERROR_SCHEMA,
      },
    },
    event: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'operation', 'correlationId', 'event'],
      properties: {
        type: { const: 'event' },
        operation: { const: 'run' },
        correlationId: { $ref: '#/$defs/correlationId' },
        event: { $ref: '#/$defs/runEvent' },
      },
    },
    errorRecord: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'correlationId', 'error'],
      properties: {
        type: { const: 'error' },
        operation: { $ref: '#/$defs/operation' },
        correlationId: { $ref: '#/$defs/correlationId' },
        error: { $ref: '#/$defs/error' },
      },
    },
    runEvent: RUN_EVENT_SCHEMA,
    error: ERROR_SCHEMA,
  },
});

class ExternalAdapterProtocolError extends Error {
  constructor(code, detail = '', metadata = {}) {
    const safeDetail = redactText(detail, DEFAULT_EXTERNAL_ADAPTER_LIMITS.maxErrorBytes);
    super(safeDetail ? `${code}:${safeDetail}` : code);
    this.name = 'ExternalAdapterProtocolError';
    this.code = code;
    this.detail = safeDetail || '';
    Object.assign(this, metadata);
  }
}

const AJV = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
const validateProtocol = AJV.compile(EXTERNAL_ADAPTER_PROTOCOL_SCHEMA);

function formatAjvErrors(errors) {
  return (errors || []).map(error => ({
    code: `schema_${error.keyword}`,
    path: error.instancePath || '/',
    message: redactText(error.message || 'schema validation failed', 256),
  }));
}

function mergeLimits(limits = {}) {
  const merged = { ...DEFAULT_EXTERNAL_ADAPTER_LIMITS };
  for (const [key, value] of Object.entries(limits || {})) {
    if (Object.prototype.hasOwnProperty.call(merged, key)
      && Number.isSafeInteger(Number(value)) && Number(value) > 0) {
      merged[key] = Number(value);
    }
  }
  return Object.freeze(merged);
}

function redactionKey(key) {
  return /(?:token|secret|password|passwd|credential|authorization|cookie|private.?key|api.?key|access.?key|refresh.?token)/i.test(String(key));
}

function redactText(value, maxBytes = DEFAULT_EXTERNAL_ADAPTER_LIMITS.maxErrorBytes) {
  let text = String(value === undefined || value === null ? '' : value);
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(?:sk|ghp|xoxb|xapp|AIza)[A-Za-z0-9_-]{12,}/g, '[REDACTED]');
  const limit = Math.max(1, Number(maxBytes) || DEFAULT_EXTERNAL_ADAPTER_LIMITS.maxErrorBytes);
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  let end = Math.max(0, limit - Buffer.byteLength('…', 'utf8'));
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > limit - Buffer.byteLength('…', 'utf8')) end -= 1;
  return `${text.slice(0, end)}…`;
}

function redactDiagnosticValue(value, limits, depth) {
  if (depth > 4) return '[TRUNCATED]';
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === 'string') return redactText(value, limits.maxErrorBytes);
  if (typeof value !== 'object') return typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
  return redactDiagnosticObject(value, limits, depth);
}

function redactDiagnosticObject(value, limits, depth) {
  if (Array.isArray(value)) return value.slice(0, limits.maxItems)
    .map(item => redactDiagnosticValue(item, limits, depth + 1));
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, limits.maxItems)) {
    result[String(key).slice(0, 128)] = redactionKey(key)
      ? '[REDACTED]'
      : redactDiagnosticValue(child, limits, depth + 1);
  }
  return result;
}

function redactDiagnostic(value, options = {}, depth = 0) {
  return redactDiagnosticValue(value, mergeLimits(options), depth);
}

function cancelSemanticErrors(record) {
  return !record.targetCorrelationId && !record.runId
    ? [{ code: 'cancel_target_required', path: '/', message: 'cancel requires targetCorrelationId or runId' }]
    : [];
}

function runSemanticErrors(record) {
  const hasInput = Object.prototype.hasOwnProperty.call(record, 'input');
  const hasPrompt = Object.prototype.hasOwnProperty.call(record, 'prompt');
  return !hasInput && !hasPrompt
    ? [{ code: 'run_input_required', path: '/', message: 'run requires input or prompt' }]
    : [];
}

function responseSemanticErrors(record) {
  const errors = [];
  if (record.ok === true && !Object.prototype.hasOwnProperty.call(record, 'result')) {
    errors.push({ code: 'response_result_required', path: '/', message: 'successful response requires result' });
  }
  if (record.ok === false && !record.error) {
    errors.push({ code: 'response_error_required', path: '/', message: 'failed response requires error' });
  }
  return errors;
}

function protocolSemanticErrors(record) {
  if (record.type === 'cancel') return cancelSemanticErrors(record);
  if (record.type === 'run') return runSemanticErrors(record);
  if (record.type === 'response') return responseSemanticErrors(record);
  return [];
}

function serializedProtocolError(record, limits) {
  let serialized;
  try {
    serialized = JSON.stringify(record);
  } catch {
    return { code: 'record_not_json', path: '/', message: 'record is not JSON serializable' };
  }
  return Buffer.byteLength(serialized, 'utf8') > limits.maxRecordBytes
    ? { code: 'record_too_large', path: '/', message: `record exceeds ${limits.maxRecordBytes} bytes` }
    : null;
}

function validateProtocolRecord(record, options = {}) {
  const limits = mergeLimits(options);
  const validSchema = !!validateProtocol(record);
  const semanticErrors = record && typeof record === 'object' && !Array.isArray(record)
    ? protocolSemanticErrors(record)
    : [];
  const errors = validSchema
    ? semanticErrors
    : [...formatAjvErrors(validateProtocol.errors), ...semanticErrors];
  if (validSchema) {
    const serializedError = serializedProtocolError(record, limits);
    if (serializedError) errors.push(serializedError);
  }
  return { valid: errors.length === 0, errors, record: errors.length === 0 ? record : null };
}

function assertProtocolRecord(record, options = {}) {
  const result = validateProtocolRecord(record, options);
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.path} ${error.message}`).join('; ');
    throw new ExternalAdapterProtocolError('PROTOCOL_RECORD_INVALID', detail, { validationErrors: result.errors });
  }
  return record;
}

function encodeProtocolRecord(record, options = {}) {
  const limits = mergeLimits(options);
  assertProtocolRecord(record, limits);
  let line;
  try {
    line = JSON.stringify(record);
  } catch (error) {
    throw new ExternalAdapterProtocolError('PROTOCOL_RECORD_NOT_JSON', error && error.message);
  }
  if (line.includes('\n') || line.includes('\r')) {
    throw new ExternalAdapterProtocolError('PROTOCOL_RECORD_LINE_INVALID');
  }
  if (Buffer.byteLength(line, 'utf8') > limits.maxRecordBytes) {
    throw new ExternalAdapterProtocolError('PROTOCOL_RECORD_TOO_LARGE');
  }
  return `${line}\n`;
}

function parseProtocolLine(line, options = {}) {
  const limits = mergeLimits(options);
  if (typeof line !== 'string') throw new ExternalAdapterProtocolError('PROTOCOL_LINE_NOT_TEXT');
  if (!line || line.includes('\r')) throw new ExternalAdapterProtocolError('PROTOCOL_LINE_NOT_STRICT_LF');
  if (Buffer.byteLength(line, 'utf8') > limits.maxRecordBytes) {
    throw new ExternalAdapterProtocolError('PROTOCOL_RECORD_TOO_LARGE');
  }
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw new ExternalAdapterProtocolError('PROTOCOL_JSON_MALFORMED');
  }
  // Keep version negotiation diagnosable even though the versioned schema
  // intentionally rejects records from a future protocol.  Callers can then
  // distinguish a peer speaking another version from arbitrary malformed
  // stdout without accepting that record into the protocol.
  if (record && record.type === 'initialized'
    && record.protocolVersion !== EXTERNAL_ADAPTER_PROTOCOL_VERSION) {
    throw new ExternalAdapterProtocolError('PROTOCOL_VERSION_MISMATCH', String(record.protocolVersion));
  }
  return assertProtocolRecord(record, limits);
}

function createStrictLfFramer(options = {}) {
  const limits = mergeLimits(options);
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let closed = false;

  function feed(chunk) {
    if (closed) throw new ExternalAdapterProtocolError('PROTOCOL_FRAMER_CLOSED');
    const text = Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
      ? decoder.write(Buffer.from(chunk))
      : String(chunk || '');
    buffer += text;
    if (Buffer.byteLength(buffer, 'utf8') > limits.maxBufferedBytes) {
      throw new ExternalAdapterProtocolError('PROTOCOL_BUFFER_TOO_LARGE');
    }
    const records = [];
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) throw new ExternalAdapterProtocolError('PROTOCOL_EMPTY_RECORD');
      records.push(parseProtocolLine(line, limits));
      newlineIndex = buffer.indexOf('\n');
    }
    return records;
  }

  function end() {
    if (closed) return;
    closed = true;
    buffer += decoder.end();
    if (buffer.length > 0) throw new ExternalAdapterProtocolError('PROTOCOL_TRAILING_PARTIAL_RECORD');
  }

  return Object.freeze({ feed, end, limits });
}

function createCorrelationId(prefix = 'req') {
  const safePrefix = String(prefix || 'req').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 24) || 'req';
  return `${safePrefix}-${crypto.randomUUID()}`.slice(0, DEFAULT_EXTERNAL_ADAPTER_LIMITS.maxCorrelationIdLength);
}

function operationCapability(operation) {
  return EXTERNAL_ADAPTER_OPERATIONS.includes(operation) ? operation : null;
}

function normalizeCapabilities(capabilities = {}) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new ExternalAdapterProtocolError('CAPABILITIES_INVALID');
  }
  const unknown = Object.keys(capabilities).filter(key => !EXTERNAL_ADAPTER_OPERATIONS.includes(key));
  if (unknown.length) throw new ExternalAdapterProtocolError('CAPABILITY_UNKNOWN', unknown.join(','));
  return Object.freeze(Object.fromEntries(EXTERNAL_ADAPTER_OPERATIONS.map(operation => [
    operation,
    capabilities[operation] === true,
  ])));
}

function isCapabilitySupported(capabilities, operation) {
  return normalizeCapabilities(capabilities || {})[operation] === true;
}

function stableProtocolError(code, detail = '', metadata = {}) {
  return new ExternalAdapterProtocolError(String(code || 'EXTERNAL_ADAPTER_ERROR').toUpperCase(), detail, metadata);
}

module.exports = {
  EXTERNAL_ADAPTER_PROTOCOL_VERSION,
  EXTERNAL_ADAPTER_PROTOCOL_NAME,
  EXTERNAL_ADAPTER_OPERATIONS,
  EXTERNAL_ADAPTER_CAPABILITIES,
  DEFAULT_EXTERNAL_ADAPTER_LIMITS,
  EXTERNAL_ADAPTER_PROTOCOL_SCHEMA,
  ExternalAdapterProtocolError,
  assertProtocolRecord,
  createCorrelationId,
  createStrictLfFramer,
  encodeProtocolRecord,
  isCapabilitySupported,
  normalizeCapabilities,
  operationCapability,
  parseProtocolLine,
  redactDiagnostic,
  redactText,
  stableProtocolError,
  validateProtocolRecord,
  _internal: {
    formatAjvErrors,
    mergeLimits,
    redactionKey,
    validateProtocol,
  },
};
