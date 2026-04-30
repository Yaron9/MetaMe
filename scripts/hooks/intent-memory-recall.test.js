'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const detectMemoryRecall = require('./intent-memory-recall');

test('intent-memory-recall: returns null for non-trigger', () => {
  assert.equal(detectMemoryRecall('hello world'), null);
  assert.equal(detectMemoryRecall(''), null);
  assert.equal(detectMemoryRecall('let me think'), null);
});

test('intent-memory-recall: returns CLI hint string for ZH triggers', () => {
  const hits = [
    '上次我们讨论过这个 bug',
    '前几天提到的方案',
    '上周说的那个改动',
    '前阵子做过的实现',
    '之前讨论过的方法',
    '还记得那个 bug 吗',
    '记不记得 daemon 的修复',
  ];
  for (const text of hits) {
    const out = detectMemoryRecall(text);
    assert.equal(typeof out, 'string', `should fire for: ${text}`);
    assert.match(out, /memory-search\.js/, 'must mention CLI command');
  }
});

test('intent-memory-recall: returns CLI hint string for EN triggers', () => {
  const hits = [
    'last time we shipped this',
    'previously you said',
    'remember when we hit the bug',
    'do you remember the daemon fix',
    'earlier we discussed this',
  ];
  for (const text of hits) {
    const out = detectMemoryRecall(text);
    assert.equal(typeof out, 'string', `should fire for: ${text}`);
  }
});

test('intent-memory-recall: hint string carries CLI usage info', () => {
  const out = detectMemoryRecall('上次说过的方案');
  assert.match(out, /关键词|keyword/);
  assert.match(out, /--facts|--sessions/);
});

test('intent-memory-recall: shim is string-only — does NOT require core/recall-plan (v4.1 §P1.14)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'intent-memory-recall.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Each banned target is matched both with and without the .js suffix so
  // require('../core/recall-plan.js') cannot slip past the invariant.
  for (const banned of ['../core/recall-plan', './core/recall-plan']) {
    const re = new RegExp(`require\\s*\\(\\s*['"]${banned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.js)?['"]\\s*\\)`);
    assert.doesNotMatch(code, re, `shim must not require ${banned}`);
  }
  // Also assert it doesn't pull memory.js or daemon — it must be pure regex.
  assert.doesNotMatch(code, /require\s*\(\s*['"][.\/]+memory(?:\.js)?['"]\s*\)/, 'shim must not require ./memory');
  assert.doesNotMatch(code, /require\s*\(\s*['"][.\/]+daemon[\w-]*(?:\.js)?['"]\s*\)/, 'shim must not require any daemon module');
});
