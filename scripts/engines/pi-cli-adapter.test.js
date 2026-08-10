'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createPiCliAdapter, _private } = require('./pi-cli-adapter');

function createAdapter(overrides = {}) {
  return createPiCliAdapter({
    binary: '/opt/test/pi',
    ...overrides,
  });
}

function line(value) {
  return JSON.stringify(value);
}

test('Pi invocation passes provider/model/thinking and stdin without shell interpolation', () => {
  const prompt = 'literal $(do-not-run)\nline two';
  const adapter = createAdapter();
  const invocation = adapter.buildInvocation({
    input: prompt,
    cwd: '/tmp/pi-project',
    provider: 'anthropic',
    model: 'anthropic/claude-sonnet-4-5',
    thinking: 'high',
    sessionDir: '/tmp/pi-sessions',
    session: { engine: 'pi', id: 'pi-session-1', started: true, cwd: '/tmp/pi-project' },
  });

  assert.deepEqual(invocation.args, [
    '--mode', 'json',
    '--provider', 'anthropic',
    '--model', 'anthropic/claude-sonnet-4-5',
    '--thinking', 'high',
    '--session-dir', '/tmp/pi-sessions',
    '--session-id', 'pi-session-1',
  ]);
  assert.equal(invocation.input, prompt);
  assert.equal(invocation.stdinStrategy, 'write-and-close');
  assert.equal(invocation.outputFraming, 'jsonl');
  assert.equal(invocation.shell, undefined);
});

test('Pi reads declarative options and preserves read-only tool scope', () => {
  const adapter = createAdapter();
  const args = adapter.buildArgs({
    input: 'review',
    readOnly: true,
    daemonCfg: {
      pi: {
        provider: 'openai',
        model: 'gpt-5.5',
        thinking: 'minimal',
        session_dir: '/tmp/configured-pi-sessions',
      },
    },
    session: { engine: 'pi', id: 'fresh-pi', started: false, cwd: '/tmp/project' },
  });
  assert.deepEqual(args, [
    '--mode', 'json',
    '--provider', 'openai',
    '--model', 'gpt-5.5',
    '--thinking', 'minimal',
    '--session-dir', '/tmp/configured-pi-sessions',
    '--tools', 'read,grep,find,ls',
    '--session-id', 'fresh-pi',
  ]);
});

test('Pi bounds prompt transport and rejects foreign or unsupported sessions', () => {
  const adapter = createAdapter();
  assert.throws(
    () => adapter.buildArgs({ input: 'x'.repeat(_private.MAX_PROMPT_BYTES + 1) }),
    /pi_prompt_too_large/
  );
  assert.throws(
    () => adapter.buildArgs({ session: { engine: 'codex', id: 'foreign', started: true } }),
    /pi_native_session_mismatch/
  );
  assert.throws(
    () => adapter.buildArgs({ session: { id: '__continue__' } }),
    /pi_continue_session_unsupported/
  );
  assert.throws(
    () => adapter.buildArgs({ thinking: 'not-a-pi-level' }),
    /pi_thinking_level_invalid/
  );
});

