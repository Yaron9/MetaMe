'use strict';

require('./test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mirrorProfileToMemory } = require('./distill');

describe('distill profile mirror', () => {
  it('mirrors each top-level profile section as an idempotent memory item', () => {
    const saved = [];
    const memoryStub = { saveMemoryItem: item => saved.push(item) };
    const profile = {
      identity: { name: '王总', role: 'founder' },
      preferences: { language: 'zh', verbosity: 'concise' },
      empty_section: null,
    };

    const mirrored = mirrorProfileToMemory(profile, memoryStub);

    assert.equal(mirrored, 2);
    assert.deepEqual(saved.map(s => s.id).sort(), ['profile:identity', 'profile:preferences']);
    for (const item of saved) {
      assert.equal(item.kind, 'profile');
      assert.equal(item.state, 'active');
      assert.equal(item.relation, 'user_profile');
      assert.ok(item.confidence >= 0.9, 'must stay under GC protection');
      assert.match(item.content, /identity:|preferences:/);
    }
  });

  it('is resilient to a broken memory backend', () => {
    const memoryStub = { saveMemoryItem: () => { throw new Error('db locked'); } };
    assert.equal(mirrorProfileToMemory({ identity: { name: 'x' } }, memoryStub), 0);
    assert.equal(mirrorProfileToMemory(null, memoryStub), 0);
  });
});
