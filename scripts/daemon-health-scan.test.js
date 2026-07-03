'use strict';

require('./test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readRecentErrors, groupErrors, formatReport } = require('./daemon-health-scan');

test('health scan reads only timestamped daemon WARN/ERROR log entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-health-scan-'));
  const logFile = path.join(dir, 'daemon.log');
  const now = new Date().toISOString();
  fs.writeFileSync(logFile, [
    `[${now}] [WARN] Config: unknown daemon.old_key (typo?)`,
    '• [2026-05-06T00:00:00.000Z] [WARN] echoed report line should not count',
    `[${now}] [INFO] normal info`,
  ].join('\n'), 'utf8');

  const lines = readRecentErrors(logFile, 24 * 60 * 60 * 1000);
  assert.deepEqual(lines, [`[${now}] [WARN] Config: unknown daemon.old_key (typo?)`]);
});

test('health scan report has one 24h summary line', () => {
  const report = formatReport({
    severity: 'medium',
    summary: '测试摘要',
    issues: [],
    action: '检查日志',
  }, 2, 1);

  assert.equal((report.match(/过去24h/g) || []).length, 1);
});

test('health scan grouping keeps long error context before bucketing', () => {
  const longLine = `[2026-05-06T00:00:00.000Z] [WARN] ${'x'.repeat(500)}`;
  const grouped = groupErrors([longLine]);
  assert.equal(grouped[0].count, 1);
});