test('Pi parser follows the installed JSON event shapes', () => {
  const adapter = createAdapter();
  const usage = {
    input: 11,
    output: 7,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 18,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistantMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'reasoning' },
      { type: 'text', text: 'hello world' },
    ],
    usage,
    stopReason: 'stop',
  };
  const partialHello = {
    ...assistantMessage,
    content: [{ type: 'text', text: 'hello' }],
  };
  const partialHelloWorld = {
    ...assistantMessage,
    content: [{ type: 'text', text: 'hello world' }],
  };
  const records = [
    { type: 'session', version: 3, id: 'pi-session-2', timestamp: '2026-08-10T00:00:00.000Z', cwd: '/tmp/project' },
    { type: 'message_update', message: partialHello, assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: partialHello } },
    { type: 'message_update', message: partialHello, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello', partial: partialHello } },
    { type: 'message_update', message: partialHelloWorld, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' world', partial: partialHelloWorld } },
    { type: 'message_update', message: partialHelloWorld, assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'hello world', partial: partialHelloWorld } },
    { type: 'message_update', message: assistantMessage, assistantMessageEvent: { type: 'thinking_start', contentIndex: 1, partial: assistantMessage } },
    { type: 'message_update', message: assistantMessage, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'reasoning', partial: assistantMessage } },
    { type: 'message_update', message: assistantMessage, assistantMessageEvent: { type: 'thinking_end', contentIndex: 1, content: 'reasoning', partial: assistantMessage } },
    { type: 'message_update', message: assistantMessage, assistantMessageEvent: {
      type: 'toolcall_end', contentIndex: 1, toolCall: { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      partial: assistantMessage,
    } },
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'README.md' } },
    { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'read', args: { path: 'README.md' }, partialResult: { text: 'part' } },
    { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: { text: 'full' }, isError: false },
    { type: 'message_update', message: assistantMessage, assistantMessageEvent: { type: 'done', reason: 'stop', message: assistantMessage } },
    { type: 'message_end', message: assistantMessage },
    { type: 'agent_settled' },
  ];
  const parsed = records.flatMap(record => adapter.parseStreamEvent(line(record)));
  assert.deepEqual(parsed.map(event => event.type), [
    'session', 'tool_update', 'tool_use', 'tool_update', 'tool_result', 'usage', 'text', 'thinking', 'usage', 'done',
  ]);
  assert.equal(parsed[0].sessionId, 'pi-session-2');
  assert.equal(parsed[6].text, 'hello world', 'text_delta chunks must be emitted as one finalized message');
  assert.equal(parsed[7].text, 'reasoning');
  assert.equal(parsed[1].toolCallId, 'call-1');
  assert.deepEqual(parsed[4].toolResult, { text: 'full' });
  assert.deepEqual(parsed[5].usage, usage);

  const normalized = records.flatMap(record => adapter.parseEvent(line(record)));
  assert.ok(normalized.some(event => event.type === 'session_observed' && event.nativeSessionId === 'pi-session-2'));
  assert.ok(normalized.some(event => event.type === 'message_delta' && event.text === 'hello world'));
  assert.equal(normalized.filter(event => event.type === 'message_delta').length, 1);
  assert.ok(normalized.some(event => event.type === 'thinking_delta' && event.text === 'reasoning'));
  assert.ok(normalized.some(event => event.type === 'tool_started'));
  assert.ok(normalized.some(event => event.type === 'tool_updated'));
  assert.ok(normalized.some(event => event.type === 'tool_finished'));
  assert.ok(normalized.some(event => event.type === 'usage_observed' && event.usage && event.usage.totalTokens === usage.totalTokens));
  assert.ok(normalized.some(event => event.type === 'run_completed'));
});

test('Pi parser and classifier are stable for malformed/auth failures', () => {
  const adapter = createAdapter();
  assert.deepEqual(adapter.parseStreamEvent('not-json'), []);
  assert.deepEqual(adapter.parseStreamEvent('{"type":"message_update"}'), []);
  assert.deepEqual(adapter.parseStreamEvent('x'.repeat(_private.MAX_NATIVE_RECORD_BYTES + 1)), []);

  const auth = adapter.classifyFailure('401 Unauthorized api_key=sk-secret-value');
  assert.equal(auth.code, 'AUTH_REQUIRED');
  assert.match(auth.message, /Pi/);
  assert.doesNotMatch(auth.message, /sk-secret/);
  assert.equal(adapter.classifyFailure('429 quota exceeded').code, 'RATE_LIMIT');
  const execution = adapter.classifyFailure('spawn failed at /tmp/pi');
  assert.equal(execution.code, 'PI_EXEC_FAILURE');
  assert.match(execution.message, /spawn failed/);
  assert.equal(adapter.classifyFailure(''), null);
});

test('Pi error followed by agent_settled has one terminal failure', async () => {
  const adapter = createAdapter();
  const errorMessage = {
    role: 'assistant',
    content: [],
    usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1 },
    stopReason: 'error',
    errorMessage: '401 Unauthorized',
  };
  const result = await adapter.runTurn({
    turn: { input: 'auth check', cwd: '/tmp/project' },
    executionPolicy: {
      execute: async () => ({
        nativeLines: [
          line({ type: 'session', version: 3, id: 'pi-error-session', cwd: '/tmp/project' }),
          line({ type: 'message_update', message: errorMessage, assistantMessageEvent: { type: 'error', reason: 'error', error: errorMessage } }),
          line({ type: 'message_end', message: errorMessage }),
          line({ type: 'agent_end', messages: [errorMessage] }),
          line({ type: 'agent_settled' }),
        ],
      }),
    },
  });
  assert.deepEqual(result.events.filter(event => event.type === 'run_failed').map(event => event.code), ['AUTH_REQUIRED']);
  assert.equal(result.events.filter(event => event.type === 'run_completed').length, 0);
  assert.equal(result.failure.code, 'AUTH_REQUIRED');
});

