'use strict';

/**
 * Claude Code Session Source Adapter.
 *
 * This module is the only place that knows Claude's native project layout and
 * JSONL record shapes.  Consumers receive opaque Session Sources and
 * canonical events; they must not inspect `sourceLocator` or native records.
 */

const os = require('node:os');
const fsDefault = require('node:fs');
const pathDefault = require('node:path');
const { deriveProjectInfo } = require('../utils');
const { sanitizePrompt, isInternalPrompt } = require('../hooks/hook-utils');
const { wrapSessionSourceAdapter } = require('./session-source-adapter');
const { normalizeCanonicalSessionEvents } = require('../core/canonical-session-event');
const {
  fingerprintSourceRevision,
} = require('../core/session-source-revision');

const ENGINE_ID = 'claude';
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 100000;
const DEFAULT_MAX_TEXT = 4000;
const DEFAULT_MAX_TOOL_TEXT = 1600;
const DEFAULT_MAX_TOOL_INPUT = 1200;
const DEFAULT_DISCOVERY_LIMIT = 1000;
const MAX_DISCOVERY_SNAPSHOT_PATHS = DEFAULT_DISCOVERY_LIMIT * 100;

function adapterError(code, detail = '') {
  const normalizedCode = String(code || '').startsWith('CLAUDE_')
    ? `session_source_${String(code).slice('CLAUDE_'.length).toLowerCase()}`
    : code;
  const error = new Error(detail ? `${normalizedCode}:${detail}` : normalizedCode);
  error.code = normalizedCode;
  return error;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function cursorPosition(cursor) {
  if (cursor === null || cursor === undefined) return null;
  if (Number.isSafeInteger(Number(cursor)) && Number(cursor) >= 0) return Number(cursor);
  const value = asObject(cursor);
  if (!value) return null;
  for (const key of ['sequence', 'seq', 'offset', 'position', 'index']) {
    if (Number.isSafeInteger(Number(value[key])) && Number(value[key]) >= 0) return Number(value[key]);
  }
  return null;
}

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function normalizeRelativePath(value, pathMod) {
  return pathMod.normalize(stringValue(value)).replace(/^\.\.(?:[\\/]|$)/, '').replace(/^[/\\]+/, '');
}

function isPathInside(root, candidate, pathMod) {
  const relative = pathMod.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !pathMod.isAbsolute(relative));
}

function stableLocatorPath(locator) {
  if (typeof locator === 'string') return locator;
  const value = asObject(locator);
  return value && firstDefined(
    value.filePath,
    value.file_path,
    value.path,
    value.absolutePath,
    value.absolute_path,
    value.relativePath,
    value.relative_path,
  );
}

function hashBytes(bytes) {
  return fingerprintSourceRevision({ content: bytes });
}

function parseLine(line) {
  try {
    const value = JSON.parse(line);
    return asObject(value);
  } catch {
    return null;
  }
}

function readFileBounded(filePath, fsMod, maxFileSize) {
  let stat;
  try {
    stat = typeof fsMod.lstatSync === 'function' ? fsMod.lstatSync(filePath) : fsMod.statSync(filePath);
  } catch (error) {
    throw adapterError('CLAUDE_SESSION_SOURCE_MISSING', error.code || filePath);
  }
  if (stat.isSymbolicLink && stat.isSymbolicLink()) {
    throw adapterError('CLAUDE_SESSION_SOURCE_INVALID', 'symlink_not_allowed');
  }
  if (!stat.isFile()) throw adapterError('CLAUDE_SESSION_SOURCE_INVALID', 'not_a_file');
  if (stat.size > maxFileSize) throw adapterError('CLAUDE_SESSION_SOURCE_TOO_LARGE', String(stat.size));
  let bytes;
  try {
    bytes = fsMod.readFileSync(filePath);
  } catch (error) {
    throw adapterError('CLAUDE_SESSION_SOURCE_READ_FAILED', error.code || filePath);
  }
  return { stat, bytes, text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
}

function recordsFromText(text) {
  const records = [];
  let invalidLines = 0;
  const value = String(text || '');
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const record = parseLine(line);
    if (!record) {
      invalidLines++;
      return;
    }
    records.push({ record, nativeSequence: index });
  });
  const nextNativeSequence = value
    ? lines.length - (value.endsWith('\n') ? 1 : 0)
    : 0;
  return { records, invalidLines, nextNativeSequence };
}

