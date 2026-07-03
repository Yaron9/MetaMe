'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createEngineRuntimeFactory,
  normalizeEngineName,
  resolveEngineModel,
  ENGINE_MODEL_CONFIG,
  _private,
} = require('./daemon-engine-runtime');

it('uses the Codex CLI default for distill instead of a stale account-specific model', () => {
  assert.equal(ENGINE_MODEL_CONFIG.codex.distill, 'auto');
});

describe('daemon-engine-runtime normalize', () => {
  it('normalizes known engines and defaults to claude', () => {
    assert.equal(normalizeEngineName('codex'), 'codex');
    assert.equal(normalizeEngineName('agy'), 'agy');
    assert.equal(normalizeEngineName('Claude'), 'claude');
    assert.equal(normalizeEngineName(''), 'claude');
    assert.equal(normalizeEngineName('unknown'), 'claude');
  });
});

describe('daemon-engine-runtime args builder', () => {
  it('skips explicit model flag when codex is set to auto', () => {
    const args = _private.buildCodexArgs({
      model: 'auto',
      session: {},
      cwd: '/tmp/proj',
    });
    assert.deepEqual(args.slice(0, 1), ['exec']);
    assert.ok(!args.includes('-m'));
    assert.ok(args.includes('-C'));
  });

  it('builds codex native resume args with explicit permission flags', () => {
    const args = _private.buildCodexArgs({
      model: 'gpt-5-codex',
      session: { started: true, id: 'sid-1' },
      cwd: '/tmp/proj',
    });
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'sid-1']);
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('-'));
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('-C'));
  });

  it('rejects Claude-only continue markers instead of silently starting fresh Codex', () => {
    assert.throws(() => _private.buildCodexArgs({
      session: { id: '__continue__', started: true },
    }), /codex_continue_session_unsupported/);
  });

  it('keeps explicit codex sandbox flags on native resume when not full access', () => {
    const args = _private.buildCodexArgs({
      model: 'gpt-5-codex',
      session: { started: true, id: 'sid-1' },
      permissionProfile: {
        sandboxMode: 'workspace-write',
        approvalPolicy: 'on-request',
        permissionMode: 'workspace-write',
      },
    });
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'sid-1']);
    assert.ok(args.includes('-s'));
    assert.ok(args.includes('workspace-write'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('always uses --dangerously-bypass-approvals-and-sandbox for codex (no config needed)', () => {
    const args = _private.buildCodexArgs({
      model: 'gpt-5-codex',
      daemonCfg: {},
      session: {},
    });
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('--full-auto'));
  });

  it('maps codex config into explicit sandbox and approval flags', () => {
    const args = _private.buildCodexArgs({
      model: 'gpt-5-codex',
      daemonCfg: { codex: { sandbox_mode: 'workspace-write', approval_policy: 'on-request' } },
      session: {},
    });
    assert.ok(args.includes('-s'));
    assert.ok(args.includes('workspace-write'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  });

  it('prefers explicit codex permissionProfile over stale session metadata on fresh exec', () => {
    const args = _private.buildCodexArgs({
      model: 'gpt-5-codex',
      session: {
        started: false,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        permissionMode: 'read-only',
      },
      permissionProfile: {
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        permissionMode: 'danger-full-access',
      },
    });
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('read-only'));
  });

  it('strips nested-session env vars from codex runtime', () => {
    const env = _private.buildCodexEnv({
      CODEX_THREAD_ID: 'tid',
      METAME_ACTIVE_SESSION: 'true',
      CLAUDE_CODE_SSE_PORT: '1234',
      PATH: '/tmp/bin',
    }, { metameProject: 'metame' });
    assert.equal(env.CODEX_THREAD_ID, undefined);
    assert.equal(env.METAME_ACTIVE_SESSION, undefined);
    assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
    assert.equal(env.METAME_PROJECT, 'metame');
    assert.equal(env.PATH, '/tmp/bin');
  });

  it('does not override CODEX_HOME from cwd for codex runtime', () => {
    const env = _private.buildCodexEnv({
      PATH: '/tmp/bin',
    }, { metameProject: 'metame', cwd: '/tmp/project-a' });
    assert.equal(env.CODEX_HOME, undefined);
    assert.equal(env.METAME_PROJECT, 'metame');
  });

  it('builds claude args with read-only tools', () => {
    const args = _private.buildClaudeArgs({
      model: 'opus',
      readOnly: true,
      session: { started: false, id: 'sid-2' },
    });
    assert.equal(args[0], '-p');
    assert.ok(args.includes('--session-id'));
    assert.ok(args.includes('sid-2'));
    assert.ok(args.includes('Read'));
    assert.ok(!args.includes('Bash'));
    assert.ok(!args.includes('Edit'));
  });

  it('does not let caller tools widen Claude read-only mode', () => {
    const args = _private.buildClaudeArgs({ readOnly: true, allowedTools: ['Bash', 'Edit'] });
    assert.ok(!args.includes('Bash'));
    assert.ok(!args.includes('Edit'));
  });

  it('always uses --dangerously-skip-permissions for claude when not read-only', () => {
    const args = _private.buildClaudeArgs({
      model: 'opus',
      daemonCfg: {},
      session: {},
    });
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--allowedTools'));
  });

  it('maps the same structured output contract to native Claude and Codex flags', () => {
    const schema = { type: 'object', required: ['status'] };
    const claude = _private.buildClaudeArgs({ outputSchema: schema });
    const codex = _private.buildCodexArgs({ outputSchemaPath: '/tmp/completion.schema.json' });
    assert.equal(claude[claude.indexOf('--json-schema') + 1], JSON.stringify(schema));
    assert.equal(codex[codex.indexOf('--output-schema') + 1], '/tmp/completion.schema.json');
  });

  it('builds agy adapter args and ignores fresh placeholder session IDs', () => {
    const fresh = _private.buildAgyArgs({
      adapterPath: '/tmp/agy-adapter.js',
      cwd: '/tmp/proj',
      session: { started: false, id: 'placeholder' },
    });
    assert.deepEqual(fresh.slice(0, 3), ['/tmp/agy-adapter.js', '--cwd', '/tmp/proj']);
    assert.equal(fresh.includes('--session'), false);
    const resumed = _private.buildAgyArgs({
      adapterPath: '/tmp/agy-adapter.js',
      cwd: '/tmp/proj',
      session: { started: true, id: 'real-id' },
    });
    assert.equal(resumed[resumed.indexOf('--session') + 1], 'real-id');
  });

  it('rejects unsupported task-level capability restrictions for agy', () => {
    assert.throws(() => _private.buildAgyArgs({
      adapterPath: '/tmp/agy-adapter.js',
      allowedTools: ['Read'],
    }), /agy_capability_unsupported/);
    assert.throws(() => _private.buildAgyArgs({
      adapterPath: '/tmp/agy-adapter.js',
      mcpConfig: '/tmp/.mcp.json',
    }), /agy_capability_unsupported/);
  });
});

