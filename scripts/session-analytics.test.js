'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSkeleton, detectSignificantSession } = require('./session-analytics');

function ts(baseMs, deltaSec) {
  return new Date(baseMs + deltaSec * 1000).toISOString();
}

test('extractSkeleton captures Step-1 numeric metrics', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-sa-'));
  const file = path.join(tmpDir, 'sess-1.jsonl');
  const base = Date.parse('2026-03-05T00:00:00.000Z');

  const lines = [
    { type: 'user', timestamp: ts(base, 0), cwd: '/tmp/demo', message: { content: [{ type: 'text', text: '登录 报错 修复' }] } },
    { type: 'assistant', timestamp: ts(base, 5), message: { model: 'sonnet', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: '/tmp/demo/src/a.js' } }] } },
    { type: 'assistant', timestamp: ts(base, 8), message: { model: 'sonnet', content: [{ type: 'tool_use', id: 'rb-1', name: 'Bash', input: { command: 'git restore /tmp/demo/src/a.js' } }] } },
    { type: 'assistant', timestamp: ts(base, 12), message: { model: 'sonnet', content: [{ type: 'tool_use', id: 'edit-2', name: 'Edit', input: { file_path: '/tmp/demo/src/a.js' } }] } },
    { type: 'assistant', timestamp: ts(base, 16), message: { model: 'sonnet', content: [{ type: 'tool_use', id: 'test-1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'assistant', timestamp: ts(base, 18), message: { model: 'sonnet', content: [{ type: 'tool_use', id: 'test-2', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', timestamp: ts(base, 30), message: { content: [{ type: 'text', text: '登录 报错 还在' }, { type: 'tool_result', tool_use_id: 'test-2', is_error: true, content: 'FAIL: eaddrinuse' }] } },
    { type: 'assistant', timestamp: ts(base, 50), message: { model: 'sonnet', content: [{ type: 'tool_use', id: 'diff-1', name: 'Bash', input: { command: 'git diff --stat' } }] } },
    { type: 'tool_result', timestamp: ts(base, 51), message: { tool_use_id: 'diff-1', is_error: false, content: '2 files changed, 40 insertions(+), 20 deletions(-)' } },
    { type: 'user', timestamp: ts(base, 70), message: { content: [{ type: 'text', text: '登录 报错 怎么办' }] } },
  ];

  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  const sk = extractSkeleton(file);

  assert.equal(sk.tool_error_count, 1);
  assert.equal(sk.file_churn, 1);
  assert.equal(sk.git_diff_lines, 60);
  assert.equal(sk.error_recovered, true);
  assert.deepEqual(sk.inter_message_gaps, [30, 40]);
  assert.equal(sk.longest_pause_sec, 40);
  assert.equal(sk.avg_pause_sec, 35);
  assert.ok(sk.retry_sequences >= 2);
  assert.ok(sk.semantic_repetition > 0);
});

test('detectSignificantSession uses numeric-only thresholds', () => {
  const a = detectSignificantSession({
    git_diff_lines: 61,
    tool_error_count: 1,
    error_recovered: true,
    duration_min: 20,
    retry_sequences: 1,
  });
  assert.equal(a.significant, true);
  assert.ok(a.reasons.includes('large_change_with_error_recovery'));

  const b = detectSignificantSession({
    git_diff_lines: 10,
    tool_error_count: 0,
    error_recovered: false,
    duration_min: 90,
    retry_sequences: 7,
  });
  assert.equal(b.significant, true);
  assert.ok(b.reasons.includes('long_debug_retry_loop'));
});
