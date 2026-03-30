'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScanSummary } = require('./ops-reactive-bootstrap');

test('buildScanSummary reports quiet scans explicitly', () => {
  const result = buildScanSummary(
    { pruned: 0 },
    { new_missions: 0, total_pending: 3 },
    { completed: false },
    { started: false, reason: 'already_running' }
  );

  assert.equal(result.quiet, true);
  assert.equal(result.action, 'quiet_scan');
  assert.deepEqual(result.findings, []);
  assert.match(result.summary, /no new recurring issues/i);
});

test('buildScanSummary reports bootstrap completion and started repair mission', () => {
  const result = buildScanSummary(
    { pruned: 1 },
    { new_missions: 2, total_pending: 5 },
    { completed: true },
    { started: true, mission: 'Fix failing tests in e2e-reactive-lifecycle.test.js', missionId: 'ops-20260319-013' }
  );

  assert.equal(result.quiet, false);
  assert.equal(result.action, 'repair_started');
  assert.equal(result.findings.length, 4);
  assert.ok(result.findings.some((line) => line.includes('completed legacy bootstrap-001')));
  assert.ok(result.findings.some((line) => line.includes('started repair ops-20260319-013')));
  assert.match(result.summary, /detected 2 new repair missions/i);
});