describe('daemon-engine-runtime model resolution', () => {
  it('defaults codex to auto when no explicit model is configured', () => {
    const model = resolveEngineModel('codex', {});
    assert.equal(model, 'auto');
  });

  it('uses per-engine models before legacy daemon.model', () => {
    const model = resolveEngineModel('codex', {
      model: 'opus',
      models: { codex: 'gpt-5.4' },
    });
    assert.equal(model, 'gpt-5.4');
  });

  it('does not leak legacy claude aliases into codex', () => {
    const model = resolveEngineModel('codex', { model: 'opus' });
    assert.equal(model, 'auto');
  });

  it('preserves legacy custom model ids for codex', () => {
    const model = resolveEngineModel('codex', { model: 'gpt-5-mini' });
    assert.equal(model, 'gpt-5-mini');
  });

  it('does not leak legacy non-codex custom model ids into codex', () => {
    const model = resolveEngineModel('codex', { model: 'MiniMax-M2.1' });
    assert.equal(model, 'auto');
  });

  it('does not leak legacy Claude models into agy', () => {
    assert.equal(resolveEngineModel('agy', { model: 'opus' }), 'auto');
    assert.equal(resolveEngineModel('agy', { models: { agy: 'gemini-custom' } }), 'gemini-custom');
  });

  it('normalizes legacy custom claude model ids back to canonical slots', () => {
    assert.equal(resolveEngineModel('claude', { model: 'MiniMax-M2.1' }), 'sonnet');
    assert.equal(resolveEngineModel('claude', { model: 'claude-opus-4-6' }), 'opus');
    assert.equal(resolveEngineModel('claude', { models: { claude: 'claude-haiku-4-5-20251001' } }), 'haiku');
  });
});

