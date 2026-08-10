'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  EXTERNAL_ADAPTER_OPERATIONS,
  EXTERNAL_ADAPTER_PROTOCOL_SCHEMA,
  EXTERNAL_ADAPTER_PROTOCOL_NAME,
  EXTERNAL_ADAPTER_PROTOCOL_VERSION,
  DEFAULT_EXTERNAL_ADAPTER_LIMITS,
  assertProtocolRecord,
  createCorrelationId,
  createStrictLfFramer,
  encodeProtocolRecord,
  normalizeCapabilities: normalizeProtocolCapabilities,
  redactDiagnostic,
  redactText,
  parseProtocolLine,
  validateProtocolRecord,
} = require('../core/external-adapter-protocol');
const { terminateChildProcess } = require('../core/handoff');
const { killProcessTree } = require('../platform');
const Ajv2020 = require('ajv/dist/2020');

const EXTERNAL_ADAPTER_MANIFEST_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://metame.local/schema/external-adapter-manifest-v1.json',
  title: 'MetaMe external Engine Plugin adapter manifest v1',
  type: 'object',
  additionalProperties: false,
  required: ['protocolVersion', 'engineId', 'executable', 'allowlistedPaths', 'capabilities'],
  properties: {
    protocolVersion: { const: EXTERNAL_ADAPTER_PROTOCOL_VERSION },
    engineId: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$', maxLength: 128 },
    displayName: { type: 'string', minLength: 1, maxLength: 256 },
    vendor: { type: 'string', minLength: 1, maxLength: 256 },
    executable: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4096 },
        args: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 4096 } },
      },
    },
    allowlistedPaths: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 4096 },
    },
    allowedProjects: {
      type: 'array',
      maxItems: 128,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 4096 },
    },
    environmentAllowlist: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 128 },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: [...EXTERNAL_ADAPTER_OPERATIONS],
      properties: Object.fromEntries(EXTERNAL_ADAPTER_OPERATIONS.map(operation => [operation, { type: 'boolean' }])),
    },
    limits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxRecordBytes: { type: 'integer', minimum: 1024, maximum: 16 * 1024 * 1024 },
        maxBufferedBytes: { type: 'integer', minimum: 1024, maximum: 16 * 1024 * 1024 },
        maxPromptBytes: { type: 'integer', minimum: 1, maximum: 4 * 1024 * 1024 },
        maxTextBytes: { type: 'integer', minimum: 1, maximum: 16 * 1024 * 1024 },
        maxEvents: { type: 'integer', minimum: 1, maximum: 100000 },
        maxStderrBytes: { type: 'integer', minimum: 1, maximum: 1024 * 1024 },
        initializeTimeoutMs: { type: 'integer', minimum: 1, maximum: 10 * 60 * 1000 },
        operationTimeoutMs: { type: 'integer', minimum: 1, maximum: 24 * 60 * 60 * 1000 },
        cancelTimeoutMs: { type: 'integer', minimum: 1, maximum: 60 * 1000 },
        shutdownTimeoutMs: { type: 'integer', minimum: 1, maximum: 60 * 1000 },
        forceKillDelayMs: { type: 'integer', minimum: 1, maximum: 60 * 1000 },
      },
    },
  },
});

const MANIFEST_AJV = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
const validateManifestDocument = MANIFEST_AJV.compile(EXTERNAL_ADAPTER_MANIFEST_SCHEMA);

const DEFAULT_SAFE_ENV_KEYS = Object.freeze([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR',
  'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
]);
const SENSITIVE_ENV_RE = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|PRIVATE.?KEY|API.?KEY|ACCESS.?KEY|REFRESH.?TOKEN)/i;
const UNSAFE_ENV_RE = /^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z0-9_]+|BASH_ENV|ENV|CDPATH|PYTHONPATH|PERL5OPT|RUBYOPT)$/i;

