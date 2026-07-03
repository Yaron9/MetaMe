'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecallContext } = require('./memory-recall-context');

test('native Codex hook injects the shared recall result with data boundaries', async () => {
  let options;
  const output = await buildRecallContext({
    prompt: '还记得上次怎么修 memory-extract 吗？',
    cwd: '/tmp/metame',
    session_id: 'codex-session',
  }, {
    deriveProjectInfo: () => ({ project: 'metame', project_id: 'scope-metame' }),
    readRecallConfig: () => ({ enabled: true, totalChars: 1200, timeoutMs: 90 }),
    prepareRecall: async input => {
      options = input;
      return { recallActive: true, recallHint: '- [bug_lesson] 后台任务必须继承当前引擎。' };
    },
  });

  assert.equal(options.runtime.engine, 'codex');
  assert.equal(options.scope.project, 'metame');
  assert.equal(options.scope.workspaceScope, null);
  assert.equal(options.budget.totalChars, 1200);
  assert.match(output, /BEGIN METAME RECALL DATA/);
  assert.match(output, /后台任务必须继承当前引擎/);
  assert.match(output, /END METAME RECALL DATA/);
});

test('native Codex hook suppresses internal prompts', async () => {
  let called = false;
  const output = await buildRecallContext({
    prompt: 'You are a MetaMe cognitive profile distiller. Extract traits.',
  }, {
    prepareRecall: async () => { called = true; return {}; },
  });
  assert.equal(output, '');
  assert.equal(called, false);
});
