'use strict';

require('./test-support/env-setup');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { extractSkeleton, detectSignificantSession, buildCodexInput, formatForPrompt, _internal } = require('./session-analytics');

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

test('Claude native gitBranch maps to the canonical branch prompt field', () => {
  const fixture = path.join(__dirname, 'engines', 'fixtures', 'claude-native-session.jsonl');
  const skeleton = extractSkeleton(fixture);

  assert.equal(skeleton.branch, 'feature/login-timeout');
  assert.match(formatForPrompt(skeleton), /Proj=metame-fixture@feature\/login-timeout/);
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

test('buildCodexInput reuses rollout evidence without ingesting internal prompts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-codex-sa-'));
  const sessionId = '019ef863-3ea5-7b01-9473-1dab91e60da4';
  const file = path.join(tmpDir, `rollout-2026-06-24T14-48-34-${sessionId}.jsonl`);
  const lines = [
    { type: 'session_meta', timestamp: '2026-06-24T06:48:34.000Z', payload: { id: sessionId, cwd: '/tmp/demo', timestamp: '2026-06-24T06:48:34.000Z', model_provider: 'openai' } },
    { type: 'response_item', timestamp: '2026-06-24T06:48:35.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'You are a MetaMe cognitive profile distiller. Ignore this internal task.' }] } },
    { type: 'response_item', timestamp: '2026-06-24T06:48:36.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请修复后台 Codex 记忆链路。' }] } },
    { type: 'response_item', timestamp: '2026-06-24T06:48:37.000Z', payload: { type: 'custom_tool_call', name: 'exec_command', input: JSON.stringify({ cmd: 'node --test', workdir: '/tmp/demo' }) } },
    { type: 'response_item', timestamp: '2026-06-24T06:48:38.000Z', payload: { type: 'custom_tool_call_output', output: JSON.stringify({ exit_code: 0, output: '12 tests passed' }) } },
    { type: 'event_msg', timestamp: '2026-06-24T06:48:39.000Z', payload: { type: 'task_complete', last_agent_message: '修复完成，12 项测试通过。' } },
  ];
  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');

  const { skeleton, evidence } = buildCodexInput(file);
  assert.equal(skeleton.engine, 'codex');
  assert.equal(skeleton.message_count, 1);
  assert.equal(skeleton.total_tool_calls, 1);
  assert.equal(skeleton.tool_counts.exec_command, 1);
  assert.deepEqual(evidence.user_messages, ['请修复后台 Codex 记忆链路。']);
  assert.match(evidence.tool_traces[0], /node --test/);
  assert.ok(evidence.file_anchors.includes('/tmp/demo'));
  assert.ok(evidence.key_results.includes('修复完成，12 项测试通过。'));
});

test('buildCodexInput leaves subagent rollouts to their parent session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-codex-subagent-'));
  const sessionId = '019ef863-3ea5-7b01-9473-1dab91e60db5';
  const file = path.join(tmpDir, `rollout-2026-06-24T14-48-34-${sessionId}.jsonl`);
  const lines = [
    { type: 'session_meta', payload: { id: sessionId, cwd: '/tmp/demo', source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '审查父任务。' }] } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '审查完成。' } },
  ];
  fs.writeFileSync(file, lines.map(x => JSON.stringify(x)).join('\n') + '\n' + 'x'.repeat(1200), 'utf8');

  const { skeleton } = buildCodexInput(file);
  assert.equal(skeleton.source, 'subagent');
  assert.equal(skeleton.message_count, 0);
});

test('Codex state_5.sqlite rollout_path can be discovered for memory extraction', () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-codex-state-db-'));
  const sessionId = '019ef863-3ea5-7b01-9473-1dab91e60dc6';
  const rollout = path.join(tmpDir, `rollout-2026-06-24T14-48-34-${sessionId}.jsonl`);
  fs.writeFileSync(rollout, [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: tmpDir } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '沉淀 Codex session 记忆。' }] } }),
  ].join('\n') + '\n' + 'x'.repeat(1200), 'utf8');

  const dbPath = path.join(tmpDir, 'state_5.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      updated_at INTEGER,
      created_at INTEGER,
      archived INTEGER DEFAULT 0
    )
  `);
  db.prepare('INSERT INTO threads (id, rollout_path, updated_at, created_at, archived) VALUES (?, ?, ?, ?, 0)')
    .run(sessionId, rollout, 1780000000, 1780000000);
  db.close();

  const rows = _internal.queryCodexThreadRows(dbPath, sessionId);
  assert.equal(rows.length, 1);
  const item = _internal.codexSessionFromRolloutPath(rows[0].rollout_path, rows[0].id);
  assert.equal(item.session_id, sessionId);
  assert.equal(item.path, rollout);
  assert.equal(item.engine, 'codex');
});
