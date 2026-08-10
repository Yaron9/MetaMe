'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  advanceCursor,
  classifySourceRevision,
  createProcessingIdentity,
  fingerprintSourceRevision,
  normalizeSessionRef,
  normalizeSessionRevision,
  processingId,
  processingIdentity,
  serializeCursor,
} = require('./session-source-revision');

const base = {
  engineId: 'fixture-agent',
  nativeSessionId: 'native-1',
  sourceHash: 'rev-a',
  sourceSize: 10,
  cursor: { offset: 10, sequence: 2 },
};

test('source revision and processing identity are deterministic and readable', () => {
  assert.equal(fingerprintSourceRevision({ sourceHash: 'rev-a' }), 'rev-a');
  const key = processingIdentity({
    engineId: 'fixture-agent', nativeSessionId: 'native-1', sourceHash: 'rev-a', pipelineVersion: 'v1',
  });
  assert.equal(key, '["fixture-agent","native-1","rev-a","v1"]');
  const identity = createProcessingIdentity({
    engineId: 'fixture-agent', nativeSessionId: 'native-1', sourceHash: 'rev-a', pipelineVersion: 'v1',
  });
  assert.equal(identity.key, key);
  assert.equal(identity.id, processingId({
    engineId: 'fixture-agent', nativeSessionId: 'native-1', sourceHash: 'rev-a', pipelineVersion: 'v1',
  }));
  assert.notEqual(identity.id, processingId({
    engineId: 'fixture-agent', nativeSessionId: 'native-1', sourceHash: 'rev-a', pipelineVersion: 'v2',
  }));
});

test('opaque cursors round-trip without adapter-specific interpretation', () => {
  const cursor = { offset: 10, sequence: 2, token: 'opaque' };
  assert.equal(serializeCursor(cursor), '{"offset":10,"sequence":2,"token":"opaque"}');
  assert.deepEqual(advanceCursor(cursor, { sequence: 3, offset: 22 }), {
    offset: 22,
    sequence: 3,
    token: 'opaque',
  });
});

test('revision classification is stable for growth, rewrite, truncation, missing, and replay', () => {
  assert.equal(classifySourceRevision(null, base), 'new');
  assert.equal(classifySourceRevision(base, { ...base }), 'replayed');
  assert.equal(classifySourceRevision(base, { ...base, replay: true }), 'replayed');
  assert.equal(classifySourceRevision(base, { ...base, sourceHash: 'rev-b', sourceSize: 20 }), 'grown');
  assert.equal(classifySourceRevision(base, { ...base, sourceHash: 'rev-c', sourceSize: 5 }), 'truncated');
  assert.equal(classifySourceRevision(base, { ...base, sourceHash: 'rev-d', sourceSize: 10 }), 'rewritten');
  assert.equal(classifySourceRevision(base, null), 'missing');
  assert.equal(classifySourceRevision(base, { ...base, availability: 'missing' }), 'missing');
});

test('session refs and revisions preserve parent attribution and aliases', () => {
  const ref = normalizeSessionRef({
    engine_id: 'fixture-agent',
    session_id: 'child',
    source_locator: { opaque: 'native-row-1' },
    parent_native_session_id: 'parent',
  });
  assert.equal(ref.nativeSessionId, 'child');
  assert.equal(ref.parentNativeSessionId, 'parent');
  assert.deepEqual(ref.sourceLocator, { opaque: 'native-row-1' });
  const revision = normalizeSessionRevision({
    ...ref,
    source_hash: 'rev-child',
    source_size: 32,
    discovery_cursor: { sequence: 4 },
  });
  assert.equal(revision.sourceHash, 'rev-child');
  assert.equal(revision.sourceRevision, 'rev-child');
  assert.equal(revision.sourceSize, 32);
  assert.deepEqual(revision.cursor, { sequence: 4 });
});

test('numeric zero cursor is a present restart position, not an absent cursor', () => {
  const revision = normalizeSessionRevision({
    engineId: 'fixture-agent',
    nativeSessionId: 'zero-cursor',
    sourceHash: 'rev-zero',
    cursor: 0,
  });
  assert.equal(revision.cursor, 0);
  assert.equal(revision.appendCursor, 0);
  assert.equal(revision.discoveryCursor, 0);
});

test('false and empty-string cursors remain present opaque positions', () => {
  assert.equal(normalizeSessionRevision({
    engineId: 'fixture-agent', nativeSessionId: 'false-cursor', sourceHash: 'rev-false', cursor: false,
  }).cursor, false);
  assert.equal(normalizeSessionRevision({
    engineId: 'fixture-agent', nativeSessionId: 'empty-cursor', sourceHash: 'rev-empty', cursor: '',
  }).cursor, '');
});
