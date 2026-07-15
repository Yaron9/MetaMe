'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyKnowledgeIntent } = require('./knowledge-intent');

test('knowledge intent keeps default recall on factual state', () => {
  assert.deepEqual(classifyKnowledgeIntent('Step3 当前精度'), { kind: 'state', artifactKinds: [] });
});

test('knowledge intent separates why and how artifacts', () => {
  assert.deepEqual(classifyKnowledgeIntent('为什么选择 WAL'), { kind: 'why', artifactKinds: ['decision'] });
  assert.deepEqual(classifyKnowledgeIntent('如何安全回滚部署'), { kind: 'how', artifactKinds: ['playbook'] });
});
