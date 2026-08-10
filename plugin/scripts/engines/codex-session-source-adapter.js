'use strict';

/**
 * Codex Session Source Adapter.
 *
 * Codex owns both the state_5.sqlite index and the rollout/history record
 * formats.  This adapter is the only module that discovers those files,
 * reads native records, enriches user messages from history, and projects
 * them into canonical session evidence.
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
const {
  makeSkeleton,
  extractEvidence,
} = require('../core/canonical-session-analytics');

const ENGINE_ID = 'codex';
const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024;
const DEFAULT_MIN_FILE_SIZE = 1024;
const DEFAULT_MAX_EVENTS = 100000;
const DEFAULT_MAX_TEXT = 4000;
const DEFAULT_MAX_TOOL_TEXT = 1600;
const DEFAULT_MAX_TOOL_INPUT = 1200;
const DEFAULT_DISCOVERY_LIMIT = 1000;
const MAX_DISCOVERY_SNAPSHOT_ENTRIES = DEFAULT_DISCOVERY_LIMIT * 100;
const DISCOVERY_CURSOR_VERSION = 1;
const CODEX_STATE_DB_NAME = 'state_5.sqlite';
const CODEX_ROLLOUT_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;
const PROCESS_EXECUTION_TOOLS = new Set(['exec_command']);

function adapterError(code, detail = '') {
  const normalizedCode = String(code || '').startsWith('CODEX_')
    ? `session_source_${String(code).slice('CODEX_'.length).toLowerCase()}`
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

function stringValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function numberValue(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  const numeric = typeof value === 'number' || /^-?\d+(?:\.\d+)?$/.test(text)
    ? Number(value)
    : null;
  const parsed = numeric !== null && Number.isFinite(numeric)
    ? Math.abs(numeric) > 1e12 ? numeric : numeric * 1000
    : new Date(text).getTime();
  if (!Number.isFinite(parsed)) return null;
  try { return new Date(parsed).toISOString(); } catch { return null; }
}

function timestampMs(value) {
  const normalized = normalizeTimestamp(value);
  return normalized ? Date.parse(normalized) : 0;
}

function compactJson(value) {
  try { return JSON.stringify(value === undefined ? null : value); } catch { return '[unserializable]'; }
}

function stripInjectedHints(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n*System hints \(internal, do not mention to user\):[\s\S]*/i, '')
    .replace(/\n*\[Respond in Simplified Chinese[\s\S]*/i, '')
    .replace(/\n*\[Agent memory snapshot:[\s\S]*/i, '')
    .replace(/\n*\[Relevant facts:[\s\S]*/i, '')
    .trim();
}

function looksLikeInternalCodexPrompt(text) {
  const clean = stripInjectedHints(text).trim();
  if (!clean) return true;
  return (
    /^you are a metame\b/i.test(clean)
    || /^you are a meta ?me\b/i.test(clean)
    || /^you are a session reflection assistant\b/i.test(clean)
    || /^you are a metacognition pattern detector\b/i.test(clean)
    || /^you are codex, based on gpt-5\b/i.test(clean)
    || /^\[nightly-reflect]/i.test(clean)
    || /^\[self-reflect]/i.test(clean)
    || /^\[memory-/i.test(clean)
  );
}

function redactSecrets(text) {
  let value = String(text || '');
  value = value.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, '[REDACTED_SECRET]');
  value = value.replace(/\b(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+)\b/gi, '[REDACTED_SECRET]');
  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED_SECRET]');
  value = value.replace(/(\b(?:[A-Z0-9]+_)*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY|TOKEN)(?:_[A-Z0-9]+)*\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  value = value.replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)(["']?)[^\s,"'}]+\2/gi, '$1[REDACTED_SECRET]');
  return value;
}

function isRecursiveOrInternal(text) {
  const value = String(text || '');
  return !value.trim()
    || isInternalPrompt(value)
    || looksLikeInternalCodexPrompt(value)
    || /<!--\s*(?:FACTS|MEMORY):START\s*-->/i.test(value)
    || /\[上次对话摘要|\b(?:previous|prior|generated)\s+session\s+summary\b/i.test(value)
    || /<task-notification\b/i.test(value);
}

function cleanText(text, maxChars = DEFAULT_MAX_TEXT, { allowInternal = false } = {}) {
  const sanitized = stripInjectedHints(sanitizePrompt(String(text || '')))
    .replace(/\s+/g, ' ')
    .trim();
  if (!allowInternal && isRecursiveOrInternal(sanitized)) return null;
  const redacted = redactSecrets(sanitized);
  if (!redacted.trim()) return null;
  return redacted.slice(0, maxChars);
}

function extractMessageText(payload) {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return payload.map(extractMessageText).filter(Boolean).join('\n').trim();
  if (typeof payload !== 'object') return '';
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.message === 'string') return payload.message;
  if (payload.type === 'input_text' || payload.type === 'output_text') return String(payload.text || '');
  if (payload.type === 'message' && Array.isArray(payload.content)) return extractMessageText(payload.content);
  if (Array.isArray(payload.content)) return extractMessageText(payload.content);
  if (payload.payload) return extractMessageText(payload.payload);
  return '';
}

function readFileBounded(filePath, fsMod, maxFileSize, minFileSize = 0) {
  let stat;
  try {
    stat = typeof fsMod.lstatSync === 'function' ? fsMod.lstatSync(filePath) : fsMod.statSync(filePath);
  } catch (error) {
    throw adapterError('CODEX_SESSION_SOURCE_MISSING', error.code || filePath);
  }
  if (stat.isSymbolicLink && stat.isSymbolicLink()) {
    throw adapterError('CODEX_SESSION_SOURCE_INVALID', 'symlink_not_allowed');
  }
  if (!stat.isFile()) throw adapterError('CODEX_SESSION_SOURCE_INVALID', 'not_a_file');
  if (stat.size < minFileSize) throw adapterError('CODEX_SESSION_SOURCE_INVALID', 'file_too_small');
  if (stat.size > maxFileSize) throw adapterError('CODEX_SESSION_SOURCE_TOO_LARGE', String(stat.size));
  let bytes;
  try { bytes = fsMod.readFileSync(filePath); } catch (error) {
    throw adapterError('CODEX_SESSION_SOURCE_READ_FAILED', error.code || filePath);
  }
  return { stat, bytes, text: bytes.toString('utf8').replace(/^\uFEFF/, '') };
}

function recordsFromText(text) {
  const records = [];
  let invalidLineCount = 0;
  const value = String(text || '');
  const lines = value.split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record');
      records.push({ record, nativeSequence: index });
    } catch { invalidLineCount++; }
  });
  return {
    records,
    invalidLineCount,
    nextNativeSequence: value ? lines.length - (value.endsWith('\n') ? 1 : 0) : 0,
  };
}

