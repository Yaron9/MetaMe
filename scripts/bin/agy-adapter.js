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
  recordsAfterLatestUser,
  buildFinalizationPrompt,
  isLockStale,
  collectDescendantPids,
} = require('../core/agy-state');

const AGY_HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const CACHE_FILE = path.join(AGY_HOME, 'cache', 'last_conversations.json');
const LOCK_DIR = path.join(os.homedir(), '.metame', 'runtime', 'agy-locks');
const MAX_PROMPT_BYTES = 512 * 1024;
const FINAL_POLL_INTERVAL_MS = 500;
const AUTH_REFRESH_RETRY_DELAY_MS = 1500;
const AGY_AUTO_MODEL = 'Gemini 3.5 Flash (Medium)';
const NONINTERACTIVE_AUTH_PATTERNS = [
  /starting oauth authentication flow/i,
  /authentication required/i,
  /waiting for authentication/i,
  /please (open|visit|go to)/i,
  /accounts\.google\.com/i,
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
  args.push('--model', options.model && options.model !== 'auto' ? options.model : AGY_AUTO_MODEL);
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
    const child = spawnFn(scriptBin, buildAgyArgs({ ...options, logFile }, prompt, agyBin), {
      cwd: options.cwd,
      env: {
        ...process.env,
        BROWSER: process.env.METAME_AGY_BROWSER || '/usr/bin/false',
        METAME_INTERNAL_PROMPT: '1',
        METAME_AGY_UNATTENDED: '1',
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
    let killTimer = null;
    let forceFinishTimer = null;
    let finalPollTimer = null;
    const requestFinalStop = () => {
      stop('SIGTERM');
      const hardKillTimer = setTimeout(() => stop('SIGKILL'), killAfterMs);
      if (typeof hardKillTimer.unref === 'function') hardKillTimer.unref();
    };
    const pollFinalResponse = () => {
      if (finished || !deps.beforeCache) return;
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
      const text = `${errorOutput}\n${output}`;
      if (NONINTERACTIVE_AUTH_PATTERNS.some(pattern => pattern.test(text))) requestNonInteractiveAuthStop();
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
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onTerm);
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
  const hasHardAuthFailure = /authentication required|waiting for authentication|authentication timed out|auth timed out|please login|please log in|unauthorized|credential|401|403/i.test(text)
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
  const artifactDeps = { ...deps, baselineRecordCounts, startedAtMs };
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
      return {
        error: {
          code: 'AGY_SESSION_CAPTURE_FAILED',
          message: 'agy 已执行并退出成功，但未写入可读取的 conversation/transcript，stdout 也没有最终文本。可先发送 /new 重建会话后重试；若连续出现，请临时切回 codex。',
        },
      };
    }
    const { sessionId, records: allRecords, minRecordCount: artifactRecordCount = beforeRecordCount } = artifacts;
    const newRecords = allRecords.slice(artifactRecordCount);
    const records = recordsAfterLatestUser(newRecords);
    const text = selectFinalResponse(records);
    if (!text) {
      const finalizationPrompt = buildFinalizationPrompt(prompt, records);
      if (!finalizationPrompt) return { error: classifyFailure(result), sessionId, records };

      const finalizationOptions = { ...options, sessionId };
      const finalizationResult = await spawnAgyFn(finalizationOptions, finalizationPrompt, deps);
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
    const result = await run(options, prompt);
    if (result.sessionId) emit({ type: 'session', session_id: result.sessionId });
    if (Array.isArray(result.records)) {
      for (const record of result.records) {
        for (const event of normalizeTranscriptRecord(record)) emit(event);
      }
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
    listRecentTranscriptSessionIds,
    listDescendantPids,
    terminateTree,
    stripAnsi,
    extractStdoutFinalText,
  },
};
