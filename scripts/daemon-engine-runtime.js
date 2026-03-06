'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CODEX_TOOL_MAP = Object.freeze({
  command_execution: 'Bash',
  file_change: 'Write',
  file_read: 'Read',
  mcp_tool_call: 'MCP',
  web_search: 'WebSearch',
  web_fetch: 'WebFetch',
});

function normalizeEngineName(name) {
  const text = String(name || '').trim().toLowerCase();
  return text === 'codex' ? 'codex' : 'claude';
}

function resolveBinary(engineName, deps = {}) {
  const engine = normalizeEngineName(engineName);
  const home = deps.HOME || os.homedir();
  const fsMod = deps.fs || fs;
  const pathMod = deps.path || path;
  const execSyncFn = deps.execSync || execSync;

  const key = engine === 'codex' ? 'codex' : 'claude';
  const cmd = process.platform === 'win32' ? `where ${key}` : `which ${key} 2>/dev/null`;
  try {
    const lines = execSyncFn(cmd, { encoding: 'utf8', timeout: 3000 })
      .split('\n').map(l => l.trim()).filter(Boolean);
    // On Windows prefer .cmd wrapper (reliably executable by spawn)
    const preferred = process.platform === 'win32'
      ? (lines.find(l => l.toLowerCase().endsWith(`${key}.cmd`)) || lines[0])
      : lines[0];
    if (preferred) return preferred;
  } catch { /* fallback */ }

  const candidates = engine === 'codex'
    ? [
      pathMod.join(home, '.local', 'bin', 'codex'),
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
    ]
    : [
      pathMod.join(home, '.local', 'bin', 'claude'),
      pathMod.join(home, '.npm-global', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ];
  for (const p of candidates) {
    if (fsMod.existsSync(p)) return p;
  }
  return key;
}

const ENGINE_DISTILL_MAP = Object.freeze({
  claude: 'haiku',
  codex: 'gpt-5.1-codex-mini',
});

function detectDefaultEngine(deps = {}) {
  for (const engine of ['claude', 'codex']) {
    const bin = resolveBinary(engine, deps);
    if (bin !== engine) return engine; // resolveBinary found a real path
  }
  return 'claude'; // ultimate fallback
}

function classifyEngineError(text) {
  const msg = String(text || '').trim();
  if (!msg) return null;
  if (/(auth|unauthorized|login|api key|authentication|permission denied|forbidden|401|403)/i.test(msg)) {
    return {
      code: 'AUTH_REQUIRED',
      message: '认证失败，请先执行 `codex login`（或配置 OPENAI_API_KEY）后重试。',
    };
  }
  if (/(rate.?limit|too many requests|quota|429)/i.test(msg)) {
    return {
      code: 'RATE_LIMIT',
      message: '请求频率或配额受限，请稍后重试。',
    };
  }
  return {
    code: 'EXEC_FAILURE',
    message: msg,
  };
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function parseClaudeStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object') return [];

  const out = [];
  if (raw.type === 'assistant' && raw.message && Array.isArray(raw.message.content)) {
    for (const block of raw.message.content) {
      if (!block) continue;
      if (block.type === 'text' && block.text) {
        out.push({ type: 'text', text: String(block.text), raw });
      } else if (block.type === 'tool_use') {
        out.push({
          type: 'tool_use',
          toolName: block.name || 'Tool',
          toolInput: block.input || {},
          raw,
        });
      }
    }
  }
  if (raw.type === 'result') {
    if (raw.result) out.push({ type: 'text', text: String(raw.result), raw });
    out.push({ type: 'done', usage: raw.usage || null, raw });
  }
  if (raw.type === 'content_block_start' || raw.type === 'content_block_delta') {
    out.push({ type: 'tool_result', raw });
  }
  if (raw.type === 'error') {
    const classified = classifyEngineError(raw.error || raw.message || '');
    if (classified) out.push({ type: 'error', ...classified, raw });
  }
  return out;
}

function parseCodexStreamEvent(line) {
  const raw = parseJsonLine(line);
  if (!raw || typeof raw !== 'object') return [];

  const out = [];
  if (raw.type === 'thread.started' && raw.thread_id) {
    out.push({ type: 'session', sessionId: String(raw.thread_id), raw });
  }

  if ((raw.type === 'item.started' || raw.type === 'item.completed') && raw.item && raw.item.type) {
    const itemType = String(raw.item.type);
    const mapped = CODEX_TOOL_MAP[itemType] || itemType;
    if (mapped && mapped !== 'reasoning' && itemType !== 'agent_message') {
      if (raw.type === 'item.started') {
        out.push({
          type: 'tool_use',
          toolName: mapped,
          toolInput: {
            command: raw.item.command || '',
            file_path: raw.item.path || raw.item.file_path || '',
          },
          raw,
        });
      } else {
        out.push({ type: 'tool_result', toolName: mapped, raw });
      }
    }
    if (raw.type === 'item.completed' && itemType === 'agent_message' && raw.item.text) {
      out.push({ type: 'text', text: String(raw.item.text), raw });
    }
  }

  if (raw.type === 'turn.completed') {
    out.push({ type: 'done', usage: raw.usage || null, raw });
  }
  if (raw.type === 'error') {
    const classified = classifyEngineError(raw.error || raw.message || '');
    if (classified) out.push({ type: 'error', ...classified, raw });
  }
  return out;
}

function buildClaudeArgs(options = {}) {
  const { model = 'opus', readOnly = false, daemonCfg = {}, session = {} } = options;
  const args = ['-p', '--model', model];
  if (readOnly) {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task'];
    for (const tool of readOnlyTools) args.push('--allowedTools', tool);
  } else {
    // Always bypass permission prompts — desktop users run in trusted local context,
    // mobile users cannot click dialogs. Security relies on allowed_chat_ids whitelist.
    args.push('--dangerously-skip-permissions');
  }

  if (session.id === '__continue__') {
    args.push('--continue');
  } else if (session.started && session.id) {
    args.push('--resume', session.id);
  } else if (session.id) {
    args.push('--session-id', session.id);
  }
  return args;
}

function buildCodexArgs(options = {}) {
  const { model = 'gpt-5-codex', readOnly = false, daemonCfg = {}, session = {}, cwd } = options;
  const args = (session && session.started && session.id && session.id !== '__continue__')
    ? ['exec', 'resume', session.id]
    : ['exec'];

  args.push('--json', '--skip-git-repo-check');
  if (model) args.push('-m', model);
  if (cwd) args.push('-C', cwd);

  if (readOnly) {
    args.push('-s', 'read-only');
  } else {
    // Mobile sessions: user cannot click permission dialogs.
    // Security relies on allowed_chat_ids whitelist, not tool restrictions.
    args.push('--dangerously-bypass-approvals-and-sandbox');
  }

  // "-" means prompt is read from stdin.
  args.push('-');
  return args;
}

function createEngineRuntimeFactory(deps = {}) {
  const home = deps.HOME || os.homedir();
  const claudeBin = deps.CLAUDE_BIN || resolveBinary('claude', { ...deps, HOME: home });
  const codexBin = deps.CODEX_BIN || resolveBinary('codex', { ...deps, HOME: home });
  const getActiveProviderEnv = typeof deps.getActiveProviderEnv === 'function'
    ? deps.getActiveProviderEnv
    : (() => ({}));

  return function getEngineRuntime(engineName) {
    const engine = normalizeEngineName(engineName);
    if (engine === 'codex') {
      return {
        name: 'codex',
        binary: codexBin,
        defaultModel: 'gpt-5-codex',
        stdinBehavior: 'write-and-close',
        killSignal: 'SIGTERM',
        timeouts: { idleMs: 10 * 60 * 1000, toolMs: 25 * 60 * 1000, ceilingMs: 60 * 60 * 1000 },
        buildArgs: buildCodexArgs,
        buildEnv: ({ metameProject = '' } = {}) => {
          const env = { ...process.env, METAME_PROJECT: metameProject };
          // Unset CODEX_HOME if it points to a non-existent path (corrupted env var)
          if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) delete env.CODEX_HOME;
          return env;
        },
        parseStreamEvent: parseCodexStreamEvent,
        classifyError: classifyEngineError,
      };
    }
    return {
      name: 'claude',
      binary: claudeBin,
      defaultModel: 'opus',
      stdinBehavior: 'write-and-close',
      killSignal: 'SIGTERM',
      timeouts: { idleMs: 5 * 60 * 1000, toolMs: 25 * 60 * 1000, ceilingMs: 60 * 60 * 1000 },
      buildArgs: buildClaudeArgs,
      buildEnv: ({ metameProject = '' } = {}) => ({
        ...(() => {
          const env = { ...process.env, ...getActiveProviderEnv(), METAME_PROJECT: metameProject };
          delete env.CLAUDECODE;
          return env;
        })(),
      }),
      parseStreamEvent: parseClaudeStreamEvent,
      classifyError: classifyEngineError,
    };
  };
}

module.exports = {
  createEngineRuntimeFactory,
  normalizeEngineName,
  resolveBinary,
  detectDefaultEngine,
  ENGINE_DISTILL_MAP,
  _private: {
    classifyEngineError,
    parseClaudeStreamEvent,
    parseCodexStreamEvent,
    buildClaudeArgs,
    buildCodexArgs,
  },
};
