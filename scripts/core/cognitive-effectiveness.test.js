'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEffectivenessReport } = require('./cognitive-effectiveness');

test('reports a broken delivery chain and producer pause candidates when demand exists', () => {
  const report = buildEffectivenessReport({
    inventory: { facts: 20, wiki: 3, skills: 2 },
    opportunities: 5,
  });
  assert.equal(report.status, 'broken');
  assert.equal(report.broken_stage, 'delivery');
  assert.deepEqual(report.pause_candidates, ['memory-extract', 'wiki-reflect', 'skill-evolve']);
});

test('does not recommend backpressure without observed demand', () => {
  const report = buildEffectivenessReport({ inventory: { facts: 20, wiki: 0, skills: 0 } });
  assert.equal(report.broken_stage, 'delivery');
  assert.deepEqual(report.pause_candidates, []);
});

test('tracks four consumption stages per host and recognizes a complete chain', () => {
  const consumption = ['delivered', 'opened', 'applied', 'validated']
    .map(consumer_stage => ({ consumer_stage, host: 'codex', n: 1 }));
  const report = buildEffectivenessReport({ inventory: { facts: 1 }, consumption });
  assert.equal(report.status, 'healthy');
  assert.equal(report.broken_stage, null);
  assert.equal(report.hosts.codex.validated, 1);
});