function extractSessionId(record) {
  const message = asObject(record && record.message);
  return stringValue(firstDefined(
    record && record.sessionId,
    record && record.session_id,
    record && record.session,
    message && message.sessionId,
    message && message.session_id,
  )).trim();
}

function extractCwd(record) {
  const message = asObject(record && record.message);
  return stringValue(firstDefined(record && record.cwd, record && record.workingDirectory, message && message.cwd)).trim();
}

function nestedParentSessionId(value) {
  const object = asObject(value);
  if (!object) return '';
  const source = asObject(object.source);
  const subagent = asObject(source && source.subagent) || asObject(object.subagent);
  return stringValue(firstDefined(
    object.parentSessionId,
    object.parent_session_id,
    object.parentThreadId,
    object.parent_thread_id,
    source && source.parentSessionId,
    source && source.parent_session_id,
    source && source.parentThreadId,
    source && source.parent_thread_id,
    subagent && subagent.parentSessionId,
    subagent && subagent.parent_session_id,
    subagent && subagent.parentThreadId,
    subagent && subagent.parent_thread_id,
  )).trim();
}

function isSidechainRecord(record) {
  const source = asObject(record && record.source);
  return record && (record.isSidechain === true || record.is_sidechain === true || !!source?.subagent);
}

function metadataFromRecords(records, locatorPath, pathMod) {
  let nativeSessionId = '';
  let cwd = '';
  let parentNativeSessionId = '';
  let sidechain = false;
  let firstTs = null;
  let lastTs = null;
  let gitBranch = null;

  for (const item of records.slice(0, 256)) {
    const record = item.record;
    nativeSessionId = nativeSessionId || extractSessionId(record);
    cwd = cwd || extractCwd(record);
    parentNativeSessionId = parentNativeSessionId || nestedParentSessionId(record);
    sidechain = sidechain || isSidechainRecord(record);
    gitBranch = gitBranch || stringValue(record.gitBranch || record.git_branch).trim() || null;
    const timestamp = firstDefined(record.timestamp, record.ts, record.createdAt, record.created_at);
    if (timestamp) {
      const parsed = Date.parse(String(timestamp));
      if (Number.isFinite(parsed)) {
        const iso = new Date(parsed).toISOString();
        if (!firstTs || iso < firstTs) firstTs = iso;
        if (!lastTs || iso > lastTs) lastTs = iso;
      }
    }
  }

  const relative = pathMod.relative(pathMod.dirname(pathMod.dirname(locatorPath)), locatorPath);
  const pathParts = locatorPath.split(pathMod.sep);
  const subagentsIndex = pathParts.lastIndexOf('subagents');
  if (!parentNativeSessionId && subagentsIndex > 0) {
    parentNativeSessionId = pathParts[subagentsIndex - 1] || '';
    sidechain = true;
  }

  const projectInfo = deriveProjectInfo(cwd);
  return {
    nativeSessionId,
    cwd: cwd || null,
    project: projectInfo.project || (relative ? relative.split(pathMod.sep)[0] : null),
    scope: projectInfo.project_id || null,
    parentNativeSessionId: parentNativeSessionId || null,
    classification: sidechain ? 'subagent' : 'conversation',
    firstTs,
    lastTs,
    gitBranch,
  };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && item.type === 'text' ? stringValue(item.text) : '').filter(Boolean).join('\n');
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => {
    if (typeof item === 'string') return item;
    return item && (item.type === 'text' || typeof item.text === 'string') ? stringValue(item.text) : '';
  }).filter(Boolean).join('\n');
}

function redactSecrets(text) {
  let value = String(text || '');
  value = value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED_SECRET]');
  value = value.replace(/\b(?:sk-ant-[a-z0-9_-]+|sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/gi, '[REDACTED_SECRET]');
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]');
  value = value.replace(/(\b(?:[A-Z0-9]+_)*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|TOKEN)(?:_[A-Z0-9]+)*\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  value = value.replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  return value;
}

