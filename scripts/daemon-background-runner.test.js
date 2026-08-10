'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackgroundRunner } = require('./daemon-background-runner');
const { createEnginePlugin } = require('./engines/engine-plugin');
const { createClaudeCliAdapter } = require('./engines/claude-cli-adapter');
const { createCodexCliAdapter } = require('./engines/codex-cli-adapter');
const { createAgyCliAdapter } = require('./engines/agy-cli-adapter');
const { getEngineDescriptor } = require('./core/engine-descriptors');

const result = {
  status: 'candidate_complete', summary: 'done', artifacts: [], claims: ['tests passed'], next: null,
};

function runtime(name) {
  const adapterOptions = {
    binary: name,
    defaultModel: name === 'claude' ? 'sonnet' : 'auto',
    timeouts: { idleMs: 1000 },
  };
  if (name === 'agy') {
    adapterOptions.nativeBinary = '/opt/test/agy';
    adapterOptions.adapterPath = '/tmp/agy-adapter.js';
    adapterOptions.pluginConfig = __filename;
  }
  const adapter = {
    claude: createClaudeCliAdapter,
    codex: createCodexCliAdapter,
    agy: createAgyCliAdapter,
  }[name](adapterOptions);
  return createEnginePlugin({
    protocolVersion: 1,
    descriptor: getEngineDescriptor(name),
    runtime: adapter,
    sessionSource: null,
    cognitiveHost: null,
  });
}

test('background runner maps Completion Contract through Claude native output', async () => {
  let invocation = null;
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtime('claude'),
    runCommand: async options => {
      invocation = options;
      return {
        output: JSON.stringify({
          type: 'result', session_id: 'claude-1', structured_output: result, usage: { input_tokens: 2 },
        }),
        error: null,
      };
    },
  });
  const completed = await runner.startTurn({ engine: 'claude', prompt: 'work', cwd: '/tmp' });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.result, result);
  assert.equal(invocation.cmd, 'claude');
  assert.equal(completed.sessionId, 'claude-1');
  assert.ok(invocation.args.includes('--json-schema'));
  assert.ok(invocation.args.includes('--output-format'));
});

test('background runner maps Completion Contract through Codex native output', async () => {
  let invocation = null;
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtime('codex'),
    runCommand: async options => {
      invocation = options;
      return {
        output: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-1' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } }),
          JSON.stringify({ type: 'turn.completed', usage: { output_tokens: 3 } }),
        ].join('\n'),
        error: null,
      };
    },
  });
  const completed = await runner.startTurn({ engine: 'codex', prompt: 'work', cwd: '/tmp' });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.result, result);
  assert.equal(completed.sessionId, 'codex-1');
  const schemaPath = invocation.args[invocation.args.indexOf('--output-schema') + 1];
  assert.match(schemaPath, /completion\.schema\.json$/);
  assert.equal(invocation.stdoutBufferMode, 'tail');
});

test('background runner keeps each runtime buffer policy at the plugin boundary', async () => {
  const seen = {};
  const runner = createBackgroundRunner({
    getEngineRuntime: engine => runtime(engine),
    runCommand: async options => {
      seen[options.cmd] = options.stdoutBufferMode;
      const output = options.cmd === 'codex'
        ? JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'plain result' } })
        : 'plain result';
      return { output, error: null };
    },
  });
  const claude = await runner.startTurn({ engine: 'claude', prompt: 'work', structured: false });
  const codex = await runner.startTurn({ engine: 'codex', prompt: 'work', structured: false });
  assert.equal(claude.ok, true);
  assert.equal(codex.ok, true);
  assert.equal(seen.claude, 'prefix');
  assert.equal(seen.codex, 'tail');
});

test('background runner rejects native success with invalid structured result', async () => {
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtime('claude'),
    runCommand: async () => ({
      output: JSON.stringify({ type: 'result', structured_output: { status: 'succeeded' } }),
      error: null,
    }),
  });
  const completed = await runner.startTurn({ engine: 'claude', prompt: 'work' });
  assert.equal(completed.ok, false);
  assert.equal(completed.errorCode, 'INVALID_STRUCTURED_OUTPUT');
});

test('background runner reports truncated structured output explicitly', async () => {
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtime('codex'),
    runCommand: async () => ({ output: '{partial', error: null, stdoutTruncated: true }),
  });
  const completed = await runner.startTurn({ engine: 'codex', prompt: 'work' });
  assert.equal(completed.ok, false);
  assert.equal(completed.errorCode, 'BUFFER_LIMIT_EXCEEDED');
});

