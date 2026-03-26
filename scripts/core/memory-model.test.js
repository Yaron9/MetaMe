'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  matchScope,
  scoreMemoryItem,
  rankMemoryItems,
  allocateBudget,
  judgeMerge,
  assemblePromptBlocks,
  shouldPromote,
  shouldArchive,
  KIND_WEIGHTS,
  DEFAULT_BUDGET,
  RECENCY_HALF_LIFE_DAYS,
} = require('./memory-model');

function makeItem(overrides = {}) {
  return {
    id: 'mem_test',
    kind: 'insight',
    state: 'active',
    title: 'Test item',
    content: 'Test content',
    confidence: 0.7,
    project: 'metame',
    scope: null,
    agent_key: null,
    task_key: null,
    session_id: null,
    source_type: 'extract',
    tags: '[]',
    fts_rank: 0.5,
    search_count: 0,
    last_searched_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// matchScope
// ---------------------------------------------------------------------------

describe('matchScope', () => {
  it('exact match (same project + scope + agent) → 1.0', () => {
    const itemScope = { project: 'metame', scope: 'core', agent: 'jarvis' };
    const queryScope = { project: 'metame', scope: 'core', agent: 'jarvis' };
    assert.strictEqual(matchScope(itemScope, queryScope), 1.0);
  });

  it('same project, different scope → 0.6', () => {
    const itemScope = { project: 'metame', scope: 'daemon', agent: null };
    const queryScope = { project: 'metame', scope: 'core', agent: null };
    assert.strictEqual(matchScope(itemScope, queryScope), 0.6);
  });

  it('wildcard project * → 0.3', () => {
    const itemScope = { project: '*', scope: null, agent: null };
    const queryScope = { project: 'metame', scope: 'core', agent: null };
    assert.strictEqual(matchScope(itemScope, queryScope), 0.3);
  });

  it('no match at all → 0', () => {
    const itemScope = { project: 'other', scope: 'x', agent: 'a' };
    const queryScope = { project: 'metame', scope: 'core', agent: 'jarvis' };
    assert.strictEqual(matchScope(itemScope, queryScope), 0);
  });

  it('handles missing/null fields gracefully', () => {
    // null/undefined → 0
    assert.strictEqual(matchScope(null, null), 0);
    assert.strictEqual(matchScope(null, { project: 'metame' }), 0);
    assert.strictEqual(matchScope({ project: 'metame' }, null), 0);
    // both empty → both default to '*' → 0.3 (wildcard rule)
    assert.strictEqual(matchScope({}, {}), 0.3);
  });
});

// ---------------------------------------------------------------------------
// scoreMemoryItem
// ---------------------------------------------------------------------------

describe('scoreMemoryItem', () => {
  const scopeCtx = { project: 'metame', scope: 'core', agent: 'jarvis' };

  it('convention item with high scope match scores highest', () => {
    const item = makeItem({
      kind: 'convention',
      project: 'metame',
      scope: 'core',
      agent_key: 'jarvis',
      confidence: 1.0,
      fts_rank: 1.0,
    });
    const query = { text: 'test', scope: scopeCtx };
    const score = scoreMemoryItem(item, query, scopeCtx);
    assert.ok(score > 0.5, `expected high score, got ${score}`);
  });

  it('episode item with low scope match scores lower than convention', () => {
    const convention = makeItem({
      kind: 'convention',
      project: 'metame',
      scope: 'core',
      agent_key: 'jarvis',
      confidence: 1.0,
      fts_rank: 1.0,
    });
    const episode = makeItem({
      kind: 'episode',
      project: 'other',
      confidence: 0.3,
      fts_rank: 0.1,
    });
    const convScore = scoreMemoryItem(convention, 'test', scopeCtx);
    const epiScore = scoreMemoryItem(episode, 'test', scopeCtx);
    assert.ok(convScore > epiScore, `convention ${convScore} should beat episode ${epiScore}`);
  });

  it('recency decay: item from today vs 60 days ago', () => {
    const recent = makeItem({ created_at: new Date().toISOString() });
    const old = makeItem({ created_at: daysAgo(60) });
    const query = { text: 'test', scope: scopeCtx };
    const recentScore = scoreMemoryItem(recent, query, scopeCtx);
    const oldScore = scoreMemoryItem(old, query, scopeCtx);
    assert.ok(recentScore > oldScore, `recent ${recentScore} should beat old ${oldScore}`);
  });

  it('missing fts_rank defaults to 0', () => {
    const item = makeItem({ fts_rank: undefined });
    const query = { text: 'test', scope: scopeCtx };
    const score = scoreMemoryItem(item, query, scopeCtx);
    assert.strictEqual(typeof score, 'number');
    assert.ok(!Number.isNaN(score));
  });

  it('confidence 0 vs 1 difference', () => {
    const low = makeItem({ confidence: 0 });
    const high = makeItem({ confidence: 1 });
    const query = { text: 'test', scope: scopeCtx };
    const lowScore = scoreMemoryItem(low, query, scopeCtx);
    const highScore = scoreMemoryItem(high, query, scopeCtx);
    assert.ok(highScore > lowScore, `high conf ${highScore} should beat low ${lowScore}`);
  });
});

// ---------------------------------------------------------------------------
// rankMemoryItems
// ---------------------------------------------------------------------------

describe('rankMemoryItems', () => {
  const scopeCtx = { project: 'metame', scope: 'core', agent: 'jarvis' };
  const query = { text: 'test', scope: scopeCtx };

  it('returns items sorted by score descending', () => {
    const items = [
      makeItem({ id: 'low', confidence: 0.1, fts_rank: 0.1 }),
      makeItem({ id: 'high', confidence: 1.0, fts_rank: 1.0, kind: 'convention', project: 'metame', scope: 'core', agent_key: 'jarvis' }),
    ];
    const ranked = rankMemoryItems(items, query, scopeCtx);
    assert.strictEqual(ranked[0].id, 'high');
    assert.strictEqual(ranked[1].id, 'low');
  });

  it('each item gets .score property added', () => {
    const items = [makeItem()];
    const ranked = rankMemoryItems(items, query, scopeCtx);
    assert.strictEqual(typeof ranked[0].score, 'number');
  });

  it('empty array returns empty array', () => {
    const ranked = rankMemoryItems([], query, scopeCtx);
    assert.deepStrictEqual(ranked, []);
  });

  it('all same score: stable order', () => {
    const items = [
      makeItem({ id: 'a' }),
      makeItem({ id: 'b' }),
      makeItem({ id: 'c' }),
    ];
    const ranked = rankMemoryItems(items, query, scopeCtx);
    // Same score → original insertion order preserved
    const ids = ranked.map((r) => r.id);
    assert.deepStrictEqual(ids, ['a', 'b', 'c']);
  });
});

// ---------------------------------------------------------------------------
// allocateBudget
// ---------------------------------------------------------------------------

describe('allocateBudget', () => {
  it('respects per-kind limits (e.g., 8 conventions max)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `c${i}`, kind: 'convention', state: 'active', score: 1 - i * 0.01 })
    );
    const result = allocateBudget(items, DEFAULT_BUDGET);
    assert.ok(result.convention.length <= (DEFAULT_BUDGET.convention || 8));
  });

  it('only includes state=active items', () => {
    const items = [
      makeItem({ id: 'a1', state: 'active', kind: 'insight', score: 0.9 }),
      makeItem({ id: 'a2', state: 'candidate', kind: 'insight', score: 0.95 }),
    ];
    const result = allocateBudget(items, DEFAULT_BUDGET);
    const allIds = [...result.convention, ...result.insight, ...result.profile, ...result.episode].map((i) => i.id);
    assert.ok(!allIds.includes('a2'), 'candidate item should be filtered out');
    assert.ok(allIds.includes('a1'), 'active item should be included');
  });

  it('filters out candidate/archived items', () => {
    const items = [
      makeItem({ id: 'cand', state: 'candidate', kind: 'insight', score: 0.9 }),
      makeItem({ id: 'arch', state: 'archived', kind: 'insight', score: 0.8 }),
      makeItem({ id: 'act', state: 'active', kind: 'insight', score: 0.7 }),
    ];
    const result = allocateBudget(items, DEFAULT_BUDGET);
    const allIds = [...result.convention, ...result.insight, ...result.profile, ...result.episode].map((i) => i.id);
    assert.ok(!allIds.includes('cand'));
    assert.ok(!allIds.includes('arch'));
    assert.ok(allIds.includes('act'));
  });

  it('empty input returns empty buckets', () => {
    const result = allocateBudget([], DEFAULT_BUDGET);
    assert.deepStrictEqual(result.convention, []);
    assert.deepStrictEqual(result.insight, []);
    assert.deepStrictEqual(result.profile, []);
    assert.deepStrictEqual(result.episode, []);
  });

  it('budget overflow: 20 conventions truncated to limit', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ id: `c${i}`, kind: 'convention', state: 'active', score: 1 - i * 0.01 })
    );
    const budget = { convention: 5, insight: 5, profile: 3, episode: 3 };
    const result = allocateBudget(items, budget);
    assert.strictEqual(result.convention.length, 5);
  });

  it('custom budget config overrides defaults', () => {
    const items = [
      makeItem({ id: 'i1', kind: 'insight', state: 'active', score: 0.9 }),
      makeItem({ id: 'i2', kind: 'insight', state: 'active', score: 0.8 }),
      makeItem({ id: 'i3', kind: 'insight', state: 'active', score: 0.7 }),
    ];
    const budget = { convention: 8, insight: 1, profile: 3, episode: 3 };
    const result = allocateBudget(items, budget);
    assert.strictEqual(result.insight.length, 1);
  });
});

