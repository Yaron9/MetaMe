'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { parseInterval, formatRelativeTime, createPathMap } = require('./utils');

// ---------------------------------------------------------
// parseInterval
// ---------------------------------------------------------
describe('parseInterval', () => {
  it('parses seconds', () => {
    assert.equal(parseInterval('30s'), 30);
    assert.equal(parseInterval('1s'), 1);
    assert.equal(parseInterval('0s'), 0);
  });

  it('parses minutes', () => {
    assert.equal(parseInterval('5m'), 300);
    assert.equal(parseInterval('1m'), 60);
  });

  it('parses hours', () => {
    assert.equal(parseInterval('1h'), 3600);
    assert.equal(parseInterval('2h'), 7200);
  });

  it('parses days', () => {
    assert.equal(parseInterval('1d'), 86400);
    assert.equal(parseInterval('7d'), 604800);
  });

  it('defaults to 3600 for invalid input', () => {
    assert.equal(parseInterval('abc'), 3600);
    assert.equal(parseInterval(''), 3600);
    assert.equal(parseInterval('10'), 3600);
    assert.equal(parseInterval('10x'), 3600);
    assert.equal(parseInterval(null), 3600);
    assert.equal(parseInterval(undefined), 3600);
  });
});

// ---------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------
describe('formatRelativeTime', () => {
  it('returns 刚刚 for times less than 1 minute ago', () => {
    const now = new Date().toISOString();
    assert.equal(formatRelativeTime(now), '刚刚');
  });

  it('returns N分钟前 for times under 1 hour', () => {
    const d = new Date(Date.now() - 5 * 60000).toISOString();
    assert.equal(formatRelativeTime(d), '5分钟前');
  });

  it('returns N小时前 for times under 24 hours', () => {
    const d = new Date(Date.now() - 3 * 3600000).toISOString();
    assert.equal(formatRelativeTime(d), '3小时前');
  });

  it('returns 昨天 for 1 day ago', () => {
    const d = new Date(Date.now() - 1.5 * 86400000).toISOString();
    assert.equal(formatRelativeTime(d), '昨天');
  });

  it('returns N天前 for 2-6 days', () => {
    const d = new Date(Date.now() - 3 * 86400000).toISOString();
    assert.equal(formatRelativeTime(d), '3天前');
  });

  it('returns date for 7+ days', () => {
    const d = new Date(Date.now() - 10 * 86400000).toISOString();
    const result = formatRelativeTime(d);
    // Should be a date string like "1/15" (month/day)
    assert.match(result, /\d+\/\d+/);
  });
});

// ---------------------------------------------------------
// createPathMap (shortenPath / expandPath)
// ---------------------------------------------------------
describe('createPathMap', () => {
  let shortenPath, expandPath;

  beforeEach(() => {
    ({ shortenPath, expandPath } = createPathMap());
  });

  it('shortens a path to a compact id', () => {
    const id = shortenPath('/Users/foo/bar/baz');
    assert.match(id, /^p\d+$/);
  });

  it('expands back to original path', () => {
    const original = '/Users/foo/bar/baz';
    const id = shortenPath(original);
    assert.equal(expandPath(id), original);
  });

  it('returns same id for same path', () => {
    const p = '/Users/foo/project';
    const id1 = shortenPath(p);
    const id2 = shortenPath(p);
    assert.equal(id1, id2);
  });

  it('returns different ids for different paths', () => {
    const id1 = shortenPath('/a');
    const id2 = shortenPath('/b');
    assert.notEqual(id1, id2);
  });

  it('expandPath returns input if not a known id', () => {
    assert.equal(expandPath('/some/real/path'), '/some/real/path');
  });

  it('ids are short enough for Telegram callback_data', () => {
    // Even with 1000 paths, id should be < 10 bytes
    for (let i = 0; i < 1000; i++) {
      shortenPath(`/path/${i}`);
    }
    const id = shortenPath('/path/1000');
    assert.ok(Buffer.byteLength(id) < 10, `id "${id}" too long`);
  });
});
