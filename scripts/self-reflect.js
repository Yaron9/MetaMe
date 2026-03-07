#!/usr/bin/env node

/**
 * self-reflect.js — Daily Self-Reflection Task
 *
 * Scans correction/metacognitive signals from the past 7 days,
 * aggregates "where did the AI get it wrong", and writes a brief
 * self-critique pattern into growth.patterns in ~/.claude_profile.yaml.
 *
 * Also distills correction signals into lessons/ SOP markdown files.
 *
 * Heartbeat: nightly at 23:00, require_idle, non-blocking.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { callHaiku, buildDistillEnv } = require('./providers');
const { writeBrainFileSafe } = require('./utils');

const HOME = os.homedir();
const SIGNAL_FILE = path.join(HOME, '.metame', 'raw_signals.jsonl');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');
const LOCK_FILE = path.join(HOME, '.metame', 'self-reflect.lock');
const LESSONS_DIR = path.join(HOME, '.metame', 'memory', 'lessons');
const WINDOW_DAYS = 7;

/**
 * Distill correction signals into reusable SOP markdown files.
 * Each run produces at most one lesson file per unique slug.
 * Returns the number of lesson files actually written.
 *
 * @param {Array} signals - all recent signals (will filter to 'correction' type internally)
 * @param {string} lessonsDir - absolute path where lesson .md files are written
 */
async function generateLessons(signals, lessonsDir) {
  // Only process correction signals that carry explicit feedback
  const corrections = signals.filter(s => s.type === 'correction' && s.feedback);
  if (corrections.length < 2) {
    console.log(`[self-reflect] Only ${corrections.length} correction signal(s) with feedback, skipping lessons.`);
    return 0;
  }

  fs.mkdirSync(lessonsDir, { recursive: true });

  const correctionText = corrections
    .slice(-15) // cap to avoid prompt bloat
    .map(c => `- Prompt: ${(c.prompt || '').slice(0, 100)}\n  Feedback: ${(c.feedback || '').slice(0, 150)}`)
    .join('\n');

  const prompt = `You are distilling correction signals into a reusable SOP for an AI assistant.

Corrections (JSON):
${correctionText}

Generate ONE actionable lesson in this JSON format:
{
  "title": "简短标题（中文，10字以内）",
  "slug": "kebab-case-english-slug",
  "content": "## 问题\\n...\\n## 根因\\n...\\n## 操作手册\\n1. ...\\n2. ...\\n3. ..."
}

Rules: content must be in 中文, concrete and actionable, 100-300 chars total.
Only output the JSON object, no explanation.`;

  let distillEnv = {};
  try { distillEnv = buildDistillEnv(); } catch {}

  let result;
  try {
    result = await Promise.race([
      callHaiku(prompt, distillEnv, 60000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 90000)),
    ]);
  } catch (e) {
    console.log(`[self-reflect] generateLessons Haiku call failed: ${e.message}`);
    return 0;
  }

  let lesson;
  try {
    const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    lesson = JSON.parse(cleaned);
    if (!lesson.title || !lesson.slug || !lesson.content) throw new Error('missing fields');
  } catch (e) {
    console.log(`[self-reflect] Failed to parse lesson JSON: ${e.message}`);
    return 0;
  }

  // Sanitize slug: only lowercase alphanumeric and hyphens
  const slug = (lesson.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) {
    console.log('[self-reflect] generateLessons: empty slug, skipping');
    return 0;
  }

  // Prevent duplicates: skip if any existing file already uses this slug
  const existing = fs.readdirSync(lessonsDir).filter(f => f.endsWith(`-${slug}.md`));
  if (existing.length > 0) {
    console.log(`[self-reflect] Lesson '${slug}' already exists (${existing[0]}), skipping.`);
    return 0;
  }

  const today = new Date().toISOString().slice(0, 10);
  const filename = `${today}-${slug}.md`;
  const filepath = path.join(lessonsDir, filename);

  const fileContent = `---
date: ${today}
source: self-reflect
corrections: ${corrections.length}
---

# ${lesson.title}

${lesson.content}
`;

  fs.writeFileSync(filepath, fileContent, 'utf8');
  console.log(`[self-reflect] Lesson written: ${filepath}`);
  return 1;
}

