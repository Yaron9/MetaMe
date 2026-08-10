'use strict';

/**
 * Pi 0.83 Session Source Adapter.
 *
 * Pi owns the JSONL files and their branching semantics.  This module is the
 * only place in MetaMe that understands that format.  Outside this adapter a
 * Pi session is an opaque Session Source and its contents are canonical
 * events, never native records.
 */

const os = require('node:os');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const { deriveProjectInfo } = require('../utils');
const { sanitizePrompt, isInternalPrompt } = require('../hooks/hook-utils');
const { wrapSessionSourceAdapter } = require('./session-source-adapter');
const { normalizeCanonicalSessionEvents } = require('../core/canonical-session-event');
const { fingerprintSourceRevision } = require('../core/session-source-revision');

const ENGINE_ID = 'pi';
const SESSION_VERSION = 3;
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100000;
const DEFAULT_MAX_TEXT = 4000;
const DEFAULT_MAX_TOOL_TEXT = 1600;
const DEFAULT_MAX_TOOL_INPUT = 1200;
const DEFAULT_DISCOVERY_LIMIT = 1000;
const MAX_DISCOVERY_SNAPSHOT_ENTRIES = DEFAULT_DISCOVERY_LIMIT * 100;
const MAX_HEADER_BYTES = 1024 * 1024;
const DISCOVERY_CURSOR_VERSION = 1;

const KNOWN_ENTRY_TYPES = new Set([
  'session', 'model_change', 'thinking_level_change', 'message', 'custom',
  'custom_message', 'compaction', 'branch_summary', 'label', 'session_info',
]);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'toolResult']);

