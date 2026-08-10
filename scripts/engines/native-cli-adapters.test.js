'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDefaultEngineRegistry, createEngineRegistry } = require('./engine-registry');
const { defineNativeCliAdapter } = require('./native-cli-adapter');
const { createClaudeCliAdapter } = require('./claude-cli-adapter');
const { createCodexCliAdapter } = require('./codex-cli-adapter');
const { createEngineRuntimeFactory } = require('../daemon-engine-runtime');

function createRegistry() {
  return createDefaultEngineRegistry({
    normalizeEngineName: value => String(value || 'claude').trim().toLowerCase(),
    claude: {
      binary: '/opt/test/claude',
      getActiveProviderEnv: () => ({ ANTHROPIC_TEST: '1' }),
    },
    codex: {
      binary: '/opt/test/codex',
    },
    agy: {
      home: '/tmp/metame-adapter-test',
      binary: process.execPath,
      nativeBinary: '/opt/test/agy',
      adapterPath: '/opt/test/agy-adapter.js',
      pluginConfig: '/tmp/metame-adapter-test/missing-plugin.json',
    },
  });
}

test('registry exposes one deep adapter per native CLI with private session storage', () => {
  const registry = createRegistry();
  const adapters = registry.list();

  assert.deepEqual(adapters.map(adapter => adapter.name), ['claude', 'codex', 'agy', 'pi']);
  assert.deepEqual(
    adapters.map(adapter => adapter.descriptor.contextProjection),
    ['claude-import', 'agents-md-merge', 'prompt-bootstrap', 'prompt-bootstrap']
  );
  assert.deepEqual(
    adapters.map(adapter => adapter.nativeSession.storage),
    ['claude-jsonl', 'codex-sqlite', 'agy-transcript', 'pi-jsonl']
  );
  assert.ok(adapters.every(adapter => adapter.nativeSession.opaque));
  assert.ok(adapters.every(Object.isFrozen));
});

test('native session guards accept legacy or same-engine slots and reject cross-engine slots', () => {
  const registry = createRegistry();
  for (const engine of ['claude', 'codex', 'agy']) {
    const adapter = registry.get(engine);
    assert.equal(adapter.acceptsNativeSession(null), true);
    assert.equal(adapter.acceptsNativeSession({ id: 'legacy-session' }), true);
    assert.equal(adapter.acceptsNativeSession({ engine, id: `${engine}-session` }), true);
    assert.equal(
      adapter.acceptsNativeSession({ engine: engine === 'claude' ? 'codex' : 'claude', id: 'foreign' }),
      false
    );
  }

  assert.throws(
    () => registry.get('claude').buildArgs({ session: { engine: 'codex', id: 'foreign', started: true } }),
    /claude_native_session_mismatch/
  );
  assert.throws(
    () => registry.get('codex').buildArgs({ session: { engine: 'agy', id: 'foreign', started: true } }),
    /codex_native_session_mismatch/
  );
  assert.throws(
    () => registry.get('agy').buildArgs({ session: { engine: 'claude', id: 'foreign', started: true } }),
    /agy_native_session_mismatch/
  );
});

test('each adapter resumes only its own native session format', () => {
  const registry = createRegistry();

  assert.deepEqual(
    registry.get('claude').buildArgs({
      model: 'sonnet',
      session: { engine: 'claude', id: 'claude-native', started: true },
    }).slice(-2),
    ['--resume', 'claude-native']
  );
  assert.deepEqual(
    registry.get('codex').buildArgs({
      session: { engine: 'codex', id: 'codex-native', started: true },
    }).slice(0, 3),
    ['exec', 'resume', 'codex-native']
  );
  assert.deepEqual(
    registry.get('agy').buildArgs({
      cwd: '/tmp/project',
      session: { engine: 'agy', id: 'agy-native', started: true },
    }).slice(-2),
    ['--session', 'agy-native']
  );
});

test('Claude adapter owns streaming and persistent CLI protocol flags', () => {
  const args = createRegistry().get('claude').buildArgs({
    streaming: true,
    persistent: true,
  });

  assert.deepEqual(
    args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2),
    ['--output-format', 'stream-json']
  );
  assert.deepEqual(
    args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2),
    ['--input-format', 'stream-json']
  );
  assert.ok(args.includes('--verbose'));
});