function isRecursiveOrInternal(text) {
  const value = String(text || '');
  return !value.trim()
    || isInternalPrompt(value)
    || /<!--\s*(?:FACTS|MEMORY):START\s*-->/i.test(value)
    || /\[上次对话摘要|\b(?:previous|prior|generated)\s+session\s+summary\b/i.test(value)
    || /<task-notification\b/i.test(value);
}

function cleanText(text, maxChars = DEFAULT_MAX_TEXT) {
  const sanitized = sanitizePrompt(String(text || '')).replace(/\s+/g, ' ').trim();
  if (isRecursiveOrInternal(sanitized)) return null;
  const redacted = redactSecrets(sanitized);
  if (!redacted.trim()) return null;
  return redacted.slice(0, maxChars);
}

function compactJson(value, maxChars) {
  let text = '';
  try { text = JSON.stringify(value === undefined ? null : value); } catch { text = '[unserializable]'; }
  return cleanText(text, maxChars) || '';
}

function eventProvenance(record, nativeSequence, metadata) {
  const message = asObject(record && record.message);
  const nativeEventId = firstDefined(record && record.uuid, record && record.id, message && message.id);
  const model = stringValue(message && message.model).trim();
  return {
    ...(nativeEventId ? { nativeEventId: String(nativeEventId) } : {}),
    ...(model ? { model: model.slice(0, 120) } : {}),
    nativeSequence,
    ...(metadata.parentNativeSessionId ? { parentNativeSessionId: metadata.parentNativeSessionId } : {}),
  };
}

function eventTimestamp(record) {
  return firstDefined(record && record.timestamp, record && record.ts, record && record.createdAt, record && record.created_at) || null;
}

function normalizedToolOutcome(value) {
  const object = asObject(value);
  if (!object) return null;
  const text = toolResultText(object.content);
  const code = firstDefined(object.exitCode, object.exit_code, object.code);
  return {
    error: !!(object.is_error || object.isError || object.error),
    ...(code !== undefined && code !== null ? { exitCode: Number(code) } : {}),
    ...(text ? { outputChars: Math.min(text.length, DEFAULT_MAX_TOOL_TEXT) } : {}),
  };
}

function projectCanonicalRecords(records, metadata, options = {}) {
  const maxText = Number(options.maxText || DEFAULT_MAX_TEXT);
  const maxToolText = Number(options.maxToolText || DEFAULT_MAX_TOOL_TEXT);
  const maxToolInput = Number(options.maxToolInput || DEFAULT_MAX_TOOL_INPUT);
  const output = [];

  const appendMessage = (actor, kind, text, record, nativeSequence, extra = {}) => {
    const cleaned = cleanText(text, kind === 'message' ? maxText : maxToolText);
    if (!cleaned) return;
    output.push({
      actor,
      kind,
      timestamp: eventTimestamp(record),
      text: cleaned,
      ...extra,
      provenance: eventProvenance(record, nativeSequence, metadata),
    });
  };

  const appendUserContent = (record, nativeSequence, content) => {
    if (typeof content === 'string') {
      appendMessage('user', 'message', content, record, nativeSequence);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        appendMessage('user', 'message', block.text, record, nativeSequence);
      } else if (block.type === 'tool_result') {
        const outputText = toolResultText(block.content);
        appendMessage('tool', 'tool_result', outputText, record, nativeSequence, {
          tool: stringValue(block.name || block.tool_name || block.toolName).trim() || null,
          outcome: normalizedToolOutcome(block),
        });
      }
    }
  };

  for (const item of records) {
    const record = item.record;
    const type = stringValue(record.type).trim().toLowerCase();
    const message = asObject(record.message);
    const content = firstDefined(record.content, message && message.content);
    if (type === 'user') {
      appendUserContent(record, item.nativeSequence, content);
      continue;
    }
    if (type === 'assistant') {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          appendMessage('assistant', 'message', block.text, record, item.nativeSequence);
        } else if (block.type === 'tool_use') {
          const inputText = compactJson(block.input || {}, maxToolInput);
          if (!inputText) continue;
          appendMessage('tool', 'tool_call', inputText, record, item.nativeSequence, {
            tool: stringValue(block.name || 'Tool').trim().slice(0, 120) || 'Tool',
          });
        }
      }
      continue;
    }
    if (type === 'tool_result') {
      const result = asObject(record.message) || record;
      appendMessage('tool', 'tool_result', toolResultText(result.content), record, item.nativeSequence, {
        tool: stringValue(result.name || result.tool_name || result.toolName).trim() || null,
        outcome: normalizedToolOutcome(result),
      });
      continue;
    }
    if (type === 'system') {
      const subtype = stringValue(record.subtype).trim().toLowerCase();
      if (subtype === 'init' || subtype === 'compact_boundary' || subtype === 'api_error') continue;
      appendMessage('system', 'checkpoint', textFromContent(content), record, item.nativeSequence);
    }
  }
  return output;
}

