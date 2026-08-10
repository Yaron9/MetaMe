'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyProjectionHashes,
  projectionHash,
} = require('./wiki-projection');

test('projection hashes normalize CRLF but preserve all other bytes', () => {
  assert.equal(projectionHash('a\r\nb'), projectionHash('a\nb'));
  assert.notEqual(projectionHash('a\nb'), projectionHash('A\nb'));
});

test('tracked baseline permits canonical drift to be written', () => {
  const result = classifyProjectionHashes({ baseHash: 'base', currentHash: 'current', userHash: 'base' });
  assert.equal(result.classification, 'drift');
  assert.equal(result.canWrite, true);
});

test('user-only edits are preserved and fail closed', () => {
  const result = classifyProjectionHashes({ baseHash: 'base', currentHash: 'base', userHash: 'user' });
  assert.equal(result.classification, 'modified');
  assert.equal(result.canWrite, false);
});

test('concurrent canonical and user edits are conflicts', () => {
  const result = classifyProjectionHashes({ baseHash: 'base', currentHash: 'current', userHash: 'user' });
  assert.equal(result.classification, 'conflict');
  assert.equal(result.canWrite, false);
});

test('legacy pages and deleted tracked pages fail closed', () => {
  assert.equal(classifyProjectionHashes({ currentHash: 'current', userHash: 'user' }).classification, 'untracked');
  assert.equal(classifyProjectionHashes({ baseHash: 'base', currentHash: 'current', userExists: false }).classification, 'missing');
  assert.equal(classifyProjectionHashes({ currentHash: 'current', userExists: false }).canWrite, true);
});