function sessionMetaFromRecords(records) {
  let meta = {};
  let sessionId = '';
  let cwd = '';
  let parentNativeSessionId = '';
  let sidechain = false;
  let firstTs = null;
  let lastTs = null;
  let model = '';
  let modelProvider = '';

  const findParent = value => {
    const object = asObject(value);
    if (!object) return '';
    const source = asObject(object.source);
    const subagent = asObject(source && source.subagent) || asObject(object.subagent);
    const spawn = asObject(subagent && (subagent.thread_spawn || subagent.threadSpawn));
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
      spawn && spawn.parentThreadId,
      spawn && spawn.parent_thread_id,
    )).trim();
  };

  for (const item of records.slice(0, 512)) {
    const record = item.record;
    const payload = asObject(record.payload) || {};
    if (record.type === 'session_meta') {
      meta = payload;
      sessionId = sessionId || stringValue(firstDefined(payload.id, payload.session_id, record.session_id)).trim();
      cwd = cwd || stringValue(firstDefined(payload.cwd, payload.working_directory, payload.workingDirectory)).trim();
      model = model || stringValue(firstDefined(payload.model, payload.model_id)).trim();
      modelProvider = modelProvider || stringValue(firstDefined(payload.model_provider, payload.modelProvider)).trim();
      const source = payload.source;
      sidechain = sidechain || !!(asObject(source)?.subagent || source === 'subagent' || payload.is_subagent === true);
      parentNativeSessionId = parentNativeSessionId || findParent(payload);
    }
    sessionId = sessionId || stringValue(firstDefined(record.sessionId, record.session_id)).trim();
    cwd = cwd || stringValue(firstDefined(record.cwd, record.working_directory, record.workingDirectory)).trim();
    parentNativeSessionId = parentNativeSessionId || findParent(record) || findParent(payload);
    sidechain = sidechain || record.isSidechain === true || record.is_sidechain === true;
    const ts = normalizeTimestamp(firstDefined(record.timestamp, record.ts, record.created_at, record.createdAt, payload.timestamp));
    if (ts) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (!lastTs || ts > lastTs) lastTs = ts;
    }
  }

  if (!parentNativeSessionId) {
    const source = asObject(meta.source);
    const subagent = asObject(source && source.subagent);
    const spawn = asObject(subagent && (subagent.thread_spawn || subagent.threadSpawn));
    parentNativeSessionId = stringValue(firstDefined(
      spawn && spawn.parent_thread_id,
      spawn && spawn.parentThreadId,
      meta.parent_thread_id,
      meta.parentThreadId,
    )).trim();
  }
  if (parentNativeSessionId) sidechain = true;
  const projectInfo = deriveProjectInfo(cwd);
  return {
    nativeSessionId: sessionId,
    cwd: cwd || null,
    project: projectInfo.project || null,
    scope: projectInfo.project_id || null,
    parentNativeSessionId: parentNativeSessionId || null,
    classification: sidechain ? 'subagent' : 'conversation',
    firstTs,
    lastTs,
    model: model || null,
    modelProvider: modelProvider || null,
    source: meta.source || null,
  };
}

function historyFromText(text, sessionId) {
  const output = [];
  const allowId = String(sessionId || '').trim();
  if (!allowId) return output;
  String(text || '').split('\n').forEach((line, historySequence) => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      if (String(entry.session_id || entry.sessionId || '').trim() !== allowId) return;
      const rawText = entry.text || entry.message || '';
      const clean = cleanText(rawText, DEFAULT_MAX_TEXT);
      if (!clean) return;
      output.push({
        ts: normalizeTimestamp(firstDefined(entry.ts, entry.timestamp, entry.created_at, entry.createdAt)),
        text: clean,
        historySequence,
      });
    } catch { /* malformed history is bounded, non-fatal evidence */ }
  });
  return output;
}

function historyFromMap(historyMap, sessionId) {
  if (!(historyMap instanceof Map)) return [];
  const values = historyMap.get(sessionId) || [];
  return values.map((item, index) => {
    const value = asObject(item) || {};
    const clean = cleanText(value.text || value.message, DEFAULT_MAX_TEXT);
    return clean ? {
      ts: normalizeTimestamp(firstDefined(value.ts, value.timestamp)),
      text: clean,
      historySequence: Number.isSafeInteger(value.historySequence) ? value.historySequence : index,
    } : null;
  }).filter(Boolean);
}

function eventTimestamp(record) {
  const payload = asObject(record && record.payload);
  return normalizeTimestamp(firstDefined(
    record && record.timestamp,
    record && record.ts,
    record && record.created_at,
    record && record.createdAt,
    payload && payload.timestamp,
  ));
}

function eventProvenance(record, nativeSequence, metadata, extra = {}) {
  const payload = asObject(record && record.payload);
  const nativeEventId = firstDefined(record && record.id, record && record.uuid, payload && payload.id);
  const model = stringValue(firstDefined(payload && payload.model, metadata.model)).trim();
  return {
    ...(nativeEventId ? { nativeEventId: String(nativeEventId) } : {}),
    ...(model ? { model: model.slice(0, 120) } : {}),
    nativeSequence,
    ...(metadata.parentNativeSessionId ? { parentNativeSessionId: metadata.parentNativeSessionId } : {}),
    ...extra,
  };
}

function nativeCallId(payload, record = null) {
  return stringValue(firstDefined(
    payload && payload.call_id,
    payload && payload.callId,
    record && record.call_id,
    record && record.callId,
  )).trim();
}