test('Pi native turn keeps continuation engine-scoped', async () => {
  const adapter = createAdapter();
  const result = await adapter.runTurn({
    turn: { input: 'continue safely', cwd: '/tmp/project', model: 'gpt-5.5' },
    nativeSession: { engine: 'pi', id: 'pi-old', started: true, cwd: '/tmp/project' },
    executionPolicy: {
      execute: async invocation => {
        assert.equal(invocation.args.at(-1), 'pi-old');
        return {
          nativeLines: [
            line({ type: 'session', version: 3, id: 'pi-next', cwd: '/tmp/project' }),
            line({ type: 'message_update', message: { role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: 'continued' } }),
            line({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'continued' }] } }),
            line({ type: 'agent_settled' }),
          ],
        };
      },
    },
  });
  assert.equal(result.final, 'continued');
  assert.equal(result.sessionId, 'pi-next');
  assert.equal(result.nativeSession.engine, 'pi');
  assert.equal(result.nativeSession.id, 'pi-next');

  await assert.rejects(
    adapter.runTurn({
      turn: { input: 'must not run', cwd: '/tmp/project' },
      nativeSession: { engine: 'claude', id: 'claude-private', started: true, cwd: '/tmp/project' },
      executionPolicy: { execute: async () => ({}) },
    }),
    /pi_native_session_mismatch/
  );
});

test('Pi probe resolves a first-party version without starting a turn', () => {
  const calls = [];
  const adapter = createAdapter({
    execFileSync: (binary, args) => {
      calls.push([binary, args]);
      return '0.83.0\n';
    },
  });
  assert.deepEqual(adapter.probe(), {
    engineId: 'pi', state: 'detected', executable: '/opt/test/pi', version: '0.83.0',
  });
  assert.deepEqual(calls, [['/opt/test/pi', ['--version']]]);
  assert.equal(createPiCliAdapter({ binary: 'pi' }).probe().state, 'unsupported');
});

test('bounded Pi live acceptance is opt-in and skipped by default', { skip: process.env.METAME_PI_LIVE !== '1' || process.env.METAME_PI_LIVE_CONFIRM !== '1' }, async () => {
  const adapter = createPiCliAdapter();
  assert.equal(adapter.probe().state, 'detected');
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-pi-live-'));
  const prompt = String(process.env.METAME_PI_LIVE_PROMPT || 'Reply with exactly PI_T18_OK and no other text.').slice(0, 200);
  const invocation = adapter.buildInvocation({
    input: prompt,
    cwd: process.cwd(),
    readOnly: true,
    sessionDir,
    session: { engine: 'pi', id: 'metame-t18-live', started: false, cwd: process.cwd() },
  });
  const events = [];
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ['pipe', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
      });
      let stdoutBuffer = '';
      const consumeStdout = (chunk, flush = false) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = flush ? '' : (lines.pop() || '');
        for (const record of lines) {
          if (!record.trim()) continue;
          events.push(...adapter.parseEvent(record));
          if (events.length > 100) events.splice(0, events.length - 100);
        }
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already closed */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already closed */ } }, 1000).unref();
        reject(new Error('Pi live acceptance timed out'));
      }, 20000);
      child.stdout.on('data', chunk => consumeStdout(chunk));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => {
        clearTimeout(timer);
        consumeStdout('', true);
        if (code === 0) resolve();
        else reject(new Error(`Pi live acceptance exited ${code}`));
      });
      child.stdin.end(invocation.input);
    });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  assert.ok(events.some(event => event.type === 'session_observed'));
  assert.ok(events.some(event => event.type === 'message_delta'));
  assert.ok(events.some(event => event.type === 'run_completed'));
});
