'use strict';

/**
 * Engine-neutral session analytics.
 *
 * The input is the canonical event contract.  Native record types, paths, and
 * storage layouts belong to a Session Source Adapter and never appear here.
 */

function textValue(value) {
  return value === undefined || value === null ? '' : String(value);
}

function timestampMs(value) {
  const parsed = new Date(textValue(value)).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenizeForRepetition(text) {
  const input = textValue(text).toLowerCase();
  if (!input) return new Set();
  const out = new Set(input.match(/[a-z0-9_./-]{2,}/g) || []);
  const hanRuns = input.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of hanRuns) {
    if (run.length === 2) out.add(run);
    else for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function overlapRate3(a, b, c) {
  if (!a.size || !b.size || !c.size) return 0;
  const union = new Set([...a, ...b, ...c]);
  let common = 0;
  for (const token of a) if (b.has(token) && c.has(token)) common++;
  return union.size ? common / union.size : 0;
}

function parseGitDiffLines(text) {
  const source = textValue(text);
  if (!source) return 0;
  let best = 0;
  const shortstat = source.match(/(\d+)\s+insertions?\(\+\)(?:,\s*(\d+)\s+deletions?\(-\))?/i);
  if (shortstat) best = Math.max(best, Number(shortstat[1] || 0) + Number(shortstat[2] || 0));
  let numstatTotal = 0;
  for (const row of source.split('\n')) {
    const match = row.match(/^\s*(\d+|-)\s+(\d+|-)\s+.+$/);
    if (!match) continue;
    numstatTotal += (match[1] === '-' ? 0 : Number(match[1])) + (match[2] === '-' ? 0 : Number(match[2]));
  }
  return Math.max(best, numstatTotal);
}

function parseToolText(event) {
  const text = textValue(event && event.text);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseFilePath(tool, value) {
  const object = value && typeof value === 'object' ? value : {};
  return textValue(object.file_path || object.filePath || object.path || object.filename).trim();
}

function parseCommand(value) {
  const object = value && typeof value === 'object' ? value : {};
  return textValue(object.command || object.cmd || object.script).trim();
}

function makeSkeleton(events, context = {}) {
  const input = Array.isArray(events) ? events.filter(Boolean) : [];
  const userEvents = input.filter(event => event.actor === 'user' && event.kind === 'message' && textValue(event.text).trim());
  const toolCalls = input.filter(event => event.kind === 'tool_call');
  const toolResults = input.filter(event => event.kind === 'tool_result');
  const timestamps = input.map(event => ({ value: event.timestamp, ms: timestampMs(event.timestamp) })).filter(item => item.ms > 0);
  const userTexts = userEvents.map(event => textValue(event.text));
  const toolCounts = {};
  const fileStates = new Map();
  const fileDirs = new Set();
  let gitCommitted = false;
  let retrySequences = 0;
  let lastToolName = null;
  let gitDiffLines = 0;
  let seenToolError = false;
  let seenToolSuccessAfterError = false;
  let fileChurn = 0;

  const markModified = filePath => {
    if (!filePath) return;
    const previous = fileStates.get(filePath) || 0;
    if (previous === 2) fileChurn++;
    fileStates.set(filePath, 1);
  };
  const markRollback = filePath => {
    if (!filePath) return;
    if ((fileStates.get(filePath) || 0) === 1) fileStates.set(filePath, 2);
  };
  const markAllRollback = () => {
    for (const [filePath, state] of fileStates) if (state === 1) fileStates.set(filePath, 2);
  };

  for (const event of toolCalls) {
    const tool = textValue(event.tool || 'unknown').trim() || 'unknown';
    toolCounts[tool] = (toolCounts[tool] || 0) + 1;
    if (tool === lastToolName) retrySequences++;
    lastToolName = tool;
    const inputValue = parseToolText(event);
    const filePath = parseFilePath(tool, inputValue);
    if (filePath) {
      const segments = filePath.split(/[\\/]/).filter(Boolean);
      if (segments.length > 1) fileDirs.add(segments.slice(-2, -1)[0]);
    }
    if (/^(?:write|edit|multiedit|file_change)$/i.test(tool)) markModified(filePath);
    const command = parseCommand(inputValue);
    if (command) {
      if (/\bgit\s+(?:commit|push)\b/i.test(command)) gitCommitted = true;
      if (/\bgit\s+(?:reset\s+--hard|checkout\s+--\s*\.)\b/i.test(command)) markAllRollback();
      const rollback = command.match(/\bgit\s+(?:checkout\s+--|restore\b(?:\s+--\S+)*\s+)(.+)$/i);
      if (rollback) for (const target of rollback[1].split(/\s+/)) {
        const clean = target.replace(/^['"]|['"]$/g, '');
        if (clean === '.' || clean === '*') markAllRollback();
        else markRollback(clean);
      }
    }
  }

  for (const event of toolResults) {
    const outcome = event.outcome && typeof event.outcome === 'object' ? event.outcome : {};
    const isError = outcome.error === true || outcome.isError === true;
    if (isError) seenToolError = true;
    else if (seenToolError) seenToolSuccessAfterError = true;
    if (isError && /diff|stat|changed|insertions?|deletions?/i.test(textValue(event.text))) {
      gitDiffLines = Math.max(gitDiffLines, parseGitDiffLines(event.text));
    }
    if (/files?\s+changed|insertions?\(\+\)|^\s*\d+\s+\d+\s+\S+/im.test(textValue(event.text))) {
      gitDiffLines = Math.max(gitDiffLines, parseGitDiffLines(event.text));
    }
  }

  const sortedTimes = timestamps.sort((a, b) => a.ms - b.ms);
  const firstTs = sortedTimes[0] ? new Date(sortedTimes[0].ms).toISOString() : (context.first_ts || null);
  const lastTs = sortedTimes[sortedTimes.length - 1] ? new Date(sortedTimes[sortedTimes.length - 1].ms).toISOString() : (context.last_ts || null);
  const durationMin = firstTs && lastTs ? Math.round((timestampMs(lastTs) - timestampMs(firstTs)) / 60000) : 0;
  const userTimes = userEvents.map(event => timestampMs(event.timestamp)).filter(Boolean).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < userTimes.length; i++) {
    const seconds = Math.round((userTimes[i] - userTimes[i - 1]) / 1000);
    if (seconds > 0 && seconds <= 2 * 60 * 60) gaps.push(seconds);
  }
  let semanticRepetition = 0;
  for (let i = 2; i < userTexts.length; i++) {
    semanticRepetition = Math.max(semanticRepetition, overlapRate3(
      tokenizeForRepetition(userTexts[i - 2]),
      tokenizeForRepetition(userTexts[i - 1]),
      tokenizeForRepetition(userTexts[i]),
    ));
  }
  const models = [...new Set(input.map(event => event.provenance && event.provenance.model).filter(Boolean))];

  return {
    session_id: textValue(context.nativeSessionId || context.session_id || (input[0] && input[0].nativeSessionId)),
    user_snippets: userTexts.slice(0, 10).map(text => text.slice(0, 100)),
    tool_counts: toolCounts,
    total_tool_calls: toolCalls.length,
    models,
    git_committed: gitCommitted,
    first_ts: firstTs,
    last_ts: lastTs,
    message_count: userEvents.length,
    duration_min: durationMin,
    project: context.project || null,
    project_id: context.project_id || context.scope || null,
    project_path: context.project_path || context.cwd || null,
    branch: context.branch || null,
    file_dirs: [...fileDirs].slice(0, 5),
    intent: userTexts.find(text => text.length >= 15 && !text.startsWith('[Request interrupted'))?.slice(0, 80) || null,
    inter_message_gaps: gaps,
    tool_error_count: toolResults.filter(event => event.outcome && event.outcome.error === true).length,
    retry_sequences: retrySequences,
    longest_pause_sec: gaps.length ? Math.max(...gaps) : 0,
    avg_pause_sec: gaps.length ? Math.round(gaps.reduce((sum, value) => sum + value, 0) / gaps.length) : 0,
    semantic_repetition: Number(semanticRepetition.toFixed(3)),
    file_churn: fileChurn,
    git_diff_lines: gitDiffLines,
    error_recovered: !!(seenToolError && seenToolSuccessAfterError),
    engine: context.engine || input[0]?.engineId || null,
    source: context.source || null,
    parent_session_id: context.parentNativeSessionId || context.parent_session_id || null,
    source_revision: context.sourceRevision || context.sourceHash || input[0]?.sourceRevision || null,
    source_size: Number(context.sourceSize || context.source_size || 0) || 0,
    source_locator: context.sourceLocator || context.source_locator || null,
  };
}

function extractEvidence(events, budget = 3000) {
  const totalBudget = Math.max(600, Number(budget) || 3000);
  const userBudget = Math.floor(totalBudget / 3);
  const toolBudget = Math.floor(totalBudget / 3);
  const resultBudget = totalBudget - userBudget - toolBudget;
  const evidence = { user_messages: [], tool_traces: [], key_results: [], file_anchors: [] };
  const seen = { user: new Set(), tool: new Set(), result: new Set(), file: new Set() };
  const used = { user: 0, tool: 0, result: 0 };
  const add = (bucket, key, value, max) => {
    const normalized = textValue(value).replace(/\s+/g, ' ').trim();
    if (!normalized || seen[key].has(normalized) || used[key] >= max) return;
    const clipped = normalized.slice(0, max - used[key]);
    if (clipped.length < 12) return;
    bucket.push(clipped);
    seen[key].add(normalized);
    used[key] += clipped.length;
  };
  for (const event of Array.isArray(events) ? events : []) {
    if (event.actor === 'user' && event.kind === 'message') add(evidence.user_messages, 'user', event.text, userBudget);
    if (event.actor === 'assistant' && event.kind === 'message') {
      add(evidence.key_results, 'result', event.text, resultBudget);
    }
    if (event.kind === 'tool_call') {
      const input = parseToolText(event);
      const tool = textValue(event.tool || 'unknown');
      add(evidence.tool_traces, 'tool', `${tool} ${event.text}`, toolBudget);
      for (const key of ['file_path', 'filePath', 'path', 'workdir', 'cwd']) {
        const anchor = input[key];
        if (typeof anchor === 'string' && anchor && !seen.file.has(anchor)) {
          evidence.file_anchors.push(anchor);
          seen.file.add(anchor);
        }
      }
    }
    if (event.kind === 'tool_result' && event.outcome && event.outcome.error) {
      add(evidence.key_results, 'result', `tool_result error: ${event.text}`, resultBudget);
    }
  }
  evidence.user_messages = evidence.user_messages.slice(0, 8);
  evidence.tool_traces = evidence.tool_traces.slice(0, 12);
  evidence.key_results = evidence.key_results.slice(0, 6);
  evidence.file_anchors = evidence.file_anchors.slice(0, 12);
  return evidence;
}

function extractPivotPoints(events) {
  const pivots = [];
  let lastIntent = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (event.actor === 'user' && event.kind === 'message') {
      const text = textValue(event.text);
      if (text.length < 20) continue;
      const shift = ['改成', '换成', '不对', '重新', '算了', '还是', '改主意', 'change to', 'switch to', 'actually', 'wait', 'no', 'instead']
        .some(keyword => text.toLowerCase().includes(keyword.toLowerCase()));
      if (shift && lastIntent && pivots.length < 3) pivots.push(`Shift: "${lastIntent.slice(0, 40)}" → "${text.slice(0, 40)}"`);
      lastIntent = text.slice(0, 80);
    }
    if (event.kind === 'tool_result' && event.outcome && event.outcome.error && pivots.length < 3) {
      pivots.push(`${event.tool || 'Tool'} error`);
    }
  }
  return pivots;
}

function detectSignificantSession(skeleton) {
  if (!skeleton || typeof skeleton !== 'object') return { significant: false, reasons: [] };
  const reasons = [];
  if (Number(skeleton.git_diff_lines || 0) > 50 && Number(skeleton.tool_error_count || 0) > 0 && skeleton.error_recovered) {
    reasons.push('large_change_with_error_recovery');
  }
  if (Number(skeleton.duration_min || 0) > 60 && Number(skeleton.retry_sequences || 0) > 5) {
    reasons.push('long_debug_retry_loop');
  }
  return { significant: reasons.length > 0, reasons };
}

module.exports = {
  makeSkeleton,
  extractEvidence,
  extractPivotPoints,
  detectSignificantSession,
  _internal: { parseGitDiffLines, tokenizeForRepetition, overlapRate3 },
};
