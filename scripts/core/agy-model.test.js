'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AGY_DEFAULT_MODEL, normalizeAgyModel } = require('./agy-model');

describe('agy model normalization', () => {
  it('resolves auto to the current supported agy default', () => {
    assert.equal(normalizeAgyModel('auto'), AGY_DEFAULT_MODEL);
  });

  it('maps legacy Claude task ids to agy model labels', () => {
    assert.equal(normalizeAgyModel('claude-sonnet-4-6'), 'Claude Sonnet 4.6 (Thinking)');
    assert.equal(normalizeAgyModel('claude-opus-4-6'), 'Claude Opus 4.6 (Thinking)');
  });

  it('does not leak Codex or unsupported Claude model ids into agy', () => {
    assert.equal(normalizeAgyModel('gpt-5.4'), AGY_DEFAULT_MODEL);
    assert.equal(normalizeAgyModel('claude-haiku-4-5-20251001'), AGY_DEFAULT_MODEL);
  });

  it('preserves current and future agy model labels', () => {
    assert.equal(normalizeAgyModel('Gemini 3.5 Flash (High)'), 'Gemini 3.5 Flash (High)');
    assert.equal(normalizeAgyModel('GPT-OSS 120B (Medium)'), 'GPT-OSS 120B (Medium)');
  });
});
