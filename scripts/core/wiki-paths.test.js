'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  RUNTIME_WIKI_RELATIVE_PATH,
  defaultWikiOutputDir,
  expandHomePath,
  resolveConfiguredWikiOutputDir,
  resolveWikiOutputDir,
} = require('./wiki-paths');

test('defaultWikiOutputDir keeps the runtime fallback in one place', () => {
  assert.equal(RUNTIME_WIKI_RELATIVE_PATH, path.join('.metame', 'wiki'));
  assert.equal(defaultWikiOutputDir('/tmp/home'), path.join('/tmp/home', '.metame', 'wiki'));
});

test('resolveWikiOutputDir expands home and resolves configured paths', () => {
  assert.equal(expandHomePath('~/Vault/MetaMe/wiki', '/tmp/home'), '/tmp/home/Vault/MetaMe/wiki');
  assert.equal(resolveWikiOutputDir('~/Vault/MetaMe/wiki', { home: '/tmp/home' }), '/tmp/home/Vault/MetaMe/wiki');
  assert.equal(resolveWikiOutputDir('/abs/wiki', { home: '/tmp/home' }), '/abs/wiki');
  assert.equal(resolveWikiOutputDir(null, { home: '/tmp/home' }), path.join('/tmp/home', '.metame', 'wiki'));
});

test('resolveConfiguredWikiOutputDir reads daemon wiki_output_dir with fallback', () => {
  assert.equal(
    resolveConfiguredWikiOutputDir({ daemon: { wiki_output_dir: '~/Vault/wiki' } }, { home: '/tmp/home' }),
    '/tmp/home/Vault/wiki'
  );
  assert.equal(
    resolveConfiguredWikiOutputDir({ daemon: {} }, { home: '/tmp/home' }),
    path.join('/tmp/home', '.metame', 'wiki')
  );
});
