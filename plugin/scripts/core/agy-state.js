'use strict';

const path = require('path');

const AGY_TOOL_TYPES = Object.freeze({
  RUN_COMMAND: 'Bash',
  VIEW_FILE: 'Read',
  LIST_DIRECTORY: 'Glob',
  SEARCH_WEB: 'WebSearch',
});

function canonicalizeCwd(cwd, deps = {}) {
  const pathMod = deps.path || path;
  const realpath = deps.realpath;
  const resolved = pathMod.resolve(String(cwd || '.'));
  if (typeof realpath !== 'function') return resolved;
  try { return realpath(resolved); } catch { return resolved; }
}

function parseConversationCache(content) {
  const parsed = JSON.parse(String(content || '{}'));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new TypeError('agy_conversation_cache_invalid');
  }
  return parsed;
}

function getCachedConversationId(cache, cwd) {
  if (!cache || typeof cache !== 'object') return '';
  return String(cache[cwd] || '').trim();
}

function captureConversationId(beforeCache, afterCache, cwd, expectedId = '') {
  const expected = String(expectedId || '').trim();
  const after = getCachedConversationId(afterCache, cwd);
  if (expected) return after || expected;
  const before = getCachedConversationId(beforeCache, cwd);
  return after && after !== before ? after : '';
}

function splitJsonLines(buffer, chunk) {
  const combined = `${buffer || ''}${chunk || ''}`;
  const lines = combined.split('\n');
  return { lines: lines.slice(0, -1).filter(Boolean), rest: lines[lines.length - 1] || '' };
}

function toolNameFromCall(call = {}) {
  return String(call.name || call.tool_name || (call.function && call.function.name) || 'Tool');
}

function toolInputFromCall(call = {}) {
  const value = call.args ?? call.arguments ?? call.parameters ?? (call.function && call.function.arguments) ?? {};
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return { input: value }; }
}

function normalizeTranscriptRecord(record) {
  if (!record || typeof record !== 'object') return [];
  const out = [];
  const type = String(record.type || '').toUpperCase();

  if (type === 'PLANNER_RESPONSE' && Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      out.push({
        type: 'tool_use',
        toolName: toolNameFromCall(call),
        toolInput: toolInputFromCall(call),
      });
    }
  }

  if (AGY_TOOL_TYPES[type]) {
    out.push({
      type: 'tool_result',
      toolName: AGY_TOOL_TYPES[type],
      status: String(record.status || '').toUpperCase(),
    });
  }
  return out;
}

function selectFinalResponse(records) {
  let lastUserIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record && record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') lastUserIndex = i;
  }
  let finalText = '';
  for (const record of records.slice(lastUserIndex + 1)) {
    if (!record || record.type !== 'PLANNER_RESPONSE') continue;
    if (String(record.status || '').toUpperCase() !== 'DONE') continue;
    const text = typeof record.content === 'string' ? record.content.trim() : '';
    if (text) finalText = text;
  }
  return finalText;
}

function recordsAfterLatestUser(records) {
  let lastUserIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record && record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') lastUserIndex = i;
  }
  return lastUserIndex >= 0 ? records.slice(lastUserIndex) : [];
}

function isLockStale(lock, opts = {}) {
  if (!lock || typeof lock !== 'object') return true;
  const now = Number(opts.now || Date.now());
  const maxAgeMs = Number(opts.maxAgeMs || 0);
  const createdAt = Number(lock.createdAt || 0);
  const pid = Number(lock.pid || 0);
  if (!pid || !createdAt) return true;
  if (typeof opts.isProcessAlive === 'function') {
    if (opts.isProcessAlive(pid)) return false;
    return true;
  }
  if (maxAgeMs > 0 && now - createdAt > maxAgeMs) return true;
  return false;
}

function isFallbackEligible({ phase = 'preflight', executionStarted = false } = {}) {
  return phase === 'preflight' && !executionStarted;
}

function collectDescendantPids(rows, rootPid) {
  const children = new Map();
  for (const row of rows || []) {
    const pid = Number(row && row.pid);
    const ppid = Number(row && row.ppid);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const visit = (pid) => {
    for (const child of children.get(pid) || []) {
      visit(child);
      out.push(child);
    }
  };
  visit(Number(rootPid));
  return out;
}

module.exports = {
  AGY_TOOL_TYPES,
  canonicalizeCwd,
  parseConversationCache,
  getCachedConversationId,
  captureConversationId,
  splitJsonLines,
  normalizeTranscriptRecord,
  selectFinalResponse,
  recordsAfterLatestUser,
  isLockStale,
  isFallbackEligible,
  collectDescendantPids,
};
