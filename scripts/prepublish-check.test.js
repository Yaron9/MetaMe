'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRealSecretValue,
  collectSecretPaths,
  inspectPackageFileList,
  resolveProjectRoot,
} = require('./prepublish-check');

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

test('prepublish check blocks test, config, metadata, and obsolete files from package', () => {
  const violations = inspectPackageFileList([
    'scripts/daemon.js',
    'scripts/daemon.test.js',
    'scripts/test-support/test-utils.js',
    'scripts/hooks/test-stop-hook.js',
    'scripts/test_daemon.js',
    'scripts/daemon.yaml',
    'scripts/daemon.yaml.bak',
    'scripts/memory-migrate-v2.js',
    'scripts/verify-reactive-claude-md.js',
    'plugin/.DS_Store',
  ]);

  assert.deepEqual(violations, [
    'scripts/daemon.test.js: test script',
    'scripts/test-support/test-utils.js: test support directory',
    'scripts/hooks/test-stop-hook.js: test hook',
    'scripts/test_daemon.js: legacy test daemon',
    'scripts/daemon.yaml: user config file',
    'scripts/daemon.yaml.bak: user config backup',
    'scripts/memory-migrate-v2.js: obsolete destructive migration',
    'scripts/verify-reactive-claude-md.js: obsolete verifier',
    'plugin/.DS_Store: macOS metadata',
  ]);
});

test('prepublish check allows current maintenance tools that are tested and explicit', () => {
  assert.deepEqual(inspectPackageFileList([
    'scripts/memory-backfill-chunks.js',
    'scripts/migrate-reactive-paths.js',
    'scripts/core/wiki-chunks.js',
  ]), []);
});