function filePathFromRef(ref, projectsRoot, pathMod) {
  const locator = stableLocatorPath(ref && ref.sourceLocator);
  if (!locator) throw adapterError('CLAUDE_SESSION_SOURCE_LOCATOR_REQUIRED');
  const candidate = pathMod.resolve(projectsRoot, locator);
  if (!isPathInside(projectsRoot, candidate, pathMod)) {
    throw adapterError('CLAUDE_SESSION_SOURCE_LOCATOR_OUTSIDE_ROOT');
  }
  return candidate;
}

function walkJsonl(root, fsMod, pathMod, output = []) {
  let entries;
  try { entries = fsMod.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const fullPath = pathMod.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkJsonl(fullPath, fsMod, pathMod, output);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      output.push(fullPath);
    }
  }
  return output;
}

function sortJsonlFilesByMtime(files, fsMod) {
  return [...files].sort((left, right) => {
    let leftMtime = 0;
    let rightMtime = 0;
    try { leftMtime = fsMod.statSync(left).mtimeMs; } catch { /* keep deterministic fallback */ }
    try { rightMtime = fsMod.statSync(right).mtimeMs; } catch { /* keep deterministic fallback */ }
    return rightMtime - leftMtime || left.localeCompare(right);
  });
}

const DISCOVERY_CURSOR_VERSION = 1;

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

function normalizeDiscoverySnapshotEntry(value, pathMod) {
  const object = asObject(value);
  const rawPath = object && firstDefined(object.relativePath, object.relative_path, object.path);
  const relativePath = normalizeRelativePath(rawPath, pathMod);
  if (!rawPath || !relativePath || relativePath === '.' || pathMod.isAbsolute(relativePath) || relativePath.startsWith('..')) {
    throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_path');
  }
  return { relativePath };
}

function parseDiscoveryCursor(value, pathMod) {
  if (value === null || value === undefined) return null;
  let cursor = value;
  if (typeof cursor === 'string') {
    try { cursor = JSON.parse(cursor); } catch { throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'json'); }
  }
  const object = asObject(cursor);
  const version = object && Number(object.version);
  const offset = object && Number(object.offset);
  if (!object || version !== DISCOVERY_CURSOR_VERSION
    || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(object.snapshot)) {
    throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_required');
  }
  const snapshot = object.snapshot.map(entry => normalizeDiscoverySnapshotEntry(entry, pathMod));
  if (snapshot.length > MAX_DISCOVERY_SNAPSHOT_PATHS) {
    throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_too_large');
  }
  if (offset > snapshot.length) throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'offset');
  const accepted = object.accepted === undefined ? offset : Number(object.accepted);
  if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > DEFAULT_DISCOVERY_LIMIT) {
    throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'accepted');
  }
  const query = asObject(object.query);
  if (!query) throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'query_required');
  return {
    version,
    offset,
    accepted,
    snapshot,
    query: {
      project: stringValue(query.project).trim(),
      cwd: stringValue(query.cwd).trim(),
      includeSubagents: query.includeSubagents !== false,
      suppressOwnedSubagents: query.suppressOwnedSubagents === true,
    },
  };
}

function sameDiscoveryQuery(left, right) {
  return left.project === right.project
    && left.cwd === right.cwd
    && left.includeSubagents === right.includeSubagents
    && left.suppressOwnedSubagents === right.suppressOwnedSubagents;
}

