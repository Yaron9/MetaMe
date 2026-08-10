'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProjectContextManifest,
  deliverProjectContext,
} = require('./cognitive-context');
const { normalizeAccessContext } = require('./core/context-manifest');

const access = normalizeAccessContext({
  principal: 'principal:test', project: 'metame', agent_id: 'jarvis',
  scopes: ['project'], host: 'fixture', trust: 'managed',
});

const claim = {
  id: 'claim-1', type: 'claim', kind: 'convention', state: 'active',
  canonical_key: 'metame.rule.one', project: 'metame', scope: 'project',
  content: 'Use the fixture test command before delivery.',
};

test('registered fixture host projects once and warm/resume delivery is idempotent', () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access, now: new Date('2026-08-10') });
  const ledger = {};
  const adapter = {
    calls: [],
    projectContext(input) {
      this.calls.push(input);
      return { state: 'projected', fingerprint: `fixture:${input.manifest.revision}` };
    },
  };
  const first = deliverProjectContext({ manifest, access, adapter, host: 'fixture', nativeSessionId: 'native-1', ledger, deliveredAt: '2026-08-10' });
  const second = deliverProjectContext({ manifest, access, adapter, host: 'fixture', nativeSessionId: 'native-1', ledger: first.ledger, deliveredAt: '2026-08-10' });
  assert.equal(first.state, 'projected');
  assert.equal(first.delivered, true);
  assert.equal(second.state, 'skipped');
  assert.equal(second.delivered, false);
  assert.equal(adapter.calls.length, 1);
});

test('unsupported host and absent project are explicit and empty', () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access: { ...access, project: null } });
  assert.deepEqual(manifest.entries, []);
  assert.equal(deliverProjectContext({ manifest, access: { ...access, project: null } }).state, 'empty');
  assert.equal(deliverProjectContext({ manifest: buildProjectContextManifest({ assets: [claim], access }), access }).state, 'unsupported');
});

test('adapter receives manifest and phase only; it cannot mutate host configuration through this seam', () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access });
  let received;
  const result = deliverProjectContext({
    manifest, access, host: 'fixture', nativeSessionId: 'native-2', ledger: {}, phase: 'project_switch',
    adapter: { projectContext(input) { received = input; return { state: 'projected', fingerprint: 'f' }; } },
  });
  assert.equal(result.state, 'projected');
  assert.deepEqual(Object.keys(received).sort(), ['manifest', 'phase']);
  assert.equal(received.phase, 'project_switch');
});