function toolInputText(input, maxToolInput) {
  let value = input;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return cleanText(value, maxToolInput, { allowInternal: true }) || ''; }
  }
  return cleanText(compactJson(value || {}), maxToolInput, { allowInternal: true }) || '';
}

function nativeExitCodeFromText(value) {
  const text = String(value || '');
  const match = text.match(/(?:^|\r?\n)[ \t]*(?:Process|Command) exited with code[ \t]+(-?\d+)\b/im)
    || text.match(/(?:^|\r?\n)[ \t]*Exit code[ \t]*[:=][ \t]*(-?\d+)\b/im);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : null;
}

function isProcessExecutionTool(toolName) {
  return PROCESS_EXECUTION_TOOLS.has(String(toolName || '').trim().toLowerCase());
}

function normalizedToolOutcome(payload, outputText = '', resolvedToolName = '') {
  const object = asObject(payload) || {};
  let parsed = object.output;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { /* retain text */ }
  }
  const result = asObject(parsed) || {};
  const code = firstDefined(
    result.exit_code,
    result.exitCode,
    result.code,
    object.exit_code,
    object.exitCode,
    object.code,
    isProcessExecutionTool(resolvedToolName)
      ? nativeExitCodeFromText(typeof object.output === 'string' ? object.output : outputText)
      : null,
  );
  const explicitError = firstDefined(result.is_error, result.isError, object.is_error, object.isError);
  const numericCode = code !== undefined && code !== null && code !== '' && Number.isFinite(Number(code))
    ? Number(code)
    : null;
  const error = explicitError === true || numericCode !== null && numericCode !== 0;
  return {
    error,
    ...(numericCode !== null ? { exitCode: numericCode } : {}),
    ...(outputText ? { outputChars: Math.min(outputText.length, DEFAULT_MAX_TOOL_TEXT) } : {}),
  };
}

function projectCanonicalRecords(records, metadata, history = [], options = {}) {
  const maxText = Number(options.maxText || DEFAULT_MAX_TEXT);
  const maxToolText = Number(options.maxToolText || DEFAULT_MAX_TOOL_TEXT);
  const maxToolInput = Number(options.maxToolInput || DEFAULT_MAX_TOOL_INPUT);
  const candidates = [];
  const hasHistory = history.length > 0 && metadata.classification !== 'subagent';
  const toolCallNames = new Map();

  for (const item of records) {
    const record = item.record;
    const payload = asObject(record.payload) || {};
    const type = stringValue(record.type).trim().toLowerCase();
    const payloadType = stringValue(payload.type).trim().toLowerCase();
    if (type !== 'response_item' || !['custom_tool_call', 'function_call'].includes(payloadType)) continue;
    const callId = nativeCallId(payload, record);
    const name = stringValue(payload.name || payload.tool_name || '').trim();
    if (callId && name) toolCallNames.set(callId, name.slice(0, 120));
  }

  const append = (candidate, nativeSequence, extra = {}) => {
    candidates.push({ ...candidate, nativeSequence, ...extra });
  };
  const appendMessage = (actor, kind, text, record, nativeSequence, extra = {}) => {
    const cleaned = cleanText(text, kind === 'message' ? maxText : maxToolText, {
      allowInternal: actor === 'tool',
    });
    if (!cleaned && kind !== 'tool_result') return;
    append({
      actor,
      kind,
      timestamp: eventTimestamp(record),
      text: cleaned || '',
      tool: extra.tool || null,
      outcome: extra.outcome || null,
      provenance: eventProvenance(record, nativeSequence, metadata, extra.provenance || {}),
    }, nativeSequence);
  };

  for (const item of records) {
    const record = item.record;
    const payload = asObject(record.payload) || {};
    const type = stringValue(record.type).trim().toLowerCase();
    const payloadType = stringValue(payload.type).trim().toLowerCase();
    if (type === 'session_meta') continue;

    if (type === 'response_item' && payloadType === 'message') {
      const role = stringValue(payload.role).trim().toLowerCase();
      const text = extractMessageText(payload.content || payload);
      if (role === 'user') {
        if (!hasHistory && metadata.classification !== 'subagent') {
          appendMessage('user', 'message', text, record, item.nativeSequence);
        }
      } else if (role === 'assistant') {
        appendMessage('assistant', 'message', text, record, item.nativeSequence);
      }
      continue;
    }

    if (type === 'response_item' && ['custom_tool_call', 'function_call'].includes(payloadType)) {
      const callId = nativeCallId(payload, record);
      const input = payloadType === 'function_call'
        ? firstDefined(payload.arguments, payload.input)
        : payload.input;
      const inputText = toolInputText(input, maxToolInput);
      const tool = stringValue(payload.name || payload.tool_name || 'unknown').trim().slice(0, 120) || 'unknown';
      if (inputText) appendMessage('tool', 'tool_call', inputText, record, item.nativeSequence, {
        tool,
        ...(callId ? { provenance: { callId } } : {}),
      });
      continue;
    }

    if (type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(payloadType)) {
      const callId = nativeCallId(payload, record);
      const resolvedToolName = callId ? toolCallNames.get(callId) || '' : '';
      const rawOutput = typeof payload.output === 'string' ? payload.output : compactJson(payload.output || '');
      const outputText = cleanText(rawOutput, maxToolText, { allowInternal: true }) || '';
      appendMessage('tool', 'tool_result', outputText, record, item.nativeSequence, {
        outcome: normalizedToolOutcome(payload, outputText, resolvedToolName),
        tool: stringValue(payload.name || payload.tool_name || (callId && toolCallNames.get(callId)) || '').trim() || null,
        ...(callId ? { provenance: { callId } } : {}),
      });
      continue;
    }

    if (type === 'event_msg') {
      const eventType = stringValue(payload.type).trim().toLowerCase();
      if (eventType === 'agent_message') {
        appendMessage('assistant', 'message', extractMessageText(payload.message), record, item.nativeSequence);
      } else if (eventType === 'task_complete') {
        appendMessage('assistant', 'message', payload.last_agent_message || payload.lastAgentMessage, record, item.nativeSequence);
      }
    }
  }

  if (hasHistory) {
    for (const item of history) {
      append({
        actor: 'user',
        kind: 'message',
        timestamp: item.ts,
        text: item.text,
        tool: null,
        outcome: null,
        provenance: {
          historySequence: item.historySequence,
          history: true,
          ...(metadata.parentNativeSessionId ? { parentNativeSessionId: metadata.parentNativeSessionId } : {}),
        },
      }, item.historySequence, { historySequence: item.historySequence, fromHistory: true });
    }
  }

  candidates.sort((left, right) => {
    const leftTs = timestampMs(left.timestamp);
    const rightTs = timestampMs(right.timestamp);
    return (leftTs || Number.MAX_SAFE_INTEGER) - (rightTs || Number.MAX_SAFE_INTEGER)
      || (left.fromHistory ? 0 : 1) - (right.fromHistory ? 0 : 1)
      || Number(left.nativeSequence || 0) - Number(right.nativeSequence || 0)
      || Number(left.historySequence || 0) - Number(right.historySequence || 0);
  });
  return candidates.map(({ nativeSequence, historySequence, fromHistory, ...event }) => ({
    ...event,
    provenance: {
      ...(event.provenance || {}),
      ...(fromHistory ? { historySequence } : {}),
    },
  }));
}