function makeDiscoveryCursor(snapshot, offset, accepted, query) {
  return {
    version: DISCOVERY_CURSOR_VERSION,
    offset,
    accepted,
    snapshot,
    query,
  };
}

function createClaudeSessionSourceAdapter(options = {}) {
  const fsMod = options.fs || fsDefault;
  const pathMod = options.path || pathDefault;
  const home = options.home || options.HOME || os.homedir();
  const projectsRoot = pathMod.resolve(options.projectsRoot || pathMod.join(home, '.claude', 'projects'));
  const maxFileSize = Number(options.maxFileSize || DEFAULT_MAX_FILE_SIZE);
  const maxEvents = Number(options.maxEvents || DEFAULT_MAX_EVENTS);
  const adapterOptions = {
    maxText: options.maxText || DEFAULT_MAX_TEXT,
    maxToolText: options.maxToolText || DEFAULT_MAX_TOOL_TEXT,
    maxToolInput: options.maxToolInput || DEFAULT_MAX_TOOL_INPUT,
  };

  function inspectFile(filePath) {
    const source = readFileBounded(filePath, fsMod, maxFileSize);
    const parsed = recordsFromText(source.text);
    const metadata = metadataFromRecords(parsed.records, filePath, pathMod);
    const nativeSessionId = metadata.nativeSessionId || pathMod.basename(filePath, '.jsonl');
    const userEvents = projectCanonicalRecords(parsed.records, metadata, adapterOptions);
    const toolCalls = userEvents.filter(event => event.kind === 'tool_call').length;
    const toolErrors = userEvents.filter(event => event.kind === 'tool_result' && event.outcome && event.outcome.error).length;
    return {
      ...metadata,
      nativeSessionId,
      sourceHash: hashBytes(source.bytes),
      sourceRevision: hashBytes(source.bytes),
      sourceSize: source.stat.size,
      cursor: { sequence: parsed.nextNativeSequence },
      messageCount: userEvents.filter(event => event.actor === 'user' && event.kind === 'message').length,
      toolCallCount: toolCalls,
      toolErrorCount: toolErrors,
      eventCount: userEvents.length,
      invalidLineCount: parsed.invalidLines,
      lastModified: source.stat.mtime.toISOString(),
    };
  }

  function refForFile(filePath, metadata = null, discoveryCursor = null) {
    const relativePath = pathMod.relative(projectsRoot, filePath);
    const info = metadata || inspectFile(filePath);
    return {
      engineId: ENGINE_ID,
      nativeSessionId: info.nativeSessionId || pathMod.basename(filePath, '.jsonl'),
      sourceLocator: { relativePath: normalizeRelativePath(relativePath, pathMod) },
      project: info.project || null,
      scope: info.scope || null,
      cwd: info.cwd || null,
      parentNativeSessionId: info.parentNativeSessionId || null,
      sourceRevision: info.sourceRevision,
      ...(discoveryCursor ? { discoveryCursor } : {}),
    };
  }

  function snapshotPaths(files) {
    return files.slice(0, MAX_DISCOVERY_SNAPSHOT_PATHS).map(filePath => ({
      relativePath: normalizeRelativePath(pathMod.relative(projectsRoot, filePath), pathMod),
    }));
  }

  function freshDiscoverySnapshot(query) {
    const files = sortJsonlFilesByMtime(walkJsonl(projectsRoot, fsMod, pathMod), fsMod);
    const canUsePathSnapshot = !query.project && !query.cwd
      && query.includeSubagents && !query.suppressOwnedSubagents;
    if (canUsePathSnapshot) return snapshotPaths(files);

    const inspected = [];
    const nativeSessionIds = new Set();
    for (const filePath of files) {
      let info;
      try { info = inspectFile(filePath); } catch { continue; }
      inspected.push({ filePath, info });
      if (info.nativeSessionId) nativeSessionIds.add(info.nativeSessionId);
    }
    return inspected
      .filter(({ info }) => !query.project || info.project === query.project)
      .filter(({ info }) => !query.cwd || info.cwd === query.cwd)
      .filter(({ info }) => query.includeSubagents || info.classification !== 'subagent')
      .filter(({ info }) => !query.suppressOwnedSubagents
        || !info.parentNativeSessionId
        || !nativeSessionIds.has(info.parentNativeSessionId))
      .slice(0, DEFAULT_DISCOVERY_LIMIT)
      .map(entry => ({
        relativePath: normalizeRelativePath(pathMod.relative(projectsRoot, entry.filePath), pathMod),
      }));
  }

  function entriesFromSnapshot(snapshot, start, limit) {
    const entries = [];
    for (let snapshotIndex = start; snapshotIndex < snapshot.length && entries.length < limit; snapshotIndex++) {
      const snapshotEntry = snapshot[snapshotIndex];
      const filePath = pathMod.resolve(projectsRoot, snapshotEntry.relativePath);
      if (!isPathInside(projectsRoot, filePath, pathMod)) continue;
      let info;
      try { info = inspectFile(filePath); } catch { continue; }
      entries.push({ filePath, info, snapshotIndex });
    }
    return entries;
  }

  function prepareDiscovery(request = {}) {
    const query = discoveryQuery(request);
    const cursor = parseDiscoveryCursor(request.cursor, pathMod);
    if (cursor) {
      if (!sameDiscoveryQuery(cursor.query, query)) {
        throw adapterError('CLAUDE_SESSION_SOURCE_CURSOR_INVALID', 'query_mismatch');
      }
      return {
        query,
        cursor,
        snapshot: cursor.snapshot,
      };
    }
    return { query, cursor: null, snapshot: freshDiscoverySnapshot(query) };
  }

  function refsForRequest(request = {}) {
    const state = prepareDiscovery(request);
    const limit = discoveryLimit(request);
    const start = state.cursor ? state.cursor.offset : 0;
    const acceptedStart = state.cursor ? state.cursor.accepted : 0;
    const page = entriesFromSnapshot(
      state.snapshot,
      start,
      Math.min(limit, DEFAULT_DISCOVERY_LIMIT - acceptedStart),
    );
    const acceptedEnd = acceptedStart + page.length;
    const hasMore = page.length > 0
      && acceptedEnd < DEFAULT_DISCOVERY_LIMIT
      && page[page.length - 1].snapshotIndex + 1 < state.snapshot.length;
    return page.map((entry, index) => refForFile(
      entry.filePath,
      entry.info,
      hasMore && index === page.length - 1
        ? makeDiscoveryCursor(state.snapshot, entry.snapshotIndex + 1, acceptedEnd, state.query)
        : null,
    ));
  }

  function listSessionRefs(request = {}) {
    return refsForRequest(request);
  }

  function inspectPath(filePath) {
    const resolved = pathMod.resolve(filePath);
    if (!isPathInside(projectsRoot, resolved, pathMod)) throw adapterError('CLAUDE_SESSION_SOURCE_LOCATOR_OUTSIDE_ROOT');
    return inspectFile(resolved);
  }

  function resolveSessionRefPath(ref) {
    return filePathFromRef(ref, projectsRoot, pathMod);
  }

  function readPathEvents(filePath, sourceRef = null) {
    const resolved = pathMod.resolve(filePath);
    const info = inspectPath(resolved);
    const source = readFileBounded(resolved, fsMod, maxFileSize);
    const parsed = recordsFromText(source.text);
    const candidates = projectCanonicalRecords(parsed.records, info, adapterOptions);
    const events = normalizeCanonicalSessionEvents(candidates, {
      engineId: ENGINE_ID,
      nativeSessionId: info.nativeSessionId,
      sourceRevision: info.sourceRevision,
    });
    if (events.length > maxEvents) throw adapterError('CLAUDE_SESSION_SOURCE_EVENT_LIMIT');
    const ref = sourceRef && sourceRef.sourceLocator
      ? sourceRef
      : refForFile(resolved, info);
    return {
      ref,
      revision: { ...info, sourceLocator: ref.sourceLocator },
      events,
    };
  }

  const rawAdapter = {
    engineId: ENGINE_ID,
    protocolVersion: 1,
    probe: () => {
      const files = walkJsonl(projectsRoot, fsMod, pathMod);
      return {
        state: files.length > 0 ? 'verified' : 'reachable',
        available: true,
        reachable: true,
        verified: files.length > 0,
        sourceCount: files.length,
      };
    },
    discover: function* discover(request = {}) {
      for (const ref of refsForRequest(request)) yield ref;
    },
    inspect(ref) {
      const filePath = filePathFromRef(ref, projectsRoot, pathMod);
      const revision = inspectFile(filePath);
      const expected = stringValue(ref.nativeSessionId).trim();
      if (expected && revision.nativeSessionId !== expected) {
        throw adapterError('CLAUDE_SESSION_SOURCE_SESSION_ID_MISMATCH', `${expected}:${revision.nativeSessionId}`);
      }
      return revision;
    },
    read: function* read(ref, request = {}) {
      const filePath = filePathFromRef(ref, projectsRoot, pathMod);
      const source = readFileBounded(filePath, fsMod, maxFileSize);
      const parsed = recordsFromText(source.text);
      const metadata = metadataFromRecords(parsed.records, filePath, pathMod);
      const revision = hashBytes(source.bytes);
      const requestedRevision = stringValue(request.sourceRevision || request.sourceHash).trim();
      if (requestedRevision && requestedRevision !== revision) {
        throw adapterError('CLAUDE_SESSION_SOURCE_REVISION_MISMATCH', `${requestedRevision}:${revision}`);
      }
      const cursor = cursorPosition(request.cursor);
      let emitted = 0;
      for (const event of projectCanonicalRecords(parsed.records, metadata, adapterOptions)) {
        if (emitted >= maxEvents) throw adapterError('CLAUDE_SESSION_SOURCE_EVENT_LIMIT');
        const nativeSequence = event.provenance && event.provenance.nativeSequence;
        if (cursor !== null && Number(nativeSequence) < cursor) continue;
        yield event;
        emitted++;
      }
    },
    validate(ref) {
      try {
        const filePath = filePathFromRef(ref, projectsRoot, pathMod);
        const revision = inspectFile(filePath);
        const expected = stringValue(ref.nativeSessionId).trim();
        if (expected && revision.nativeSessionId !== expected) {
          return { valid: false, errorCode: 'SOURCE_SESSION_ID_MISMATCH', detail: 'native session id does not match locator' };
        }
        if (revision.invalidLineCount > 0 && revision.eventCount === 0) {
          return { valid: false, errorCode: 'SOURCE_MALFORMED', detail: 'no valid native records' };
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
    inspectPath,
    resolveSessionRefPath,
    readPathEvents,
    isTrivialSession(skeleton) {
      return !!skeleton && skeleton.message_count < 2 && skeleton.duration_min < 1;
    },
  });
}

function readClaudeSessionEvents(source, ref, revision, options = {}) {
  const events = [];
  const request = { ...(options || {}), sourceRevision: revision && (revision.sourceRevision || revision.sourceHash) };
  return (async () => {
    for await (const event of source.read(ref, request)) events.push(event);
    return events;
  })();
}

function createClaudeSessionSourceForFile(filePath, options = {}) {
  const resolved = pathDefault.resolve(String(filePath || ''));
  const source = createClaudeSessionSourceAdapter({
    ...options,
    projectsRoot: options.projectsRoot || pathDefault.dirname(resolved),
  });
  return Object.freeze({
    ...source,
    filePath: resolved,
    ref: source.listSessionRefs({ limit: DEFAULT_DISCOVERY_LIMIT }).find(ref => (
      stableLocatorPath(ref.sourceLocator) === pathDefault.basename(resolved)
    )) || {
      engineId: ENGINE_ID,
      nativeSessionId: pathDefault.basename(resolved, '.jsonl'),
      sourceLocator: { relativePath: pathDefault.basename(resolved) },
    },
    readEvents() {
      return source.readPathEvents(resolved);
    },
  });
}

module.exports = {
  ENGINE_ID,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_EVENTS,
  createClaudeSessionSourceAdapter,
  createClaudeSessionSource: createClaudeSessionSourceAdapter,
  createClaudeSessionSourceForFile,
  readClaudeSessionEvents,
  redactSecrets,
  cleanText,
  projectCanonicalRecords,
  _internal: {
    recordsFromText,
    metadataFromRecords,
    nestedParentSessionId,
    isSidechainRecord,
    walkJsonl,
    sortJsonlFilesByMtime,
  },
};
