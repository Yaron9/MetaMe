'use strict';

require('../test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  makeSkeleton,
  extractEvidence,
  detectSignificantSession,
} = require('./canonical-session-analytics');

function event(actor, kind, text, timestamp, extra = {}) {
  return { actor, kind, text, timestamp, ...extra };
}

test('canonical analytics derives bounded metrics without native record shapes', () => {
  const events = [
    event('user', 'message', '请修复登录失败并保留可复用配置约定。', '2026-07-01T10:00:00.000Z'),
    event('tool', 'tool_call', JSON.stringify({ file_path: '/tmp/app/config.js' }), '2026-07-01T10:00:01.000Z', { tool: 'Edit' }),
    event('tool', 'tool_result', '2 files changed, 40 insertions(+), 20 deletions(-)', '2026-07-01T10:00:02.000Z', { outcome: { error: true } }),
    event('tool', 'tool_call', JSON.stringify({ command: 'npm test' }), '2026-07-01T10:00:03.000Z', { tool: 'Bash' }),
    event('tool', 'tool_result', '12 tests passed', '2026-07-01T10:00:04.000Z', { outcome: { error: false } }),
    event('user', 'message', '登录失败仍然存在，请继续修复。', '2026-07-01T10:01:00.000Z'),
  ];
  const skeleton = makeSkeleton(events, {
    engine: 'claude',
    nativeSessionId: 'opaque-session',
    sourceRevision: 'rev-1',
    sourceLocator: { relativePath: 'opaque.jsonl' },
  });

  assert.equal(skeleton.engine, 'claude');
  assert.equal(skeleton.session_id, 'opaque-session');
  assert.equal(skeleton.total_tool_calls, 2);
  assert.equal(skeleton.tool_error_count, 1);
  assert.equal(skeleton.error_recovered, true);
  assert.equal(skeleton.git_diff_lines, 60);
  assert.equal(skeleton.source_revision, 'rev-1');
  assert.deepEqual(skeleton.source_locator, { relativePath: 'opaque.jsonl' });
  assert.equal(skeleton.file_churn, 0);
});

test('canonical evidence and significant-session detection preserve budgets', () => {
  const events = [
    event('user', 'message', '用户需求：' + 'x'.repeat(500), '2026-07-01T10:00:00.000Z'),
    event('tool', 'tool_call', JSON.stringify({ command: 'git diff --stat' }), '2026-07-01T10:00:01.000Z', { tool: 'Bash' }),
    event('tool', 'tool_result', 'command failed', '2026-07-01T10:00:02.000Z', { tool: 'Bash', outcome: { error: true } }),
  ];
  const evidence = extractEvidence(events, 600);
  const used = [...evidence.user_messages, ...evidence.tool_traces, ...evidence.key_results]
    .reduce((sum, text) => sum + text.length, 0);
  assert.ok(used <= 600);
  assert.ok(evidence.file_anchors.length <= 12);

  const result = detectSignificantSession({
    git_diff_lines: 61,
    tool_error_count: 1,
    error_recovered: true,
  });
  assert.equal(result.significant, true);
  assert.ok(result.reasons.includes('large_change_with_error_recovery'));
});
