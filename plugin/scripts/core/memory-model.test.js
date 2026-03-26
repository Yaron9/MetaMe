'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreMemoryItem,
  rankMemoryItems,
  matchScope,
  allocateBudget,
  judgeMerge,
  assemblePromptBlocks,
  shouldPromote,
  shouldArchive,
  _internal: { recencyScore },
} = require('./memory-model');

const NOW = Date.now();
const scopeCtx = { project: 'test-proj', scope: 'global', agent: 'jarvis' };

function makeItem(overrides = {}) {
  return {
    kind: 'convention',
    state: 'active',
    confidence: 0.8,
    created_at: NOW,
    project: 'test-proj',
    scope: 'global',
    agent_key: 'jarvis',
    fts_rank: 0,
    ...overrides,
  };
}

describe('scoreMemoryItem', () => {
  it('returns a positive score for a valid item', () => {
    const score = scoreMemoryItem(makeItem(), 'test', scopeCtx, NOW);
    assert.ok(score > 0, `expected positive score, got ${score}`);
  });

  it('FTS rank contributes to score when normalized', () => {
    const withRank = makeItem({ fts_rank: 0.8 });
    const withoutRank = makeItem({ fts_rank: 0 });
    const s1 = scoreMemoryItem(withRank, 'test', scopeCtx);
    const s2 = scoreMemoryItem(withoutRank, 'test', scopeCtx);
    assert.ok(s1 > s2, `fts_rank 0.8 (${s1}) should score higher than 0 (${s2})`);
  });

  it('accepts optional now parameter for testability', () => {
    const item = makeItem({ created_at: NOW - 86400000 * 30 });
    const s1 = scoreMemoryItem(item, 'test', scopeCtx, NOW);
    const s2 = scoreMemoryItem(item, 'test', scopeCtx, NOW + 86400000 * 60);
    assert.ok(s1 > s2, `score at NOW (${s1}) should be higher than 60 days later (${s2})`);
  });
});

describe('rankMemoryItems', () => {
  it('sorts items by score descending', () => {
    const items = [
      makeItem({ kind: 'episode', confidence: 0.2 }),
      makeItem({ kind: 'convention', confidence: 0.9 }),
    ];
    const ranked = rankMemoryItems(items, 'test', scopeCtx, NOW);
    assert.ok(ranked[0].score >= ranked[1].score);
  });

  it('passes now through to scoreMemoryItem', () => {
    const items = [makeItem({ created_at: NOW - 86400000 * 60 })];
    const ranked = rankMemoryItems(items, 'test', scopeCtx, NOW);
    assert.ok(ranked[0].score > 0);
  });
});

describe('matchScope', () => {
  it('returns 1.0 for exact match', () => {
    assert.equal(matchScope(
      { project: 'p', scope: 's', agent: 'a' },
      { project: 'p', scope: 's', agent: 'a' },
    ), 1.0);
  });

  it('returns 0 for different projects', () => {
    assert.equal(matchScope(
      { project: 'a', scope: 's', agent: 'x' },
      { project: 'b', scope: 's', agent: 'x' },
    ), 0);
  });

  it('returns 0.3 for wildcard project', () => {
    assert.equal(matchScope(
      { project: '*', scope: 's', agent: 'a' },
      { project: 'p', scope: 's', agent: 'a' },
    ), 0.3);
  });
});

describe('recencyScore', () => {
  it('returns 1 for now', () => {
    assert.ok(Math.abs(recencyScore(NOW, NOW) - 1.0) < 0.001);
  });

  it('returns ~0.5 after half-life days', () => {
    const halfLife = 30 * 86400000;
    const score = recencyScore(NOW - halfLife, NOW);
    assert.ok(Math.abs(score - 0.5) < 0.05, `expected ~0.5, got ${score}`);
  });

  it('returns 0 for missing createdAt', () => {
    assert.equal(recencyScore(null, NOW), 0);
  });
});
