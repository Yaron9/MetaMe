'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toSlug, sanitizeFts5 } = require('./wiki-slug.js');

// --- toSlug tests ---

test('toSlug: basic mixed case with Chinese and slash', () => {
  assert.equal(toSlug('Session 管理 / v2'), 'session-管理-v2');
});

test('toSlug: empty string throws Error', () => {
  assert.throws(() => toSlug(''), /Error/);
});

test('toSlug: only special chars throws Error', () => {
  assert.throws(() => toSlug('!!!###'), /Error/);
});

test('toSlug: truncates to 80 chars', () => {
  const result = toSlug('a'.repeat(100));
  assert.ok(result.length <= 80, `expected length <= 80, got ${result.length}`);
});

test('toSlug: collapses multiple hyphens', () => {
  assert.equal(toSlug('hello--world'), 'hello-world');
});

// --- sanitizeFts5 tests ---

test('sanitizeFts5: plain text passes through', () => {
  assert.equal(sanitizeFts5('hello world'), 'hello world');
});

test('sanitizeFts5: removes FTS5 special chars " * ^', () => {
  const result = sanitizeFts5('a"b*c^d');
  assert.ok(!result.includes('"'), 'should not contain "');
  assert.ok(!result.includes('*'), 'should not contain *');
  assert.ok(!result.includes('^'), 'should not contain ^');
});

test('sanitizeFts5: whitespace-only returns null', () => {
  assert.equal(sanitizeFts5('   '), null);
});

test('sanitizeFts5: empty string returns null', () => {
  assert.equal(sanitizeFts5(''), null);
});