async function run() {
  // Atomic lock
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(lockFd, process.pid.toString());
    fs.closeSync(lockFd);
  } catch (e) {
    if (e.code === 'EEXIST') {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < 300000) { console.log('[self-reflect] Already running.'); return; }
      fs.unlinkSync(LOCK_FILE);
      try {
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(lockFd, process.pid.toString());
        fs.closeSync(lockFd);
      } catch {
        // Another process acquired the lock, or write failed — ensure fd is closed
        try { if (lockFd !== undefined) fs.closeSync(lockFd); } catch { /* ignore */ }
        return;
      }
    } else throw e;
  }

  try {
    // Read signals from last WINDOW_DAYS days
    if (!fs.existsSync(SIGNAL_FILE)) {
      console.log('[self-reflect] No signal file, skipping.');
      return;
    }

    const cutoff = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const lines = fs.readFileSync(SIGNAL_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const recentSignals = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(s => s && s.ts && new Date(s.ts).getTime() > cutoff);

    // Filter to correction + metacognitive signals only
    const correctionSignals = recentSignals.filter(s =>
      s.type === 'correction' || s.type === 'metacognitive'
    );

    if (correctionSignals.length < 2) {
      console.log(`[self-reflect] Only ${correctionSignals.length} correction signals this week, skipping.`);
      return;
    }

    // Read current profile for context
    let currentPatterns = '';
    try {
      const yaml = require('js-yaml');
      const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      const existing = (profile.growth && profile.growth.patterns) || [];
      if (existing.length > 0) {
        currentPatterns = `Current growth.patterns (avoid repeating):\n${existing.map(p => `- ${p}`).join('\n')}\n\n`;
      }
    } catch { /* non-fatal */ }

    const signalText = correctionSignals
      .slice(-20) // cap at 20 signals
      .map((s, i) => `${i + 1}. [${s.type}] "${s.prompt}"`)
      .join('\n');

    const prompt = `你是一个AI自我审视引擎。分析以下用户纠正/元认知信号，找出AI（即你）**系统性**犯错的模式。

${currentPatterns}用户纠正信号（最近7天）：
${signalText}

任务：找出1-2条AI的系统性问题（不是偶发错误），例如：
- "经常过度简化用户的技术问题，忽略背景细节"
- "倾向于在用户还没说完就开始行动，导致方向偏差"
- "在不确定时倾向于肯定用户，而非直接说不知道"

输出格式（JSON数组，最多2条，每条≤40字中文）：
["模式1描述", "模式2描述"]

注意：
- 只输出有充分证据支持的系统性模式
- 如果证据不足，输出 []
- 只输出JSON，不要解释`;

    let distillEnv = {};
    try { distillEnv = buildDistillEnv(); } catch {}

    let result;
    try {
      result = await Promise.race([
        callHaiku(prompt, distillEnv, 60000),
        // outer safety net in case callHaiku's internal timeout doesn't propagate
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 90000)),
      ]);
    } catch (e) {
      console.log(`[self-reflect] Haiku call failed: ${e.message}`);
      return;
    }

    // Parse result
    let patterns = [];
    try {
      const cleaned = result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        patterns = parsed.filter(p => typeof p === 'string' && p.length > 5 && p.length <= 80);
      }
    } catch {
      console.log('[self-reflect] Failed to parse Haiku output.');
      return;
    }

    // === Generate lessons/ from correction signals (independent of patterns result) ===
    try {
      const lessonsCount = await generateLessons(recentSignals, LESSONS_DIR);
      if (lessonsCount > 0) {
        console.log(`[self-reflect] Generated ${lessonsCount} lesson(s) in ${LESSONS_DIR}`);
      }
    } catch (e) {
      console.log(`[self-reflect] generateLessons failed (non-fatal): ${e.message}`);
    }

    if (patterns.length === 0) {
      console.log('[self-reflect] No patterns found this week.');
      return;
    }

    // Merge into growth.patterns (cap at 3, keep newest)
    try {
      const yaml = require('js-yaml');
      const raw = fs.readFileSync(BRAIN_FILE, 'utf8');
      const profile = yaml.load(raw) || {};
      if (!profile.growth) profile.growth = {};
      const existing = Array.isArray(profile.growth.patterns) ? profile.growth.patterns : [];
      // Add new patterns, deduplicate, cap at 3 newest
      const merged = [...existing, ...patterns]
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .slice(-3);
      profile.growth.patterns = merged;
      profile.growth.last_reflection = new Date().toISOString().slice(0, 10);

      // Preserve locked lines (simple approach: only update growth section)
      const dumped = yaml.dump(profile, { lineWidth: -1 });
      await writeBrainFileSafe(dumped);
      console.log(`[self-reflect] ${patterns.length} pattern(s) written to growth.patterns: ${patterns.join(' | ')}`);
    } catch (e) {
      console.log(`[self-reflect] Failed to write profile: ${e.message}`);
    }

  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

if (require.main === module) {
  run().then(() => {
    console.log('✅ self-reflect complete');
  }).catch(e => {
    console.error(`[self-reflect] Fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { run };
