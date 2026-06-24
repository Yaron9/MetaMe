'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDeterministicVerifier } = require('./daemon-verifier');

test('deterministic verifier records command evidence and stops on failure', async () => {
  const calls = [];
  const verifier = createDeterministicVerifier({
    platform: 'linux',
    runCommand: async options => {
      calls.push(options);
      return calls.length === 1
        ? { output: 'lint ok', error: null }
        : { output: null, error: 'tests failed' };
    },
  });
  const verdict = await verifier.verify({
    cwd: '/repo',
    spec: { commands: [{ name: 'lint', command: 'npm run lint' }, { name: 'test', command: 'npm test' }] },
  });
  assert.equal(verdict.passed, false);
  assert.deepEqual(verdict.checks, ['lint', 'test']);
  assert.equal(verdict.evidence[0].output, 'lint ok');
  assert.equal(calls[0].cmd, '/bin/sh');
  assert.equal(calls[0].useProcessGroup, true);
});

test('deterministic verifier distinguishes interrupted infrastructure', async () => {
  const verifier = createDeterministicVerifier({
    runCommand: async () => ({ output: null, error: 'Aborted', errorCode: 'INTERRUPTED' }),
  });
  const verdict = await verifier.verify({ spec: { command: 'node --test' } });
  assert.equal(verdict.infra_failure, true);
  assert.equal(verdict.retryable, true);
});

test('deterministic verifier blocks modified protected verifier paths', async () => {
  const verifier = createDeterministicVerifier({
    runCommand: async options => options.cmd === 'git'
      ? { output: 'scripts/verifier.js\n', error: null }
      : { output: 'ok', error: null },
  });
  const verdict = await verifier.verify({
    baseRevision: 'abc1234',
    spec: { command: 'node scripts/verifier.js', protected_paths: ['scripts/verifier.js'] },
  });
  assert.equal(verdict.passed, false);
  assert.equal(verdict.verifier_modified, true);
  assert.equal(verdict.retryable, false);
});
