'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildThreadChatId,
  parseThreadChatId,
  isThreadChatId,
  rawChatId,
} = require('./thread-chat-id');

describe('buildThreadChatId', () => {
  it('builds composite ID from chatId and threadId', () => {
    assert.equal(buildThreadChatId('oc_123', 'om_abc'), 'thread:oc_123:om_abc');
  });

  it('trims whitespace', () => {
    assert.equal(buildThreadChatId(' oc_123 ', ' om_abc '), 'thread:oc_123:om_abc');
  });

  it('returns plain chatId when threadId is empty', () => {
    assert.equal(buildThreadChatId('oc_123', ''), 'oc_123');
    assert.equal(buildThreadChatId('oc_123', null), 'oc_123');
    assert.equal(buildThreadChatId('oc_123', undefined), 'oc_123');
  });

  it('returns empty string when chatId is empty', () => {
    assert.equal(buildThreadChatId('', 'om_abc'), '');
    assert.equal(buildThreadChatId(null, 'om_abc'), '');
  });

  it('returns empty string when both are empty', () => {
    assert.equal(buildThreadChatId('', ''), '');
  });
});

describe('parseThreadChatId', () => {
  it('parses valid composite ID', () => {
    assert.deepEqual(parseThreadChatId('thread:oc_123:om_abc'), {
      chatId: 'oc_123',
      threadId: 'om_abc',
    });
  });

  it('handles threadId containing colons', () => {
    assert.deepEqual(parseThreadChatId('thread:oc_123:om_abc:extra'), {
      chatId: 'oc_123',
      threadId: 'om_abc:extra',
    });
  });

  it('returns null for plain chatId', () => {
    assert.equal(parseThreadChatId('oc_123'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseThreadChatId(''), null);
  });

  it('returns null for null/undefined', () => {
    assert.equal(parseThreadChatId(null), null);
    assert.equal(parseThreadChatId(undefined), null);
  });

  it('returns null when prefix present but missing parts', () => {
    assert.equal(parseThreadChatId('thread:'), null);
    assert.equal(parseThreadChatId('thread:oc_123'), null);
    assert.equal(parseThreadChatId('thread::om_abc'), null);
    assert.equal(parseThreadChatId('thread:oc_123:'), null);
  });
});

describe('isThreadChatId', () => {
  it('returns true for valid composite ID', () => {
    assert.equal(isThreadChatId('thread:oc_123:om_abc'), true);
  });

  it('returns false for plain chatId', () => {
    assert.equal(isThreadChatId('oc_123'), false);
  });

  it('returns false for malformed thread prefix', () => {
    assert.equal(isThreadChatId('thread:'), false);
    assert.equal(isThreadChatId('thread:oc_123'), false);
  });

  it('returns false for non-string', () => {
    assert.equal(isThreadChatId(null), false);
    assert.equal(isThreadChatId(123), false);
  });
});

describe('rawChatId', () => {
  it('extracts chatId from composite', () => {
    assert.equal(rawChatId('thread:oc_123:om_abc'), 'oc_123');
  });

  it('returns plain chatId as-is', () => {
    assert.equal(rawChatId('oc_123'), 'oc_123');
  });

  it('returns empty string for null', () => {
    assert.equal(rawChatId(null), '');
  });
});

describe('round-trip', () => {
  it('build then parse preserves values', () => {
    const built = buildThreadChatId('oc_foo', 'om_bar');
    const parsed = parseThreadChatId(built);
    assert.deepEqual(parsed, { chatId: 'oc_foo', threadId: 'om_bar' });
  });
});
