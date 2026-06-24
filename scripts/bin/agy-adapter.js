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
  captureConversationId,
  normalizeTranscriptRecord,
  selectFinalResponse,
  recordsAfterLatestUser,
  isLockStale,
  collectDescendantPids,
} = require('../core/agy-state');

const AGY_HOME = path.join(os.homedir(), '.gemini', 'antigravity-cli');
const CACHE_FILE = path.join(AGY_HOME, 'cache', 'last_conversations.json');
const LOCK_DIR = path.join(os.homedir(), '.metame', 'runtime', 'agy-locks');
const MAX_PROMPT_BYTES = 512 * 1024;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForArtifacts(before, options, minRecordCount = 0, deps = {}) {
  const wait = deps.sleep || sleep;
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const after = readCache();
    const sessionId = captureConversationId(before, after, options.cwd, options.sessionId);
    if (sessionId) {
      try {
        const records = readTranscript(sessionId);
        if (records.length > minRecordCount) return { sessionId, records };
      } catch { /* retry */ }
    }
    if (attempt < 20) await wait(100);
  }
  return null;
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
  if (!options.readOnly) args.push('--dangerously-skip-permissions');
  if (options.sessionId) args.push('--conversation', options.sessionId);
  if (options.model && options.model !== 'auto') args.push('--model', options.model);
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
  if (process.platform !== 'darwin' && !deps.allowAnyPlatform) {
    return Promise.resolve({ error: { code: 'AGY_UNSUPPORTED_PLATFORM', message: 'agy 后台适配器当前仅支持 macOS。' } });
  }
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    const child = spawnFn(scriptBin, buildAgyArgs(options, prompt, agyBin), {
      cwd: options.cwd,
      env: { ...process.env, METAME_INTERNAL_PROMPT: '1' },
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
    let killTimer = null;
    let forceFinishTimer = null;
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
    const timeout = setTimeout(() => requestStop('timeout'), options.timeoutMs + timeoutPaddingMs);
    const onTerm = () => requestStop('signal');
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onTerm);
    child.stdout.on('data', (data) => { output = `${output}${data}`.slice(-256 * 1024); });
    child.stderr.on('data', (data) => { errorOutput = `${errorOutput}${data}`.slice(-64 * 1024); });
    child.on('error', (err) => finish({ spawnError: err }));
    child.on('close', (code) => finish(timedOut
      ? { error: { code: 'AGY_TIMEOUT', message: `agy 超过 ${Math.ceil(options.timeoutMs / 1000)} 秒未完成。` } }
      : interrupted
        ? { error: { code: 'AGY_EXEC_FAILURE', message: 'agy 执行已停止。' } }
        : { code, output, errorOutput }));
    let finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onTerm);
      resolve(result);
    }
  });
}

function classifyFailure(result) {
  const text = `${result.errorOutput || ''}\n${result.output || ''}\n${result.spawnError ? result.spawnError.message : ''}`.trim();
  if (result.spawnError && result.spawnError.code === 'ENOENT') {
    return { code: 'AGY_PTY_FAILED', message: '无法启动 agy PTY。' };
  }
  if (/(auth|login|unauthorized|credential|oauth|401|403)/i.test(text)) {
    return { code: 'AGY_AUTH_REQUIRED', message: 'agy 认证不可用，请先在终端完成 agy 登录。' };
  }
  return { code: 'AGY_EXEC_FAILURE', message: text.slice(0, 1000) || `agy exited with code ${result.code}` };
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
  const before = readCache();
  let beforeRecordCount = 0;
  if (options.sessionId) {
    try { beforeRecordCount = readTranscript(options.sessionId).length; } catch { /* validated after run */ }
  }
  try {
    const result = await spawnAgy(options, prompt, deps);
    if (result.error) return result;
    const artifacts = await waitForArtifacts(before, options, beforeRecordCount, deps);
    if (!artifacts) return { error: { code: 'AGY_SESSION_CAPTURE_FAILED', message: 'agy 已执行，但无法确认 conversation 与 transcript，结果状态未知。' } };
    const { sessionId, records: allRecords } = artifacts;
    const newRecords = options.sessionId ? allRecords.slice(beforeRecordCount) : allRecords;
    const records = recordsAfterLatestUser(newRecords);
    const text = selectFinalResponse(records);
    if (!text) return { error: classifyFailure(result), sessionId };
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
  _internal: { acquireLock, readCache, readTranscript, waitForArtifacts, listDescendantPids, terminateTree },
};