function adapterError(code, detail = '') {
  const normalized = String(code || '').startsWith('PI_')
    ? `session_source_${String(code).slice(3).toLowerCase()}`
    : code;
  const error = new Error(detail ? `${normalized}:${detail}` : normalized);
  error.code = normalized;
  return error;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function normalizeSessionId(value) {
  const id = stringValue(value).trim();
  if (!id || !SESSION_ID_RE.test(id)) throw adapterError('PI_SESSION_SOURCE_SESSION_ID_INVALID', id || 'missing');
  return id;
}

function normalizeRelativePath(value, pathMod) {
  const raw = stringValue(value).trim();
  if (!raw || pathMod.isAbsolute(raw)) throw adapterError('PI_SESSION_SOURCE_LOCATOR_INVALID', 'absolute_path');
  const normalized = pathMod.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${pathMod.sep}`)
    || normalized.startsWith('../') || normalized.startsWith('..\\')) {
    throw adapterError('PI_SESSION_SOURCE_LOCATOR_INVALID', 'path_traversal');
  }
  return normalized;
}

function isPathInside(root, candidate, pathMod) {
  const relative = pathMod.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !pathMod.isAbsolute(relative));
}

function safeCwd(value, pathMod) {
  const cwd = stringValue(value).trim();
  return cwd ? pathMod.resolve(cwd) : null;
}

function projectInfo(cwd, pathMod) {
  const value = stringValue(cwd).trim();
  if (!value) return { project: null, scope: null, cwd: null };
  let info = {};
  try { info = deriveProjectInfo(value) || {}; } catch { info = {}; }
  return {
    project: info.project || pathMod.basename(value) || null,
    scope: info.project_id || null,
    cwd: value,
  };
}

function hashBytes(bytes) {
  return fingerprintSourceRevision({ content: bytes });
}

function parseJsonLine(line) {
  try {
    const value = JSON.parse(line);
    return asObject(value);
  } catch {
    return null;
  }
}

/**
 * Parse complete JSONL records while retaining physical line positions.
 * Pi accepts a final JSON record without a newline; an incomplete final line
 * is deliberately held back so a concurrent writer cannot leak partial data.
 */
function recordsFromText(text) {
  const value = String(text || '').replace(/^\uFEFF/, '');
  const physicalLines = value.split('\n');
  const hasFinalNewline = value.endsWith('\n');
  const records = [];
  let invalidLineCount = 0;
  let partialFinalLine = false;
  let finalLineParsed = false;

  physicalLines.forEach((line, index) => {
    if (hasFinalNewline && index === physicalLines.length - 1) return;
    if (!line.trim()) return;
    const parsed = parseJsonLine(line);
    if (!parsed) {
      if (!hasFinalNewline && index === physicalLines.length - 1) partialFinalLine = true;
      else invalidLineCount += 1;
      return;
    }
    if (!hasFinalNewline && index === physicalLines.length - 1) finalLineParsed = true;
    records.push({ record: parsed, nativeSequence: index });
  });

  const completeBytes = hasFinalNewline || !partialFinalLine
    ? Buffer.byteLength(value, 'utf8')
    : Buffer.byteLength(physicalLines.slice(0, -1).join('\n') + (physicalLines.length > 1 ? '\n' : ''), 'utf8');
  return {
    records,
    invalidLineCount,
    partialFinalLine,
    nextNativeSequence: hasFinalNewline
      ? physicalLines.length - 1
      : (finalLineParsed ? physicalLines.length : Math.max(physicalLines.length - 1, 0)),
    completeByteOffset: completeBytes,
  };
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const date = new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function cleanText(text, maxChars = DEFAULT_MAX_TEXT, { allowInternal = false } = {}) {
  const sanitized = sanitizePrompt(stringValue(text)).replace(/\s+/g, ' ').trim();
  if (!sanitized || (!allowInternal && isInternalPrompt(sanitized))) return null;
  const redacted = sanitized
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/gi, '[REDACTED_SECRET]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|private[_-]?key)\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  return redacted.trim() ? redacted.slice(0, maxChars) : null;
}

function compactJson(value, maxChars) {
  let text;
  try { text = JSON.stringify(value === undefined ? null : value); } catch { text = '[unserializable]'; }
  return cleanText(text, maxChars, { allowInternal: true }) || '';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block && block.type === 'text')
    .map(block => stringValue(block.text)).filter(Boolean).join('\n');
}

function normalizedToolOutcome(message, contentText) {
  const object = asObject(message) || {};
  const output = cleanText(contentText, DEFAULT_MAX_TOOL_TEXT, { allowInternal: true }) || '';
  return {
    error: !!(object.isError || object.is_error || object.error),
    ...(output ? { outputChars: Math.min(output.length, DEFAULT_MAX_TOOL_TEXT) } : {}),
  };
}

function messageTimestamp(message, entry) {
  return normalizeTimestamp(firstDefined(message && message.timestamp, entry && entry.timestamp));
}

function nativeEventId(entry, message, block) {
  return stringValue(firstDefined(
    block && (block.id || block.toolCallId || block.tool_call_id),
    message && message.id,
    entry && entry.id,
  )).trim() || null;
}

function provenanceFor(entry, message, block, nativeSequence, metadata) {
  const eventId = nativeEventId(entry, message, block);
  return {
    ...(eventId ? { nativeEventId: eventId } : {}),
    nativeSequence,
    recordType: stringValue(entry && entry.type).trim(),
    ...(metadata.parentNativeSessionId ? { parentNativeSessionId: metadata.parentNativeSessionId } : {}),
    ...(message && message.provider ? { provider: stringValue(message.provider).slice(0, 100) } : {}),
    ...(message && message.model ? { model: stringValue(message.model).slice(0, 120) } : {}),
  };
}

function appendEvent(output, actor, kind, text, entry, nativeSequence, metadata, extra = {}, options = {}) {
  const maxChars = kind === 'message' ? options.maxText : options.maxToolText;
  const cleaned = cleanText(text, maxChars || DEFAULT_MAX_TEXT, options);
  if (!cleaned) return;
  output.push({
    actor,
    kind,
    timestamp: messageTimestamp(options.message, entry),
    text: cleaned,
    ...extra,
    provenance: provenanceFor(entry, options.message, options.block, nativeSequence, metadata),
  });
}

function projectMessageEntry(entry, nativeSequence, metadata, output, options) {
  const message = asObject(entry.message);
  if (!message || !MESSAGE_ROLES.has(message.role)) return;
  const content = message.content;
  if (message.role === 'toolResult') {
    const text = textFromContent(content);
    appendEvent(output, 'tool', 'tool_result', text, entry, nativeSequence, metadata, {
      tool: stringValue(message.toolName).trim() || null,
      outcome: normalizedToolOutcome(message, text),
    }, { ...options, allowInternal: true, message });
    return;
  }

  if (typeof content === 'string') {
    appendEvent(output, message.role, 'message', content, entry, nativeSequence, metadata, {}, { ...options, message });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!asObject(block)) continue;
    if (block.type === 'text') {
      appendEvent(output, message.role, 'message', block.text, entry, nativeSequence, metadata, {}, { ...options, message, block });
    } else if (block.type === 'toolCall') {
      const input = compactJson(block.arguments === undefined ? {} : block.arguments, options.maxToolInput);
      if (!input) continue;
      appendEvent(output, 'tool', 'tool_call', input, entry, nativeSequence, metadata, {
        tool: stringValue(block.name || 'Tool').trim().slice(0, 120) || 'Tool',
      }, { ...options, allowInternal: true, message, block });
    }
  }
}

function projectActiveEntries(entries, metadata, options = {}) {
  const output = [];
  for (const item of entries) {
    const entry = item.record;
    const nativeSequence = item.nativeSequence;
    if (entry.type === 'message') {
      projectMessageEntry(entry, nativeSequence, metadata, output, options);
    } else if (entry.type === 'compaction') {
      appendEvent(output, 'system', 'checkpoint', entry.summary, entry, nativeSequence, metadata, {
        outcome: { checkpoint: 'compaction', tokensBefore: Number.isSafeInteger(Number(entry.tokensBefore)) ? Number(entry.tokensBefore) : null },
      }, { ...options, allowInternal: true });
    } else if (entry.type === 'branch_summary') {
      appendEvent(output, 'system', 'checkpoint', entry.summary, entry, nativeSequence, metadata, {
        outcome: { checkpoint: 'branch_summary', fromId: stringValue(entry.fromId).trim() || null },
      }, { ...options, allowInternal: true });
    } else if (entry.type === 'custom_message') {
      appendEvent(output, 'user', 'message', textFromContent(entry.content), entry, nativeSequence, metadata, {}, {
        ...options, allowInternal: true,
      });
    }
  }
  return output;
}

function validEntry(item) {
  const entry = item && item.record;
  if (!entry || !KNOWN_ENTRY_TYPES.has(entry.type) || entry.type === 'session') return false;
  const id = stringValue(entry.id).trim();
  return !!id && !id.includes('/') && !id.includes('\\');
}

function activePath(items) {
  const entries = items.filter(validEntry);
  if (!entries.length) return [];
  const byId = new Map(entries.map(item => [item.record.id, item]));
  let current = entries[entries.length - 1];
  const path = [];
  const seen = new Set();
  while (current && !seen.has(current.record.id)) {
    seen.add(current.record.id);
    path.push(current);
    const parentId = stringValue(current.record.parentId).trim();
    current = parentId ? byId.get(parentId) : null;
  }
  path.reverse();
  return path;
}

function buildContextEntries(items) {
  const path = activePath(items);
  let compaction = null;
  for (const item of path) if (item.record.type === 'compaction') compaction = item;
  if (!compaction) return path;
  const compactionIndex = path.findIndex(item => item.record.id === compaction.record.id);
  const context = [compaction];
  let found = false;
  const firstKept = stringValue(compaction.record.firstKeptEntryId).trim();
  for (let index = 0; index < compactionIndex; index += 1) {
    if (path[index].record.id === firstKept) found = true;
    if (found) context.push(path[index]);
  }
  context.push(...path.slice(compactionIndex + 1));
  return context;
}

function headerFromRecords(parsed) {
  const headerItem = parsed.records[0];
  if (!headerItem || headerItem.record.type !== 'session') throw adapterError('PI_SESSION_SOURCE_HEADER_MISSING');
  const header = headerItem.record;
  normalizeSessionId(header.id);
  if (header.version !== undefined && Number(header.version) !== SESSION_VERSION) {
    throw adapterError('PI_SESSION_SOURCE_VERSION_UNSUPPORTED', String(header.version));
  }
  return header;
}

function parentSessionId(header, pathMod) {
  const parent = stringValue(header.parentSession).trim();
  if (!parent) return null;
  const base = pathMod.basename(parent).replace(/\.jsonl$/i, '');
  return SESSION_ID_RE.test(base) ? base : null;
}

function metadataFromParsed(parsed, filePath, pathMod) {
  const header = headerFromRecords(parsed);
  const info = projectInfo(header.cwd, pathMod);
  const parentNativeSessionId = parentSessionId(header, pathMod);
  const active = buildContextEntries(parsed.records);
  const metadata = {
    nativeSessionId: header.id,
    cwd: info.cwd,
    project: info.project,
    scope: info.scope,
    parentNativeSessionId,
    classification: parentNativeSessionId ? 'subagent' : 'conversation',
    firstTs: normalizeTimestamp(header.timestamp),
    lastTs: normalizeTimestamp(header.timestamp),
    version: Number(header.version || SESSION_VERSION),
  };
  for (const item of active) {
    const timestamp = normalizeTimestamp(item.record.timestamp);
    if (timestamp && (!metadata.firstTs || timestamp < metadata.firstTs)) metadata.firstTs = timestamp;
    if (timestamp && (!metadata.lastTs || timestamp > metadata.lastTs)) metadata.lastTs = timestamp;
  }
  const candidates = projectActiveEntries(active, metadata, {
    maxText: DEFAULT_MAX_TEXT,
    maxToolText: DEFAULT_MAX_TOOL_TEXT,
    maxToolInput: DEFAULT_MAX_TOOL_INPUT,
  });
  const toolCalls = candidates.filter(event => event.kind === 'tool_call').length;
  return {
    ...metadata,
    sourceLocator: null,
    sourceHash: null,
    sourceRevision: null,
    sourceSize: 0,
    cursor: { sequence: parsed.nextNativeSequence, byteOffset: parsed.completeByteOffset },
    eventCount: candidates.length,
    messageCount: candidates.filter(event => event.actor === 'user' && event.kind === 'message').length,
    toolCallCount: toolCalls,
    toolErrorCount: candidates.filter(event => event.kind === 'tool_result' && event.outcome && event.outcome.error).length,
    invalidLineCount: parsed.invalidLineCount,
    partialFinalLine: parsed.partialFinalLine,
    unknownRecordCount: parsed.records.filter(item => !KNOWN_ENTRY_TYPES.has(item.record.type)).length,
    knownRecordCount: parsed.records.filter(item => KNOWN_ENTRY_TYPES.has(item.record.type)).length,
    activeEntryCount: active.length,
    activeContextEntryCount: active.length,
    filePath,
  };
}

function readFileBounded(filePath, fsMod, maxFileSize, pathMod, rootPath = null) {
  let stat;
  try {
    stat = fsMod.lstatSync(filePath);
  } catch (error) {
    throw adapterError('PI_SESSION_SOURCE_MISSING', error.code || filePath);
  }
  if (stat.isSymbolicLink && stat.isSymbolicLink()) throw adapterError('PI_SESSION_SOURCE_INVALID', 'symlink_not_allowed');
  if (!stat.isFile()) throw adapterError('PI_SESSION_SOURCE_INVALID', 'not_a_file');
  if (rootPath) {
    let current = rootPath;
    const relative = pathMod.relative(rootPath, filePath);
    for (const segment of relative.split(pathMod.sep).filter(Boolean)) {
      current = pathMod.join(current, segment);
      let component;
      try { component = fsMod.lstatSync(current); } catch (error) { throw adapterError('PI_SESSION_SOURCE_MISSING', error.code || current); }
      if (component.isSymbolicLink && component.isSymbolicLink()) {
        throw adapterError('PI_SESSION_SOURCE_INVALID', 'symlink_not_allowed');
      }
    }
  }
  if (stat.size > maxFileSize) throw adapterError('PI_SESSION_SOURCE_TOO_LARGE', String(stat.size));
  let bytes;
  try { bytes = fsMod.readFileSync(filePath); } catch (error) {
    throw adapterError('PI_SESSION_SOURCE_READ_FAILED', error.code || filePath);
  }
  return { stat, bytes, text: bytes.toString('utf8') };
}

function readHeaderBounded(filePath, fsMod, pathMod, rootPath) {
  try {
    const source = readFileBounded(filePath, fsMod, MAX_HEADER_BYTES, pathMod, rootPath);
    const lines = source.text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const header = parseJsonLine(line);
      return header && header.type === 'session' && typeof header.id === 'string' ? header : null;
    }
  } catch {
    return null;
  }
  return null;
}

function walkJsonl(root, fsMod, pathMod, output = []) {
  let entries;
  try { entries = fsMod.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = pathMod.join(root, entry.name);
    if (entry.isDirectory()) walkJsonl(fullPath, fsMod, pathMod, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(fullPath);
  }
  return output;
}

function sortFiles(files, fsMod) {
  return [...files].sort((left, right) => {
    let lm = 0; let rm = 0;
    try { lm = fsMod.statSync(left).mtimeMs; } catch { /* race */ }
    try { rm = fsMod.statSync(right).mtimeMs; } catch { /* race */ }
    return rm - lm || left.localeCompare(right);
  });
}

function discoveryQuery(request = {}) {
  return {
    project: stringValue(request.project || request.projectKey).trim(),
    cwd: stringValue(request.cwd).trim(),
    includeSubagents: request.includeSubagents !== false,
    suppressOwnedSubagents: request.suppressOwnedSubagents === true,
  };
}

function discoveryLimit(request = {}) {
  return Math.min(Math.max(Number(request.limit) || DEFAULT_DISCOVERY_LIMIT, 1), DEFAULT_DISCOVERY_LIMIT);
}

function normalizeSnapshotEntry(value, pathMod) {
  const object = asObject(value);
  const root = stringValue(object && object.root).trim();
  if (!root || !/^[a-z][a-z0-9_-]*$/i.test(root)) throw adapterError('PI_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_root');
  return { root, relativePath: normalizeRelativePath(object && object.relativePath, pathMod) };
}

function parseDiscoveryCursor(value, pathMod) {
  if (value === null || value === undefined) return null;
  let cursor = value;
  if (typeof cursor === 'string') {
    try { cursor = JSON.parse(cursor); } catch { throw adapterError('PI_SESSION_SOURCE_CURSOR_INVALID', 'json'); }
  }
  const object = asObject(cursor);
  const offset = object && Number(object.offset);
  const accepted = object && Number(object.accepted === undefined ? offset : object.accepted);
  if (!object || Number(object.version) !== DISCOVERY_CURSOR_VERSION
    || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(object.snapshot) || object.snapshot.length > MAX_DISCOVERY_SNAPSHOT_ENTRIES
    || !Number.isSafeInteger(accepted) || accepted < 0 || accepted > DEFAULT_DISCOVERY_LIMIT
    || !asObject(object.query)) {
    throw adapterError('PI_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_required');
  }
  if (offset > object.snapshot.length) throw adapterError('PI_SESSION_SOURCE_CURSOR_INVALID', 'offset');
  const snapshot = object.snapshot.map(item => normalizeSnapshotEntry(item, pathMod));
  return {
    version: DISCOVERY_CURSOR_VERSION,
    offset,
    accepted,
    snapshot,
    query: discoveryQuery(object.query),
  };
}

function sameDiscoveryQuery(left, right) {
  return left.project === right.project && left.cwd === right.cwd
    && left.includeSubagents === right.includeSubagents
    && left.suppressOwnedSubagents === right.suppressOwnedSubagents;
}

function makeDiscoveryCursor(snapshot, offset, accepted, query) {
  return { version: DISCOVERY_CURSOR_VERSION, offset, accepted, snapshot, query };
}

function createPiSessionSourceAdapter(options = {}) {
  const fsMod = options.fs || fsDefault;
  const pathMod = options.path || pathDefault;
  const home = options.home || options.HOME || os.homedir();
  const agentDir = pathMod.resolve(options.agentDir || options.piAgentDir || pathMod.join(home, '.pi', 'agent'));
  const defaultRoot = pathMod.resolve(options.defaultSessionsRoot || pathMod.join(agentDir, 'sessions'));
  const configuredValue = firstDefined(
    options.sessionDir,
    options.session_dir,
    options.daemonCfg && options.daemonCfg.pi && (options.daemonCfg.pi.sessionDir || options.daemonCfg.pi.session_dir),
    process.env.PI_CODING_AGENT_SESSION_DIR,
  );
  const roots = [{ key: 'default', path: defaultRoot, kind: 'default' }];
  if (configuredValue && pathMod.resolve(String(configuredValue)) !== defaultRoot) {
    roots.push({ key: 'configured', path: pathMod.resolve(String(configuredValue)), kind: 'configured' });
  }
  const rootByKey = new Map(roots.map(root => [root.key, root]));
  const maxFileSize = Number(options.maxFileSize || DEFAULT_MAX_FILE_SIZE);
  const maxEvents = Math.min(Math.max(Number(options.maxEvents) || DEFAULT_MAX_EVENTS, 1), DEFAULT_MAX_EVENTS);
  const adapterOptions = {
    maxText: Number(options.maxText || DEFAULT_MAX_TEXT),
    maxToolText: Number(options.maxToolText || DEFAULT_MAX_TOOL_TEXT),
    maxToolInput: Number(options.maxToolInput || DEFAULT_MAX_TOOL_INPUT),
  };

  function rootForRef(ref) {
    const locator = asObject(ref && ref.sourceLocator);
    if (!locator) throw adapterError('PI_SESSION_SOURCE_LOCATOR_REQUIRED');
    const root = rootByKey.get(stringValue(locator.root).trim());
    if (!root) throw adapterError('PI_SESSION_SOURCE_LOCATOR_INVALID', 'root');
    const relativePath = normalizeRelativePath(locator.relativePath, pathMod);
    const candidate = pathMod.resolve(root.path, relativePath);
    if (!isPathInside(root.path, candidate, pathMod)) throw adapterError('PI_SESSION_SOURCE_LOCATOR_OUTSIDE_ROOT');
    return { root, relativePath, filePath: candidate };
  }

  function inspectFile(filePath, rootPath = null) {
    const source = readFileBounded(filePath, fsMod, maxFileSize, pathMod, rootPath);
    const parsed = recordsFromText(source.text);
    const metadata = metadataFromParsed(parsed, filePath, pathMod);
    const sourceRevision = hashBytes(source.bytes);
    const activeEvents = normalizeCanonicalSessionEvents(projectActiveEntries(
      buildContextEntries(parsed.records), metadata, adapterOptions,
    ), {
      engineId: ENGINE_ID,
      nativeSessionId: metadata.nativeSessionId,
      sourceRevision,
    });
    return {
      ...metadata,
      sourceHash: sourceRevision,
      sourceRevision,
      sourceSize: source.stat.size,
      sourceLocator: null,
      eventCount: activeEvents.length,
      messageCount: activeEvents.filter(event => event.actor === 'user' && event.kind === 'message').length,
      toolCallCount: activeEvents.filter(event => event.kind === 'tool_call').length,
      toolErrorCount: activeEvents.filter(event => event.kind === 'tool_result' && event.outcome && event.outcome.error).length,
      eventLimitExceeded: activeEvents.length > maxEvents,
      lastModified: source.stat.mtime.toISOString(),
    };
  }

  function refForFile(root, relativePath, info, discoveryCursor = null) {
    const ref = {
      engineId: ENGINE_ID,
      nativeSessionId: info.nativeSessionId,
      sourceLocator: { root: root.key, relativePath },
      project: info.project || null,
      scope: info.scope || null,
      cwd: info.cwd || null,
      parentNativeSessionId: info.parentNativeSessionId || null,
      sourceRevision: info.sourceRevision,
    };
    if (discoveryCursor) ref.discoveryCursor = discoveryCursor;
    return ref;
  }

  function snapshotFiles(query) {
    const files = [];
    for (const root of roots) {
      const candidates = sortFiles(walkJsonl(root.path, fsMod, pathMod), fsMod);
      for (const filePath of candidates) {
        const relativePath = normalizeRelativePath(pathMod.relative(root.path, filePath), pathMod);
        const header = readHeaderBounded(filePath, fsMod, pathMod, root.path);
        if (!header) continue;
        const info = projectInfo(header.cwd, pathMod);
        const parent = parentSessionId(header, pathMod);
        if (query.project && info.project !== query.project) continue;
        if (query.cwd && safeCwd(header.cwd, pathMod) !== safeCwd(query.cwd, pathMod)) continue;
        if (!query.includeSubagents && parent) continue;
        files.push({ root: root.key, filePath, relativePath, header, project: info.project, parentNativeSessionId: parent });
      }
    }
    // Roots are ordered intentionally (configured source after default), then
    // the same newest-first ordering is applied across both roots.
    files.sort((left, right) => {
      let lm = 0; let rm = 0;
      try { lm = fsMod.statSync(left.filePath).mtimeMs; } catch { /* race */ }
      try { rm = fsMod.statSync(right.filePath).mtimeMs; } catch { /* race */ }
      return rm - lm || left.root.localeCompare(right.root) || left.relativePath.localeCompare(right.relativePath);
    });
    const bounded = files.slice(0, MAX_DISCOVERY_SNAPSHOT_ENTRIES);
    if (query.suppressOwnedSubagents) {
      const ids = new Set(bounded.map(item => item.header.id));
      return bounded.filter(item => !item.parentNativeSessionId || !ids.has(item.parentNativeSessionId));
    }
    return bounded;
  }

  function prepareDiscovery(request = {}) {
    const query = discoveryQuery(request);
    const cursor = parseDiscoveryCursor(request.cursor, pathMod);
    if (cursor) {
      if (!sameDiscoveryQuery(cursor.query, query)) throw adapterError('PI_SESSION_SOURCE_CURSOR_INVALID', 'query_mismatch');
      return { query, cursor, snapshot: cursor.snapshot };
    }
    return {
      query,
      cursor: null,
      snapshot: snapshotFiles(query).map(item => ({ root: item.root, relativePath: item.relativePath })),
    };
  }

  function refsForRequest(request = {}) {
    const state = prepareDiscovery(request);
    const limit = discoveryLimit(request);
    const start = state.cursor ? state.cursor.offset : 0;
    const acceptedStart = state.cursor ? state.cursor.accepted : 0;
    const page = [];
    for (let index = start; index < state.snapshot.length && page.length < limit
      && acceptedStart + page.length < DEFAULT_DISCOVERY_LIMIT; index += 1) {
      const item = state.snapshot[index];
      const root = rootByKey.get(item.root);
      if (!root) continue;
      let info;
      try { info = inspectFile(pathMod.resolve(root.path, normalizeRelativePath(item.relativePath, pathMod)), root.path); } catch { continue; }
      if (state.query.suppressOwnedSubagents) {
        // This query is already filtered while making a fresh snapshot.  A
        // cursor snapshot is immutable and therefore needs no second scan.
      }
      page.push({ index, root, info, relativePath: normalizeRelativePath(item.relativePath, pathMod) });
    }
    const acceptedEnd = acceptedStart + page.length;
    const lastIndex = page.length ? page[page.length - 1].index : start;
    const hasMore = acceptedEnd < DEFAULT_DISCOVERY_LIMIT && lastIndex + 1 < state.snapshot.length;
    return page.map((item, pageIndex) => refForFile(
      item.root,
      item.relativePath,
      item.info,
      hasMore && pageIndex === page.length - 1
        ? makeDiscoveryCursor(state.snapshot, item.index + 1, acceptedEnd, state.query)
        : null,
    ));
  }

  function listSessionRefs(request = {}) {
    return refsForRequest(request);
  }

  function inspectRef(ref) {
    const resolved = rootForRef(ref);
    const revision = inspectFile(resolved.filePath, resolved.root.path);
    const expected = stringValue(ref.nativeSessionId).trim();
    if (expected && revision.nativeSessionId !== expected) {
      throw adapterError('PI_SESSION_SOURCE_SESSION_ID_MISMATCH', `${expected}:${revision.nativeSessionId}`);
    }
    return { ...revision, sourceLocator: { root: resolved.root.key, relativePath: resolved.relativePath } };
  }

  function readPathEvents(filePath, sourceRef = null) {
    const resolvedPath = pathMod.resolve(String(filePath || ''));
    const root = roots.find(candidate => isPathInside(candidate.path, resolvedPath, pathMod));
    if (!root) throw adapterError('PI_SESSION_SOURCE_LOCATOR_OUTSIDE_ROOT');
    const info = inspectFile(resolvedPath, root.path);
    const source = readFileBounded(resolvedPath, fsMod, maxFileSize, pathMod, root.path);
    const parsed = recordsFromText(source.text);
    const ref = sourceRef && sourceRef.sourceLocator
      ? sourceRef
      : refForFile(root, normalizeRelativePath(pathMod.relative(root.path, resolvedPath), pathMod), info);
    const events = normalizeCanonicalSessionEvents(projectActiveEntries(
      buildContextEntries(parsed.records), info, adapterOptions,
    ), { engineId: ENGINE_ID, nativeSessionId: info.nativeSessionId, sourceRevision: info.sourceRevision });
    if (events.length > maxEvents) throw adapterError('PI_SESSION_SOURCE_EVENT_LIMIT');
    return { ref, revision: { ...info, sourceLocator: ref.sourceLocator }, events };
  }

  const rawAdapter = {
    engineId: ENGINE_ID,
    protocolVersion: 1,
    probe() {
      const sourceCount = roots.reduce((count, root) => count + walkJsonl(root.path, fsMod, pathMod).length, 0);
      return {
        state: sourceCount > 0 ? 'verified' : 'reachable',
        available: true,
        reachable: true,
        verified: sourceCount > 0,
        sourceCount,
      };
    },
    discover: function* discover(request = {}) {
      for (const ref of refsForRequest(request)) yield ref;
    },
    inspect(ref) {
      return inspectRef(ref);
    },
    read: function* read(ref, request = {}) {
      const resolved = rootForRef(ref);
      const source = readFileBounded(resolved.filePath, fsMod, maxFileSize, pathMod, resolved.root.path);
      const parsed = recordsFromText(source.text);
      const metadata = metadataFromParsed(parsed, resolved.filePath, pathMod);
      const sourceRevision = hashBytes(source.bytes);
      const requested = stringValue(request.sourceRevision || request.sourceHash).trim();
      if (requested && requested !== sourceRevision) {
        throw adapterError('PI_SESSION_SOURCE_REVISION_MISMATCH', `${requested}:${sourceRevision}`);
      }
      if (metadata.partialFinalLine && request.requireComplete === true) {
        throw adapterError('PI_SESSION_SOURCE_PARTIAL_FINAL_LINE');
      }
      const cursorValue = request.cursor && typeof request.cursor === 'object'
        ? firstDefined(request.cursor.sequence, request.cursor.offset, request.cursor.position, request.cursor.index)
        : request.cursor;
      const cursor = Number.isSafeInteger(Number(cursorValue)) && Number(cursorValue) >= 0 ? Number(cursorValue) : null;
      const candidates = projectActiveEntries(buildContextEntries(parsed.records), metadata, adapterOptions);
      let emitted = 0;
      for (const event of candidates) {
        const nativeSequence = event.provenance && Number(event.provenance.nativeSequence);
        if (cursor !== null && Number.isSafeInteger(nativeSequence) && nativeSequence < cursor) continue;
        if (emitted >= maxEvents) throw adapterError('PI_SESSION_SOURCE_EVENT_LIMIT');
        yield event;
        emitted += 1;
      }
    },
    validate(ref) {
      try {
        const revision = inspectRef(ref);
        if (revision.invalidLineCount > 0 && revision.eventCount === 0) {
          return { valid: false, errorCode: 'SOURCE_MALFORMED', detail: 'no valid Pi records' };
        }
        if (revision.partialFinalLine) {
          return { valid: true, state: 'partial', errorCode: 'SOURCE_PARTIAL_FINAL_LINE', detail: 'final incomplete line held back' };
        }
        if (revision.eventLimitExceeded) {
          return { valid: false, errorCode: 'PI_EVENT_LIMIT', detail: 'active context event cap exceeded' };
        }
        return { valid: true, state: 'valid' };
      } catch (error) {
        return { valid: false, errorCode: error.code || 'SOURCE_INVALID', detail: error.message };
      }
    },
  };

  const source = wrapSessionSourceAdapter(rawAdapter, { engineId: ENGINE_ID });
  return Object.freeze({
    ...source,
    listSessionRefs,
    inspectPath(filePath) {
      const resolved = pathMod.resolve(String(filePath || ''));
      const root = roots.find(candidate => isPathInside(candidate.path, resolved, pathMod));
      if (!root) throw adapterError('PI_SESSION_SOURCE_LOCATOR_OUTSIDE_ROOT');
      return inspectFile(resolved, root.path);
    },
    resolveSessionRefPath(ref) { return rootForRef(ref).filePath; },
    readPathEvents,
    isTrivialSession(skeleton) {
      return !!skeleton && skeleton.message_count < 2 && skeleton.duration_min < 1;
    },
  });
}

function readPiSessionEvents(source, ref, revision, options = {}) {
  const events = [];
  const request = { ...(options || {}), sourceRevision: revision && (revision.sourceRevision || revision.sourceHash) };
  return (async () => {
    for await (const event of source.read(ref, request)) events.push(event);
    return events;
  })();
}

function createPiSessionSourceForFile(filePath, options = {}) {
  const resolved = pathDefault.resolve(String(filePath || ''));
  const source = createPiSessionSourceAdapter({
    ...options,
    sessionDir: options.sessionDir || pathDefault.dirname(resolved),
  });
  const relativePath = pathDefault.basename(resolved);
  const ref = {
    engineId: ENGINE_ID,
    nativeSessionId: pathDefault.basename(resolved, '.jsonl'),
    sourceLocator: { root: 'configured', relativePath },
  };
  return Object.freeze({
    ...source,
    filePath: resolved,
    ref,
    readEvents() { return source.readPathEvents(resolved, ref); },
  });
}

module.exports = {
  ENGINE_ID,
  SESSION_VERSION,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_EVENTS,
  createPiSessionSourceAdapter,
  createPiSessionSource: createPiSessionSourceAdapter,
  createPiSessionSourceForFile,
  readPiSessionEvents,
  cleanText,
  projectActiveEntries,
  _internal: {
    recordsFromText,
    metadataFromParsed,
    buildContextEntries,
    activePath,
    walkJsonl,
    sortFiles,
    normalizeSessionId,
  },
};
