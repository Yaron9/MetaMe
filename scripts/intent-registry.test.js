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
});