// ---------------------------------------------------------------------------
// judgeMerge
// ---------------------------------------------------------------------------

describe('judgeMerge', () => {
  it('exact content match → noop', () => {
    const candidate = makeItem({ title: 'Rule A', content: 'Do X always' });
    const existing = [makeItem({ id: 'e1', title: 'Rule A', content: 'Do X always' })];
    const result = judgeMerge(candidate, existing);
    assert.strictEqual(result.action, 'noop');
  });

  it('same title, different content → supersede with targetId', () => {
    const candidate = makeItem({ title: 'Rule A', content: 'Do X v2' });
    const existing = [makeItem({ id: 'e1', title: 'Rule A', content: 'Do X v1' })];
    const result = judgeMerge(candidate, existing);
    assert.strictEqual(result.action, 'supersede');
    assert.strictEqual(result.targetId, 'e1');
  });

  it('genuinely new → promote', () => {
    const candidate = makeItem({ title: 'Brand new rule', content: 'Something unique' });
    const existing = [makeItem({ id: 'e1', title: 'Old rule', content: 'Old content' })];
    const result = judgeMerge(candidate, existing);
    assert.strictEqual(result.action, 'promote');
  });

  it('protected item (source_type=manual) → reject', () => {
    const candidate = makeItem({ title: 'Rule A', content: 'Do X v2' });
    const existing = [makeItem({ id: 'e1', title: 'Rule A', content: 'Do X v1', source_type: 'manual' })];
    const result = judgeMerge(candidate, existing);
    assert.strictEqual(result.action, 'reject');
  });

  it('protected item (tags=[protected]) → reject', () => {
    const candidate = makeItem({ title: 'Rule A', content: 'Do X v2' });
    const existing = [makeItem({ id: 'e1', title: 'Rule A', content: 'Do X v1', tags: '["protected"]' })];
    const result = judgeMerge(candidate, existing);
    assert.strictEqual(result.action, 'reject');
  });

  it('protected item (kind=profile, confidence=0.95) → reject', () => {
    const candidate = makeItem({ title: 'User pref', content: 'Updated pref' });
    const existing = [makeItem({ id: 'e1', title: 'User pref', content: 'Original pref', kind: 'profile', confidence: 0.95 })];
    const result = judgeMerge(candidate, existing);
    assert.strictEqual(result.action, 'reject');
  });
});

