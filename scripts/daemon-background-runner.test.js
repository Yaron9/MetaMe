'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBackgroundRunner } = require('./daemon-background-runner');
const { _private } = require('./daemon-engine-runtime');

const result = {
  status: 'candidate_complete', summary: 'done', artifacts: [], claims: ['tests passed'], next: null,
};

function runtime(name) {
  return {
    name,
    binary: name,
    defaultModel: 'auto',
    timeouts: { idleMs: 1000 },
    killSignal: 'SIGTERM',
    buildArgs: name === 'codex' ? _private.buildCodexArgs : _private.buildClaudeArgs,
    buildEnv: () => ({}),
    parseStreamEvent: name === 'codex'
      ? _private.parseCodexStreamEvent
      : (name === 'agy' ? _private.parseAgyStreamEvent : _private.parseClaudeStreamEvent),
    classifyError: _private.classifyEngineError,
  };
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