function sourceRevisionBytes(rolloutBytes, history) {
  return Buffer.concat([
    Buffer.isBuffer(rolloutBytes) ? rolloutBytes : Buffer.from(String(rolloutBytes || '')),
    Buffer.from('\n--metame-codex-history--\n', 'utf8'),
    Buffer.from(JSON.stringify(history || []), 'utf8'),
  ]);
}

function rolloutIdFromPath(filePath, fallbackId = '') {
  const match = pathDefault.basename(String(filePath || '')).match(CODEX_ROLLOUT_PATTERN);
  return String(fallbackId || (match && match[1]) || '').trim();
}

function statRollout(filePath, fsMod, minFileSize = 0) {
  try {
    const stat = fsMod.statSync(filePath);
    if (!stat.isFile() || stat.size < minFileSize) return null;
    return stat;
  } catch { return null; }
}

function normalizeLocator(locator) {
  if (typeof locator === 'string') return { rolloutPath: locator };
  const object = asObject(locator);
  if (!object) throw adapterError('CODEX_SESSION_SOURCE_LOCATOR_REQUIRED');
  const rolloutPath = stringValue(firstDefined(
    object.rolloutPath,
    object.rollout_path,
    object.path,
    object.filePath,
    object.file_path,
  )).trim();
  if (!rolloutPath) throw adapterError('CODEX_SESSION_SOURCE_LOCATOR_REQUIRED');
  return {
    rolloutPath,
    ...(object.dbPath || object.db_path ? { dbPath: String(object.dbPath || object.db_path) } : {}),
    ...(object.authority ? { authority: String(object.authority) } : {}),
  };
}

function loadDaemonStateCwds(filePath, fsMod) {
  const values = new Set();
  try {
    const raw = JSON.parse(fsMod.readFileSync(filePath, 'utf8'));
    const sessions = raw && raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    for (const session of Object.values(sessions)) {
      const cwd = session && typeof session === 'object' ? String(session.cwd || '').trim() : '';
      if (cwd) values.add(pathDefault.resolve(cwd));
    }
  } catch { /* optional state file */ }
  return [...values];
}

function openReadonlyDatabase(dbPath, DatabaseSync) {
  if (!DatabaseSync) return null;
  try { return new DatabaseSync(dbPath, { readonly: true }); } catch { return null; }
}

function tableColumns(db, tableName) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => String(row.name)));
  } catch { return new Set(); }
}

