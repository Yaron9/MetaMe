'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  collectIntentHints,
  buildIntentHintBlock,
} = require('./intent-registry');

describe('intent-registry', () => {
  it('detects file transfer hints through the shared registry', () => {
    const hints = collectIntentHints('把报告发给我', {}, '');
    assert.equal(hints.some(item => item.key === 'file_transfer'), true);
    assert.match(buildIntentHintBlock('把报告发给我', {}, ''), /\[\[FILE:\/absolute\/path\]\]/);
  });

  it('respects daemon hook toggles', () => {
    const block = buildIntentHintBlock('把报告发给我', {
      hooks: { file_transfer: false },
    }, '');
    assert.equal(block, '');
  });

  it('passes project-aware config into team dispatch detection', () => {
    const block = buildIntentHintBlock('告诉工匠处理这个', {
      projects: {
        business: {
          name: 'Business',
          team: [{ key: 'builder', name: '工匠', nicknames: ['工匠'] }],
        },
      },
    }, 'business');
    assert.match(block, /dispatch_to/);
    assert.match(block, /builder/);
  });

  it('injects weixin bridge hints by default for explicit weixin setup prompts', () => {
    const block = buildIntentHintBlock('帮我配置微信桥接并开始绑定账号', {}, '');
    assert.match(block, /\[微信桥接提示\]/);
    assert.match(block, /weixin\.enabled=true/);
    assert.match(block, /\/weixin login start/);
    assert.match(block, /text-only/);
  });

  it('allows disabling weixin bridge hints explicitly', () => {
    const block = buildIntentHintBlock('帮我配置微信桥接并开始绑定账号', {
      hooks: { weixin_bridge: false },
    }, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('does not inject weixin bridge hints for generic wechat mentions', () => {
    const block = buildIntentHintBlock('我想研究微信生态的商业模式', {
      hooks: { weixin_bridge: true },
    }, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('does not inject weixin bridge hints for generic wechat complaints without bind/setup intent', () => {
    const block = buildIntentHintBlock('微信用户说怎么还没回他，你帮我排查下模型链路', {
      hooks: { weixin_bridge: true },
    }, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });

  it('does not inject weixin bridge hints for generic no-response complaints without weixin context', () => {
    const block = buildIntentHintBlock('为什么没回，用户那边一直没收到回复', {}, '');
    assert.doesNotMatch(block, /\[微信桥接提示\]/);
  });
});
