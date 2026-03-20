#!/usr/bin/env node

/**
 * MetaMe Signal Capture Hook
 *
 * Runs as a Claude Code UserPromptSubmit hook.
 * Receives user prompt via stdin JSON, filters for potential
 * persistent preferences/identity signals, appends to buffer.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUFFER_FILE = path.join(os.homedir(), '.metame', 'raw_signals.jsonl');
const OVERFLOW_FILE = path.join(os.homedir(), '.metame', 'raw_signals.overflow.jsonl');
const LOCK_FILE = path.join(os.homedir(), '.metame', 'raw_signals.lock');
const LOCK_RETRY_MAX = 80;
const LOCK_RETRY_MS = 8;
const LOCK_STALE_MS = 30 * 1000;
const MAX_BUFFER_LINES = 300;
const MAX_CAPTURE_CHARS = 1600;
const ABSOLUTE_MAX_CAPTURE_CHARS = 6000;

// === CONFIDENCE PATTERNS ===

// Strong directive signals → high confidence (direct write to T3)
// Allow up to 6 chars between key words (e.g. "以后代码一律" = "以后" + "代码" + "一律")
const STRONG_SIGNAL_ZH = /以后.{0,6}(都|总是|一律|每次|全部|统一)|永远.{0,4}(不要|别|不能|要)|千万.{0,4}(别|不要)|记住|一定.{0,4}(要|得)|一律|统一用/;
const STRONG_SIGNAL_EN = /(from now on|always|never|don't ever|remember to|every time)/i;

// Implicit preference signals → normal confidence (needs accumulation)
const IMPLICIT_ZH = /我(喜欢|偏好|习惯|讨厌|不喜欢|一般都|通常|总是|倾向于)/;
const IMPLICIT_EN = /I (prefer|like|hate|usually|tend to|always)/i;

// Correction signals → high confidence (user is teaching us)
const CORRECTION_ZH = /不是.*我(要|想|说)的|我说的不是|你理解错了|不对.*应该/;
const CORRECTION_EN = /(no,? I meant|that's not what I|you misunderstood|wrong.+should be)/i;

// Metacognitive signals → normal confidence (self-reflection, strategy shifts)
const META_ZH = /我(发现|意识到|觉得|反思|总结|复盘)|想错了|换个(思路|方向|方案)|回头(想想|看看)|之前的(方案|思路|方向).*(不行|不对|有问题)|我的(问题|毛病|习惯)是|下次(应该|要|得)/;
const META_EN = /(I realize|looking back|on reflection|my (mistake|problem|habit) is|let me rethink|wrong approach|next time I should)/i;

// Internal/system prompts must never enter cognition signal buffer.
const INTERNAL_PROMPT_PATTERNS = [
  /You are a MetaMe cognitive profile distiller/i,
  /You are a metacognition pattern detector/i,
  /你是精准的知识提取引擎/,
  /RECALLED LONG-TERM FACTS \(context only/i,
  /\[System hints - DO NOT mention these to user:/i,
  /\[Mac automation policy - do NOT expose this block:/i,
  /MANDATORY FIRST ACTION: The user has not been calibrated yet/i,
  /<\!--\s*FACTS:START\s*-->/i,
  /<\!--\s*MEMORY:START\s*-->/i,
  /\[Task notification\]/i,
  /<task-notification\b/i,
];

function sanitizeMetaMePrompt(text) {
  let prompt = String(text || '');
  if (!prompt) return '';

  // Remove daemon-injected RAG blocks
  prompt = prompt.replace(/<!--\s*FACTS:START\s*-->[\s\S]*?<!--\s*FACTS:END\s*-->/gi, ' ');
  prompt = prompt.replace(/<!--\s*MEMORY:START\s*-->[\s\S]*?<!--\s*MEMORY:END\s*-->/gi, ' ');

  // Remove daemon/system internal hint blocks
  prompt = prompt.replace(/\[System hints - DO NOT mention these to user:[\s\S]*?\]/gi, ' ');
  prompt = prompt.replace(/\[Mac automation policy - do NOT expose this block:[\s\S]*?\]/gi, ' ');
  prompt = prompt.replace(/\[Task notification\][\s\S]*?(?=\n{2,}|$)/gi, ' ');
  prompt = prompt.replace(/<task-notification\b[\s\S]*?<\/task-notification>/gi, ' ');
  prompt = prompt.replace(/<task-notification\b[\s\S]*$/gi, ' ');

  return prompt.trim();
}

function isInternalPrompt(text) {
  const prompt = String(text || '');
  if (!prompt) return false;
  return INTERNAL_PROMPT_PATTERNS.some((re) => re.test(prompt));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withBufferLock(fn) {
  const dir = path.dirname(BUFFER_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let acquired = false;
  for (let i = 0; i < LOCK_RETRY_MAX; i++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, process.pid.toString());
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch { /* lock released by another process */ }
      sleep(LOCK_RETRY_MS);
    }
  }

  if (!acquired) return false;
  try {
    fn();
    return true;
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* non-fatal */ }
  }
}

