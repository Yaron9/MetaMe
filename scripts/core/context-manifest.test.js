'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_CONTEXT_CHARS,
  MAX_ENTRIES,
  MAX_MANIFEST_CHARS,
  accessIdentity,
  buildManifest,
  compareAndSetDelivery,
  composeContext,
  dedupeJitItems,
  deliveryKey,
  manifestRenderedChars,
  normalizeAccessContext,
  resolveAccessContext,
  selectManifestEntries,
} = require('./context-manifest');

function access(overrides = {}) {
  return normalizeAccessContext({
    principal: 'principal:test',
    project: 'metame',
    agent_id: 'jarvis',
    scopes: ['project'],
    host: 'fixture',
    trust: 'managed',
    ...overrides,
  });
}

function claim(id, overrides = {}) {
  return {
    id,
    type: 'claim',
    kind: 'convention',
    state: 'active',
    canonical_key: `metame.rule.${id}`,
    project: 'metame',
    scope: 'project',
    content: `${id} is an active project rule`,
    updated_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

test('manifest selects eligible assets with stable policy/claim/synthesis ordering', () => {
  const selected = selectManifestEntries([
    claim('late', { updated_at: '2026-08-10T00:00:00.000Z' }),
    { id: 's1', type: 'synthesis', kind: 'playbook', status: 'active', project_key: 'metame', summary: 'playbook' },
    { id: 'p1', type: 'policy', status: 'accepted', project: 'metame', summary: 'policy' },
    claim('early', { updated_at: '2026-08-09T00:00:00.000Z' }),
  ], access());
  assert.deepEqual(selected.map(item => `${item.type}:${item.id}`), ['policy:p1', 'claim:late', 'claim:early', 'synthesis:s1']);
});

test('manifest excludes candidates, conflicts, episodes, profiles, stale, expired, and wrong project', () => {
  const now = new Date('2026-08-10T00:00:00.000Z');
  const selected = selectManifestEntries([
    claim('good'),
    claim('candidate', { state: 'candidate' }),
    claim('conflict', { state: 'conflict' }),
    claim('episode', { kind: 'episode', canonical_key: null, task_key: 'task-1' }),
    { id: 'profile', type: 'claim', kind: 'profile', state: 'active', canonical_key: 'profile.x', project: 'metame', content: 'private' },
    claim('stale', { stale: true }),
    claim('expired', { expires_at: '2026-08-09T00:00:00.000Z' }),
    claim('other', { project: 'other' }),
    { id: 'archived-policy', type: 'policy', status: 'archived', project: 'metame', summary: 'old' },
    { id: 'candidate-synthesis', type: 'synthesis', status: 'active', candidate: true, project_key: 'metame', summary: 'draft' },
  ], access(), { now });
  assert.deepEqual(selected.map(item => item.id), ['good']);
});

test('project access admits global canonical claims but rejects unrelated scopes', () => {
  const selected = selectManifestEntries([
    claim('global', { project: '*', scope: '*', canonical_key: 'global.rule' }),
    claim('wrong-scope', { scope: 'other-workspace' }),
  ], access());
  assert.deepEqual(selected.map(item => item.id), ['global']);
});

test('duplicate candidate input order cannot change the selected manifest entry', () => {
  const left = claim('same', { summary: 'first', source_fingerprint: 'claim:same:a' });
  const right = claim('same', { summary: 'second', source_fingerprint: 'claim:same:b' });
  assert.deepEqual(
    selectManifestEntries([left, right], access()),
    selectManifestEntries([right, left], access()),
  );
});

test('manifest is bounded and revision is stable when volatile timestamps change', () => {
  const assets = Array.from({ length: 12 }, (_, i) => claim(`rule-${i}`, { content: 'x'.repeat(600) }));
  const first = buildManifest({ assets, access: access(), now: new Date('2026-08-10T00:00:00.000Z') });
  const second = buildManifest({ assets, access: access(), now: new Date('2026-08-11T00:00:00.000Z') });
  assert.ok(first.entries.length <= MAX_ENTRIES);
  assert.ok(manifestRenderedChars(first) <= MAX_MANIFEST_CHARS);
  assert.equal(first.revision, second.revision);
  assert.notEqual(first.generated_at, second.generated_at);
});

test('untrusted access cannot read profile or agent-private working memory', () => {
  const trusted = resolveAccessContext({
    trustedContext: access({ project: 'metame', agent_id: 'jarvis' }),
    request: { project: 'other', agent_id: 'other', host: 'forged' },
  });
  assert.equal(trusted.project, 'metame');
  assert.equal(trusted.agent_id, 'jarvis');
  const untrusted = resolveAccessContext({ request: { project: 'metame', agent_id: 'jarvis' } });
  assert.equal(untrusted.agent_id, null);
  const privateClaim = claim('private', { agent_key: 'jarvis' });
  assert.deepEqual(selectManifestEntries([privateClaim], untrusted), []);
});

test('manifest and JIT share fingerprints and a deterministic total budget', () => {
  const manifest = buildManifest({ assets: [claim('one')], access: access(), now: new Date('2026-08-10') });
  const jit = dedupeJitItems([
    { text: 'duplicate', source_fingerprint: manifest.entries[0].source_fingerprint },
    { text: 'keep', source: { kind: 'fact', id: 'other' } },
    { text: 'keep duplicate', source: { kind: 'fact', id: 'other' } },
  ], manifest);
  assert.deepEqual(jit.map(item => item.text), ['keep']);
  const composed = composeContext({ manifest, jit: [...jit, { text: 'z'.repeat(5000), source_fingerprint: 'new' }] });
  assert.ok(composed.chars <= MAX_CONTEXT_CHARS);
  assert.equal(composed.manifest_chars, manifestRenderedChars(manifest));
});

test('delivery key and compare-and-set are idempotent across resume', () => {
  const key = deliveryKey({
    host: 'codex', nativeSessionId: 'native-1', project: 'metame',
    accessIdentity: accessIdentity(access()), revision: 'rev-1',
  });
  const once = compareAndSetDelivery({}, key, { revision: 'rev-1', project: 'metame', delivered_at: '2026-08-10T00:00:00.000Z' });
  const twice = compareAndSetDelivery(once.ledger, key, { revision: 'rev-1' });
  assert.equal(once.delivered, true);
  assert.equal(twice.delivered, false);
  assert.deepEqual(twice.ledger, once.ledger);
});
