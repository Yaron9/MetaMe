'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mentor = require('./mentor-engine');

const runtimeFiles = [];

function withRuntimeFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-mentor-'));
  const file = path.join(dir, 'mentor_runtime.json');
  runtimeFiles.push(file);
  process.env.METAME_MENTOR_RUNTIME = file;
  return file;
}

afterEach(() => {
  delete process.env.METAME_MENTOR_RUNTIME;
  for (const file of runtimeFiles.splice(0)) {
    try { fs.rmSync(path.dirname(file), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('checkEmotionBreaker triggers cooldown and blocks during cooldown', () => {
  withRuntimeFile();
  const now = Date.parse('2026-03-05T08:00:00.000Z');
  const first = mentor.checkEmotionBreaker('我快崩了，wtf', {}, now);
  assert.equal(first.tripped, true);
  assert.ok(first.remaining_ms > 0);

  const second = mentor.checkEmotionBreaker('正常消息', {}, now + 1000);
  assert.equal(second.tripped, true);
  assert.equal(second.reason, 'cooldown_active');
});

test('computeZone classifies comfort and panic', () => {
  const comfort = mentor.computeZone({
    tool_error_count: 0,
    retry_sequences: 1,
    semantic_repetition: 0.1,
    total_tool_calls: 6,
    duration_min: 25,
  });
  assert.equal(comfort.zone, 'comfort');

  const panic = mentor.computeZone({
    tool_error_count: 4,
    retry_sequences: 8,
    semantic_repetition: 0.8,
    duration_min: 80,
    avg_pause_sec: 220,
  });
  assert.equal(panic.zone, 'panic');
});

test('debt lifecycle: register -> collect -> gc', () => {
  const runtime = withRuntimeFile();
  const now = Date.parse('2026-03-05T10:00:00.000Z');
  const debt = mentor.registerDebt('proj_abc', 'RAG memory hint 设计', 56, now);
  assert.equal(debt.project_id, 'proj_abc');

  const miss = mentor.collectDebt('proj_xxx', 'RAG memory hint', now + 1000);
  assert.equal(miss, null);

  const hit = mentor.collectDebt('proj_abc', '这次继续做 rag memory hint 优化', now + 2000);
  assert.ok(hit);
  assert.match(hit.prompt, /核心逻辑/);

  const raw = JSON.parse(fs.readFileSync(runtime, 'utf8'));
  raw.debts.push({
    project_id: 'proj_abc',
    topic: 'expired',
    topic_keywords: ['expired'],
    recorded_at: now - 100000,
    expires_at: now - 1,
  });
  fs.writeFileSync(runtime, JSON.stringify(raw), 'utf8');
  const gc = mentor.gcExpiredDebts(now);
  assert.equal(gc.removed, 1);
});

test('buildMentorPrompt respects quiet_until and expert skip', () => {
  withRuntimeFile();
  const now = Date.parse('2026-03-05T12:00:00.000Z');

  const quietPrompt = mentor.buildMentorPrompt(
    { topic: 'nodejs retry' },
    { growth: { quiet_until: new Date(now + 3600000).toISOString() } },
    { enabled: true, mode: 'active' },
    now
  );
  assert.equal(quietPrompt, '');

  const expertPrompt = mentor.buildMentorPrompt(
    { topic: 'nodejs retry' },
    { user_competence_map: { nodejs: 'expert' }, growth: {} },
    { enabled: true, mode: 'active' },
    now
  );
  assert.equal(expertPrompt, '');

  const activePrompt = mentor.buildMentorPrompt(
    {
      topic: 'python parser',
      zone: 'stretch',
      recentMessages: [
        { text: '继续', tool_calls: 2 },
        { text: '继续', tool_calls: 2 },
        { text: '继续', tool_calls: 2 },
      ],
      sessionStartTime: new Date(now - 30 * 60 * 1000).toISOString(),
    },
    { growth: {} },
    { enabled: true, mode: 'active' },
    now
  );
  assert.match(activePrompt, /mode=active/);
  assert.match(activePrompt, /关键收获/);
});

test('detectPatterns triggers fatigue with cooldown', () => {
  withRuntimeFile();
  const start = Date.parse('2026-03-05T08:00:00.000Z');
  const firstNow = Date.parse('2026-03-05T10:00:01.000Z');
  const a = mentor.detectPatterns([{ text: '继续处理一下' }], new Date(start).toISOString(), { nowMs: firstNow });
  assert.equal(a.fatigued, true);

  const b = mentor.detectPatterns([{ text: '继续处理一下' }], new Date(start).toISOString(), { nowMs: firstNow + 1000 });
  assert.equal(b.fatigued, false);
});

