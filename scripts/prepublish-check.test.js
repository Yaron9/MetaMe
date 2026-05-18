'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRealSecretValue, collectSecretPaths, resolveProjectRoot } = require('./prepublish-check');

test('prepublish check ignores empty and placeholder credential values', () => {
  assert.equal(isRealSecretValue(null), false);
  assert.equal(isRealSecretValue('null'), false);
  assert.equal(isRealSecretValue('<APP_SECRET>'), false);
  assert.equal(isRealSecretValue('${APP_SECRET}'), false);
});

test('prepublish check detects real secrets regardless of first character', () => {
  assert.equal(isRealSecretValue('n_real_secret'), true);
  assert.equal(isRealSecretValue('123456:telegram-token'), true);
});

test('prepublish check reports nested secret paths without treating enabled flags as secrets', () => {
  const paths = collectSecretPaths({
    telegram: { enabled: true, bot_token: '123456:telegram-token' },
    feishu: { enabled: true, app_secret: null },
  });
  assert.deepEqual(paths, ['telegram.bot_token']);
});

test('prepublish check resolves the project root from the scripts copy', () => {
  assert.equal(resolveProjectRoot().endsWith('MetaMe'), true);
});
