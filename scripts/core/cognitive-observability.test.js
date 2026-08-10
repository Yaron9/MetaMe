'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildObservabilityResult,
  normalizeDays,
  toBoundedSourceRef,
} = require('./cognitive-observability');

test('observability deduplicates one observe/inject opportunity and trace/source pairs', () => {
  const result = buildObservabilityResult({
    now: '2026-08-10T00:00:00.000Z',
    auditRows: [
      { id: 'observe', phase: 'observe', trace_id: 'trace-1', should_recall: 1 },
      { id: 'inject', phase: 'inject', trace_id: 'trace-1', should_recall: 1, source_refs: '["id:item-1"]', injected_chars: 120, outcome: 'injected' },
      { id: 'delivery-a', phase: 'consume', trace_id: 'trace-1', consumer_stage: 'delivered', source_refs: '["id:item-1","wiki:guide"]', injected_chars: 80 },
      { id: 'delivery-b', phase: 'consume', trace_id: 'trace-1', consumer_stage: 'delivered', source_refs: '["id:item-1"]', injected_chars: 80 },
    ],
    sessionSources: [{ status: 'indexed' }],
  });
  assert.equal(result.recall.audit_rows, 4);
  assert.equal(result.recall.unique_traces, 1);
  assert.equal(result.recall.opportunities, 1);
  assert.equal(result.recall.injected, 1);
  assert.equal(result.recall.delivered, 2, 'two unique trace/source pairs');
  assert.equal(result.efficiency.delivered_chars, 160);
  assert.equal(result.recall.feedback_coverage, null);
  assert.ok(result.diagnostics.some(item => item.code === 'insufficient_data'));
});

test('missing feedback is unknown rather than a fabricated hit rate', () => {
  const result = buildObservabilityResult({
    auditRows: [{ id: 'delivery', phase: 'consume', trace_id: 'trace-1', consumer_stage: 'delivered', source_refs: '["fact:f1"]' }],
    sessionSources: [{ status: 'indexed' }],
  });
  assert.equal(result.recall.unknown_usage, 1);
  assert.equal(result.recall.feedback_coverage, null);
  assert.equal(result.status, 'degraded');
  assert.ok(result.diagnostics.some(item => item.code === 'insufficient_data'));
});

test('bounded source references reject recalled text and cap identifiers', () => {
  assert.equal(toBoundedSourceRef({ kind: 'fact', id: 'f1' }), 'fact:f1');
  assert.equal(toBoundedSourceRef('fact:credential_value'), 'fact:credential_value');
  assert.equal(toBoundedSourceRef('this is recalled content'), null);
  assert.equal(toBoundedSourceRef(`wiki:${'x'.repeat(161)}`), null);
});

test('days validation accepts the contract range only', () => {
  assert.equal(normalizeDays(), 30);
  assert.equal(normalizeDays('1'), 1);
  assert.equal(normalizeDays(365), 365);
  assert.throws(() => normalizeDays(0), /1 to 365/);
  assert.throws(() => normalizeDays(366), /1 to 365/);
  assert.throws(() => normalizeDays('1.5'), /1 to 365/);
});
