'use strict';

/**
 * Auto-Rules Intent Module
 *
 * Injects auto-promoted defensive rules distilled by memory-nightly-reflect.
 * Rules live in ~/.metame/auto-rules.md — one-liners promoted from recurring
 * hot-fact patterns (3+ occurrences in memory.db).
 *
 * Always fires when rules exist — no pattern detection needed.
 * Overhead: ~10–15 one-liners ≈ 200 tokens per turn.
 *
 * File is cached for CACHE_TTL_MS to avoid per-prompt disk I/O.
 * Cache refreshes automatically after nightly-reflect writes new rules.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const RULES_FILE = path.join(os.homedir(), '.metame', 'auto-rules.md');
const CACHE_TTL_MS = 60 * 1000; // 1 minute — nightly-reflect runs once/day

let _cached = null;
let _cacheTs = 0;

function loadRules() {
  const now = Date.now();
  if (_cached !== null && now - _cacheTs < CACHE_TTL_MS) return _cached;

  try {
    const content = fs.readFileSync(RULES_FILE, 'utf8');
    const rules = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('<!--'));
    _cached = rules.length > 0 ? rules : [];
  } catch {
    _cached = [];
  }

  _cacheTs = now;
  return _cached;
}

module.exports = function detectAutoRules() {
  const rules = loadRules();
  if (rules.length === 0) return null;
  return ['[自动晋升规则 — 夜间蒸馏高频模式]', ...rules.map(r => `- ${r}`)].join('\n');
};