function externalAdapterError(code, detail = '', cause = null, metadata = {}) {
  const message = redactText(detail, DEFAULT_EXTERNAL_ADAPTER_LIMITS.maxErrorBytes);
  const error = new Error(message ? `${code}:${message}` : code);
  error.name = 'ExternalAdapterError';
  error.code = code;
  error.detail = message;
  if (cause) error.cause = cause;
  Object.assign(error, metadata);
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function schemaErrors(errors) {
  return (errors || []).map(error => ({
    code: `schema_${error.keyword}`,
    path: error.instancePath || '/',
    message: redactText(error.message || 'manifest schema validation failed', 256),
  }));
}

function normalizeManifestCapabilities(value) {
  if (!isPlainObject(value)) throw externalAdapterError('EXTERNAL_ADAPTER_CAPABILITIES_REQUIRED');
  const unknown = Object.keys(value).filter(key => !EXTERNAL_ADAPTER_OPERATIONS.includes(key));
  if (unknown.length) throw externalAdapterError('EXTERNAL_ADAPTER_CAPABILITY_UNKNOWN', unknown.join(','));
  const invalid = Object.entries(value).filter(([, supported]) => typeof supported !== 'boolean');
  if (invalid.length) throw externalAdapterError('EXTERNAL_ADAPTER_CAPABILITY_INVALID', invalid.map(([key]) => key).join(','));
  return Object.fromEntries(EXTERNAL_ADAPTER_OPERATIONS.map(operation => [operation, value[operation] === true]));
}

function assertKnownManifestKeys(value) {
  const allowed = new Set([
    'protocolVersion', 'engineId', 'engine_id', 'displayName', 'vendor',
    'executable', 'executablePath', 'adapterPath', 'path', 'args',
    'allowlistedPaths', 'allowedExecutables', 'allowlist',
    'allowedProjects', 'allowedProjectRoots', 'environmentAllowlist', 'envAllowlist',
    'capabilities', 'limits',
  ]);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw externalAdapterError('EXTERNAL_ADAPTER_MANIFEST_PROPERTY_UNKNOWN', unknown.join(','));
}

function resolveManifestExecutableInput(input) {
  if (input.executable !== undefined && !isPlainObject(input.executable) && typeof input.executable !== 'string') {
    throw externalAdapterError('EXTERNAL_ADAPTER_EXECUTABLE_INVALID');
  }
  const executableInput = isPlainObject(input.executable)
    ? input.executable
    : {
      path: typeof input.executable === 'string'
        ? input.executable
        : (input.executablePath || input.adapterPath || input.path),
      args: input.args,
    };
  const executableKeys = Object.keys(executableInput);
  if (executableKeys.some(key => !['path', 'args'].includes(key))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_EXECUTABLE_PROPERTY_UNKNOWN', executableKeys.join(','));
  }
  if (executableInput.path !== undefined && typeof executableInput.path !== 'string') {
    throw externalAdapterError('EXTERNAL_ADAPTER_EXECUTABLE_PATH_INVALID');
  }
  if (executableInput.args !== undefined && !Array.isArray(executableInput.args)) {
    throw externalAdapterError('EXTERNAL_ADAPTER_EXECUTABLE_ARGS_INVALID');
  }
  if (Array.isArray(executableInput.args) && executableInput.args.some(value => typeof value !== 'string')) {
    throw externalAdapterError('EXTERNAL_ADAPTER_EXECUTABLE_ARG_INVALID');
  }
  return executableInput;
}

function assertManifestArrayTypes(input) {
  for (const key of ['allowlistedPaths', 'allowedExecutables', 'allowlist', 'allowedProjects', 'allowedProjectRoots', 'environmentAllowlist', 'envAllowlist']) {
    if (input[key] !== undefined && !Array.isArray(input[key])) {
      throw externalAdapterError('EXTERNAL_ADAPTER_MANIFEST_ARRAY_INVALID', key);
    }
    if (Array.isArray(input[key]) && input[key].some(value => typeof value !== 'string')) {
      throw externalAdapterError('EXTERNAL_ADAPTER_MANIFEST_STRING_ARRAY_INVALID', key);
    }
  }
}

function assertManifestObjectTypes(input) {
  if (input.capabilities !== undefined && !isPlainObject(input.capabilities)) {
    throw externalAdapterError('EXTERNAL_ADAPTER_CAPABILITIES_REQUIRED');
  }
  if (input.limits !== undefined && !isPlainObject(input.limits)) {
    throw externalAdapterError('EXTERNAL_ADAPTER_LIMITS_INVALID');
  }
}

function assertManifestStringTypes(input) {
  if (input.displayName !== undefined && typeof input.displayName !== 'string') {
    throw externalAdapterError('EXTERNAL_ADAPTER_DISPLAY_NAME_INVALID');
  }
  if (input.vendor !== undefined && typeof input.vendor !== 'string') {
    throw externalAdapterError('EXTERNAL_ADAPTER_VENDOR_INVALID');
  }
}

function assertManifestInputTypes(input) {
  assertManifestArrayTypes(input);
  assertManifestObjectTypes(input);
  assertManifestStringTypes(input);
}

function firstManifestArray(input, keys) {
  const value = keys.map(key => input[key]).find(candidate => candidate !== undefined);
  return Array.isArray(value) ? value.map(item => String(item).trim()) : [];
}

function normalizeManifestVersion(input) {
  return input.protocolVersion === undefined
    ? EXTERNAL_ADAPTER_PROTOCOL_VERSION : Number(input.protocolVersion);
}

function normalizeManifestText(input, key) {
  return input[key] === undefined ? {} : { [key]: String(input[key]).trim() };
}

function normalizeManifestArgs(value) {
  return Array.isArray(value) ? value.map(item => String(item)) : [];
}

function buildNormalizedManifest(input, executableInput) {
  const pathValue = String(executableInput.path || '').trim();
  const rawEngineId = String(input.engineId || input.engine_id || '').trim();
  if (rawEngineId && rawEngineId !== rawEngineId.toLowerCase()) {
    throw externalAdapterError('EXTERNAL_ADAPTER_ENGINE_ID_NOT_LOWERCASE', rawEngineId);
  }
  const normalized = {
    protocolVersion: normalizeManifestVersion(input),
    engineId: rawEngineId.toLowerCase(),
    ...normalizeManifestText(input, 'displayName'),
    ...normalizeManifestText(input, 'vendor'),
    executable: {
      path: pathValue,
      args: normalizeManifestArgs(executableInput.args),
    },
    allowlistedPaths: firstManifestArray(input, ['allowlistedPaths', 'allowedExecutables', 'allowlist']),
    allowedProjects: firstManifestArray(input, ['allowedProjects', 'allowedProjectRoots']),
    environmentAllowlist: firstManifestArray(input, ['environmentAllowlist', 'envAllowlist']),
    capabilities: normalizeManifestCapabilities(input.capabilities || {}),
    ...(input.limits === undefined ? {} : { limits: { ...input.limits } }),
  };
  return normalized;
}

function assertNormalizedManifestSafety(normalized) {
  if (!path.isAbsolute(normalized.executable.path)) {
    throw externalAdapterError('EXTERNAL_ADAPTER_EXECUTABLE_ABSOLUTE_REQUIRED');
  }
  if (normalized.environmentAllowlist.some(key => SENSITIVE_ENV_RE.test(key))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_ENV_SECRET_NOT_ALLOWED');
  }
  if (normalized.environmentAllowlist.some(key => UNSAFE_ENV_RE.test(key))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_ENV_UNSAFE_NOT_ALLOWED');
  }
  if (normalized.allowlistedPaths.some(value => !path.isAbsolute(value))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_ALLOWLIST_ABSOLUTE_REQUIRED');
  }
  if (normalized.allowedProjects.some(value => !path.isAbsolute(value))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_PROJECT_ROOT_ABSOLUTE_REQUIRED');
  }
}

function normalizeExternalAdapterManifest(input = {}) {
  if (!isPlainObject(input)) throw externalAdapterError('EXTERNAL_ADAPTER_MANIFEST_REQUIRED');
  assertKnownManifestKeys(input);
  const executableInput = resolveManifestExecutableInput(input);
  assertManifestInputTypes(input);
  const normalized = buildNormalizedManifest(input, executableInput);
  const result = validateExternalAdapterManifest(normalized);
  if (!result.valid) {
    const detail = result.errors.map(error => `${error.path} ${error.message}`).join('; ');
    throw externalAdapterError('EXTERNAL_ADAPTER_MANIFEST_INVALID', detail, null, { validationErrors: result.errors });
  }
  assertNormalizedManifestSafety(normalized);
  return deepFreeze(normalized);
}

function validateExternalAdapterManifest(value) {
  const valid = !!validateManifestDocument(value);
  return {
    valid,
    errors: valid ? [] : schemaErrors(validateManifestDocument.errors),
    manifest: valid ? value : null,
  };
}

function resolvePathForComparison(value, pathModule = path, fsModule = fs) {
  const candidate = pathModule.resolve(String(value || ''));
  try {
    return fsModule.realpathSync.native ? fsModule.realpathSync.native(candidate) : fsModule.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

function resolveExternalAdapterExecutable(manifest, deps = {}) {
  const pathModule = deps.path || path;
  const fsModule = deps.fs || fs;
  const executable = pathModule.resolve(manifest.executable.path);
  let stat;
  try {
    stat = fsModule.statSync(executable);
  } catch (error) {
    throw externalAdapterError('EXTERNAL_ADAPTER_NOT_INSTALLED', executable, error);
  }
  if (!stat.isFile()) throw externalAdapterError('EXTERNAL_ADAPTER_NOT_FILE', executable);
  const resolved = resolvePathForComparison(executable, pathModule, fsModule);
  const allowlisted = manifest.allowlistedPaths
    .map(value => resolvePathForComparison(value, pathModule, fsModule))
    .some(value => value === resolved);
  if (!allowlisted) throw externalAdapterError('EXTERNAL_ADAPTER_NOT_ALLOWLISTED', resolved);
  if (process.platform !== 'win32' && typeof fsModule.accessSync === 'function') {
    try {
      fsModule.accessSync(resolved, fsModule.constants && fsModule.constants.X_OK);
    } catch (error) {
      throw externalAdapterError('EXTERNAL_ADAPTER_NOT_EXECUTABLE', resolved, error);
    }
  }
  return resolved;
}

function isPathWithin(childPath, rootPath, pathModule = path) {
  const relative = pathModule.relative(rootPath, childPath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathModule.sep}`) && !pathModule.isAbsolute(relative));
}

function resolveSelectedProjectCwd(selectedCwd, allowedProjects = [], deps = {}) {
  const pathModule = deps.path || path;
  const fsModule = deps.fs || fs;
  const requestedCwd = pathModule.resolve(String(selectedCwd || ''));
  if (!selectedCwd || !pathModule.isAbsolute(String(selectedCwd))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_CWD_ABSOLUTE_REQUIRED');
  }
  try {
    if (!fsModule.statSync(requestedCwd).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw externalAdapterError('EXTERNAL_ADAPTER_CWD_INVALID', requestedCwd, error);
  }
  const cwd = resolvePathForComparison(requestedCwd, pathModule, fsModule);
  const roots = (allowedProjects || []).map(value => resolvePathForComparison(value, pathModule, fsModule)).filter(Boolean);
  if (roots.length > 0 && !roots.some(root => isPathWithin(cwd, root, pathModule))) {
    throw externalAdapterError('EXTERNAL_ADAPTER_CWD_NOT_ALLOWED', cwd);
  }
  return cwd;
}

function buildMinimalEnvironment(baseEnv = process.env, options = {}) {
  const allowed = new Set([
    ...DEFAULT_SAFE_ENV_KEYS,
    ...(Array.isArray(options.allowlist) ? options.allowlist : []),
  ]);
  const env = {};
  for (const key of allowed) {
    if (!key || SENSITIVE_ENV_RE.test(key) || UNSAFE_ENV_RE.test(key)) continue;
    if (baseEnv && typeof baseEnv[key] === 'string') env[key] = baseEnv[key];
  }
  // An explicit marker is useful to an adapter, but no user credential or
  // complete parent environment is inherited by accident.
  env.METAME_EXTERNAL_ADAPTER = '1';
  return Object.freeze(env);
}

function mergeClientLimits(manifest, options = {}) {
  const source = { ...DEFAULT_EXTERNAL_ADAPTER_LIMITS, ...(manifest.limits || {}), ...(options.limits || {}) };
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_EXTERNAL_ADAPTER_LIMITS)) {
    const value = Number(source[key]);
    result[key] = Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  result.initializeTimeoutMs = Number(source.initializeTimeoutMs) || 5000;
  result.operationTimeoutMs = Number(source.operationTimeoutMs) || 300000;
  result.cancelTimeoutMs = Number(source.cancelTimeoutMs) || 2000;
  result.shutdownTimeoutMs = Number(source.shutdownTimeoutMs) || 2000;
  result.forceKillDelayMs = Number(source.forceKillDelayMs) || 1000;
  return Object.freeze(result);
}

function asProtocolError(error, fallbackCode = 'EXTERNAL_ADAPTER_ERROR') {
  if (error && error.code) return error;
  return externalAdapterError(fallbackCode, error && error.message ? error.message : String(error || ''));
}

function resultValue(record) {
  if (!record || record.type !== 'response') return null;
  return record.result;
}

class ExternalAdapterClient {
  constructor(options = {}) {
    this.manifest = normalizeExternalAdapterManifest(options.manifest || options);
    this.limits = mergeClientLimits(this.manifest, options);
    this.fs = options.fs || fs;
    this.path = options.path || path;
    this.spawn = options.spawn || spawn;
    this.projectCwd = resolveSelectedProjectCwd(
      options.projectCwd || options.cwd,
      this.manifest.allowedProjects,
      { fs: this.fs, path: this.path },
    );
    this.baseEnv = options.baseEnv || process.env;
    this.env = buildMinimalEnvironment(this.baseEnv, {
      allowlist: this.manifest.environmentAllowlist,
    });
    this.useProcessGroup = options.useProcessGroup !== false && process.platform !== 'win32';
    this.child = null;
    this.executable = null;
    this.started = false;
    this.initialized = false;
    this.closing = false;
    this.protocolVersion = null;
    this.capabilities = Object.freeze({ ...this.manifest.capabilities });
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = '';
    this.stderrTruncated = false;
    this.stats = { records: 0, stdoutBytes: 0, stderrBytes: 0, events: 0 };
    this.framer = null;
    this.onRecord = typeof options.onRecord === 'function' ? options.onRecord : null;
    this._childError = null;
  }

  _newRequestId(operation) {
    return createCorrelationId(String(operation || 'request').replace(/[^A-Za-z0-9]/g, '-'));
  }

  _ensureStarted() {
    if (!this.started || !this.child) throw externalAdapterError('EXTERNAL_ADAPTER_NOT_STARTED');
    if (this.closing) throw externalAdapterError('EXTERNAL_ADAPTER_CLOSING');
  }

  _ensureCapability(operation, { allowUnsupported = false } = {}) {
    if (!EXTERNAL_ADAPTER_OPERATIONS.includes(operation)) {
      throw externalAdapterError('EXTERNAL_ADAPTER_OPERATION_UNKNOWN', operation);
    }
    if (!allowUnsupported && this.capabilities[operation] !== true) {
      throw externalAdapterError('CAPABILITY_UNSUPPORTED', operation);
    }
  }

  _appendStderr(chunk) {
    const text = redactText(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''), this.limits.maxStderrBytes);
    const next = `${this.stderr}${text}`;
    if (Buffer.byteLength(next, 'utf8') > this.limits.maxStderrBytes) {
      this.stderr = redactText(next, this.limits.maxStderrBytes);
      this.stderrTruncated = true;
    } else {
      this.stderr = next;
    }
    this.stats.stderrBytes += Buffer.byteLength(text, 'utf8');
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _protocolFailure(error) {
    const protocolError = asProtocolError(error, 'PROTOCOL_STDOUT_INVALID');
    const protocolCode = protocolError.code === 'PROTOCOL_VERSION_MISMATCH'
      ? protocolError.code
      : protocolError.code && protocolError.code.startsWith('PROTOCOL_')
      ? 'PROTOCOL_STDOUT_INVALID'
      : protocolError.code;
    const wrapped = externalAdapterError(protocolCode, protocolError.detail || protocolError.message, protocolError);
    this._rejectPending(wrapped);
    this._terminateProcess();
    return wrapped;
  }

  _removePending(correlationId, pending) {
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
  }

  _handleEventRecord(record, pending, correlationId) {
    this.stats.events += 1;
    if (pending.onEvent) {
      try { pending.onEvent(record.event); } catch { /* event observers are isolated */ }
    }
    const terminal = record.event.type === 'run_completed' || record.event.type === 'run_failed';
    if (!terminal) return;
    if (pending.terminalEvent) {
      this._protocolFailure(externalAdapterError('PROTOCOL_TERMINAL_DUPLICATE', correlationId));
      return;
    }
    pending.terminalEvent = record.event.type;
  }

  _handleErrorRecord(record, pending, correlationId) {
    this._removePending(correlationId, pending);
    pending.reject(externalAdapterError(record.error.code, record.error.message, null, {
      operation: record.operation || pending.operation,
    }));
  }

  _handleResponseRecord(record, pending, correlationId) {
    this._removePending(correlationId, pending);
    if (record.type === 'response' && record.ok === false) {
      pending.reject(externalAdapterError(record.error.code, record.error.message, null, {
        operation: record.operation || pending.operation,
      }));
      return;
    }
    pending.resolve(record);
  }

  _validateIncomingCorrelation(record, pending) {
    if ((record.type === 'response' || record.type === 'error')
      && record.operation && record.operation !== pending.operation) {
      this._protocolFailure(externalAdapterError('PROTOCOL_CORRELATION_OPERATION_MISMATCH', `${record.operation}:${pending.operation}`));
      return false;
    }
    if (record.type === 'initialized' && pending.operation !== 'initialize') {
      this._protocolFailure(externalAdapterError('PROTOCOL_RECORD_UNEXPECTED', 'initialized'));
      return false;
    }
    return true;
  }

  _handleRecord(record) {
    this.stats.records += 1;
    if (this.stats.records > this.limits.maxEvents) return void this._protocolFailure(externalAdapterError('PROTOCOL_EVENT_LIMIT'));
    if (this.onRecord) {
      try { this.onRecord(record); } catch { /* diagnostics hooks must not break protocol handling */ }
    }
    const correlationId = record.correlationId;
    const pending = correlationId ? this.pending.get(correlationId) : null;
    if (!pending) return void this._protocolFailure(externalAdapterError('PROTOCOL_CORRELATION_UNKNOWN', correlationId || 'missing'));
    if (!this._validateIncomingCorrelation(record, pending)) return;
    if (record.type === 'event') return this._handleEventRecord(record, pending, correlationId);
    if (record.type === 'error') return this._handleErrorRecord(record, pending, correlationId);
    if (record.type === 'response' || record.type === 'initialized') {
      return this._handleResponseRecord(record, pending, correlationId);
    }
    this._protocolFailure(externalAdapterError('PROTOCOL_RECORD_UNEXPECTED', record.type));
  }

  _attachChild(child) {
    if (!child || !child.stdout || !child.stderr || !child.stdin || typeof child.on !== 'function') {
      throw externalAdapterError('EXTERNAL_ADAPTER_CHILD_INVALID');
    }
    this.child = child;
    this.framer = createStrictLfFramer(this.limits);
    child.stdout.on('data', chunk => {
      this.stats.stdoutBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ''), 'utf8');
      try {
        for (const record of this.framer.feed(chunk)) this._handleRecord(record);
      } catch (error) {
        this._protocolFailure(error);
      }
    });
    child.stderr.on('data', chunk => this._appendStderr(chunk));
    child.stdin.on('error', error => {
      if (!this.closing) this._rejectPending(externalAdapterError('EXTERNAL_ADAPTER_STDIN_FAILED', error && error.message, error));
    });
    child.on('error', error => {
      this._childError = error;
      if (!this.closing) this._rejectPending(externalAdapterError('EXTERNAL_ADAPTER_CRASHED', error && error.message, error));
    });
    child.on('close', (code, signal) => {
      try { this.framer.end(); } catch (error) { this._protocolFailure(error); }
      if (!this.closing && this.pending.size > 0) {
        this._rejectPending(externalAdapterError('EXTERNAL_ADAPTER_CRASHED', `exit=${code},signal=${signal || ''}`));
      }
      this.child = null;
      this.started = false;
      this.initialized = false;
    });
  }

  _write(record) {
    this._ensureStarted();
    const line = encodeProtocolRecord(record, this.limits);
    try {
      this.child.stdin.write(line);
    } catch (error) {
      throw externalAdapterError('EXTERNAL_ADAPTER_STDIN_FAILED', error && error.message, error);
    }
  }

  _requestRecord(operation, payload = {}, options = {}) {
    if (!options.allowBeforeInit) {
      this._ensureStarted();
      if (!this.initialized) throw externalAdapterError('EXTERNAL_ADAPTER_NOT_INITIALIZED');
    }
    if (!options.allowUnsupported) this._ensureCapability(operation);
    const correlationId = options.correlationId || this._newRequestId(operation);
    const record = {
      type: operation,
      correlationId,
      ...payload,
    };
    delete record.type;
    record.type = operation;
    const result = validateProtocolRecord(record, this.limits);
    if (!result.valid) {
      throw externalAdapterError('PROTOCOL_REQUEST_INVALID', result.errors.map(error => error.message).join('; '));
    }
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.limits.operationTimeoutMs;
    return new Promise((resolve, reject) => {
      const pending = {
        operation,
        resolve,
        reject,
        onEvent: options.onEvent,
        terminalEvent: null,
        signal: options.signal || null,
        abortHandler: null,
        timer: null,
      };
      pending.timer = setTimeout(() => {
        this.pending.delete(correlationId);
        if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
        const timeoutError = externalAdapterError('EXTERNAL_ADAPTER_TIMEOUT', operation);
        reject(timeoutError);
        this._terminateProcess();
      }, timeoutMs);
      if (typeof pending.timer.unref === 'function') pending.timer.unref();
      if (pending.signal) {
        pending.abortHandler = () => {
          this.pending.delete(correlationId);
          clearTimeout(pending.timer);
          const cancelError = externalAdapterError('EXTERNAL_ADAPTER_CANCELLED', operation);
          reject(cancelError);
          this._sendCancellation(correlationId).finally(() => this._terminateProcess());
        };
        if (pending.signal.aborted) {
          pending.abortHandler();
          return;
        }
        pending.signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      this.pending.set(correlationId, pending);
      try {
        this._write(record);
      } catch (error) {
        this.pending.delete(correlationId);
        clearTimeout(pending.timer);
        if (pending.signal && pending.abortHandler) pending.signal.removeEventListener('abort', pending.abortHandler);
        reject(error);
      }
    });
  }

  async _sendCancellation(targetCorrelationId) {
    if (!this.child || !this.initialized || !this.capabilities.cancel) return null;
    try {
      return await this._requestRecord('cancel', {
        targetCorrelationId,
        reason: 'caller_cancelled',
      }, {
        timeoutMs: this.limits.cancelTimeoutMs,
        allowUnsupported: true,
      });
    } catch {
      return null;
    }
  }

  _terminateProcess() {
    const child = this.child;
    if (!child) return false;
    this.closing = true;
    const useProcessGroup = this.useProcessGroup;
    const terminate = signal => process.platform === 'win32'
      ? killProcessTree(child.pid, signal)
      : terminateChildProcess(child, signal, { useProcessGroup });
    terminate('SIGTERM');
    const timer = setTimeout(() => terminate('SIGKILL'), this.limits.forceKillDelayMs);
    if (typeof timer.unref === 'function') timer.unref();
    return true;
  }

  _spawnProcess() {
    this.executable = resolveExternalAdapterExecutable(this.manifest, { fs: this.fs, path: this.path });
    const spawnOptions = {
      cwd: this.projectCwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: this.useProcessGroup,
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    };
    let child;
    try {
      child = this.spawn(this.executable, [...this.manifest.executable.args], spawnOptions);
      this._attachChild(child);
    } catch (error) {
      throw externalAdapterError('EXTERNAL_ADAPTER_SPAWN_FAILED', error && error.message, error);
    }
    this.started = true;
    this.closing = false;
  }

  _requestInitialization() {
    const correlationId = this._newRequestId('initialize');
    return this._requestRecord('initialize', {
      protocolVersion: EXTERNAL_ADAPTER_PROTOCOL_VERSION,
      engineId: this.manifest.engineId,
      ...(this.manifest.capabilities ? { requestedCapabilities: Object.entries(this.manifest.capabilities)
        .filter(([, supported]) => supported).map(([operation]) => operation) } : {}),
    }, {
      allowBeforeInit: true,
      allowUnsupported: true,
      correlationId,
      timeoutMs: this.limits.initializeTimeoutMs,
    });
  }

  _acceptHandshake(record) {
    if (record.type !== 'initialized') throw externalAdapterError('PROTOCOL_INITIALIZATION_REQUIRED');
    if (record.protocolVersion !== EXTERNAL_ADAPTER_PROTOCOL_VERSION) {
      throw externalAdapterError('PROTOCOL_VERSION_MISMATCH', String(record.protocolVersion));
    }
    if (record.engineId !== this.manifest.engineId) {
      throw externalAdapterError('ENGINE_ID_MISMATCH', `${record.engineId}:${this.manifest.engineId}`);
    }
    const negotiated = normalizeProtocolCapabilities(record.capabilities);
    const overclaimed = Object.entries(negotiated)
      .some(([operation, supported]) => supported && !this.manifest.capabilities[operation]);
    if (overclaimed) throw externalAdapterError('CAPABILITY_NEGOTIATION_INVALID');
    this.capabilities = negotiated;
    this.protocolVersion = record.protocolVersion;
    this.initialized = true;
    this.handshake = Object.freeze({
      protocolVersion: this.protocolVersion,
      engineId: record.engineId,
      capabilities: this.capabilities,
      adapterVersion: record.adapterVersion || null,
    });
    return this.handshake;
  }

  async start() {
    if (this.initialized) return this.handshake;
    if (this.started) throw externalAdapterError('EXTERNAL_ADAPTER_START_IN_PROGRESS');
    this._spawnProcess();
    try {
      return this._acceptHandshake(await this._requestInitialization());
    } catch (error) {
      this._terminateProcess();
      throw asProtocolError(error, 'EXTERNAL_ADAPTER_INITIALIZE_FAILED');
    }
  }

  request(operation, payload = {}, options = {}) {
    try {
      return this._requestRecord(operation, payload, options).then(record => resultValue(record));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  probe(options = {}) {
    return this.request('probe', {}, options);
  }

  run(request = {}, options = {}) {
    const payload = { ...request };
    if (payload.input === undefined && payload.prompt !== undefined) payload.input = String(payload.prompt);
    const requestOptions = { ...options };
    if (!requestOptions.onEvent && Array.isArray(options.events)) {
      requestOptions.onEvent = event => options.events.push(event);
    }
    try {
      return this._requestRecord('run', payload, requestOptions).then(record => ({
        ...(isPlainObject(resultValue(record)) ? resultValue(record) : { result: resultValue(record) }),
        events: options.events || [],
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  cancel(target, options = {}) {
    const payload = typeof target === 'string'
      ? { targetCorrelationId: target }
      : { ...(target || {}) };
    return this.request('cancel', payload, { ...options, timeoutMs: options.timeoutMs || this.limits.cancelTimeoutMs });
  }

  sessionDiscover(request = {}, options = {}) {
    const { project, cursor, limit } = request || {};
    return this.request('session.discover', {
      ...(project !== undefined ? { project } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }, options).then(result => (
      Array.isArray(result) ? result : (result && Array.isArray(result.sessions) ? result.sessions : [])
    ));
  }

  sessionInspect(session, options = {}) {
    return this.request('session.inspect', { session }, options).then(result => (
      result && result.revision ? result.revision : result
    ));
  }

  sessionRead(session, request = {}, options = {}) {
    const { sourceRevision, source_revision, sourceHash, source_hash, cursor, limit } = request || {};
    return this.request('session.read', {
      session,
      sourceRevision: sourceRevision || source_revision || sourceHash || source_hash,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    }, options).then(result => (
      Array.isArray(result) ? result : (result && Array.isArray(result.events) ? result.events : [])
    ));
  }

  async validateSession(session, options = {}) {
    try {
      const revision = await this.sessionInspect(session, options);
      return { valid: true, ...(isPlainObject(revision) ? revision : {}) };
    } catch (error) {
      return { valid: false, errorCode: error.code || 'SESSION_SOURCE_INVALID', detail: redactText(error.message, 1024) };
    }
  }

  async shutdown(options = {}) {
    if (!this.child) return { closed: true, supported: false };
    let response = null;
    if (this.initialized && this.capabilities.shutdown) {
      try {
        response = await this._requestRecord('shutdown', { reason: options.reason || 'client_shutdown' }, {
          allowUnsupported: true,
          timeoutMs: options.timeoutMs || this.limits.shutdownTimeoutMs,
        });
      } catch { /* process termination below remains authoritative */ }
    }
    this.closing = true;
    this._terminateProcess();
    this._rejectPending(externalAdapterError('EXTERNAL_ADAPTER_SHUTDOWN'));
    return { closed: true, supported: !!this.capabilities.shutdown, response: resultValue(response) };
  }

  close() {
    return this.shutdown({ reason: 'client_close' });
  }

  diagnostics() {
    return redactDiagnostic({
      engineId: this.manifest.engineId,
      protocolVersion: this.protocolVersion,
      executable: this.executable,
      cwd: this.projectCwd,
      initialized: this.initialized,
      capabilities: this.capabilities,
      stderr: this.stderr,
      stderrTruncated: this.stderrTruncated,
      stats: this.stats,
    }, this.limits);
  }
}

function createExternalAdapterClient(options) {
  return new ExternalAdapterClient(options);
}

module.exports = {
  DEFAULT_SAFE_ENV_KEYS,
  DEFAULT_EXTERNAL_ADAPTER_LIMITS,
  EXTERNAL_ADAPTER_MANIFEST_SCHEMA,
  EXTERNAL_ADAPTER_OPERATIONS,
  EXTERNAL_ADAPTER_PROTOCOL_NAME,
  EXTERNAL_ADAPTER_PROTOCOL_SCHEMA,
  EXTERNAL_ADAPTER_PROTOCOL_VERSION,
  ExternalAdapterClient,
  assertProtocolRecord,
  buildMinimalEnvironment,
  createExternalAdapterClient,
  createStrictLfFramer,
  encodeProtocolRecord,
  normalizeExternalAdapterManifest,
  parseProtocolLine,
  resolveExternalAdapterExecutable,
  resolveSelectedProjectCwd,
  validateExternalAdapterManifest,
  validateProtocolRecord,
  _internal: {
    asProtocolError,
    deepFreeze,
    externalAdapterError,
    isPathWithin,
    isPlainObject,
    mergeClientLimits,
    normalizeManifestCapabilities,
    resolvePathForComparison,
    schemaErrors,
  },
};
