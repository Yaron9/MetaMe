'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calcStaleness } = require('./wiki-staleness.js');

test('calcStaleness(0, 10) === 0', () => {
  assert.strictEqual(calcStaleness(0, 10), 0);
});

test('calcStaleness(10, 0) === 1', () => {
  assert.strictEqual(calcStaleness(10, 0), 1);
});

test('calcStaleness(4, 6) ≈ 0.4 (error < 0.001)', () => {
  const result = calcStaleness(4, 6);
  assert.ok(Math.abs(result - 0.4) < 0.001, `expected ~0.4 but got ${result}`);
});

test('calcStaleness(0, 0) === 0 (no divide-by-zero)', () => {
  assert.strictEqual(calcStaleness(0, 0), 0);
});

test('arbitrary positive integers yield result in [0, 1]', () => {
  const cases = [
    [1, 1],
    [100, 1],
    [1, 100],
    [999, 1000],
    [7, 3],
    [50, 50],
  ];
  for (const [newFacts, rawSourceCount] of cases) {
    const result = calcStaleness(newFacts, rawSourceCount);
    assert.ok(
      result >= 0 && result <= 1,
      `calcStaleness(${newFacts}, ${rawSourceCount}) = ${result} is out of [0,1]`
    );
  }
});
