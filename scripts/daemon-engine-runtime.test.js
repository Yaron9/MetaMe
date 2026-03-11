'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createEngineRuntimeFactory,
  normalizeEngineName,
  resolveEngineModel,
  _private,
} = require('./daemon-engine-runtime');

describe('daemon-engine-runtime normalize', () => {
  it('normalizes known engines and defaults to claude', () => {
    assert.equal(normalizeEngineName('codex'), 'codex');
    assert.equal(normalizeEngineName('Claude'), 'claude');
    assert.equal(normalizeEngineName(''), 'claude');
    assert.equal(normalizeEngineName('unknown'), 'claude');
  });
});

describe('daemon-engine-runtime args builder', () => {
  it('builds codex resume args with stdin prompt mode', () => {
    const args = _private.buildCodexArgs({
      model: 'gpt-5-codex',
      session: { started: true, id: 'sid-1' },
      cwd: '/tmp/proj',
    });
    assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'sid-1']);
    assert.ok(args.includes('--json'));
    assert.ok(args.includes('-'));
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
    assert.ok(args.includes('--ask-for-approval'));
    assert.ok(args.includes('on-request'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
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
});

describe('daemon-engine-runtime model resolution', () => {
  it('uses per-engine models before legacy daemon.model', () => {
    const model = resolveEngineModel('codex', {
      model: 'opus',
      models: { codex: 'gpt-5.4' },
    });
    assert.equal(model, 'gpt-5.4');
  });

  it('does not leak legacy claude aliases into codex', () => {
    const model = resolveEngineModel('codex', { model: 'opus' });
    assert.equal(model, 'gpt-5.4');
  });

  it('preserves legacy custom model ids for codex', () => {
    const model = resolveEngineModel('codex', { model: 'gpt-5-mini' });
    assert.equal(model, 'gpt-5-mini');
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
    assert.equal(codex.defaultModel, 'gpt-5.4');
  });
});
