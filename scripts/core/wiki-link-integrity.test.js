'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  auditDocuments,
  auditWorkspaceState,
  extractInternalLinks,
  replaceMissingWorkspaceFiles,
} = require('./wiki-link-integrity');

test('auditDocuments resolves canonical paths, attachments, and unique basenames', () => {
  const result = auditDocuments({
    'sessions/a.md': 'Summary\n\n## Related Knowledge\n\n- Capsule: [[capsules/metame/daemon|Daemon]]\n![[assets/photo.png]]\n[[topic]]',
    'capsules/metame/daemon.md': '# Daemon',
    'topics/topic.md': '# Topic',
  }, { availableFiles: [
    'sessions/a.md', 'capsules/metame/daemon.md', 'topics/topic.md', 'assets/photo.png',
  ] });
  assert.equal(result.links, 3);
  assert.deepEqual(result.broken, []);
});

test('auditDocuments treats only generated navigation failures as hard', () => {
  const result = auditDocuments({
    'sessions/a.md': '[[future-note]]\n\n## Related Knowledge\n\n- Capsule: [[capsules/retired]]',
    'capsules/current.md': '[[future-concept]]',
  });
  assert.deepEqual(result.hardBroken.map(item => item.target), ['capsules/retired']);
  assert.deepEqual(result.softBroken.map(item => item.target), ['future-note', 'future-concept']);
});

test('extractInternalLinks ignores fenced code, inline code, comments, and URLs', () => {
  const links = extractInternalLinks([
    '[[local]] [doc](../My%20Page.md)',
    '```md', '[[example-missing]]', '```',
    '`[[inline]]` <!-- [[comment]] -->',
    '[site](https://example.com) [pdf](file.pdf)',
  ].join('\n'));
  assert.deepEqual(links.map(({ kind, target }) => ({ kind, target })), [
    { kind: 'wiki', target: 'local' },
    { kind: 'markdown', target: '../My Page.md' },
  ]);
});

test('path matching remains case-sensitive', () => {
  const result = auditDocuments({ 'a.md': '[wrong](Foo.md)', 'foo.md': '# lower' });
  assert.equal(result.softBroken.length, 1);
});

test('workspace audit is limited to file-backed leaf views', () => {
  const workspace = { children: [
    { type: 'leaf', state: { type: 'markdown', state: { file: 'missing.md' } } },
    { type: 'leaf', state: { type: 'search', state: { file: 'not-a-view.md' } } },
    { metadata: { file: 'not-a-leaf.md' } },
  ] };
  const audit = auditWorkspaceState(workspace, ['live.md']);
  assert.deepEqual(audit.missing.map(item => item.file), ['missing.md']);
  const repaired = replaceMissingWorkspaceFiles(workspace, audit.missing, 'live.md');
  assert.equal(repaired.replaced, 1);
  assert.equal(repaired.workspace.children[0].state.state.file, 'live.md');
  assert.equal(repaired.workspace.children[1].state.state.file, 'not-a-view.md');
  assert.equal(repaired.workspace.children[2].metadata.file, 'not-a-leaf.md');
});
