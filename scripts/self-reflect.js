#!/usr/bin/env node

/**
 * self-reflect.js — Weekly Self-Reflection Task
 *
 * Scans correction/metacognitive signals from the past 7 days,
 * aggregates "where did the AI get it wrong", and writes a brief
 * self-critique pattern into growth.patterns in ~/.claude_profile.yaml.
 *
 * Heartbeat: weekly, require_idle, non-blocking.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { callHaiku, buildDistillEnv } = require('./providers');

const HOME = os.homedir();
const SIGNAL_FILE = path.join(HOME, '.metame', 'raw_signals.jsonl');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');
const LOCK_FILE = path.join(HOME, '.metame', 'self-reflect.lock');
const WINDOW_DAYS = 7;

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
      lockFd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(lockFd, process.pid.toString());
      fs.closeSync(lockFd);
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
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 65000)),
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
      fs.writeFileSync(BRAIN_FILE, dumped, 'utf8');
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
