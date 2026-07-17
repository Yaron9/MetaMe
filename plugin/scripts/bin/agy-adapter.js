#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const {
  canonicalizeCwd,
  parseConversationCache,
  getCachedConversationId,
  captureConversationId,
  normalizeTranscriptRecord,
  selectFinalResponse,
  advanceTranscriptCursor,
  recordsAfterLatestUser,
  buildFinalizationPrompt,
  isLockStale,
  collectDescendantPids,
} = require('../core/agy-state');
const { normalizeAgyModel } = require('../core/agy-model');

const AGY_HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const CACHE_FILE = path.join(AGY_HOME, 'cache', 'last_conversations.json');
const LOCK_DIR = path.join(os.homedir(), '.metame', 'runtime', 'agy-locks');
const MAX_PROMPT_BYTES = 512 * 1024;
const FINAL_POLL_INTERVAL_MS = 500;
const AUTH_REFRESH_RETRY_DELAY_MS = 1500;
const NONINTERACTIVE_AUTH_PATTERNS = [
  /starting oauth authentication flow/i,
  /authentication required/i,
  /waiting for authentication/i,
  /if your browser didn't open/i,
  /open the url below in your browser/i,
  /please (open|visit|go to)/i,
  /accounts\.google\.com/i,
  /metame blocked unattended browser open/i,
  /auth timed out/i,
  /authentication timed out/i,
];

