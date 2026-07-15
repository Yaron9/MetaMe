'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRelativePath,
  projectMarkdown,
  slugForRelativePath,
  splitFrontmatter,
} = require('./openwiki-projection');

describe('OpenWiki Markdown projection', () => {
  it('hashes title and scope metadata as well as body content', () => {
    const base = projectMarkdown({
      relativePath: 'topic.md', markdown: '---\ntitle: One\n---\nBody', scopeTags: ['metame'],
    });
    const retitled = projectMarkdown({
      relativePath: 'topic.md', markdown: '---\ntitle: Two\n---\nBody', scopeTags: ['metame'],
    });
    const rescoped = projectMarkdown({
      relativePath: 'topic.md', markdown: '---\ntitle: One\n---\nBody', scopeTags: ['private'],
    });
    assert.notEqual(base.contentHash, retitled.contentHash);
    assert.notEqual(base.contentHash, rescoped.contentHash);
  });

  it('creates a stable namespaced page without indexing frontmatter', () => {
    const page = projectMarkdown({
      relativePath: 'sources/Git Repo.md',
      markdown: '---\ntitle: "Git Evidence"\nprivate: false\n---\n# Ignored title\n\nEvidence body.',
      scopeTags: ['metame'],
    });
    assert.equal(page.sourceKey, 'openwiki:sources/Git Repo.md');
    assert.equal(page.pageSpec.slug, 'external/openwiki/sources/git-repo');
    assert.equal(page.pageSpec.title, 'Git Evidence');
    assert.equal(page.content, '# Ignored title\n\nEvidence body.');
    assert.deepEqual(page.pageSpec.topic_tags, ['metame', 'external', 'openwiki', 'sources']);
    assert.deepEqual(page.pageSpec.raw_source_ids, ['openwiki:sources/Git Repo.md']);
  });

  it('uses the first H1 then filename as title fallbacks', () => {
    assert.equal(projectMarkdown({
      relativePath: 'themes.md', markdown: '# Active Themes\nbody',
    }).pageSpec.title, 'Active Themes');
    assert.equal(projectMarkdown({
      relativePath: 'open-questions.md', markdown: 'No heading here.',
    }).pageSpec.title, 'open questions');
  });

  it('rejects traversal, empty pages and non-Markdown files', () => {
    assert.throws(() => normalizeRelativePath('../secret.md'), /unsafe/);
    assert.throws(() => slugForRelativePath('raw.json'), /only accepts Markdown/);
    assert.throws(() => projectMarkdown({ relativePath: 'empty.md', markdown: '  ' }), /empty/);
  });

  it('treats incomplete frontmatter as normal content', () => {
    assert.deepEqual(splitFrontmatter('---\ntitle: unfinished\nbody'), {
      body: '---\ntitle: unfinished\nbody', frontmatter: '',
    });
  });
});
