'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const FATIGUE_COOLDOWN_MS = 60 * 60 * 1000;

function runtimeFilePath() {
  const override = String(process.env.METAME_MENTOR_RUNTIME || '').trim();
  if (override) return override;
  return path.join(os.homedir(), '.metame', 'mentor_runtime.json');
}

function defaultRuntime() {
  return {
    emotion_breaker_until: null,
    debts: [],
    last_fatigue_alert: null,
    last_pattern_check: null,
  };
}

function safeNow(nowMs) {
  return Number.isFinite(nowMs) ? nowMs : Date.now();
}

function ensureParentDir(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadRuntime() {
  const file = runtimeFilePath();
  try {
    if (!fs.existsSync(file)) return defaultRuntime();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ...defaultRuntime(),
      ...(data && typeof data === 'object' ? data : {}),
      debts: Array.isArray(data && data.debts) ? data.debts : [],
    };
  } catch {
    return defaultRuntime();
  }
}

function saveRuntime(runtime) {
  const file = runtimeFilePath();
  ensureParentDir(file);
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(runtime, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function clearRuntime() {
  saveRuntime(defaultRuntime());
  return defaultRuntime();
}

function normalizeText(input) {
  return String(input || '').trim();
}

function tokenize(text) {
  const input = normalizeText(text).toLowerCase();
  if (!input) return [];
  const out = [];
  const seen = new Set();
  const push = (t) => {
    const v = String(t || '').trim();
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  const ascii = input.match(/[a-z0-9_./-]{2,}/g) || [];
  for (const t of ascii) push(t);

  const hanRuns = input.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of hanRuns) {
    if (run.length === 2) push(run);
    else {
      for (let i = 0; i < run.length - 1; i++) push(run.slice(i, i + 2));
    }
  }
  return out;
}

function overlapRatio(a, b) {
  const sa = new Set(Array.isArray(a) ? a : []);
  const sb = new Set(Array.isArray(b) ? b : []);
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const x of sa) if (sb.has(x)) common++;
  const base = Math.min(sa.size, sb.size);
  return base > 0 ? common / base : 0;
}

function endOfTodayMs(nowMs) {
  const d = new Date(safeNow(nowMs));
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function resolveMode(config = {}) {
  const mode = String(config.mode || '').toLowerCase().trim();
  if (mode === 'gentle' || mode === 'active' || mode === 'intense') return mode;
  const level = Number(config.friction_level);
  if (Number.isFinite(level)) {
    if (level >= 8) return 'intense';
    if (level >= 4) return 'active';
  }
  return 'gentle';
}

function checkEmotionBreaker(userMessage, config = {}, nowMs = Date.now()) {
  const text = normalizeText(userMessage);
  const runtime = loadRuntime();
  const now = safeNow(nowMs);
  const until = Number(runtime.emotion_breaker_until || 0);

  if (until > now) {
    return {
      tripped: true,
      reason: 'cooldown_active',
      response: '已暂停导师模式，先专注把问题解决。',
      remaining_ms: until - now,
    };
  }

  const baseRe = /[操草靠妈tmd]|fuck|shit|wtf|!!{2,}|？？{2,}|急|崩|炸|烦死/i;
  const extras = Array.isArray(config.emotion_keywords_extra) ? config.emotion_keywords_extra : [];
  const hitExtra = extras.find(k => k && text.toLowerCase().includes(String(k).toLowerCase()));
  const hit = baseRe.test(text) || !!hitExtra;
  if (!hit) return { tripped: false };

  runtime.emotion_breaker_until = now + DEFAULT_COOLDOWN_MS;
  saveRuntime(runtime);
  return {
    tripped: true,
    reason: hitExtra ? `keyword:${hitExtra}` : 'emotion_keyword',
    response: '已暂停导师模式，先专注把问题解决。',
    remaining_ms: DEFAULT_COOLDOWN_MS,
  };
}

function computeZone(skeleton = {}) {
  const toolErrors = Number(skeleton.tool_error_count || 0);
  const retries = Number(skeleton.retry_sequences || 0);
  const repetition = Number(skeleton.semantic_repetition || 0);
  const durationMin = Number(skeleton.duration_min || 0);
  const toolCalls = Number(skeleton.total_tool_calls || 0);
  const avgPause = Number(skeleton.avg_pause_sec || 0);
  const recovered = !!skeleton.error_recovered;

  let panicScore = 0;
  if (toolErrors >= 3) panicScore++;
  if (retries >= 6) panicScore++;
  if (repetition >= 0.6) panicScore++;
  if (durationMin >= 75 && toolErrors >= 1) panicScore++;
  if (avgPause >= 180) panicScore++;

  let comfortScore = 0;
  if (toolErrors === 0) comfortScore++;
  if (retries <= 2) comfortScore++;
  if (repetition < 0.35) comfortScore++;
  if (toolCalls >= 3 && durationMin <= 45) comfortScore++;
  if (recovered && toolErrors <= 1) comfortScore++;

  let zone = 'stretch';
  let dominant = Math.max(panicScore, comfortScore);
  if (panicScore >= 2) zone = 'panic';
  else if (comfortScore >= 3 && panicScore === 0) zone = 'comfort';

  const confidence = Math.min(0.95, 0.6 + dominant * 0.08);
  return {
    zone,
    confidence: Number(confidence.toFixed(2)),
    signals: {
      tool_error_count: toolErrors,
      retry_sequences: retries,
      semantic_repetition: repetition,
      duration_min: durationMin,
      tool_calls: toolCalls,
      avg_pause_sec: avgPause,
      error_recovered: recovered,
    },
  };
}

function registerDebt(projectId, topic, codeLineCount, nowMs = Date.now()) {
  const pid = normalizeText(projectId);
  const lines = Number(codeLineCount || 0);
  if (!pid || lines <= 30) return null;

  const t = normalizeText(topic) || 'unknown-topic';
  const now = safeNow(nowMs);
  const runtime = loadRuntime();
  const topicKeywords = tokenize(t).slice(0, 8);

  const debt = {
    project_id: pid,
    topic: t,
    topic_keywords: topicKeywords,
    code_summary: `Generated ${lines} lines`,
    recorded_at: now,
    expires_at: endOfTodayMs(now),
  };
  runtime.debts.push(debt);
  if (runtime.debts.length > 100) runtime.debts = runtime.debts.slice(-100);
  saveRuntime(runtime);
  return debt;
}

function collectDebt(projectId, currentTopic, nowMs = Date.now()) {
  const pid = normalizeText(projectId);
  if (!pid) return null;
  const runtime = loadRuntime();
  const now = safeNow(nowMs);

  const valid = [];
  let matched = null;
  const currentKeywords = tokenize(currentTopic).slice(0, 12);

  for (const debt of runtime.debts) {
    if (!debt || typeof debt !== 'object') continue;
    if (Number(debt.expires_at || 0) < now) continue;

    if (!matched && debt.project_id === pid) {
      const ratio = overlapRatio(currentKeywords, debt.topic_keywords || []);
      if (ratio > 0.3) {
        matched = {
          ...debt,
          overlap_ratio: Number(ratio.toFixed(2)),
          prompt: `刚才那段 ${debt.topic} 的代码，核心逻辑是什么？`,
        };
        continue;
      }
    }
    valid.push(debt);
  }

  runtime.debts = valid;
  saveRuntime(runtime);
  return matched;
}

function gcExpiredDebts(nowMs = Date.now()) {
  const runtime = loadRuntime();
  const now = safeNow(nowMs);
  const before = runtime.debts.length;
  runtime.debts = runtime.debts.filter(d => d && Number(d.expires_at || 0) >= now);
  const removed = before - runtime.debts.length;
  if (removed > 0) saveRuntime(runtime);
  return { removed, remaining: runtime.debts.length };
}

function repetitionFromTexts(texts) {
  if (!Array.isArray(texts) || texts.length < 3) return 0;
  let maxOverlap = 0;
  for (let i = 2; i < texts.length; i++) {
    const a = new Set(tokenize(texts[i - 2]));
    const b = new Set(tokenize(texts[i - 1]));
    const c = new Set(tokenize(texts[i]));
    const union = new Set([...a, ...b, ...c]);
    if (!union.size) continue;
    let common = 0;
    for (const t of a) if (b.has(t) && c.has(t)) common++;
    maxOverlap = Math.max(maxOverlap, common / union.size);
  }
  return Number(maxOverlap.toFixed(3));
}

function extractErrorClass(text) {
  const src = normalizeText(text).toLowerCase();
  if (!src) return '';
  if (/(timeout|timed out|超时)/.test(src)) return 'timeout';
  if (/(permission|eacces|denied|权限)/.test(src)) return 'permission';
  if (/(not found|enoent|找不到)/.test(src)) return 'not_found';
  if (/(typeerror|referenceerror|syntaxerror|报错|异常|error)/.test(src)) return 'runtime_error';
  return '';
}

function detectPatterns(recentMessages, sessionStartTime, opts = {}) {
  const now = safeNow(opts.nowMs);
  const runtime = loadRuntime();
  let dirty = false;
  const prevPatternTs = Number(runtime.last_pattern_check || 0);
  if (!prevPatternTs || (now - prevPatternTs) > 30000) {
    runtime.last_pattern_check = now;
    dirty = true;
  }

  const normalized = (Array.isArray(recentMessages) ? recentMessages : [])
    .map(m => (typeof m === 'string' ? { text: m } : (m && typeof m === 'object' ? m : null)))
    .filter(Boolean);

  const texts = normalized.map(m => normalizeText(m.text || m.message || ''));
  const shortCount = texts.filter(t => t && t.length < 20).length;
  const toolCalls = normalized.reduce((acc, m) => acc + (Number(m.tool_calls || m.toolCalls || 0) || 0), 0);
  const errorClasses = normalized.map(m => extractErrorClass(m.text || m.message || '')).filter(Boolean);
  const classCount = new Map();
  for (const c of errorClasses) classCount.set(c, (classCount.get(c) || 0) + 1);
  const repeatedError = [...classCount.values()].some(v => v >= 3);
  const semanticRepetition = repetitionFromTexts(texts);

  const autopilot = shortCount >= 3 && toolCalls >= 3 && errorClasses.length === 0;
  const stuck = repeatedError && semanticRepetition > 0.6;

  const sessionMs = Math.max(0, now - safeNow(new Date(sessionStartTime).getTime()));
  const isFatiguedRaw = sessionMs > 90 * 60 * 1000;
  const lastFatigue = Number(runtime.last_fatigue_alert || 0);
  const fatigued = isFatiguedRaw && (!lastFatigue || (now - lastFatigue) > FATIGUE_COOLDOWN_MS);
  if (fatigued) {
    runtime.last_fatigue_alert = now;
    dirty = true;
  }

  let suggestion = '';
  if (stuck) suggestion = '检测到你在反复遇到类似问题，建议先退一步梳理整体思路。';
  else if (fatigued) suggestion = '你已连续工作较久，建议短暂休息后再继续。';
  else if (autopilot) suggestion = '你在高效执行模式，建议确认一下当前方向是否仍然正确。';

  if (dirty) saveRuntime(runtime);
  return { autopilot, stuck, fatigued, suggestion, semantic_repetition: semanticRepetition };
}

function getRuntimeStatus(nowMs = Date.now()) {
  const runtime = loadRuntime();
  const now = safeNow(nowMs);
  const until = Number(runtime.emotion_breaker_until || 0);
  return {
    debt_count: Array.isArray(runtime.debts) ? runtime.debts.length : 0,
    cooldown_until: until || null,
    cooldown_remaining_ms: until > now ? (until - now) : 0,
    last_fatigue_alert: runtime.last_fatigue_alert || null,
    last_pattern_check: runtime.last_pattern_check || null,
  };
}

function shouldSkipByCompetence(profile, sessionState = {}) {
  const map = profile && typeof profile.user_competence_map === 'object'
    ? profile.user_competence_map
    : null;
  if (!map) return false;
  const text = `${sessionState.topic || ''} ${sessionState.currentTopic || ''} ${sessionState.lastUserMessage || ''}`.toLowerCase();
  if (!text) return false;
  for (const [domain, level] of Object.entries(map)) {
    if (String(level || '').toLowerCase() !== 'expert') continue;
    if (text.includes(String(domain || '').toLowerCase())) return true;
  }
  return false;
}

function buildMentorPrompt(sessionState = {}, profile = {}, config = {}, nowMs = Date.now()) {
  if (!config || config.enabled === false) return '';
  const now = safeNow(nowMs);

  const quietUntil = profile && profile.growth ? profile.growth.quiet_until : null;
  const quietMs = quietUntil ? new Date(quietUntil).getTime() : 0;
  if (quietMs && quietMs > now) return '';
  if (shouldSkipByCompetence(profile, sessionState)) return '';

  const mode = resolveMode(config);
  const zone = sessionState.zone || computeZone(sessionState.skeleton || {}).zone;
  const lines = [];
  lines.push('[Mentor mode protocol - keep concise and practical:');
  lines.push(`- mode=${mode}, zone=${zone}`);

  if (mode === 'gentle') {
    lines.push('- Give solution but include brief rationale so user can learn the "why".');
  } else if (mode === 'active') {
    lines.push('- Lead with the key concept/principle before the implementation.');
    lines.push('- Add one-line "关键收获" at the end of your reply.');
  } else {
    lines.push('- Prefer scaffold/pseudocode first; avoid dumping full solution immediately.');
    lines.push('- Apply knowledge firewall: do not fill user logic gaps with unstated assumptions.');
    lines.push('- Guide via explanation structure, not by asking the user questions.');
  }

  if (zone === 'comfort') lines.push('- Increase challenge slightly (new method or stronger abstraction).');
  if (zone === 'panic') lines.push('- Reduce friction: provide step-by-step scaffold and reassurance.');

  const pattern = detectPatterns(sessionState.recentMessages || [], sessionState.sessionStartTime || Date.now(), { nowMs: now });
  if (pattern.suggestion) lines.push(`- Pattern nudge: ${pattern.suggestion}`);

  lines.push(']');
  return lines.join('\n');
}

module.exports = {
  checkEmotionBreaker,
  buildMentorPrompt,
  computeZone,
  registerDebt,
  collectDebt,
  gcExpiredDebts,
  detectPatterns,
  getRuntimeStatus,
  clearRuntime,
  _private: {
    runtimeFilePath,
    loadRuntime,
    saveRuntime,
    tokenize,
    overlapRatio,
    repetitionFromTexts,
  },
};
