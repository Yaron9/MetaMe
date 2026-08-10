'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isManagedWikiSourceType,
  partitionWikiPages,
  resolveWikiPageRelativePath,
  wikiPageLink,
} = require('./wiki-layout');

test('managed source predicate excludes independently-owned Wiki rows', () => {
  assert.equal(isManagedWikiSourceType('memory'), true);
  assert.equal(isManagedWikiSourceType('managed_redirect'), true);
  assert.equal(isManagedWikiSourceType('doc'), true);
  assert.equal(isManagedWikiSourceType('topic_cluster'), true);
  assert.equal(isManagedWikiSourceType('openwiki'), false);
  assert.equal(isManagedWikiSourceType('knowledge_artifact'), false);
  assert.equal(isManagedWikiSourceType(null), true);
});

test('wiki layout routes rebuildable projections by source type', () => {
  assert.equal(resolveWikiPageRelativePath({ slug: 'memory', source_type: 'memory' }), 'topics/memory.md');
  assert.equal(resolveWikiPageRelativePath({ slug: 'paper', source_type: 'doc' }), 'sources/paper.md');
  assert.equal(resolveWikiPageRelativePath({ slug: 'cluster-a', source_type: 'topic_cluster' }), 'topics/clusters/cluster-a.md');
  assert.equal(resolveWikiPageRelativePath({ slug: 'external/openwiki/quickstart', source_type: 'openwiki' }), 'external/openwiki/quickstart.md');
  assert.equal(resolveWikiPageRelativePath({ slug: 'step3-2', source_type: 'managed_redirect' }), 'topics/step3-2.md');
  assert.equal(wikiPageLink({ slug: 'memory', source_type: 'memory' }), 'topics/memory');
});

test('wiki layout preserves legacy callers without source metadata', () => {
  assert.equal(resolveWikiPageRelativePath({ slug: 'legacy' }), 'legacy.md');
});

test('wiki layout rejects traversal and partitions navigation collections', () => {
  assert.throws(() => resolveWikiPageRelativePath({ slug: '../secret', source_type: 'doc' }), /invalid wiki slug/);
  const grouped = partitionWikiPages([
    { slug: 'a', source_type: 'memory' },
    { slug: 'b', source_type: 'doc' },
    { slug: 'external/openwiki/c', source_type: 'openwiki' },
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(grouped).map(([key, value]) => [key, value.length])), {
    topics: 1,
    sources: 1,
    external: 1,
    other: 0,
  });
});
