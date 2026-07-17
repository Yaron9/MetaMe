'use strict';

const path = require('path');

const AGY_TOOL_TYPES = Object.freeze({
  RUN_COMMAND: 'Bash',
  VIEW_FILE: 'Read',
  LIST_DIRECTORY: 'Glob',
  SEARCH_WEB: 'WebSearch',
});

const AGY_EVIDENCE_TYPES = new Set([
  ...Object.keys(AGY_TOOL_TYPES),
  'GENERIC',
  'ERROR_MESSAGE',
]);

const FINALIZATION_EVIDENCE_LIMIT = 10;
const FINALIZATION_CONTENT_LIMIT = 14000;

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
    // agy writes the natural-language preamble and its tool call in the same
    // planner record. That preamble describes intended work; it is not a
    // terminal answer. Accepting it makes MetaMe reply "I will ..." and then
    // silently drop the tool result and the empty final planner record.
    if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) continue;
    const text = typeof record.content === 'string' ? record.content.trim() : '';
    if (text) finalText = text;
  }
  return finalText;
}

function advanceTranscriptCursor(records, cursor = 0, baseline = 0) {
  const list = Array.isArray(records) ? records : [];
  const start = Math.min(list.length, Math.max(0, Number(cursor || 0), Number(baseline || 0)));
  return {
    records: list.slice(start),
    cursor: list.length,
  };
}

function recordsAfterLatestUser(records) {
  let lastUserIndex = -1;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record && record.type === 'USER_INPUT' && record.source === 'USER_EXPLICIT') lastUserIndex = i;
  }
  return lastUserIndex >= 0 ? records.slice(lastUserIndex) : [];
}

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function collectToolEvidence(records, opts = {}) {
  const limit = Number(opts.limit || FINALIZATION_EVIDENCE_LIMIT);
  const maxChars = Number(opts.maxChars || FINALIZATION_CONTENT_LIMIT);
  const out = [];
  let used = 0;
  for (const record of records || []) {
    if (!record || typeof record !== 'object') continue;
    const type = String(record.type || '').toUpperCase();
    if (!AGY_EVIDENCE_TYPES.has(type)) continue;
    const content = normalizeWhitespace(record.content || record.message || record.error || '');
    if (!content) continue;
    const remaining = maxChars - used;
    if (remaining <= 0 || out.length >= limit) break;
    const clipped = content.slice(0, remaining);
    used += clipped.length;
    out.push({
      type,
      status: String(record.status || '').toUpperCase(),
      content: clipped,
    });
  }
  return out;
}

function buildFinalizationPrompt(originalPrompt, records, opts = {}) {
  const evidence = collectToolEvidence(records, opts);
  if (evidence.length === 0) return '';
  const userText = normalizeWhitespace(originalPrompt).slice(0, 2000);
  const evidenceText = evidence.map((item, index) => [
    `## 材料 ${index + 1}: ${item.type}${item.status ? ` / ${item.status}` : ''}`,
    item.content,
  ].join('\n')).join('\n\n');
  return [
    '上一轮已经执行了搜索或工具调用，但没有给用户输出最终回答。现在必须补上最终回答。',
    '',
    '严格要求：',
    '1. 不要再调用工具，不要继续搜索。',
    '2. 只基于下面“已有工具材料”总结给用户。',
    '3. 如果材料足够，直接给结论和关键依据。',
    '4. 如果材料不足、工具失败、或无法得出结论，明确告诉用户哪里不足/哪里失败。',
    '5. 用中文回答，简明但要可执行。',
    '',
    `用户原始问题：${userText || '(未捕获)'}`,
    '',
    '已有工具材料：',
    evidenceText,
  ].join('\n');
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
  advanceTranscriptCursor,
  recordsAfterLatestUser,
  collectToolEvidence,
  buildFinalizationPrompt,
  isLockStale,
  isFallbackEligible,
  collectDescendantPids,
};