// ---------------------------------------------------------------------------
// assemblePromptBlocks
// ---------------------------------------------------------------------------

describe('assemblePromptBlocks', () => {
  it('formats items as "- [title]: content"', () => {
    const allocated = {
      convention: [makeItem({ title: 'Rule 1', content: 'Always do X' })],
      insight: [],
      profile: [],
      episode: [],
    };
    const blocks = assemblePromptBlocks(allocated);
    assert.ok(blocks.conventions.includes('- [Rule 1]: Always do X'));
  });

  it('long content truncated to 200 chars', () => {
    const longContent = 'A'.repeat(300);
    const allocated = {
      convention: [makeItem({ title: 'Long', content: longContent })],
      insight: [],
      profile: [],
      episode: [],
    };
    const blocks = assemblePromptBlocks(allocated);
    // Truncated content should be <= 200 chars (plus possible ellipsis)
    const line = blocks.conventions.split('\n').find((l) => l.includes('[Long]'));
    assert.ok(line, 'should contain the item');
    assert.ok(line.length < 250, `line too long: ${line.length}`);
  });

  it('empty buckets produce empty strings', () => {
    const allocated = { convention: [], insight: [], profile: [], episode: [] };
    const blocks = assemblePromptBlocks(allocated);
    assert.strictEqual(blocks.conventions, '');
    assert.strictEqual(blocks.insights, '');
    assert.strictEqual(blocks.profile, '');
    assert.strictEqual(blocks.episodes, '');
  });

  it('missing title handled gracefully', () => {
    const allocated = {
      convention: [makeItem({ title: null, content: 'No title content' })],
      insight: [],
      profile: [],
      episode: [],
    };
    const blocks = assemblePromptBlocks(allocated);
    assert.ok(blocks.conventions.includes('No title content'));
  });
});