describe('daemon-engine-runtime parsers', () => {
  it('parses codex session + text + done events', () => {
    const e1 = _private.parseCodexStreamEvent('{"type":"thread.started","thread_id":"t-1"}');
    const e2 = _private.parseCodexStreamEvent('{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}');
    const e3 = _private.parseCodexStreamEvent('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}');
    assert.equal(e1[0].type, 'session');
    assert.equal(e1[0].sessionId, 't-1');
    assert.equal(e2[0].type, 'text');
    assert.equal(e2[0].text, 'hello');
    assert.equal(e3[0].type, 'done');
    assert.equal(e3[0].usage.output_tokens, 2);
  });

  it('parses claude tool + text events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/a.js' } },
          { type: 'text', text: 'done' },
        ],
      },
    });
    const events = _private.parseClaudeStreamEvent(line);
    assert.equal(events[0].type, 'tool_use');
    assert.equal(events[0].toolName, 'Write');
    assert.equal(events[1].type, 'text');
    assert.equal(events[1].text, 'done');
  });

  it('parses normalized agy adapter events', () => {
    assert.deepEqual(_private.parseAgyStreamEvent('{"type":"heartbeat"}'), []);
    const session = _private.parseAgyStreamEvent('{"type":"session","session_id":"agy-1"}');
    const text = _private.parseAgyStreamEvent('{"type":"text","text":"answer"}');
    const error = _private.parseAgyStreamEvent('{"type":"error","code":"AGY_CWD_BUSY","message":"busy"}');
    assert.equal(session[0].sessionId, 'agy-1');
    assert.equal(text[0].text, 'answer');
    assert.equal(error[0].code, 'AGY_CWD_BUSY');
  });
});

describe('daemon-engine-runtime error classification', () => {
  it('returns null for empty inputs', () => {
    assert.equal(_private.classifyEngineError(''), null);
    assert.equal(_private.classifyEngineError(null), null);
    assert.equal(_private.classifyEngineError(undefined), null);
    assert.equal(_private.classifyEngineError('   '), null);
  });

  it('classifies auth errors', () => {
    const out = _private.classifyEngineError('Unauthorized: please login');
    assert.equal(out.code, 'AUTH_REQUIRED');
    assert.match(out.message, /codex login/i);
  });

  it('classifies rate limit errors', () => {
    const out = _private.classifyEngineError('429 Too many requests');
    assert.equal(out.code, 'RATE_LIMIT');
  });

  it('falls back to exec failure', () => {
    const out = _private.classifyEngineError('spawn failed');
    assert.equal(out.code, 'EXEC_FAILURE');
    assert.equal(out.message, 'spawn failed');
  });
});

describe('daemon-engine-runtime factory', () => {
  it('creates codex runtime with expected defaults', () => {
    const getRuntime = createEngineRuntimeFactory({
      CLAUDE_BIN: 'claude',
      CODEX_BIN: 'codex',
      getActiveProviderEnv: () => ({ ANTHROPIC_API_KEY: 'x' }),
    });
    const codex = getRuntime('codex');
    assert.equal(codex.name, 'codex');
    assert.equal(codex.binary, 'codex');
    assert.equal(codex.stdinBehavior, 'write-and-close');
    assert.equal(codex.defaultModel, 'auto');
  });

  it('creates agy runtime through the protocol adapter', () => {
    const getRuntime = createEngineRuntimeFactory({
      AGY_BIN: '/tmp/agy',
      AGY_ADAPTER: '/tmp/agy-adapter.js',
    });
    const agy = getRuntime('agy');
    assert.equal(agy.name, 'agy');
    assert.equal(agy.binary, process.execPath);
    assert.equal(agy.nativeBinary, '/tmp/agy');
    assert.equal(agy.capabilities.outputSchema, false);
    assert.equal(agy.buildEnv({}).AGY_BIN, '/tmp/agy');
  });
});

describe('daemon-engine-runtime timeout resolution', () => {
  it('keeps codex on idle/tool watchdogs only', () => {
    const timeouts = _private.resolveEngineTimeouts('codex');
    assert.equal(timeouts.idleMs, 10 * 60 * 1000);
    assert.equal(timeouts.toolMs, 25 * 60 * 1000);
    assert.equal(timeouts.ceilingMs, null);
  });

  it('keeps claude on idle/tool watchdogs only', () => {
    const timeouts = _private.resolveEngineTimeouts('claude');
    assert.equal(timeouts.idleMs, 20 * 60 * 1000);
    assert.equal(timeouts.toolMs, 25 * 60 * 1000);
    assert.equal(timeouts.ceilingMs, null);
  });

  it('keeps agy on idle/tool watchdogs only', () => {
    const timeouts = _private.resolveEngineTimeouts('agy');
    assert.equal(timeouts.idleMs, 20 * 60 * 1000);
    assert.equal(timeouts.toolMs, 25 * 60 * 1000);
    assert.equal(timeouts.ceilingMs, null);
  });
});