test('Codex adapter owns AGENTS.md context projection without following symlinks', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-codex-context-'));
  const adapter = createCodexCliAdapter({ fs, path });
  try {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Project');
    fs.writeFileSync(path.join(projectDir, 'SOUL.md'), '# Soul');
    assert.deepEqual(
      adapter.projectContext({ cwd: projectDir, fresh: true }),
      { status: 'refreshed', sections: 2 }
    );
    assert.equal(
      fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8'),
      '# Project\n\n# Soul'
    );

    fs.unlinkSync(path.join(projectDir, 'AGENTS.md'));
    fs.symlinkSync(path.join(projectDir, 'CLAUDE.md'), path.join(projectDir, 'AGENTS.md'));
    assert.deepEqual(
      adapter.projectContext({ cwd: projectDir, fresh: true }),
      { status: 'symlink-skipped', sections: 0 }
    );
    assert.equal(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8'), '# Project');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('native event fixtures remain engine-specific behind the adapter seam', () => {
  const registry = createRegistry();
  const claude = registry.get('claude');
  const codex = registry.get('codex');
  const agy = registry.get('agy');

  assert.deepEqual(
    claude.parseStreamEvent(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session',
    })).map(event => [event.type, event.sessionId]),
    [['session', 'claude-session']]
  );
  assert.deepEqual(
    codex.parseStreamEvent(JSON.stringify({
      type: 'thread.started',
      thread_id: 'codex-thread',
    })).map(event => [event.type, event.sessionId]),
    [['session', 'codex-thread']]
  );
  assert.deepEqual(
    agy.parseStreamEvent(JSON.stringify({
      type: 'session',
      session_id: 'agy-conversation',
    })).map(event => [event.type, event.sessionId]),
    [['session', 'agy-conversation']]
  );

  assert.deepEqual(claude.parseStreamEvent('{"type":"thread.started","thread_id":"wrong"}'), []);
  assert.deepEqual(codex.parseStreamEvent('{"type":"session","session_id":"wrong"}'), []);
  assert.deepEqual(agy.parseStreamEvent('{"type":"system","subtype":"init","session_id":"wrong"}'), []);
});

test('final runtime boundary exposes only normalized event vocabulary', () => {
  const registry = createRegistry();
  const fixtures = {
    claude: JSON.stringify({
      type: 'result', session_id: 'claude-final', result: 'done', usage: { input_tokens: 1 },
    }),
    codex: JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 2 } }),
    agy: JSON.stringify({ type: 'done' }),
  };
  for (const engine of ['claude', 'codex', 'agy']) {
    const runtime = registry.get(engine).runtime;
    const events = runtime.parseEvent(fixtures[engine]);
    assert.ok(events.some(event => event.type === 'run_completed'), engine);
    assert.ok(events.every(event => !['session', 'text', 'tool_use', 'tool_result', 'done', 'error'].includes(event.type)), engine);
  }
});

test('registry adapters execute one logical turn and return engine-scoped session state', async () => {
  const registry = createRegistry();
  const fixtures = {
    claude: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-next' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude text' }] } }),
    ],
    codex: [
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-next' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex text' } }),
    ],
    agy: [
      JSON.stringify({ type: 'session', session_id: 'agy-next' }),
      JSON.stringify({ type: 'text', text: 'agy text' }),
    ],
  };

  for (const engine of ['claude', 'codex', 'agy']) {
    const adapter = registry.get(engine);
    const observed = [];
    const result = await adapter.runTurn({
      turn: {
        input: `run ${engine}`,
        cwd: '/tmp/project',
        model: adapter.defaultModel,
      },
      nativeSession: {
        engine,
        id: `${engine}-previous`,
        started: true,
        cwd: '/tmp/project',
      },
      onEvent: event => observed.push(event),
      executionPolicy: {
        execute: async invocation => {
          assert.equal(invocation.engine, engine);
          assert.equal(invocation.input, `run ${engine}`);
          assert.ok(invocation.args.includes(`${engine}-previous`));
          return {
            nativeLines: fixtures[engine],
            output: `${engine} final`,
          };
        },
      },
    });

    assert.equal(result.final, `${engine} final`);
    assert.deepEqual(observed.map(event => event.type), ['session_observed', 'message_delta']);
    assert.equal(observed[0].nativeSessionId, `${engine}-next`);
    assert.equal(result.nativeSession.engine, engine);
    assert.equal(result.nativeSession.id, `${engine}-next`);
    assert.equal(result.nativeSession.started, true);
  }
});

test('adapter turn seam rejects foreign sessions before execution', async () => {
  const adapter = createRegistry().get('codex');
  let executed = false;

  await assert.rejects(
    adapter.runTurn({
      turn: { input: 'do not run', cwd: '/tmp/project' },
      nativeSession: {
        engine: 'claude',
        id: 'claude-private-session',
        started: true,
        cwd: '/tmp/project',
      },
      executionPolicy: {
        execute: async () => {
          executed = true;
          return {};
        },
      },
    }),
    /codex_native_session_mismatch/
  );
  assert.equal(executed, false);
});