// ---------------------------------------------------------------------------
// shouldPromote
// ---------------------------------------------------------------------------

describe('shouldPromote', () => {
  it('search_count=3, last_searched_at=today → true', () => {
    const item = makeItem({ search_count: 3, last_searched_at: new Date().toISOString(), state: 'candidate' });
    assert.strictEqual(shouldPromote(item), true);
  });

  it('search_count=2 → false', () => {
    const item = makeItem({ search_count: 2, last_searched_at: new Date().toISOString(), state: 'candidate' });
    assert.strictEqual(shouldPromote(item), false);
  });

  it('search_count=5, last_searched_at=8 days ago → false', () => {
    const item = makeItem({ search_count: 5, last_searched_at: daysAgo(8), state: 'candidate' });
    assert.strictEqual(shouldPromote(item), false);
  });

  it('search_count=0 → false', () => {
    const item = makeItem({ search_count: 0, state: 'candidate' });
    assert.strictEqual(shouldPromote(item), false);
  });
});

// ---------------------------------------------------------------------------
// shouldArchive
// ---------------------------------------------------------------------------

describe('shouldArchive', () => {
  it('candidate, 31 days old, never searched → true', () => {
    const item = makeItem({ state: 'candidate', created_at: daysAgo(31), search_count: 0 });
    assert.strictEqual(shouldArchive(item), true);
  });

  it('candidate, 29 days old → false', () => {
    const item = makeItem({ state: 'candidate', created_at: daysAgo(29), search_count: 0 });
    assert.strictEqual(shouldArchive(item), false);
  });

  it('active, 91 days old, confidence=0.5, not searched 31 days → true', () => {
    const item = makeItem({
      state: 'active',
      created_at: daysAgo(91),
      confidence: 0.5,
      last_searched_at: daysAgo(31),
      search_count: 1,
    });
    assert.strictEqual(shouldArchive(item), true);
  });

  it('active, 91 days old, confidence=0.7 → false (confidence too high)', () => {
    const item = makeItem({
      state: 'active',
      created_at: daysAgo(91),
      confidence: 0.7,
      last_searched_at: daysAgo(31),
      search_count: 1,
    });
    assert.strictEqual(shouldArchive(item), false);
  });

  it('source_type=manual → NEVER archive', () => {
    const item = makeItem({
      state: 'candidate',
      created_at: daysAgo(100),
      source_type: 'manual',
      search_count: 0,
    });
    assert.strictEqual(shouldArchive(item), false);
  });

  it('tags=[protected] → NEVER archive', () => {
    const item = makeItem({
      state: 'candidate',
      created_at: daysAgo(100),
      tags: '["protected"]',
      search_count: 0,
    });
    assert.strictEqual(shouldArchive(item), false);
  });

  it('kind=convention + source_type=manual → NEVER archive', () => {
    const item = makeItem({
      kind: 'convention',
      state: 'active',
      created_at: daysAgo(200),
      confidence: 0.3,
      source_type: 'manual',
      last_searched_at: daysAgo(60),
      search_count: 0,
    });
    assert.strictEqual(shouldArchive(item), false);
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('KIND_WEIGHTS is an object with expected keys', () => {
    assert.ok(typeof KIND_WEIGHTS === 'object');
    assert.ok('convention' in KIND_WEIGHTS);
    assert.ok('insight' in KIND_WEIGHTS);
    assert.ok('profile' in KIND_WEIGHTS);
    assert.ok('episode' in KIND_WEIGHTS);
  });

  it('DEFAULT_BUDGET has per-kind limits', () => {
    assert.ok(typeof DEFAULT_BUDGET === 'object');
    assert.ok(typeof DEFAULT_BUDGET.convention === 'number');
    assert.ok(typeof DEFAULT_BUDGET.insight === 'number');
  });

  it('RECENCY_HALF_LIFE_DAYS is a positive number', () => {
    assert.ok(typeof RECENCY_HALF_LIFE_DAYS === 'number');
    assert.ok(RECENCY_HALF_LIFE_DAYS > 0);
  });
});
