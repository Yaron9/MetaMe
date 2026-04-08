'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildWikiPrompt, validateWikilinks } = require('./wiki-prompt');

const sampleTopic = { tag: 'ai', slug: 'artificial-intelligence', label: '人工智能' };
const sampleFacts = [
  { title: '定义', content: '人工智能是模拟人类智能的技术', confidence: 0.95, search_count: 120 },
  { title: '历史', content: '1956年达特茅斯会议正式提出该概念', confidence: 0.9, search_count: 80 },
];
const sampleSlugs = ['machine-learning', 'neural-network'];

describe('buildWikiPrompt', () => {
  it('返回字符串包含 topic.label', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '', sampleSlugs);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('人工智能'));
  });

  it('返回字符串包含至少一条 fact 内容', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '', sampleSlugs);
    assert.ok(result.includes('人工智能是模拟人类智能的技术'));
  });

  it('返回字符串包含 allowedSlugs 中的 slug 提示', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '', sampleSlugs);
    assert.ok(result.includes('machine-learning'));
    assert.ok(result.includes('neural-network'));
  });

  it('包含 capsuleExcerpts 背景内容', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '深度学习是AI的子领域', sampleSlugs);
    assert.ok(result.includes('深度学习是AI的子领域'));
  });

  it('capsuleExcerpts 为空时不输出背景补充段', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '', sampleSlugs);
    assert.ok(!result.includes('背景补充'));
  });

  it('allowedSlugs 为空时输出不得使用 wikilinks 的提示', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '', []);
    assert.ok(result.includes('不得使用任何 [[wikilinks]]'));
  });

  it('facts 为空数组时不输出参考事实段', () => {
    const result = buildWikiPrompt(sampleTopic, [], '', sampleSlugs);
    assert.ok(!result.includes('参考事实'));
  });

  it('包含中文要求说明', () => {
    const result = buildWikiPrompt(sampleTopic, sampleFacts, '', sampleSlugs);
    assert.ok(result.includes('中文'));
  });
});

describe('validateWikilinks', () => {
  it('不在白名单的 wikilink 被剥除，加入 stripped', () => {
    const { content, stripped } = validateWikilinks('text [[valid]] and [[bad]]', ['valid']);
    assert.equal(content, 'text [[valid]] and bad');
    assert.deepEqual(stripped, ['bad']);
  });

  it('白名单为空时，所有 wikilink 被剥除', () => {
    const { content, stripped } = validateWikilinks('see [[alpha]] and [[beta]]', []);
    assert.equal(content, 'see alpha and beta');
    assert.deepEqual(stripped, ['alpha', 'beta']);
  });

  it('无 wikilink 的正文原样返回，stripped 为 []', () => {
    const { content, stripped } = validateWikilinks('plain text without links', ['valid']);
    assert.equal(content, 'plain text without links');
    assert.deepEqual(stripped, []);
  });

  it('有效 slug 不在 stripped 中', () => {
    const { stripped } = validateWikilinks('[[valid]] and [[invalid]]', ['valid']);
    assert.ok(!stripped.includes('valid'));
    assert.ok(stripped.includes('invalid'));
  });

  it('多个有效 slug 全部保留', () => {
    const { content, stripped } = validateWikilinks('[[a]] [[b]] [[c]]', ['a', 'b']);
    assert.equal(content, '[[a]] [[b]] c');
    assert.deepEqual(stripped, ['c']);
  });

  it('同一无效 slug 出现多次，每次都被剥除', () => {
    const { content, stripped } = validateWikilinks('[[x]] and [[x]] again', []);
    assert.equal(content, 'x and x again');
    assert.deepEqual(stripped, ['x', 'x']);
  });

  it('allowedSlugs 为 undefined 时，所有 wikilink 被剥除', () => {
    const { content, stripped } = validateWikilinks('[[foo]] bar', undefined);
    assert.equal(content, 'foo bar');
    assert.deepEqual(stripped, ['foo']);
  });
});
