'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDossierSlug,
  buildDossierPrompt,
  groupTopicEvidence,
  normalizeProjectKey,
  normalizeTopicKey,
  parseStructuredClaims,
  planCanonicalTopics,
  relatedTopics,
  renderDossier,
  renderTopicHub,
  safePathSegment,
  selectDossierEvidence,
  sourceMembershipHash,
} = require('./wiki-topic-model');

test('normalizes case, compatibility unicode and whitespace without changing raw tags', () => {
  assert.equal(normalizeTopicKey('  Ｓｔｅｐ３  '), 'step3');
  assert.equal(normalizeTopicKey('Skill\n  Design'), 'skill design');
  assert.equal(normalizeProjectKey('MetaMe'), 'metame');
  assert.equal(normalizeProjectKey('*'), null);
  assert.equal(normalizeProjectKey('unknown'), null);
});

test('builds traversal-safe stable dossier slugs and handles collisions', () => {
  assert.equal(buildDossierSlug('step3', 'MetaMe'), 'step3/projects/metame');
  assert.match(buildDossierSlug('step3', '.metame'), /^step3\/projects\/metame-[a-f0-9]{8}$/);
  assert.equal(safePathSegment('projects'), 'p-projects');
  assert.match(safePathSegment('MetaMe', { existing: ['metame'] }), /^metame-[a-f0-9]{8}$/);
  assert.throws(() => buildDossierSlug('../step3', 'MetaMe'), /invalid topic slug/);
});

test('creates dossiers only from three distinct active atomic facts', () => {
  const items = [
    { id: '1', project: 'MetaMe', kind: 'insight', state: 'active' },
    { id: '2', project: 'metame', kind: 'convention', state: 'active' },
    { id: '3', project: 'METAME', kind: 'insight', state: 'active' },
    { id: '4', project: 'Other', kind: 'insight', state: 'active' },
    { id: '5', project: 'Other', kind: 'episode', state: 'active' },
    { id: '6', project: '*', kind: 'insight', state: 'active' },
  ];
  const grouped = groupTopicEvidence(items);
  assert.deepEqual(grouped.dossiers.map(row => row.projectKey), ['metame']);
  assert.deepEqual(grouped.dossiers[0].facts.map(row => row.id), ['1', '2', '3']);
  assert.deepEqual(grouped.sparse.map(row => row.id).sort(), ['4', '6']);
});

test('selects bounded dossier evidence with relation coverage', () => {
  const facts = [
    ...Array.from({ length: 25 }, (_, i) => ({ id: `same-${i}`, relation: 'decision', content: 'x'.repeat(500) })),
    { id: 'failure', relation: 'failure', content: 'failed once' },
    { id: 'workflow', relation: 'workflow', content: 'actual workflow' },
  ];
  const selected = selectDossierEvidence(facts);
  assert.ok(selected.length <= 20);
  assert.ok(selected.some(fact => fact.id === 'failure'));
  assert.ok(selected.some(fact => fact.id === 'workflow'));
  assert.ok(selected.reduce((sum, fact) => sum + fact._promptText.length, 0) <= 6000);
});

test('structured claims reject hallucinated refs and candidate authority', () => {
  const valid = parseStructuredClaims('{"claims":[{"section":"decisions","text":"采用 WAL","evidenceRefs":["M:1"]}]}', ['M:1']);
  assert.equal(valid.claims[0].text, '采用 WAL');
  assert.throws(() => parseStructuredClaims('{"claims":[{"section":"decisions","text":"x","evidenceRefs":["M:2"]}]}', ['M:1']), /invalid evidence/);
  assert.throws(() => parseStructuredClaims('{"claims":[{"section":"current_state","text":"x","evidenceRefs":["C:1"]}]}', ['C:1']), /candidate evidence/);
});

test('renderer emits sections and evidence footnotes deterministically', () => {
  const content = renderDossier({
    title: 'Step3', projectKey: 'metame', hubSlug: 'step3',
    claims: [{ section: 'decisions', text: '采用 WAL', evidenceRefs: ['M:1'] }],
    evidence: [{ ref: 'M:1', text: 'SQLite 使用 WAL。' }],
  });
  assert.match(content, /## 关键决策/);
  assert.match(content, /\[\^M:1\]: SQLite 使用 WAL/);
});

test('dossier prompt is project-grounded and hub does not duplicate dossier facts', () => {
  const prompt = buildDossierPrompt({ topic: 'Step3', projectKey: 'metame', evidence: [
    { ref: 'M:1', state: 'active', kind: 'insight', text: '采用 WAL' },
  ] });
  assert.match(prompt, /不是在写百科词条/);
  assert.match(prompt, /M:1/);
  const hub = renderTopicHub({
    title: 'Step3', topicSlug: 'step3',
    dossiers: [{ slug: 'step3/projects/metame', projectKey: 'metame', factCount: 3 }],
    sparse: [{ id: 's1', content: '全局约束' }],
  });
  assert.match(hub, /\[\[topics\/step3\/projects\/metame\|metame\]\]/);
  assert.doesNotMatch(hub, /采用 WAL/);
  assert.match(hub, /全局约束/);
});

test('membership hash and related-topic ranking are order independent', () => {
  assert.equal(sourceMembershipHash([{ id: 'b' }, { id: 'a' }]), sourceMembershipHash([{ id: 'a' }, { id: 'b' }]));
  assert.notEqual(sourceMembershipHash([{ id: 'a', content: 'old' }]), sourceMembershipHash([{ id: 'a', content: 'new' }]));
  const result = relatedTopics([
    { slug: 'b', shared: 2, leftTotal: 4, rightTotal: 4 },
    { slug: 'a', shared: 3, leftTotal: 9, rightTotal: 4 },
    { slug: 'ignored', shared: 1, leftTotal: 1, rightTotal: 1 },
  ]);
  assert.deepEqual(result.map(row => row.slug), ['a', 'b']);
});

test('canonical topic planning merges normalization aliases but not semantic plurals', () => {
  const plan = planCanonicalTopics([
    { tag: 'Step3', slug: 'step3' },
    { tag: 'step3', slug: 'step3-2' },
    { tag: 'skill', slug: 'skill' },
    { tag: 'skills', slug: 'skills' },
  ]);
  assert.equal(plan.length, 3);
  const step3 = plan.find(item => item.slug === 'step3');
  assert.deepEqual(step3.aliases, ['step3', 'Step3']);
  assert.deepEqual(step3.legacySlugs, ['step3-2']);
  assert.ok(plan.some(item => item.slug === 'skill'));
  assert.ok(plan.some(item => item.slug === 'skills'));
});
