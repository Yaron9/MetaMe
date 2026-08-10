'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSessionSourceAdapter,
  runSessionSourceConformance,
} = require('./session-source-adapter');

function fixtureAdapter(overrides = {}) {
  return createSessionSourceAdapter({
    engineId: 'fixture-agent',
    probe: async () => ({ state: 'verified', available: true, reachable: true }),
    discover: async function* discover() {
      yield { sessionId: 'native-1', sourceLocator: { fileKey: 'opaque-1' }, project: 'metame' };
    },
    inspect: async ref => ({
      ...ref,
      sourceHash: 'rev-1',
      sourceSize: 12,
      cursor: { sequence: 2, token: 'opaque' },
    }),
    read: async function* read(ref, request) {
      yield { actor: 'user', kind: 'message', text: 'hello', sequence: 0, provenance: { native: ref.sourceLocator } };
      yield { actor: 'assistant', kind: 'message', text: 'world', sequence: 1, provenance: { revision: request.sourceRevision } };
    },
    validate: async () => ({ valid: true, state: 'valid' }),
    ...overrides,
  });
}

test('public source seam exposes probe/discover/inspect/read/validate', async () => {
  const source = fixtureAdapter();
  const probe = await source.probe({ cwd: '/tmp/project' });
  assert.equal(probe.engineId, 'fixture-agent');
  assert.equal(probe.verified, true);

  const refs = [];
  for await (const ref of source.discover({ cursor: 'restart-safe' })) refs.push(ref);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].nativeSessionId, 'native-1');
  assert.deepEqual(refs[0].sourceLocator, { fileKey: 'opaque-1' });

  const revision = await source.inspect(refs[0]);
  assert.equal(revision.sourceRevision, 'rev-1');
  const events = [];
  for await (const event of source.read({ ...refs[0], sourceRevision: revision.sourceRevision }, { cursor: revision.cursor })) {
    events.push(event);
  }
  assert.deepEqual(events.map(event => event.actor), ['user', 'assistant']);
  assert.deepEqual(events.map(event => event.sourceRevision), ['rev-1', 'rev-1']);
  const validation = await source.validate(refs[0]);
  assert.equal(validation.valid, true);
  assert.equal(runSessionSourceConformance(source).ok, true);
});

test('source seam enforces engine identity and stable revision context', async () => {
  const source = fixtureAdapter();
  await assert.rejects(() => source.inspect({ engineId: 'other', nativeSessionId: 'n' }), /session_source_engine_mismatch/);
  await assert.rejects(async () => {
    for await (const _event of source.read({ nativeSessionId: 'native-1' })) { /* consume */ }
  }, /session_source_revision_required/);
});

test('missing source validation is represented as a stable non-truth result', async () => {
  const source = fixtureAdapter({
    validate: async () => ({ valid: false, errorCode: 'SOURCE_MISSING', detail: 'locator unavailable' }),
  });
  const result = await source.validate({ nativeSessionId: 'native-1' });
  assert.equal(result.valid, false);
  assert.equal(result.errorCode, 'SOURCE_MISSING');
  assert.equal(result.detail, 'locator unavailable');
});