function queryCodexThreadRows(dbPath, sessionId = '', deps = {}) {
  const fsMod = deps.fs || fsDefault;
  const DatabaseSync = deps.DatabaseSync || (() => {
    try { return require('node:sqlite').DatabaseSync; } catch { return null; }
  })();
  if (!dbPath || !fsMod.existsSync(dbPath)) return [];
  const db = openReadonlyDatabase(dbPath, DatabaseSync);
  if (!db) return [];
  try {
    const columns = tableColumns(db, 'threads');
    if (!columns.has('id') || !columns.has('rollout_path')) return [];
    const selected = [
      'id', 'rollout_path', 'cwd', 'title', 'first_user_message', 'source', 'created_at', 'updated_at',
      'archived', 'has_user_event', 'model_provider', 'parent_thread_id', 'parent_session_id',
    ]
      .filter(column => columns.has(column));
    const where = sessionId ? 'WHERE id = ?' : '';
    const order = columns.has('updated_at') ? 'ORDER BY updated_at DESC' : columns.has('created_at') ? 'ORDER BY created_at DESC' : '';
    const sql = `SELECT ${selected.join(', ')} FROM threads ${where} ${order} LIMIT 1000`;
    const rows = sessionId ? db.prepare(sql).all(sessionId) : db.prepare(sql).all();
    return rows || [];
  } catch {
    return [];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function writeSafeWalk(root, fsMod, pathMod, output = [], limit = MAX_DISCOVERY_SNAPSHOT_ENTRIES) {
  if (output.length >= limit) return output;
  let entries;
  try { entries = fsMod.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (output.length >= limit) break;
    if (entry.isSymbolicLink()) continue;
    const fullPath = pathMod.join(root, entry.name);
    if (entry.isDirectory()) writeSafeWalk(fullPath, fsMod, pathMod, output, limit);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.startsWith('rollout-')) output.push(fullPath);
  }
  return output;
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

function cloneSnapshotEntry(value) {
  const object = asObject(value);
  if (!object || !object.rolloutPath) throw adapterError('CODEX_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_entry');
  return {
    rolloutPath: String(object.rolloutPath),
    ...(object.dbPath ? { dbPath: String(object.dbPath) } : {}),
    ...(object.authority ? { authority: String(object.authority) } : {}),
  };
}

function parseDiscoveryCursor(value) {
  if (value === null || value === undefined) return null;
  let cursor = value;
  if (typeof cursor === 'string') {
    try { cursor = JSON.parse(cursor); } catch { throw adapterError('CODEX_SESSION_SOURCE_CURSOR_INVALID', 'json'); }
  }
  const object = asObject(cursor);
  const offset = object && Number(object.offset);
  const accepted = object && Number(object.accepted === undefined ? offset : object.accepted);
  if (!object || Number(object.version) !== DISCOVERY_CURSOR_VERSION
    || !Number.isSafeInteger(offset) || offset < 0
    || !Array.isArray(object.snapshot) || object.snapshot.length > MAX_DISCOVERY_SNAPSHOT_ENTRIES
    || !Number.isSafeInteger(accepted) || accepted < 0 || accepted > DEFAULT_DISCOVERY_LIMIT
    || !asObject(object.query)) {
    throw adapterError('CODEX_SESSION_SOURCE_CURSOR_INVALID', 'snapshot_required');
  }
  if (offset > object.snapshot.length) throw adapterError('CODEX_SESSION_SOURCE_CURSOR_INVALID', 'offset');
  return {
    version: DISCOVERY_CURSOR_VERSION,
    offset,
    accepted,
    snapshot: object.snapshot.map(cloneSnapshotEntry),
    query: discoveryQuery(object.query),
  };
}

function sameDiscoveryQuery(left, right) {
  return left.project === right.project
    && left.cwd === right.cwd
    && left.includeSubagents === right.includeSubagents
    && left.suppressOwnedSubagents === right.suppressOwnedSubagents;
}

function makeDiscoveryCursor(snapshot, offset, accepted, query) {
  return { version: DISCOVERY_CURSOR_VERSION, offset, accepted, snapshot, query };
}

function rowTimestamp(row) {
  const value = Number(firstDefined(row.updated_at, row.created_at));
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0;
}

function createCodexSessionSourceAdapter(options = {}) {
  const fsMod = options.fs || fsDefault;
  const pathMod = options.path || pathDefault;
  const home = pathMod.resolve(options.home || options.HOME || os.homedir());
  const codexRoot = pathMod.resolve(options.codexRoot || pathMod.join(home, '.codex'));
  const sessionsRoot = pathMod.resolve(options.sessionsRoot || pathMod.join(codexRoot, 'sessions'));
  const historyPath = pathMod.resolve(options.historyPath || pathMod.join(codexRoot, 'history.jsonl'));
  const daemonStatePath = pathMod.resolve(options.daemonStatePath || pathMod.join(home, '.metame', 'daemon_state.json'));
  const maxFileSize = Number(options.maxFileSize || DEFAULT_MAX_FILE_SIZE);
  const minFileSize = Number(options.minFileSize === undefined ? DEFAULT_MIN_FILE_SIZE : options.minFileSize);
  const maxEvents = Number(options.maxEvents || DEFAULT_MAX_EVENTS);
  const adapterOptions = {
    maxText: Number(options.maxText || DEFAULT_MAX_TEXT),
    maxToolText: Number(options.maxToolText || DEFAULT_MAX_TOOL_TEXT),
    maxToolInput: Number(options.maxToolInput || DEFAULT_MAX_TOOL_INPUT),
  };

  function knownDbPaths() {
    const paths = [];
    const seen = new Set();
    const add = value => {
      const candidate = String(value || '').trim();
      if (!candidate || seen.has(candidate)) return;
      seen.add(candidate);
      paths.push(candidate);
    };
    for (const value of options.dbPaths || []) add(value);
    add(options.dbPath);
    add(pathMod.join(codexRoot, CODEX_STATE_DB_NAME));
    const cwdValues = [
      ...(options.daemonCwds || []),
      ...loadDaemonStateCwds(daemonStatePath, fsMod),
    ];
    for (const cwd of cwdValues) add(pathMod.join(pathMod.resolve(String(cwd)), '.codex', CODEX_STATE_DB_NAME));
    return paths;
  }

  function readHistory(sessionId) {
    try {
      if (!fsMod.existsSync(historyPath)) return [];
      return historyFromText(fsMod.readFileSync(historyPath, 'utf8'), sessionId);
    } catch { return []; }
  }

  function resolveRolloutPath(locator) {
    const normalized = normalizeLocator(locator);
    const candidate = pathMod.resolve(normalized.rolloutPath);
    return { path: candidate, locator: normalized };
  }

  function inspectFile(filePath, expectedSessionId = '', locator = null) {
    const source = readFileBounded(filePath, fsMod, maxFileSize, 0);
    const parsed = recordsFromText(source.text);
    const metadata = sessionMetaFromRecords(parsed.records);
    const nativeSessionId = metadata.nativeSessionId || expectedSessionId || rolloutIdFromPath(filePath);
    if (!nativeSessionId) throw adapterError('CODEX_SESSION_SOURCE_SESSION_ID_REQUIRED');
    const history = readHistory(nativeSessionId);
    const sourceBytes = sourceRevisionBytes(source.bytes, history);
    const sourceHash = fingerprintSourceRevision({ content: sourceBytes });
    const events = projectCanonicalRecords(parsed.records, { ...metadata, nativeSessionId }, history, adapterOptions);
    const firstEventTs = events.map(event => event.timestamp).filter(Boolean).sort()[0] || metadata.firstTs;
    const lastEventTs = events.map(event => event.timestamp).filter(Boolean).sort().at(-1) || metadata.lastTs;
    const sourceLocator = locator || { rolloutPath: filePath };
    return {
      ...metadata,
      nativeSessionId,
      sourceLocator,
      sourceHash,
      sourceRevision: sourceHash,
      sourceSize: source.bytes.length + Buffer.byteLength(JSON.stringify(history), 'utf8'),
      rolloutSize: source.bytes.length,
      historySize: history.length,
      cursor: { sequence: parsed.nextNativeSequence, historySequence: history.length },
      messageCount: events.filter(event => event.actor === 'user' && event.kind === 'message').length,
      toolCallCount: events.filter(event => event.kind === 'tool_call').length,
      toolErrorCount: events.filter(event => event.kind === 'tool_result' && event.outcome && event.outcome.error).length,
      eventCount: events.length,
      invalidLineCount: parsed.invalidLineCount,
      firstTs: firstEventTs,
      lastTs: lastEventTs,
      lastModified: source.stat.mtime.toISOString(),
    };
  }

  function refForEntry(entry) {
    const info = entry.info || inspectFile(entry.rolloutPath, entry.sessionId, entry.locator);
    return {
      engineId: ENGINE_ID,
      nativeSessionId: info.nativeSessionId,
      sourceLocator: entry.locator || {
        rolloutPath: entry.rolloutPath,
        ...(entry.dbPath ? { dbPath: entry.dbPath } : {}),
        ...(entry.authority ? { authority: entry.authority } : {}),
      },
      project: info.project || null,
      scope: info.scope || null,
      cwd: info.cwd || null,
      parentNativeSessionId: info.parentNativeSessionId || null,
      sourceRevision: info.sourceRevision,
      ...(entry.discoveryCursor ? { discoveryCursor: entry.discoveryCursor } : {}),
    };
  }

  function dbEntries() {
    const entries = [];
    const seen = new Set();
    for (const dbPath of knownDbPaths()) {
      for (const row of queryCodexThreadRows(dbPath, '', { fs: fsMod })) {
        const sessionId = stringValue(row && row.id).trim();
        const rawRolloutPath = stringValue(row && row.rollout_path).trim();
        if (!sessionId || !rawRolloutPath || row.archived) continue;
        const rolloutPath = pathMod.isAbsolute(rawRolloutPath)
          ? rawRolloutPath
          : pathMod.resolve(pathMod.dirname(dbPath), rawRolloutPath);
        if (seen.has(sessionId)) continue;
        if (!statRollout(rolloutPath, fsMod, 0)) continue;
        const seed = stringValue(firstDefined(row.first_user_message, row.title)).trim();
        if (seed && looksLikeInternalCodexPrompt(seed)) continue;
        const sourceKind = stringValue(row.source).trim().toLowerCase();
        if (!seed && sourceKind && sourceKind !== 'cli') continue;
        let info;
        try {
          info = inspectFile(rolloutPath, sessionId, { rolloutPath, dbPath, authority: 'state_5.sqlite' });
        } catch { continue; }
        if (info.nativeSessionId !== sessionId) continue;
        if (row.cwd && !info.cwd) {
          info.cwd = String(row.cwd);
          const projectInfo = deriveProjectInfo(info.cwd);
          info.project = info.project || projectInfo.project || null;
          info.scope = info.scope || projectInfo.project_id || null;
        }
        if (row.source && !info.source) info.source = String(row.source);
        if (row.model_provider && !info.modelProvider) info.modelProvider = String(row.model_provider);
        const parentId = stringValue(firstDefined(row.parent_thread_id, row.parent_session_id)).trim();
        if (parentId && !info.parentNativeSessionId) {
          info.parentNativeSessionId = parentId;
          info.classification = 'subagent';
        }
        if (row.updated_at || row.created_at) info.lastModified = new Date(rowTimestamp(row) || Date.now()).toISOString();
        seen.add(sessionId);
        entries.push({
          sessionId,
          rolloutPath,
          dbPath,
          locator: { rolloutPath, dbPath, authority: 'state_5.sqlite' },
          info,
          mtime: rowTimestamp(row) || fsMod.statSync(rolloutPath).mtimeMs,
          authoritative: true,
        });
      }
    }
    return { entries, seen };
  }

  function fallbackEntries(seen) {
    const output = [];
    for (const rolloutPath of writeSafeWalk(sessionsRoot, fsMod, pathMod)) {
      const sessionId = rolloutIdFromPath(rolloutPath);
      if (!sessionId || seen.has(sessionId)) continue;
      const stat = statRollout(rolloutPath, fsMod, minFileSize);
      if (!stat) continue;
      let info;
      try { info = inspectFile(rolloutPath, sessionId, { rolloutPath, authority: 'rollout-fallback' }); } catch { continue; }
      if (info.nativeSessionId !== sessionId) continue;
      if (info.source && looksLikeInternalCodexPrompt(info.source)) continue;
      seen.add(sessionId);
      output.push({
        sessionId,
        rolloutPath,
        locator: { rolloutPath, authority: 'rollout-fallback' },
        info,
        mtime: stat.mtimeMs,
        authoritative: false,
      });
    }
    return output;
  }

  function freshEntries(query) {
    const authoritative = dbEntries();
    const entries = [...authoritative.entries, ...fallbackEntries(authoritative.seen)];
    return entries
      .filter(entry => !query.project || entry.info.project === query.project)
      .filter(entry => !query.cwd || entry.info.cwd === query.cwd)
      .filter(entry => query.includeSubagents || entry.info.classification !== 'subagent')
      .filter(entry => !query.suppressOwnedSubagents
        || !entry.info.parentNativeSessionId
        || !entries.some(candidate => candidate.info.nativeSessionId === entry.info.parentNativeSessionId))
      .sort((left, right) => right.mtime - left.mtime || left.sessionId.localeCompare(right.sessionId))
      .slice(0, MAX_DISCOVERY_SNAPSHOT_ENTRIES);
  }

  function entriesFromSnapshot(snapshot, offset, limit) {
    const entries = [];
    for (let index = offset; index < snapshot.length && entries.length < limit; index++) {
      const snapshotEntry = snapshot[index];
      const filePath = pathMod.resolve(snapshotEntry.rolloutPath);
      let info;
      try { info = inspectFile(filePath, '', snapshotEntry); } catch { continue; }
      entries.push({ ...snapshotEntry, rolloutPath: filePath, info, snapshotIndex: index });
    }
    return entries;
  }

  function prepareDiscovery(request = {}) {
    const query = discoveryQuery(request);
    const cursor = parseDiscoveryCursor(request.cursor);
    if (cursor) {
      if (!sameDiscoveryQuery(cursor.query, query)) throw adapterError('CODEX_SESSION_SOURCE_CURSOR_INVALID', 'query_mismatch');
      return { query, cursor, snapshot: cursor.snapshot };
    }
    return {
      query,
      cursor: null,
      snapshot: freshEntries(query).map(entry => ({
        rolloutPath: entry.rolloutPath,
        ...(entry.dbPath ? { dbPath: entry.dbPath } : {}),
        ...(entry.locator && entry.locator.authority ? { authority: entry.locator.authority } : {}),
      })),
    };
  }

  function refsForRequest(request = {}) {
    const state = prepareDiscovery(request);
    const limit = discoveryLimit(request);
    const start = state.cursor ? state.cursor.offset : 0;
    const acceptedStart = state.cursor ? state.cursor.accepted : 0;
    const page = entriesFromSnapshot(state.snapshot, start, Math.min(limit, DEFAULT_DISCOVERY_LIMIT - acceptedStart));
    const acceptedEnd = acceptedStart + page.length;
    const hasMore = page.length > 0
      && acceptedEnd < DEFAULT_DISCOVERY_LIMIT
      && page[page.length - 1].snapshotIndex + 1 < state.snapshot.length;
    return page.map((entry, index) => refForEntry({
      ...entry,
      discoveryCursor: hasMore && index === page.length - 1
        ? makeDiscoveryCursor(state.snapshot, entry.snapshotIndex + 1, acceptedEnd, state.query)
        : null,
    }));
  }

  function sourceForRef(ref) {
    const locator = normalizeLocator(ref && ref.sourceLocator);
    return resolveRolloutPath(locator);
  }

  function readFileEvents(ref, request = {}) {
    const resolved = sourceForRef(ref);
    const source = readFileBounded(resolved.path, fsMod, maxFileSize, 0);
    const parsed = recordsFromText(source.text);
    const metadata = sessionMetaFromRecords(parsed.records);
    const nativeSessionId = metadata.nativeSessionId || ref.nativeSessionId || rolloutIdFromPath(resolved.path);
    if (nativeSessionId !== ref.nativeSessionId) throw adapterError('CODEX_SESSION_SOURCE_SESSION_ID_MISMATCH', `${ref.nativeSessionId}:${nativeSessionId}`);
    const history = readHistory(nativeSessionId);
    const sourceHash = fingerprintSourceRevision({ content: sourceRevisionBytes(source.bytes, history) });
    const requestedRevision = stringValue(request.sourceRevision || request.sourceHash).trim();
    if (requestedRevision && requestedRevision !== sourceHash) {
      throw adapterError('CODEX_SESSION_SOURCE_REVISION_MISMATCH', `${requestedRevision}:${sourceHash}`);
    }
    const candidates = projectCanonicalRecords(parsed.records, { ...metadata, nativeSessionId }, history, adapterOptions);
    const cursor = asObject(request.cursor);
    const nativeCursor = cursor ? numberValue(firstDefined(cursor.sequence, cursor.offset, cursor.position), null) : numberValue(request.cursor, null);
    const historyCursor = cursor ? numberValue(firstDefined(cursor.historySequence, cursor.history_sequence), null) : null;
    const events = candidates.filter(event => {
      const provenance = event.provenance || {};
      if (nativeCursor !== null && provenance.nativeSequence !== undefined && !provenance.history && Number(provenance.nativeSequence) < nativeCursor) return false;
      if (historyCursor !== null && provenance.historySequence !== undefined && Number(provenance.historySequence) < historyCursor) return false;
      return true;
    });
    if (events.length > maxEvents) throw adapterError('CODEX_SESSION_SOURCE_EVENT_LIMIT');
    return { source, parsed, metadata, history, sourceHash, events };
  }

  const rawAdapter = {
    engineId: ENGINE_ID,
    protocolVersion: 1,
    probe: () => {
      const dbAvailable = knownDbPaths().some(dbPath => fsMod.existsSync(dbPath));
      const fallbackAvailable = fsMod.existsSync(sessionsRoot);
      const authoritative = dbEntries();
      const sourceCount = authoritative.entries.length + fallbackEntries(authoritative.seen).length;
      return {
        state: sourceCount > 0 ? 'verified' : (dbAvailable || fallbackAvailable ? 'reachable' : 'unavailable'),
        available: dbAvailable || fallbackAvailable,
        reachable: dbAvailable || fallbackAvailable,
        verified: sourceCount > 0,
        sourceCount,
      };
    },
    discover: function* discover(request = {}) {
      for (const ref of refsForRequest(request)) yield ref;
    },
    inspect(ref) {
      const resolved = sourceForRef(ref);
      return inspectFile(resolved.path, ref.nativeSessionId, resolved.locator);
    },
    read: function* read(ref, request = {}) {
      const result = readFileEvents(ref, request);
      for (const event of result.events) yield event;
    },
    validate(ref) {
      try {
        const resolved = sourceForRef(ref);
        const revision = inspectFile(resolved.path, ref.nativeSessionId, resolved.locator);
        if (revision.nativeSessionId !== ref.nativeSessionId) {
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
    listSessionRefs: refsForRequest,
    knownDbPaths,
    readHistory,
    readPathEvents(filePath, expectedSessionIdOrRef = '') {
      const resolved = pathMod.resolve(String(filePath || ''));
      const suppliedRef = asObject(expectedSessionIdOrRef) ? expectedSessionIdOrRef : null;
      const nativeSessionId = (suppliedRef && suppliedRef.nativeSessionId)
        || (typeof expectedSessionIdOrRef === 'string' ? expectedSessionIdOrRef : '')
        || rolloutIdFromPath(resolved)
        || pathMod.basename(resolved, '.jsonl');
      const ref = {
        engineId: ENGINE_ID,
        nativeSessionId,
        sourceLocator: suppliedRef && suppliedRef.sourceLocator
          ? suppliedRef.sourceLocator
          : { rolloutPath: resolved },
      };
      const revision = inspectFile(resolved, nativeSessionId, ref.sourceLocator);
      const result = readFileEvents(ref, { sourceRevision: revision.sourceRevision });
      const events = normalizeCanonicalSessionEvents(result.events, {
        engineId: ENGINE_ID,
        nativeSessionId: revision.nativeSessionId,
        sourceRevision: revision.sourceRevision,
      });
      if (events.length > maxEvents) throw adapterError('CODEX_SESSION_SOURCE_EVENT_LIMIT');
      return { ref, revision: { ...revision, sourceLocator: ref.sourceLocator }, events };
    },
    loadHistory(sessionIds = null) {
      return loadCodexHistory(historyPath, sessionIds, fsMod);
    },
    queryThreadRows(dbPath, sessionId = '') {
      return queryCodexThreadRows(dbPath, sessionId, { fs: fsMod });
    },
    isTrivialSession(skeleton) {
      return !!skeleton && skeleton.message_count < 1;
    },
    sessionFromRolloutPath(filePath, fallbackId = '') {
      const resolved = pathMod.resolve(String(filePath || ''));
      const sessionId = fallbackId || rolloutIdFromPath(resolved);
      const stat = statRollout(resolved, fsMod, minFileSize);
      if (!sessionId || !stat) return null;
      return { path: resolved, session_id: sessionId, mtime: stat.mtimeMs, engine: ENGINE_ID };
    },
    inspectPath(filePath, expectedSessionIdOrRef = '') {
      const resolved = pathMod.resolve(String(filePath || ''));
      const suppliedRef = asObject(expectedSessionIdOrRef) ? expectedSessionIdOrRef : null;
      const expectedSessionId = (suppliedRef && suppliedRef.nativeSessionId)
        || (typeof expectedSessionIdOrRef === 'string' ? expectedSessionIdOrRef : '');
      const locator = suppliedRef && suppliedRef.sourceLocator
        ? suppliedRef.sourceLocator
        : { rolloutPath: resolved };
      return inspectFile(resolved, expectedSessionId, locator);
    },
    resolveSessionRefPath(ref) { return sourceForRef(ref).path; },
  });
}

function buildCanonicalInputFromPath(filePath, options = {}, historyMap = null) {
  const resolved = pathDefault.resolve(String(filePath || ''));
  const source = createCodexSessionSourceAdapter({
    ...options,
    sessionsRoot: options.sessionsRoot || pathDefault.dirname(resolved),
    minFileSize: options.minFileSize === undefined ? 0 : options.minFileSize,
  });
  const ref = {
    engineId: ENGINE_ID,
    nativeSessionId: rolloutIdFromPath(resolved) || pathDefault.basename(resolved, '.jsonl'),
    sourceLocator: { rolloutPath: resolved },
  };
  const revision = source.inspectPath(resolved, ref.nativeSessionId);
  const events = [];
  // Use the raw adapter path only through its public source seam. A supplied
  // history map is a compatibility/testing input and remains adapter-owned.
  const history = historyFromMap(historyMap, revision.nativeSessionId);
  const nativeEvents = [];
  const sourceFile = (options.fs || fsDefault).readFileSync(resolved);
  const parsed = recordsFromText(sourceFile.toString('utf8'));
  const metadata = sessionMetaFromRecords(parsed.records);
  const effectiveHistory = historyMap instanceof Map
    ? history
    : source.readHistory(revision.nativeSessionId);
  const projected = projectCanonicalRecords(parsed.records, { ...metadata, nativeSessionId: revision.nativeSessionId }, effectiveHistory, options);
  const normalized = normalizeCanonicalSessionEvents(projected, {
    engineId: ENGINE_ID,
    nativeSessionId: revision.nativeSessionId,
    sourceRevision: revision.sourceRevision,
  });
  nativeEvents.push(...normalized);
  events.push(...nativeEvents);
  const context = {
    engine: ENGINE_ID,
    source: revision.classification === 'subagent' ? 'subagent' : 'codex',
    nativeSessionId: revision.nativeSessionId,
    sourceRevision: revision.sourceRevision,
    sourceSize: revision.sourceSize,
    sourceLocator: revision.sourceLocator,
    project: revision.project,
    project_id: revision.scope,
    project_path: revision.cwd,
    parentNativeSessionId: revision.parentNativeSessionId,
    first_ts: revision.firstTs,
    last_ts: revision.lastTs,
  };
  return {
    path: resolved,
    ref,
    revision,
    events,
    skeleton: makeSkeleton(events, context),
    evidence: extractEvidence(events, 3000),
  };
}

function loadCodexHistory(historyPath, sessionIds = null, fsMod = fsDefault) {
  const map = new Map();
  const allow = sessionIds && sessionIds.length > 0 ? new Set(sessionIds.map(String)) : null;
  try {
    if (!fsMod.existsSync(historyPath)) return map;
    String(fsMod.readFileSync(historyPath, 'utf8')).split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const entry = JSON.parse(line);
        const sessionId = String(entry.session_id || entry.sessionId || '').trim();
        if (!sessionId || (allow && !allow.has(sessionId))) return;
        const text = cleanText(entry.text || entry.message, DEFAULT_MAX_TEXT);
        if (!text) return;
        if (!map.has(sessionId)) map.set(sessionId, []);
        map.get(sessionId).push({ ts: entry.ts, text, historySequence: index });
      } catch { /* skip malformed history */ }
    });
  } catch { /* optional */ }
  return map;
}

function buildCodexInput(rolloutPath, historyMap = new Map(), options = {}) {
  const input = buildCanonicalInputFromPath(rolloutPath, options, historyMap);
  return { skeleton: input.skeleton, evidence: input.evidence, events: input.events, revision: input.revision, ref: input.ref };
}

module.exports = {
  ENGINE_ID,
  DEFAULT_MAX_FILE_SIZE,
  DEFAULT_MAX_EVENTS,
  createCodexSessionSourceAdapter,
  createCodexSessionSource: createCodexSessionSourceAdapter,
  buildCanonicalInputFromPath,
  buildCodexInput,
  loadCodexHistory,
  cleanText,
  redactSecrets,
  projectCanonicalRecords,
  _internal: {
    recordsFromText,
    sessionMetaFromRecords,
    extractMessageText,
    queryCodexThreadRows,
    rolloutIdFromPath,
    normalizeLocator,
    sourceRevisionBytes,
    looksLikeInternalCodexPrompt,
    nativeExitCodeFromText,
    isProcessExecutionTool,
  },
};