test('background runner rejects tools in pure subconscious inference', async () => {
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtime('agy'),
    runCommand: async () => ({
      output: [
        JSON.stringify({ type: 'tool_use', tool_name: 'Read' }),
        JSON.stringify({ type: 'text', text: 'should not be accepted' }),
        JSON.stringify({ type: 'done' }),
      ].join('\n'),
      error: null,
    }),
  });
  const completed = await runner.startTurn({
    engine: 'agy', prompt: 'summarize', structured: false, forbidTools: true,
  });
  assert.equal(completed.ok, false);
  assert.equal(completed.errorCode, 'BACKGROUND_TOOL_USE_FORBIDDEN');
});

test('background runner rejects a successful process without a terminal answer', async () => {
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtime('agy'),
    runCommand: async () => ({ output: JSON.stringify({ type: 'done' }), error: null }),
  });
  const completed = await runner.startTurn({ engine: 'agy', prompt: 'summarize', structured: false });
  assert.equal(completed.ok, false);
  assert.equal(completed.errorCode, 'EMPTY_FINAL_REPLY');
});

test('background runner executes through plugin.runtime final operations', async () => {
  const calls = [];
  let invocation = null;
  const plugin = createEnginePlugin({
    protocolVersion: 1,
    descriptor: getEngineDescriptor('claude'),
    runtime: {
      name: 'claude',
      binary: 'fixture-claude',
      defaultModel: 'auto',
      timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: null },
      killSignal: 'SIGTERM',
      probe: () => ({ state: 'verified' }),
      buildInvocation: options => {
        calls.push('buildInvocation');
        return {
          executable: 'fixture-claude',
          binary: 'fixture-claude',
          args: ['-p'],
          env: {},
          cwd: options.cwd || '',
          input: options.input || '',
          killSignal: 'SIGTERM',
          timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: null },
        };
      },
      parseEvent: line => {
        calls.push('parseEvent');
        const record = JSON.parse(line);
        return [{ type: 'run_completed', result: record.result }];
      },
      classifyFailure: () => {
        calls.push('classifyFailure');
        return null;
      },
      validateSession: () => {
        calls.push('validateSession');
        return true;
      },
      updateSession: () => {
        calls.push('updateSession');
        return null;
      },
    },
    sessionSource: null,
    cognitiveHost: null,
  });
  const runner = createBackgroundRunner({
    getEngineRuntime: () => plugin,
    runCommand: async options => {
      invocation = options;
      return {
        output: JSON.stringify({ result }),
        error: null,
      };
    },
  });
  const completed = await runner.startTurn({ engine: 'claude', prompt: 'work', cwd: '/tmp' });
  assert.equal(completed.ok, true);
  assert.deepEqual(completed.result, result);
  assert.equal(invocation.cmd, 'fixture-claude');
  assert.deepEqual(calls, ['validateSession', 'buildInvocation', 'updateSession', 'parseEvent']);
});

test('background runner keeps terminal failure exclusive and kills active child trees on shutdown', async () => {
  const runtimePlugin = createEnginePlugin({
    protocolVersion: 1,
    descriptor: getEngineDescriptor('claude'),
    runtime: {
      name: 'claude', binary: 'fixture-claude', defaultModel: 'auto',
      timeouts: { idleMs: 1000, toolMs: 1000, ceilingMs: null }, killSignal: 'SIGTERM',
      buildInvocation: () => ({ executable: 'fixture-claude', binary: 'fixture-claude', args: [], env: {}, cwd: '', input: '', killSignal: 'SIGTERM', timeouts: { idleMs: 1000 } }),
      parseEvent: line => {
        const record = JSON.parse(line);
        return record.type === 'failed'
          ? [{ type: 'run_failed', code: 'FIXTURE_FAILURE', message: 'failed' }]
          : [{ type: 'run_completed', result }];
      },
      classifyFailure: error => ({ code: 'EXEC_FAILURE', message: String(error) }),
      validateSession: () => true,
      updateSession: session => session,
    },
    sessionSource: null,
    cognitiveHost: null,
  });
  const terminal = require('./daemon-background-runner')._internal.collectNativeResult(
    runtimePlugin,
    '{"type":"failed"}\n{"type":"completed"}'
  );
  assert.equal(terminal.classifiedError.code, 'FIXTURE_FAILURE');
  assert.equal(terminal.finalValue, null);

  let resolveCommand;
  const child = { pid: 999999999, killSignals: [], kill(signal) { this.killSignals.push(signal); } };
  const runner = createBackgroundRunner({
    getEngineRuntime: () => runtimePlugin,
    runCommand: options => new Promise(resolve => {
      resolveCommand = resolve;
      options.onChild(child);
    }),
  });
  const pending = runner.startTurn({ engine: 'claude', prompt: 'work' });
  await new Promise(resolve => setImmediate(resolve));
  runner.shutdown('SIGTERM');
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  resolveCommand({ output: '', error: 'Stopped by user', errorCode: 'INTERRUPTED' });
  await pending;
});
