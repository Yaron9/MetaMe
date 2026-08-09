'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { assembleSearchResults, scopeKeys } = require('./cognitive-consumption');

test('assembleSearchResults returns typed summary-first facts and wiki', () => {
  const result = assembleSearchResults({
    facts: [{ id: 'f1', title: 'Deploy rule', content: 'Run tests first', project: 'metame', confidence: 0.9, provenance_root_id: 'session:s1' }],
    wikiPages: [{ slug: 'deploy', title: 'Deploy guide', excerpt: 'A safe deployment guide', project_key: 'metame', score: 0.8 }],
  }, { limit: 5, maxChars: 4000 });

  assert.deepEqual(result.results.map(item => item.type), ['fact', 'wiki']);
  assert.equal(result.results[0].provenance[0], 'session:s1');
  assert.equal(result.results[1].content, undefined, 'search returns summaries, not full content');
});

test('assembleSearchResults excludes stale wiki and exact cross-source duplicates', () => {
  const result = assembleSearchResults({
    facts: [{ id: 'f1', title: 'Deploy rule', content: 'Run tests first' }],
    wikiPages: [
      { slug: 'same', title: 'Deploy rule', excerpt: 'Run tests first' },
      { slug: 'stale', title: 'Old rule', excerpt: 'Old', stale: true },
    ],
  });
  assert.deepEqual(result.results.map(item => `${item.type}:${item.id}`), ['fact:f1']);
});

test('assembleSearchResults fails closed on contradictory active facts', () => {
  const result = assembleSearchResults({
    facts: [
      { id: 'old', title: 'Runtime.port', relation: 'config_fact', content: 'Port is 3000', project: 'metame' },
      { id: 'new', title: 'Runtime.port', relation: 'config_fact', content: 'Port is 4000', project: 'metame' },
      { id: 'safe', title: 'Runtime.host', relation: 'config_fact', content: 'Host is local', project: 'metame' },
    ],
  });
  assert.deepEqual(result.results.map(item => item.id), ['safe']);
});

test('assembleSearchResults keeps only the newest exact duplicate fact', () => {
  const result = assembleSearchResults({
    facts: [
      { id: 'old', title: 'Runtime.port', relation: 'config_fact', content: 'Port is 4000', updated_at: '2026-01-01' },
      { id: 'new', title: 'Runtime.port', relation: 'config_fact', content: 'Port is 4000', updated_at: '2026-02-01' },
    ],
  });
  assert.deepEqual(result.results.map(item => item.id), ['new']);
});

test('assembleSearchResults applies deterministic result and character budgets', () => {
  const facts = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, title: `Fact ${i}`, content: 'x'.repeat(500) }));
  const result = assembleSearchResults({ facts }, { limit: 3, maxChars: 500 });
  assert.ok(result.results.length <= 3);
  assert.equal(result.truncated, true);
  assert.ok(result.usedChars <= 520, `budget drift too large: ${result.usedChars}`);
});

test('scopeKeys normalizes one optional project key', () => {
  assert.deepEqual(scopeKeys(' MetaMe '), ['metame']);
  assert.deepEqual(scopeKeys(''), []);
});
