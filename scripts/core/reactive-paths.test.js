'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { resolveReactivePaths, resolveLegacyPaths } = require('./reactive-paths');

describe('resolveReactivePaths', () => {
  it('returns correct directory structure', () => {
    const p = resolveReactivePaths('scientist', '/home/user/.metame');
    assert.equal(p.dir, path.join('/home/user/.metame', 'reactive', 'scientist'));
    assert.equal(p.memory, path.join(p.dir, 'memory.md'));
    assert.equal(p.l2cache, path.join(p.dir, 'l2cache.md'));
    assert.equal(p.state, path.join(p.dir, 'state.md'));
    assert.equal(p.events, path.join(p.dir, 'events.jsonl'));
    assert.equal(p.latest, path.join(p.dir, 'latest.md'));
  });

  it('works with different keys', () => {
    const p = resolveReactivePaths('my_project', '/tmp/meta');
    assert.equal(p.dir, path.join('/tmp/meta', 'reactive', 'my_project'));
    assert.equal(p.events, path.join('/tmp/meta', 'reactive', 'my_project', 'events.jsonl'));
  });
});

describe('resolveLegacyPaths', () => {
  it('returns flat legacy paths', () => {
    const p = resolveLegacyPaths('scientist', '/home/user/.metame');
    assert.equal(p.memory, path.join('/home/user/.metame', 'memory', 'now', 'scientist_memory.md'));
    assert.equal(p.l2cache, path.join('/home/user/.metame', 'memory', 'now', 'scientist_l2cache.md'));
    assert.equal(p.state, path.join('/home/user/.metame', 'memory', 'now', 'scientist.md'));
    assert.equal(p.events, path.join('/home/user/.metame', 'events', 'scientist.jsonl'));
    assert.equal(p.latest, path.join('/home/user/.metame', 'memory', 'agents', 'scientist_latest.md'));
  });
});