function writeBufferAtomically(lines) {
  const tmp = BUFFER_FILE + `.tmp.${process.pid}`;
  const content = lines.length > 0 ? (lines.join('\n') + '\n') : '';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, BUFFER_FILE);
}

// Read JSON from stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    let prompt = (data.prompt || '').trim();

    // Internal Claude subprocesses (distill/memory extract/skill evolution) set this flag.
    if (process.env.METAME_INTERNAL_PROMPT === '1') {
      process.exit(0);
    }

    // Strip daemon/system injected wrappers first; keep user payload if present.
    prompt = sanitizeMetaMePrompt(prompt);
    if (!prompt) {
      process.exit(0);
    }

    // Belt-and-suspenders: filter known internal prompt templates.
    if (isInternalPrompt(prompt)) {
      process.exit(0);
    }

    // === LAYER 0: Metacognitive bypass — always capture self-reflection ===
    const isMeta = META_ZH.test(prompt) || META_EN.test(prompt);

    // === LAYER 1: Hard filters (definitely not preferences) ===
    // Metacognitive signals bypass all hard filters — they reveal how user thinks

    // Skip empty or very short messages
    // Chinese chars carry more info per char, so use weighted length
    const weightedLen = [...prompt].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 3 : 1), 0);
    if (weightedLen < 15) {
      process.exit(0);
    }

    // Hard cap to prevent giant prompt pastes from poisoning distill budget.
    if (prompt.length > ABSOLUTE_MAX_CAPTURE_CHARS) {
      process.exit(0);
    }
    if (prompt.length > MAX_CAPTURE_CHARS) {
      prompt = prompt.slice(0, MAX_CAPTURE_CHARS);
    }

    // Skip messages that are purely code or file paths
    if (!isMeta && /^(```|\/[\w/]+\.\w+$)/.test(prompt)) {
      process.exit(0);
    }

    // Skip common non-preference commands
    if (!isMeta && /^(\/\w+|!metame|git |npm |pnpm |yarn |brew |sudo |cd |ls |cat |mkdir )/.test(prompt)) {
      process.exit(0);
    }

    // Skip pure task instructions (fix/add/delete/refactor/debug/deploy/test/run/build)
    if (!isMeta && /^(帮我|请你|麻烦)?\s*(fix|add|delete|remove|refactor|debug|deploy|test|run|build|create|update|implement|write|generate|make)/i.test(prompt)) {
      process.exit(0);
    }
    if (!isMeta && /^(帮我|请你|麻烦)?\s*(修|加|删|重构|调试|部署|测试|运行|构建|创建|更新|实现|写|生成|做)/.test(prompt)) {
      process.exit(0);
    }

    // Skip agent identity definitions (these belong in project CLAUDE.md, not user profile)
    if (!isMeta && /^(你是|你叫|你的(角色|身份|职责|任务)|你负责|你现在是|from now on you are|you are now|your role is)/i.test(prompt)) {
      process.exit(0);
    }

    // Skip pasted error logs / stack traces
    if (!isMeta && /^(Error|TypeError|SyntaxError|ReferenceError|at\s+\w+|Traceback|FATAL|WARN|ERR!)/i.test(prompt)) {
      process.exit(0);
    }
    if (!isMeta && prompt.split('\n').length > 10) {
      // Multi-line pastes are usually code or logs, not preferences
      process.exit(0);
    }

    // Skip pure questions with no preference signal
    if (!isMeta && /^(what|how|why|where|when|which|can you|could you|is there|are there|does|do you)\s/i.test(prompt) &&
        !/prefer|like|hate|always|never|style|习惯|偏好|喜欢|讨厌/.test(prompt)) {
      process.exit(0);
    }
    if (!isMeta && /^(什么|怎么|为什么|哪|能不能|可以|是不是)\s/.test(prompt) &&
        !/偏好|喜欢|讨厌|习惯|以后|一律|总是|永远|记住/.test(prompt)) {
      process.exit(0);
    }

    // === LAYER 2: Confidence tagging ===
    const isStrong = STRONG_SIGNAL_ZH.test(prompt) || STRONG_SIGNAL_EN.test(prompt);
    const isCorrection = CORRECTION_ZH.test(prompt) || CORRECTION_EN.test(prompt);

    // === LAYER 2.5: Implicit signal whitelist ===
    // If not meta/correction/directive, require at least one preference keyword.
    // This flips from blacklist ("exclude known noise") to whitelist ("require signal").
    if (!isMeta && !isStrong && !isCorrection) {
      const hasPreferenceSignal =
        IMPLICIT_ZH.test(prompt) || IMPLICIT_EN.test(prompt) ||
        /风格|方式|原则|策略|思路|态度|价值观|审美|品味/.test(prompt) ||
        /style|approach|principle|strategy|mindset|philosophy/i.test(prompt);
      if (!hasPreferenceSignal) {
        process.exit(0);
      }
    }

    const confidence = (isStrong || isCorrection) ? 'high' : 'normal';
    const signalType = isMeta ? 'metacognitive' : isCorrection ? 'correction' : isStrong ? 'directive' : 'implicit';

    // Append to buffer
    const entry = {
      ts: new Date().toISOString(),
      prompt: prompt,
      confidence: confidence,
      type: signalType,
      session: data.session_id || null,
      cwd: data.cwd || null
    };

    // Append/update with process-level lock to avoid concurrent read-modify-write loss.
    const locked = withBufferLock(() => {
      let existingLines = [];
      try {
        existingLines = fs.readFileSync(BUFFER_FILE, 'utf8').split('\n').filter(l => l.trim());
      } catch {
        // File doesn't exist yet, that's fine
      }

      // Drain overflow written during prior lock-contention periods.
      // unlink AFTER writeBufferAtomically succeeds — crash-safe ordering.
      let overflowDrained = false;
      try {
        const overflowLines = fs.readFileSync(OVERFLOW_FILE, 'utf8').split('\n').filter(Boolean);
        if (overflowLines.length > 0) {
          existingLines = existingLines.concat(overflowLines);
          overflowDrained = true;
        }
      } catch { /* no overflow file — normal case */ }

      // Opportunistic hygiene: remove old internal/system lines if any slipped in historically.
      existingLines = existingLines.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          const p = String(parsed && parsed.prompt ? parsed.prompt : '');
          if (!p) return false;
          if (p.length > ABSOLUTE_MAX_CAPTURE_CHARS) return false;
          if (isInternalPrompt(p)) return false;
          return true;
        } catch {
          return false;
        }
      });

      existingLines.push(JSON.stringify(entry));
      if (existingLines.length > MAX_BUFFER_LINES) {
        existingLines = existingLines.slice(-MAX_BUFFER_LINES);
      }
      writeBufferAtomically(existingLines);
      // Unlink overflow only after main file is safely written.
      if (overflowDrained) {
        try { fs.unlinkSync(OVERFLOW_FILE); } catch { /* already gone */ }
      }
    });

    if (!locked) {
      // Last-resort fallback: write to overflow side-file so the next lock-holder
      // can drain, clean, and cap it — never bypassing buffer rules.
      // Guard against unbounded growth: drop entry if overflow already at cap.
      fs.mkdirSync(path.dirname(OVERFLOW_FILE), { recursive: true });
      try {
        const ofLines = fs.readFileSync(OVERFLOW_FILE, 'utf8').split('\n').filter(Boolean);
        if (ofLines.length >= MAX_BUFFER_LINES) return; // shed load
      } catch { /* overflow file doesn't exist yet */ }
      fs.appendFileSync(OVERFLOW_FILE, JSON.stringify(entry) + '\n', 'utf8');
    }

  } catch {
    // Silently ignore parse errors — never block the user's workflow
  }

  process.exit(0);
});
