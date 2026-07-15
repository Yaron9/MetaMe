'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditDocuments,
  extractInternalLinks,
  replaceMissingWorkspaceFiles,
  stripBrokenLinks,
} = require('./wiki-link-integrity');

test('auditDocuments resolves canonical paths and unique Obsidian basenames', () => {
  const result = auditDocuments({
    'sessions/a.md': '[[capsules/metame/daemon|Daemon]] and [[topic]]',
    'capsules/metame/daemon.md': '# Daemon',
    'topics/topic.md': '# Topic',
  });
  assert.equal(result.links, 2);
  assert.deepEqual(result.broken, []);
});

test('auditDocuments separates generated failures from authored concepts', () => {
  const result = auditDocuments({
    'sessions/a.md': '[[capsules/retired]]',
    'capsules/current.md': '[[future-concept]]',
  });
  assert.equal(result.hardBroken.length, 1);
  assert.equal(result.softBroken.length, 1);
});

test('extractInternalLinks ignores URLs and non-markdown attachments', () => {
  const links = extractInternalLinks('[[local]] [site](https://example.com) [pdf](file.pdf) [doc](../a.md)');
  assert.deepEqual(links, [
    { kind: 'wiki', target: 'local' },
    { kind: 'markdown', target: '../a.md' },
  ]);
});

test('replaceMissingWorkspaceFiles changes only missing markdown panes', () => {
  const result = replaceMissingWorkspaceFiles({ leaves: [
    { state: { file: 'capsules/retired.md' } },
    { state: { file: 'topics/live.md' } },
  ] }, new Set(['topics/live.md', 'capsules/_index.md']), 'capsules/_index.md');
  assert.equal(result.replaced, 1);
  assert.equal(result.workspace.leaves[0].state.file, 'capsules/_index.md');
  assert.equal(result.workspace.leaves[1].state.file, 'topics/live.md');
});

test('stripBrokenLinks degrades unresolved projections to readable text', () => {
  const result = stripBrokenLinks('**[[future|Future idea]]** and [Old page](old.md)', [
    { kind: 'wiki', target: 'future' },
    { kind: 'markdown', target: 'old.md' },
  ]);
  assert.equal(result.content, '**Future idea** and Old page');
  assert.equal(result.stripped, 2);
});
