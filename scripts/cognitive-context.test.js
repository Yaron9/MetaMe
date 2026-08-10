'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProjectContextManifest,
  deliverProjectContext,
} = require('./cognitive-context');
const { compareAndSetDelivery, normalizeAccessContext } = require('./core/context-manifest');

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

test('failed projection does not consume the delivery revision and can be retried', () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access });
  const ledger = {};
  let calls = 0;
  const adapter = {
    projectContext() {
      calls += 1;
      if (calls === 1) throw new Error('transient host failure');
      return { state: 'projected', fingerprint: 'retry-ok' };
    },
  };
  const first = deliverProjectContext({ manifest, access, adapter, host: 'fixture', nativeSessionId: 'retry-1', ledger });
  assert.equal(first.state, 'failed');
  assert.equal(first.delivered, false);
  assert.deepEqual(first.ledger, {});
  const second = deliverProjectContext({ manifest, access, adapter, host: 'fixture', nativeSessionId: 'retry-1', ledger: first.ledger });
  assert.equal(second.state, 'projected');
  assert.equal(second.delivered, true);
  assert.equal(calls, 2);
});

test('concurrent async projection claims one delivery per revision', async () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access });
  const ledger = {};
  let calls = 0;
  const adapter = {
    projectContext() {
      calls += 1;
      return new Promise(resolve => setTimeout(() => resolve({ state: 'projected', fingerprint: 'async-ok' }), 10));
    },
  };
  const options = { manifest, access, adapter, host: 'fixture', nativeSessionId: 'async-1', ledger };
  const first = deliverProjectContext(options);
  const second = deliverProjectContext(options);
  assert.equal(first, second);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.delivered, true);
  assert.equal(right.delivered, true);
  assert.equal(calls, 1);
});

function sessionLedgerStore() {
  const ledgers = new Map();
  const entryKey = (chatId, engine) => `${chatId}:${engine}`;
  return {
    getContextDeliveryLedger(chatId, engine) {
      return { ...(ledgers.get(entryKey(chatId, engine)) || {}) };
    },
    compareAndSetContextDelivery(chatId, engine, key, metadata) {
      const id = entryKey(chatId, engine);
      const result = compareAndSetDelivery(ledgers.get(id) || {}, key, metadata);
      if (result.delivered) ledgers.set(id, result.ledger);
      return result;
    },
  };
}

test('concurrent sessions do not share in-flight projection or ledger result', async () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access });
  const store = sessionLedgerStore();
  let calls = 0;
  const adapter = {
    projectContext() {
      calls += 1;
      return new Promise(resolve => setTimeout(() => resolve({ state: 'projected', fingerprint: `session-${calls}` }), 10));
    },
  };
  const common = { manifest, access, adapter, host: 'fixture', nativeSessionId: 'shared-native', engine: 'fixture', sessionStore: store };
  const first = deliverProjectContext({ ...common, logicalSessionId: 'logical-a' });
  const second = deliverProjectContext({ ...common, logicalSessionId: 'logical-b' });
  assert.notEqual(first, second);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.delivered, true);
  assert.equal(right.delivered, true);
  assert.equal(calls, 2);
  assert.ok(store.getContextDeliveryLedger('logical-a', 'fixture')[left.key]);
  assert.ok(store.getContextDeliveryLedger('logical-b', 'fixture')[right.key]);
});

test('same logical session shares in-flight projection and keeps its ledger entry', async () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access });
  const store = sessionLedgerStore();
  let calls = 0;
  const adapter = {
    projectContext() {
      calls += 1;
      return new Promise(resolve => setTimeout(() => resolve({ state: 'projected', fingerprint: 'same-session' }), 10));
    },
  };
  const common = { manifest, access, adapter, host: 'fixture', nativeSessionId: 'shared-native-2', engine: 'fixture', sessionStore: store, logicalSessionId: 'logical-same' };
  const first = deliverProjectContext(common);
  const second = deliverProjectContext(common);
  assert.equal(first, second);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.delivered, true);
  assert.equal(right.delivered, true);
  assert.equal(calls, 1);
  assert.ok(store.getContextDeliveryLedger('logical-same', 'fixture')[left.key]);
});

test('different no-CAS session-store wrappers share ledger-scoped in-flight state', async () => {
  const manifest = buildProjectContextManifest({ assets: [claim], access });
  const sharedLedger = {};
  let calls = 0;
  const adapter = {
    projectContext() {
      calls += 1;
      return new Promise(resolve => setTimeout(() => resolve({ state: 'projected', fingerprint: 'shared-ledger' }), 10));
    },
  };
  // These wrappers expose no CAS method, so persistence falls back to the
  // shared pure ledger and must use that ledger identity for in-flight scope.
  const wrapperA = { getContextDeliveryLedger() { return {}; } };
  const wrapperB = { getContextDeliveryLedger() { return {}; } };
  const common = { manifest, access, adapter, host: 'fixture', nativeSessionId: 'shared-ledger-native', ledger: sharedLedger };
  const first = deliverProjectContext({ ...common, sessionStore: wrapperA, logicalSessionId: 'logical-wrapper' });
  const second = deliverProjectContext({ ...common, sessionStore: wrapperB, logicalSessionId: 'logical-wrapper' });
  assert.equal(first, second);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.delivered, true);
  assert.equal(right.delivered, true);
  assert.equal(calls, 1);
});