function parseArgs(argv) {
  const out = { cwd: process.cwd(), model: 'auto', sessionId: '', timeoutMs: 20 * 60 * 1000, readOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--cwd') out.cwd = argv[++i];
    else if (value === '--model') out.model = argv[++i];
    else if (value === '--session') out.sessionId = argv[++i];
    else if (value === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (value === '--read-only') out.readOnly = true;
  }
  out.cwd = canonicalizeCwd(out.cwd, { realpath: fs.realpathSync.native });
  return out;
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function readCache(retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try { return parseConversationCache(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (err) {
      if (err.code === 'ENOENT') return {};
      if (attempt === retries) throw err;
    }
  }
  return {};
}

function getReadCache(deps = {}) {
  return deps.readCache || readCache;
}

function getReadTranscript(deps = {}) {
  return deps.readTranscript || readTranscript;
}

function transcriptFile(sessionId) {
  return path.join(AGY_HOME, 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

function readTranscript(sessionId) {
  const file = transcriptFile(sessionId);
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  return lines.flatMap((line, index) => {
    try { return [JSON.parse(line)]; } catch (err) {
      if (index === lines.length - 1 && !content.endsWith('\n')) return [];
      throw err;
    }
  });
}

function listRecentTranscriptSessionIds(sinceMs = 0, deps = {}) {
  const fsMod = deps.fs || fs;
  const brainDir = deps.brainDir || path.join(AGY_HOME, 'brain');
  const threshold = Number(sinceMs || 0) - 1000;
  let entries = [];
  try {
    entries = fsMod.readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter(entry => entry && entry.isDirectory && entry.isDirectory())
    .map((entry) => {
      const sessionId = entry.name;
      const file = path.join(brainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
      try {
        const stat = fsMod.statSync(file);
        return { sessionId, mtimeMs: Number(stat.mtimeMs || 0) };
      } catch {
        return null;
      }
    })
    .filter(item => item && item.mtimeMs >= threshold)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 20)
    .map(item => item.sessionId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForArtifacts(before, options, minRecordCount = 0, deps = {}) {
  const wait = deps.sleep || sleep;
  const readCacheFn = getReadCache(deps);
  const readTranscriptFn = getReadTranscript(deps);
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const after = readCacheFn();
    for (const sessionId of candidateSessionIds(before, after, options, deps)) {
      try {
        const records = readTranscriptFn(sessionId);
        const baseline = getBaselineRecordCount(deps.baselineRecordCounts, sessionId, minRecordCount);
        if (records.length > baseline) return { sessionId, records, minRecordCount: baseline };
      } catch { /* retry */ }
    }
    if (attempt < 20) await wait(100);
  }
  return null;
}

function readFinalResponseArtifact(before, options, minRecordCount = 0, deps = {}) {
  const readCacheFn = getReadCache(deps);
  const readTranscriptFn = getReadTranscript(deps);
  const after = readCacheFn();
  for (const sessionId of candidateSessionIds(before, after, options, deps)) {
    const allRecords = readTranscriptFn(sessionId);
    const baseline = getBaselineRecordCount(deps.baselineRecordCounts, sessionId, minRecordCount);
    if (allRecords.length <= baseline) continue;
    const newRecords = allRecords.slice(baseline);
    const records = recordsAfterLatestUser(newRecords);
    const text = selectFinalResponse(records);
    if (text) return { sessionId, text, records };
  }
  return null;
}

function getRecentSessionIds(deps = {}) {
  if (Array.isArray(deps.recentSessionIds)) return deps.recentSessionIds;
  if (typeof deps.listRecentSessionIds === 'function') return deps.listRecentSessionIds();
  if (!deps.startedAtMs) return [];
  return listRecentTranscriptSessionIds(deps.startedAtMs, deps);
}

function candidateSessionIds(beforeCache, afterCache, options, deps = {}) {
  const out = [];
  const add = (value) => {
    const id = String(value || '').trim();
    if (id && !out.includes(id)) out.push(id);
  };
  add(captureConversationId(beforeCache, afterCache, options.cwd, options.sessionId));
  add(options.sessionId);
  add(getCachedConversationId(afterCache, options.cwd));
  add(getCachedConversationId(beforeCache, options.cwd));
  for (const sessionId of getRecentSessionIds(deps)) add(sessionId);
  return out;
}

function getBaselineRecordCount(baselineRecordCounts, sessionId, fallback = 0) {
  const explicit = Number(fallback || 0);
  if (!baselineRecordCounts || typeof baselineRecordCounts !== 'object') return explicit;
  const value = Number(baselineRecordCounts[sessionId] || 0);
  return Math.max(explicit, Number.isFinite(value) ? value : 0);
}

function createTranscriptEventState() {
  return { cursors: {}, sessionId: '' };
}

function emitTranscriptDelta(sessionId, records, baseline, deps = {}) {
  if (typeof deps.onEvent !== 'function') return;
  const state = deps.eventState || createTranscriptEventState();
  const id = String(sessionId || '').trim();
  if (!id) return;
  if (state.sessionId !== id) {
    state.sessionId = id;
    deps.onEvent({ type: 'session', session_id: id });
  }
  const currentCursor = Object.prototype.hasOwnProperty.call(state.cursors, id)
    ? state.cursors[id]
    : baseline;
  const delta = advanceTranscriptCursor(records, currentCursor, baseline);
  state.cursors[id] = delta.cursor;
  for (const record of delta.records) {
    for (const event of normalizeTranscriptRecord(record)) deps.onEvent(event);
  }
}

function pollTranscriptEvents(beforeCache, options, minRecordCount, deps = {}) {
  if (typeof deps.onEvent !== 'function') return;
  const readCacheFn = getReadCache(deps);
  const readTranscriptFn = getReadTranscript(deps);
  const afterCache = readCacheFn();
  for (const sessionId of candidateSessionIds(beforeCache, afterCache, options, deps)) {
    try {
      const records = readTranscriptFn(sessionId);
      const baseline = getBaselineRecordCount(deps.baselineRecordCounts, sessionId, minRecordCount);
      if (records.length <= baseline) continue;
      emitTranscriptDelta(sessionId, records, baseline, deps);
      return;
    } catch { /* transcript may be between atomic writes */ }
  }
}

function captureBaselineRecordCounts(beforeCache, options, readTranscriptFn) {
  const out = {};
  for (const sessionId of candidateSessionIds(beforeCache, beforeCache, options)) {
    try { out[sessionId] = readTranscriptFn(sessionId).length; } catch { out[sessionId] = 0; }
  }
  return out;
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function lockFileFor(options) {
  const key = `cwd:${options.cwd}`;
  return path.join(LOCK_DIR, `${crypto.createHash('sha256').update(key).digest('hex')}.lock`);
}

function acquireLock(options) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const file = lockFileFor(options);
  const token = crypto.randomUUID();
  const record = { pid: process.pid, token, createdAt: Date.now(), cwd: options.cwd, sessionId: options.sessionId || '' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.closeSync(fd);
      return () => {
        try {
          const current = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (current.token === token) fs.unlinkSync(file);
        } catch { /* best effort */ }
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let current = null;
      try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* stale */ }
      if (!isLockStale(current, { maxAgeMs: options.timeoutMs + 60_000, isProcessAlive })) return null;
      try { fs.unlinkSync(file); } catch { return null; }
    }
  }
  return null;
}

function buildAgyArgs(options, prompt, agyBin) {
  const args = ['-q', '/dev/null', agyBin, '--print-timeout', `${Math.max(1, Math.ceil(options.timeoutMs / 1000))}s`];
  if (options.logFile) args.push('--log-file', options.logFile);
  if (!options.readOnly) args.push('--dangerously-skip-permissions');
  if (options.sessionId) args.push('--conversation', options.sessionId);
  // agy executes tools from its own scratch directory. Register the MetaMe
  // project explicitly so file tools can resolve and access the requested cwd.
  if (options.cwd) args.push('--add-dir', options.cwd);
  args.push('--model', normalizeAgyModel(options.model));
  args.push('-p', prompt);
  return args;
}

function listDescendantPids(rootPid) {
  try {
    const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
    const rows = output.split('\n').map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      return { pid, ppid };
    });
    return collectDescendantPids(rows, rootPid);
  } catch { return []; }
}

function terminateTree(child, signal) {
  for (const pid of listDescendantPids(child.pid)) {
    try { process.kill(pid, signal); } catch { /* already exited */ }
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { } }
}

function createOpenBlockerDir(deps = {}) {
  const fsMod = deps.fs || fs;
  const base = deps.openBlockerBase || os.tmpdir();
  const dir = fsMod.mkdtempSync(path.join(base, 'metame-agy-open-blocker-'));
  const openPath = path.join(dir, 'open');
  fsMod.writeFileSync(openPath, [
    '#!/bin/sh',
    'echo "METAME blocked unattended browser open: $*" >&2',
    'exit 73',
    '',
  ].join('\n'), 'utf8');
  fsMod.chmodSync(openPath, 0o755);
  return {
    dir,
    cleanup: () => {
      try { fsMod.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

function spawnAgy(options, prompt, deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const agyBin = deps.agyBin || process.env.AGY_BIN || 'agy';
  const scriptBin = deps.scriptBin || '/usr/bin/script';
  const logFile = deps.logFile || path.join(os.tmpdir(), `metame-agy-${process.pid}-${Date.now()}.log`);
  if (process.platform !== 'darwin' && !deps.allowAnyPlatform) {
    return Promise.resolve({ error: { code: 'AGY_UNSUPPORTED_PLATFORM', message: 'agy 后台适配器当前仅支持 macOS。' } });
  }
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let finished = false;
    let polledLogOutput = '';
    const openBlocker = deps.openBlocker || createOpenBlockerDir(deps);
    const child = spawnFn(scriptBin, buildAgyArgs({ ...options, logFile }, prompt, agyBin), {
      cwd: options.cwd,
      env: {
        ...process.env,
        BROWSER: process.env.METAME_AGY_BROWSER || '/usr/bin/false',
        METAME_INTERNAL_PROMPT: '1',
        METAME_AGY_UNATTENDED: '1',
        PATH: `${openBlocker.dir}${path.delimiter}${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), 15_000);
    let timedOut = false;
    let interrupted = false;
    const terminate = deps.terminateTree || terminateTree;
    const stop = (signal) => terminate(child, signal);
    const timeoutPaddingMs = deps.timeoutPaddingMs ?? 5_000;
    const killAfterMs = deps.killAfterMs ?? 5_000;
    const forceFinishAfterMs = deps.forceFinishAfterMs ?? 7_000;
    const finalPollIntervalMs = deps.finalPollIntervalMs ?? FINAL_POLL_INTERVAL_MS;
    const authLogPollIntervalMs = deps.authLogPollIntervalMs ?? 250;
    let killTimer = null;
    let forceFinishTimer = null;
    let finalPollTimer = null;
    let authLogPollTimer = null;
    const requestFinalStop = () => {
      stop('SIGTERM');
      const hardKillTimer = setTimeout(() => stop('SIGKILL'), killAfterMs);
      if (typeof hardKillTimer.unref === 'function') hardKillTimer.unref();
    };
    const pollFinalResponse = () => {
      if (finished || !deps.beforeCache) return;
      pollTranscriptEvents(deps.beforeCache, options, Number(deps.minRecordCount || 0), deps);
      let finalResponse = null;
      try {
        finalResponse = readFinalResponseArtifact(
          deps.beforeCache,
          options,
          Number(deps.minRecordCount || 0),
          deps
        );
      } catch { return; }
      if (!finalResponse) return;
      requestFinalStop();
      finish({ code: 0, output, errorOutput, earlyFinal: finalResponse });
    };
    const requestStop = (reason) => {
      if (reason === 'timeout') timedOut = true;
      else interrupted = true;
      stop('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => stop('SIGKILL'), killAfterMs);
      if (!forceFinishTimer) {
        forceFinishTimer = setTimeout(() => finish({ error: timedOut
          ? { code: 'AGY_TIMEOUT', message: `agy 超过 ${Math.ceil(options.timeoutMs / 1000)} 秒未完成。` }
          : { code: 'AGY_EXEC_FAILURE', message: 'agy 执行已停止。' } }), forceFinishAfterMs);
      }
    };
    const requestNonInteractiveAuthStop = () => {
      stop('SIGTERM');
      if (!killTimer) killTimer = setTimeout(() => stop('SIGKILL'), killAfterMs);
      finish({
        error: {
          code: 'AGY_AUTH_REQUIRED',
          message: 'agy 需要交互式 Google 登录，已阻止后台弹窗。请在前台终端完成 agy 登录后重试。',
        },
      });
    };
    const watchForInteractiveAuth = () => {
      const text = `${errorOutput}\n${output}\n${polledLogOutput}`;
      if (NONINTERACTIVE_AUTH_PATTERNS.some(pattern => pattern.test(text))) requestNonInteractiveAuthStop();
    };
    const pollAuthLog = () => {
      polledLogOutput = readLogTail(logFile, deps);
      watchForInteractiveAuth();
    };
    const timeout = setTimeout(() => requestStop('timeout'), options.timeoutMs + timeoutPaddingMs);
    const onTerm = () => requestStop('signal');
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onTerm);
    if (deps.beforeCache && finalPollIntervalMs > 0) {
      finalPollTimer = setInterval(pollFinalResponse, finalPollIntervalMs);
      if (typeof finalPollTimer.unref === 'function') finalPollTimer.unref();
      pollFinalResponse();
    }
    if (authLogPollIntervalMs > 0) {
      authLogPollTimer = setInterval(pollAuthLog, authLogPollIntervalMs);
      if (typeof authLogPollTimer.unref === 'function') authLogPollTimer.unref();
    }
    child.stdout.on('data', (data) => {
      output = `${output}${data}`.slice(-256 * 1024);
      watchForInteractiveAuth();
    });
    child.stderr.on('data', (data) => {
      errorOutput = `${errorOutput}${data}`.slice(-64 * 1024);
      watchForInteractiveAuth();
    });
    child.on('error', (err) => finish({ spawnError: err }));
    child.on('close', (code) => finish(timedOut
      ? { error: { code: 'AGY_TIMEOUT', message: `agy 超过 ${Math.ceil(options.timeoutMs / 1000)} 秒未完成。` } }
      : interrupted
        ? { error: { code: 'AGY_EXEC_FAILURE', message: 'agy 执行已停止。' } }
        : { code, output, errorOutput, logOutput: readLogTail(logFile, deps) }));
    function finish(result) {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      if (finalPollTimer) clearInterval(finalPollTimer);
      if (authLogPollTimer) clearInterval(authLogPollTimer);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onTerm);
      if (openBlocker && typeof openBlocker.cleanup === 'function') openBlocker.cleanup();
      resolve(result);
    }
  });
}

function readLogTail(file, deps = {}) {
  const fsMod = deps.fs || fs;
  try {
    const content = fsMod.readFileSync(file, 'utf8');
    return content.slice(-64 * 1024);
  } catch {
    return '';
  }
}

function classifyFailure(result) {
  const text = `${result.errorOutput || ''}\n${cleanStdout(result.output)}\n${result.logOutput || ''}\n${result.spawnError ? result.spawnError.message : ''}`.trim();
  if (result.spawnError && result.spawnError.code === 'ENOENT') {
    return { code: 'AGY_PTY_FAILED', message: '无法启动 agy PTY。' };
  }
  if (/neither PlanModel nor RequestedModel specified|must specify a valid model/i.test(text)) {
    return { code: 'AGY_MODEL_REQUIRED', message: 'agy 1.1.0 要求显式模型，但当前 MetaMe 传入的是 auto。请为该 agent 配置 models.agy 或将 agy 默认模型改为有效 Gemini 模型。' };
  }
  const hasAuthSuccess = /silent auth succeeded|OAuth: authenticated successfully|authenticated via keyring/i.test(text);
  const hasHardAuthFailure = /authentication required|waiting for authentication|authentication timed out|auth timed out|please login|please log in|if your browser didn't open|open the url below in your browser|metame blocked unattended browser open|unauthorized|credential|401|403/i.test(text)
    || (/not logged into Antigravity/i.test(text) && !hasAuthSuccess);
  if (hasHardAuthFailure) {
    return { code: 'AGY_AUTH_REQUIRED', message: 'agy 认证不可用，请先在终端完成 agy 登录。' };
  }
  return { code: 'AGY_EXEC_FAILURE', message: text.slice(0, 1000) || `agy exited with code ${result.code}` };
}

function shouldRetryAfterAuthFailure(result) {
  if (!result || result.earlyFinal) return false;
  if (result.error) return result.error.code === 'AGY_AUTH_REQUIRED';
  if (result.code === 0) return false;
  const failure = classifyFailure(result);
  if (failure.code !== 'AGY_AUTH_REQUIRED') return false;
  const text = `${result.errorOutput || ''}\n${result.output || ''}`.trim();
  return /authentication timed out|auth timed out|waiting for authentication/i.test(text);
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function cleanStdout(value) {
  return stripAnsi(value)
    .replace(/\^D(?:\x08|\b)*/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function looksLikeFailureOutput(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/(auth|login|unauthorized|credential|oauth|401|403)/i.test(value)) return true;
  if (value.length < 800 && /\b(error|failed|exception|not found|invalid|timeout|timed out)\b/i.test(value)) return true;
  return false;
}

function extractStdoutFinalText(result) {
  if (!result || result.code !== 0) return '';
  const text = cleanStdout(result.output)
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
  if (!text || looksLikeFailureOutput(text)) return '';
  return text;
}

function buildMissingFinalRecoveryPrompt(originalPrompt) {
  const userText = String(originalPrompt || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  return [
    '上一轮可能已经调用工具或完成分析，但没有把最终回答返回给用户。现在请补上最终回答。',
    '',
    '严格要求：',
    '1. 不要再调用任何工具，不要继续搜索。',
    '2. 直接基于当前会话里已有的搜索、工具结果和分析上下文回答。',
    '3. 如果已有材料足够，给出结论、关键依据和可执行建议。',
    '4. 如果已有材料不足或上一轮工具失败，明确告诉用户哪里不足/哪里失败。',
    '5. 用中文回答，不要提到本条系统补救指令。',
    '',
    `用户原始问题：${userText || '(未捕获)'}`,
  ].join('\n');
}

async function recoverMissingFinalTurn(options, originalPrompt, deps = {}) {
  const readCacheFn = getReadCache(deps);
  const readTranscriptFn = getReadTranscript(deps);
  const spawnAgyFn = deps.spawnAgyFn || deps.spawnAgy || spawnAgy;
  const before = readCacheFn();
  const recoveryOptions = {
    ...options,
    sessionId: options.sessionId || getCachedConversationId(before, options.cwd),
  };
  const startedAtMs = Date.now();
  const baselineRecordCounts = captureBaselineRecordCounts(before, recoveryOptions, readTranscriptFn);
  const minRecordCount = getBaselineRecordCount(baselineRecordCounts, recoveryOptions.sessionId, 0);
  const artifactDeps = { ...deps, baselineRecordCounts, startedAtMs };
  const recoveryPrompt = buildMissingFinalRecoveryPrompt(originalPrompt);
  const result = await spawnAgyFn(
    recoveryOptions,
    recoveryPrompt,
    { ...artifactDeps, beforeCache: before, minRecordCount }
  );
  if (result.error) return { error: result.error };
  if (result.earlyFinal) return result.earlyFinal;

  const artifacts = await waitForArtifacts(before, recoveryOptions, minRecordCount, artifactDeps);
  if (!artifacts) {
    const stdoutText = extractStdoutFinalText(result);
    if (stdoutText) return { sessionId: recoveryOptions.sessionId || '', text: stdoutText, records: [] };
    return { error: null };
  }

  const { sessionId, records: allRecords, minRecordCount: artifactRecordCount = minRecordCount } = artifacts;
  const records = recordsAfterLatestUser(allRecords.slice(artifactRecordCount));
  emitTranscriptDelta(sessionId, allRecords, artifactRecordCount, artifactDeps);
  const text = selectFinalResponse(records);
  if (text) return { sessionId, text, records };
  return { error: null, sessionId, records };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_PROMPT_BYTES) throw Object.assign(new Error('agy prompt exceeds 512 KiB'), { code: 'AGY_EXEC_FAILURE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function run(options, prompt, deps = {}) {
  const release = acquireLock(options);
  if (!release) return { error: { code: 'AGY_CWD_BUSY', message: '同一 agy 工作区或会话已有任务运行。' } };
  const readCacheFn = getReadCache(deps);
  const readTranscriptFn = getReadTranscript(deps);
  const spawnAgyFn = deps.spawnAgy || spawnAgy;
  const before = readCacheFn();
  const startedAtMs = Date.now();
  const baselineRecordCounts = captureBaselineRecordCounts(before, options, readTranscriptFn);
  const beforeRecordCount = getBaselineRecordCount(baselineRecordCounts, options.sessionId, 0);
  const eventState = deps.eventState || createTranscriptEventState();
  const artifactDeps = { ...deps, eventState, baselineRecordCounts, startedAtMs };
  try {
    let result = await spawnAgyFn(options, prompt, { ...artifactDeps, beforeCache: before, minRecordCount: beforeRecordCount });
    if (shouldRetryAfterAuthFailure(result)) {
      await (deps.sleep || sleep)(deps.authRetryDelayMs ?? AUTH_REFRESH_RETRY_DELAY_MS);
      result = await spawnAgyFn(options, prompt, { ...artifactDeps, beforeCache: before, minRecordCount: beforeRecordCount });
    }
    if (result.error) return result;
    if (result.earlyFinal) return result.earlyFinal;
    const artifacts = await waitForArtifacts(before, options, beforeRecordCount, artifactDeps);
    if (!artifacts) {
      const stdoutText = extractStdoutFinalText(result);
      if (stdoutText) return { sessionId: options.sessionId || '', text: stdoutText, records: [] };
      const failure = classifyFailure(result);
      if (failure.message && !/^agy exited with code 0$/.test(failure.message)) return { error: failure };
      const recovered = await recoverMissingFinalTurn(options, prompt, { ...artifactDeps, spawnAgyFn });
      if (recovered && !recovered.error && recovered.text) return recovered;
      if (recovered && recovered.error) return recovered;
      return {
        error: {
          code: 'AGY_SESSION_CAPTURE_FAILED',
          message: 'agy 已执行并退出成功，但未写入可读取的 conversation/transcript，stdout 也没有最终文本。可先发送 /new 重建会话后重试；若连续出现，请临时切回 codex。',
        },
      };
    }
    const { sessionId, records: allRecords, minRecordCount: artifactRecordCount = beforeRecordCount } = artifacts;
    emitTranscriptDelta(sessionId, allRecords, artifactRecordCount, artifactDeps);
    const newRecords = allRecords.slice(artifactRecordCount);
    const records = recordsAfterLatestUser(newRecords);
    const text = selectFinalResponse(records);
    if (!text) {
      const finalizationPrompt = buildFinalizationPrompt(prompt, records);
      if (!finalizationPrompt) return { error: classifyFailure(result), sessionId, records };

      const finalizationOptions = { ...options, sessionId };
      const finalizationResult = await spawnAgyFn(finalizationOptions, finalizationPrompt, {
        ...artifactDeps,
        beforeCache: before,
        minRecordCount: allRecords.length,
      });
      if (finalizationResult.error) return { error: finalizationResult.error, sessionId, records };

      const finalArtifacts = await waitForArtifacts(before, finalizationOptions, allRecords.length, artifactDeps);
      if (!finalArtifacts) {
        const stdoutText = extractStdoutFinalText(finalizationResult);
        if (stdoutText) return { sessionId, text: stdoutText, records };
        return {
          error: { code: 'AGY_FINALIZATION_CAPTURE_FAILED', message: '已有工具结果，但无法确认 agy 最终总结 transcript。' },
          sessionId,
          records,
        };
      }

      const finalRecords = recordsAfterLatestUser(finalArtifacts.records.slice(allRecords.length));
      emitTranscriptDelta(sessionId, finalArtifacts.records, allRecords.length, artifactDeps);
      const finalText = selectFinalResponse(finalRecords);
      const combinedRecords = [...records, ...finalRecords];
      if (finalText) return { sessionId, text: finalText, records: combinedRecords };
      return {
        error: {
          code: 'AGY_FINALIZATION_FAILED',
          message: '已有工具结果，但 agy 未能生成最终总结；请重试或缩小问题范围。',
        },
        sessionId,
        records: combinedRecords,
      };
    }
    return { sessionId, text, records };
  } finally {
    release();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const prompt = await readStdin();
    const eventState = createTranscriptEventState();
    const result = await run(options, prompt, { onEvent: emit, eventState });
    if (result.sessionId && eventState.sessionId !== result.sessionId) {
      emit({ type: 'session', session_id: result.sessionId });
    }
    if (result.error) emit({ type: 'error', code: result.error.code, message: result.error.message });
    else {
      emit({ type: 'text', text: result.text });
      emit({ type: 'done' });
    }
  } catch (err) {
    emit({ type: 'error', code: err.code || 'AGY_EXEC_FAILURE', message: err.message || String(err) });
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  buildAgyArgs,
  classifyFailure,
  spawnAgy,
  run,
  _internal: {
    acquireLock,
    readCache,
    readTranscript,
    waitForArtifacts,
    buildMissingFinalRecoveryPrompt,
    recoverMissingFinalTurn,
    listRecentTranscriptSessionIds,
    listDescendantPids,
    terminateTree,
    stripAnsi,
    extractStdoutFinalText,
    createTranscriptEventState,
    emitTranscriptDelta,
    pollTranscriptEvents,
  },
};