test('adapter turn seam drops an invalid native resume and starts fresh', async () => {
  const adapter = createCodexCliAdapter({
    binary: '/opt/test/codex',
    validateNativeSession: () => false,
  });
  let invocation = null;
  const result = await adapter.runTurn({
    turn: { input: 'retry safely', cwd: '/tmp/project' },
    nativeSession: {
      engine: 'codex',
      id: 'expired-codex-thread',
      started: true,
      cwd: '/tmp/project',
    },
    executionPolicy: {
      execute: async value => {
        invocation = value;
        return {
          nativeLines: [
            JSON.stringify({ type: 'thread.started', thread_id: 'fresh-codex-thread' }),
          ],
          output: 'recovered',
        };
      },
    },
  });

  assert.equal(result.sessionWasValid, false);
  assert.equal(invocation.args.includes('expired-codex-thread'), false);
  assert.equal(result.nativeSession.id, 'fresh-codex-thread');
});

test('compatibility runtime factory delegates selection to native CLI adapters', () => {
  const getRuntime = createEngineRuntimeFactory({
    HOME: '/tmp/metame-adapter-test',
    CLAUDE_BIN: '/opt/test/claude',
    CODEX_BIN: '/opt/test/codex',
    AGY_BIN: '/opt/test/agy',
    AGY_ADAPTER: '/opt/test/agy-adapter.js',
    getActiveProviderEnv: () => ({ ANTHROPIC_TEST: '1' }),
  });

  for (const engine of ['claude', 'codex', 'agy']) {
    const runtime = getRuntime(engine);
    assert.equal(runtime.name, engine);
    assert.equal(runtime.descriptor.name, engine);
    assert.equal(runtime.nativeSession.opaque, true);
    assert.equal(typeof runtime.acceptsNativeSession, 'function');
    assert.equal(typeof runtime.runTurn, 'function');
  }
  assert.equal(getRuntime('unknown').name, 'claude');
});

test('registry rejects shallow or duplicate adapter definitions', () => {
  assert.throws(
    () => defineNativeCliAdapter({ name: 'broken', descriptor: { name: 'broken' } }),
    /descriptor_incomplete/
  );

  const claude = createRegistry().get('claude');
  assert.throws(
    () => createEngineRegistry([claude, claude]),
    /duplicate_engine_adapter/
  );
});

test('Codex adapter owns permission migration, bridge context and resume retry policy', () => {
  let now = 1_000;
  const adapter = createCodexCliAdapter({
    binary: '/opt/test/codex',
    sessionPolicy: {
      now: () => now,
      getSessionSandboxProfile: () => ({
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        permissionMode: 'read-only',
      }),
    },
  });
  const policy = adapter.sessionPolicy;
  const actual = policy.getActualPermissionProfile({ id: 'codex-native', cwd: '/tmp/project' });
  const requested = policy.resolvePermissionProfile({
    daemonCfg: { codex: { sandbox_mode: 'danger-full-access', approval_policy: 'never' } },
  });

  assert.equal(policy.needsFallbackForRequestedPermissions(actual, requested), true);
  assert.match(policy.buildFallbackBridgePrompt({
    fullPrompt: 'continue the task',
    previousSessionId: 'codex-native',
    previousProfile: actual,
    requestedProfile: requested,
    recentContext: { lastUser: 'fix it', lastAssistant: 'working' },
  }), /Recent conversation context:[\s\S]*continue the task/);
  assert.equal(policy.canRetry('chat-1', 'expired'), true);
  policy.markRetried('chat-1', 'expired');
  assert.equal(policy.canRetry('chat-1', 'expired'), false);
  now += policy.retryWindowMs + 1;
  assert.equal(policy.canRetry('chat-1', 'expired'), true);
  assert.equal(policy.classifyResumeFailure('connection reset', '').kind, 'transport');
});

test('Claude adapter owns native JSONL resume inspection without exposing it to registry', () => {
  let repairedSessionId = '';
  const adapter = createClaudeCliAdapter({
    binary: '/opt/test/claude',
    sessionPolicy: {
      fs: {
        readFileSync: () => `${JSON.stringify({
          message: { model: 'claude-opus-4-6' },
        })}\n`,
      },
      findSessionFile: sessionId => `/tmp/${sessionId}.jsonl`,
      stripThinkingSignatures: sessionId => {
        repairedSessionId = sessionId;
        return 2;
      },
    },
  });

  assert.deepEqual(
    adapter.sessionPolicy.inspectResumeSession({
      engine: 'claude',
      id: 'claude-native',
      started: true,
    }, 'sonnet'),
    { shouldResume: true, modelPin: 'opus', reason: '' }
  );
  assert.equal(
    adapter.sessionPolicy.isThinkingSignatureError('Invalid signature in thinking block'),
    true
  );
  const failure = adapter.sessionPolicy.classifyResumeFailure('Invalid signature in thinking block');
  assert.deepEqual(failure, {
    isResumeFailure: true,
    reason: 'thinking-signature-invalid',
    repairable: true,
  });
  assert.equal(
    adapter.sessionPolicy.repairResumeSession({ id: 'claude-native' }, failure),
    true
  );
  assert.equal(repairedSessionId, 'claude-native');
  assert.equal(Object.hasOwn(adapter, 'findSessionFile'), false);
});
