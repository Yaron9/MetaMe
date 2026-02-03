#!/usr/bin/env node

/**
 * MetaMe Plugin — Distillation Engine
 *
 * Reads raw signal buffer, calls Claude (haiku, non-interactive)
 * to extract persistent preferences/identity, merges into profile.
 *
 * Bundled in the plugin for standalone use. Resolves schema and
 * pending-traits from the same directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = os.homedir();
const BUFFER_FILE = path.join(HOME, '.metame', 'raw_signals.jsonl');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');
const LOCK_FILE = path.join(HOME, '.metame', 'distill.lock');

const { hasKey, isLocked, getTier, getAllowedKeysForPrompt, estimateTokens, TOKEN_BUDGET } = require('./schema');
const { loadPending, savePending, upsertPending, getPromotable, removePromoted } = require('./pending-traits');

function distill() {
  if (!fs.existsSync(BUFFER_FILE)) {
    return { updated: false, behavior: null, summary: 'No signals to process.' };
  }

  const raw = fs.readFileSync(BUFFER_FILE, 'utf8').trim();
  if (!raw) {
    return { updated: false, behavior: null, summary: 'Empty buffer.' };
  }

  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { updated: false, behavior: null, summary: 'No signals to process.' };
  }

  // Prevent concurrent distillation
  if (fs.existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge < 120000) {
      return { updated: false, behavior: null, summary: 'Distillation already in progress.' };
    }
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());

  try {
    const signals = [];
    let highConfidenceCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.prompt) {
          signals.push(entry.prompt);
          if (entry.confidence === 'high') highConfidenceCount++;
        }
      } catch { /* skip malformed */ }
    }

    if (signals.length === 0) {
      cleanup();
      return { updated: false, behavior: null, summary: 'No valid signals.' };
    }

    let currentProfile = '';
    try {
      currentProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    } catch {
      currentProfile = '(empty profile)';
    }

    const userMessages = signals.map((s, i) => `${i + 1}. "${s}"`).join('\n');
    const allowedKeys = getAllowedKeysForPrompt();

    const distillPrompt = `You are a MetaMe cognitive profile distiller. Your job is to extract COGNITIVE TRAITS and PREFERENCES — how the user thinks, decides, and communicates. You are NOT a memory system. Do NOT store facts ("user lives in X"). Only store cognitive patterns and preferences.

CURRENT PROFILE:
\`\`\`yaml
${currentProfile}
\`\`\`

ALLOWED FIELDS (you may ONLY output keys from this list):
${allowedKeys}

RECENT USER MESSAGES:
${userMessages}

INSTRUCTIONS:
1. Extract ONLY cognitive traits, preferences, and behavioral patterns — NOT facts or events.
2. IGNORE task-specific messages (e.g., "fix this bug", "add a button").
3. Only extract things that should persist across ALL future sessions.
4. You may ONLY output fields from ALLOWED FIELDS. Any other key will be rejected.
5. Fields marked [LOCKED] must NEVER be changed (T1 and T2 tiers).
6. For enum fields, you MUST use one of the listed values.

EPISODIC MEMORY — TWO EXCEPTIONS to the "no facts" rule:
7. context.anti_patterns (max 5): If the user encountered a REPEATED technical failure or expressed strong frustration about a specific technical approach, record it as an anti-pattern.
8. context.milestones (max 3): If the user completed a significant milestone or made a key decision, record it.

COGNITIVE BIAS PREVENTION:
- A single observation is a STATE, not a TRAIT. Do NOT infer T3 cognition fields from one message.
- Never infer cognitive style from identity/demographics.
- If a new signal contradicts an existing profile value, do NOT output the field.
- Signal weight hierarchy:
  L1 Surface (word choice, tone) → low weight, needs 5+ observations
  L2 Behavior (question patterns, decision patterns) → medium weight, needs 3 observations
  L3 Self-declaration ("I prefer...", "以后一律...") → high weight, can write directly

CONFIDENCE TAGGING:
- If a message contains strong directives, mark as HIGH.
- Add a _confidence block mapping field keys to "high" or "normal".
- Add a _source block mapping field keys to the quote that triggered the extraction.

OUTPUT FORMAT — respond with ONLY a YAML code block:
\`\`\`yaml
preferences:
  code_style: concise
_confidence:
  preferences.code_style: high
_source:
  preferences.code_style: "以后代码一律简洁风格"
\`\`\`

BEHAVIORAL PATTERN DETECTION:
Output a _behavior block:
  decision_pattern: premature_closure | exploratory | iterative | null
  cognitive_load: low | medium | high | null
  zone: comfort | stretch | panic | null
  avoidance_topics: []
  emotional_response: analytical | blame_external | blame_self | withdrawal | null
  topics: []

IMPORTANT: _behavior is ALWAYS output, even if no profile updates.

If nothing worth saving AND no behavior detected: respond with exactly NO_UPDATE
Do NOT repeat existing unchanged values. Only output NEW or CHANGED fields.`;

    let result;
    try {
      result = execSync(
        `claude -p --model haiku`,
        {
          input: distillPrompt,
          encoding: 'utf8',
          timeout: 60000,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      ).trim();
    } catch (err) {
      try { fs.unlinkSync(LOCK_FILE); } catch {}
      const isTimeout = err.killed || (err.signal === 'SIGTERM');
      if (isTimeout) {
        return { updated: false, behavior: null, summary: 'Skipped — API too slow. Will retry next launch.' };
      }
      return { updated: false, behavior: null, summary: 'Skipped — Claude not available. Will retry next launch.' };
    }

    if (!result || result === 'NO_UPDATE') {
      cleanup();
      return { updated: false, behavior: null, summary: `Analyzed ${signals.length} messages — no persistent insights found.` };
    }

    const yamlMatch = result.match(/```yaml\n([\s\S]*?)```/) || result.match(/```\n([\s\S]*?)```/);
    if (!yamlMatch) {
      cleanup();
      return { updated: false, behavior: null, summary: `Analyzed ${signals.length} messages — no persistent insights found.` };
    }
    const yamlContent = yamlMatch[1].trim();

    if (!yamlContent) {
      cleanup();
      return { updated: false, behavior: null, summary: 'Distiller returned empty result.' };
    }

    try {
      const yaml = require('js-yaml');
      const updates = yaml.load(yamlContent);
      if (!updates || typeof updates !== 'object') {
        cleanup();
        return { updated: false, behavior: null, summary: 'Distiller returned invalid data.' };
      }

      const behavior = updates._behavior || null;
      delete updates._behavior;

      const filtered = filterBySchema(updates);
      if (Object.keys(filtered).length === 0 && !behavior) {
        cleanup();
        return { updated: false, behavior: null, summary: `Analyzed ${signals.length} messages — all extracted fields rejected by schema.` };
      }

      if (Object.keys(filtered).length === 0 && behavior) {
        cleanup();
        return { updated: false, behavior, signalCount: signals.length, summary: `Analyzed ${signals.length} messages — behavior logged, no profile changes.` };
      }

      const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      expireAntiPatterns(profile);

      const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
      const lockedKeys = extractLockedKeys(rawProfile);
      const inlineComments = extractInlineComments(rawProfile);

      const pendingTraits = loadPending();
      const confidenceMap = updates._confidence || {};
      const sourceMap = updates._source || {};
      const merged = strategicMerge(profile, filtered, lockedKeys, pendingTraits, confidenceMap, sourceMap);
      savePending(pendingTraits);

      if (!merged.evolution) merged.evolution = {};
      if (!merged.evolution.auto_distill) merged.evolution.auto_distill = [];
      merged.evolution.auto_distill.push({
        ts: new Date().toISOString(),
        signals: signals.length,
        fields: Object.keys(filtered).join(', ')
      });
      if (merged.evolution.auto_distill.length > 10) {
        merged.evolution.auto_distill = merged.evolution.auto_distill.slice(-10);
      }

      let dumped = yaml.dump(merged, { lineWidth: -1 });
      let restored = restoreComments(dumped, inlineComments);

      let tokens = estimateTokens(restored);
      if (tokens > TOKEN_BUDGET) {
        if (merged.evolution.recent_changes) {
          merged.evolution.recent_changes = [];
        }
        dumped = yaml.dump(merged, { lineWidth: -1 });
        restored = restoreComments(dumped, inlineComments);
        tokens = estimateTokens(restored);
      }
      if (tokens > TOKEN_BUDGET) {
        truncateArrays(merged);
        dumped = yaml.dump(merged, { lineWidth: -1 });
        restored = restoreComments(dumped, inlineComments);
        tokens = estimateTokens(restored);
      }
      if (tokens > TOKEN_BUDGET) {
        cleanup();
        return { updated: false, behavior, signalCount: signals.length, summary: `Profile too large (${tokens} tokens > ${TOKEN_BUDGET}). Write rejected.` };
      }

      fs.writeFileSync(BRAIN_FILE, restored, 'utf8');
      cleanup();
      return {
        updated: true,
        behavior,
        signalCount: signals.length,
        summary: `${Object.keys(filtered).length} new trait${Object.keys(filtered).length > 1 ? 's' : ''} absorbed. (${tokens} tokens)`
      };

    } catch (err) {
      cleanup();
      return { updated: false, behavior: null, summary: `Profile merge failed: ${err.message}` };
    }

  } catch (err) {
    cleanup();
    return { updated: false, behavior: null, summary: `Distillation error: ${err.message}` };
  }
}

function extractLockedKeys(rawYaml) {
  const locked = new Set();
  for (const line of rawYaml.split('\n')) {
    if (line.includes('# [LOCKED]')) {
      const match = line.match(/^\s*([\w_]+)\s*:/);
      if (match) locked.add(match[1]);
    }
  }
  return locked;
}

function extractInlineComments(rawYaml) {
  const comments = new Map();
  for (const line of rawYaml.split('\n')) {
    const commentMatch = line.match(/^(\s*[\w_]+\s*:.+?)\s+(#.+)$/);
    if (commentMatch) {
      comments.set(commentMatch[1].trim(), commentMatch[2]);
    }
    const keyCommentMatch = line.match(/^(\s*[\w_]+\s*:)\s+(#.+)$/);
    if (keyCommentMatch) {
      comments.set(keyCommentMatch[1].trim(), keyCommentMatch[2]);
    }
  }
  return comments;
}

function restoreComments(dumpedYaml, comments) {
  const lines = dumpedYaml.split('\n');
  return lines.map(line => {
    const trimmed = line.trim();
    for (const [content, comment] of comments) {
      if (trimmed === content || trimmed.startsWith(content)) {
        if (!line.includes('#')) return `${line} ${comment}`;
      }
    }
    return line;
  }).join('\n');
}

function strategicMerge(profile, updates, lockedKeys, pendingTraits, confidenceMap, sourceMap) {
  const result = JSON.parse(JSON.stringify(profile));
  const flat = flattenObject(updates);

  for (const [key, value] of Object.entries(flat)) {
    if (key.startsWith('_')) continue;
    if (lockedKeys.has(key.split('.')[0])) continue;
    if (isLocked(key)) continue;
    if (value === null || value === '') continue;

    const tier = getTier(key);
    if (!tier) continue;

    switch (tier) {
      case 'T1':
      case 'T2':
        continue;

      case 'T3': {
        const confidence = confidenceMap[key] || 'normal';
        const source = sourceMap[key] || null;
        if (confidence === 'high') {
          setNested(result, key, value);
        } else {
          upsertPending(pendingTraits, key, value, confidence, source);
        }
        break;
      }

      case 'T4':
        if (key === 'context.anti_patterns' && Array.isArray(value)) {
          const today = new Date().toISOString().slice(0, 10);
          const existing = getNested(result, key) || [];
          const existingTexts = new Set(existing.map(e => typeof e === 'string' ? e : e.text));
          const stamped = value
            .filter(v => !existingTexts.has(typeof v === 'string' ? v : v.text))
            .map(v => typeof v === 'string' ? { text: v, added: today } : v);
          setNested(result, key, [...existing, ...stamped].slice(-5));
        } else {
          setNested(result, key, value);
        }
        if (key === 'context.focus') {
          setNested(result, 'context.focus_since', new Date().toISOString().slice(0, 10));
        }
        break;

      case 'T5':
        setNested(result, key, value);
        break;
    }
  }

  const promotable = getPromotable(pendingTraits);
  for (const { key, value } of promotable) {
    setNested(result, key, value);
  }
  removePromoted(pendingTraits, promotable.map(p => p.key));

  return result;
}

function flattenObject(obj, parentKey = '', result = {}) {
  for (const key of Object.keys(obj)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const value = obj[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      flattenObject(value, fullKey, result);
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function getNested(obj, dotPath) {
  const keys = dotPath.split('.');
  let current = obj;
  for (const k of keys) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[k];
  }
  return current;
}

function setNested(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]] || typeof current[keys[i]] !== 'object') {
      current[keys[i]] = {};
    }
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function filterBySchema(obj, parentKey = '') {
  const result = {};
  for (const key of Object.keys(obj)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const value = obj[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = filterBySchema(value, fullKey);
      if (Object.keys(nested).length > 0) result[key] = nested;
    } else {
      if (hasKey(fullKey) && !isLocked(fullKey)) result[key] = value;
    }
  }
  return result;
}

function truncateArrays(obj) {
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length > 1) {
      obj[key] = obj[key].slice(-Math.ceil(obj[key].length / 2));
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      truncateArrays(obj[key]);
    }
  }
}

function expireAntiPatterns(profile) {
  if (!profile.context || !Array.isArray(profile.context.anti_patterns)) return;
  const now = Date.now();
  const SIXTY_DAYS = 60 * 24 * 60 * 60 * 1000;
  profile.context.anti_patterns = profile.context.anti_patterns.filter(entry => {
    if (typeof entry === 'string') return true;
    if (entry.added) return (now - new Date(entry.added).getTime()) < SIXTY_DAYS;
    return true;
  });
}

function cleanup() {
  try { fs.unlinkSync(BUFFER_FILE); } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// Session log (same as main distill.js)
const SESSION_LOG_FILE = path.join(HOME, '.metame', 'session_log.yaml');
const MAX_SESSION_LOG = 30;

function writeSessionLog(behavior, signalCount) {
  if (!behavior) return;
  const yaml = require('js-yaml');
  let log = { sessions: [] };
  try {
    if (fs.existsSync(SESSION_LOG_FILE)) {
      log = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8')) || { sessions: [] };
    }
  } catch { log = { sessions: [] }; }

  if (!Array.isArray(log.sessions)) log.sessions = [];

  log.sessions.push({
    ts: new Date().toISOString().slice(0, 10),
    topics: behavior.topics || [],
    zone: behavior.zone || null,
    decision_pattern: behavior.decision_pattern || null,
    cognitive_load: behavior.cognitive_load || null,
    emotional_response: behavior.emotional_response || null,
    avoidance: behavior.avoidance_topics || [],
    signal_count: signalCount,
  });

  if (log.sessions.length > MAX_SESSION_LOG) {
    log.sessions = log.sessions.slice(-MAX_SESSION_LOG);
  }

  fs.writeFileSync(SESSION_LOG_FILE, yaml.dump(log, { lineWidth: -1 }), 'utf8');
}

function detectPatterns() {
  const yaml = require('js-yaml');
  if (!fs.existsSync(SESSION_LOG_FILE)) return;
  const log = yaml.load(fs.readFileSync(SESSION_LOG_FILE, 'utf8'));
  if (!log || !Array.isArray(log.sessions) || log.sessions.length < 5) return;

  if (!fs.existsSync(BRAIN_FILE)) return;
  const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8'));
  if (!profile) return;

  const distillCount = (profile.evolution && profile.evolution.distill_count) || 0;
  if (distillCount % 5 !== 0 || distillCount === 0) return;

  const recent = log.sessions.slice(-20);
  const sessionSummary = recent.map((s, i) =>
    `${i + 1}. [${s.ts}] topics=${(s.topics || []).join(',')} zone=${s.zone || '?'} decision=${s.decision_pattern || '?'} load=${s.cognitive_load || '?'} avoidance=[${(s.avoidance || []).join(',')}]`
  ).join('\n');

  const patternPrompt = `You are a metacognition pattern detector. Analyze these ${recent.length} session summaries and find repeated behavioral patterns.

SESSION HISTORY:
${sessionSummary}

Find at most 2 patterns from these categories:
1. Avoidance: topics mentioned repeatedly but never acted on
2. Energy: what task types correlate with high/low cognitive load
3. Zone: consecutive comfort zone? frequent panic?
4. Growth: areas where user went from asking questions to giving commands

RULES:
- Only report patterns with confidence > 0.7
- Each pattern must appear in at least 3 sessions
- Be specific and concise

OUTPUT FORMAT — respond with ONLY a YAML code block:
\`\`\`yaml
patterns:
  - type: avoidance|energy|zone|growth
    summary: "one sentence description"
    confidence: 0.7-1.0
\`\`\`

If no clear patterns found: respond with exactly NO_PATTERNS`;

  try {
    const result = execSync(
      `claude -p --model haiku`,
      { input: patternPrompt, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!result || result.includes('NO_PATTERNS')) return;

    const yamlMatch = result.match(/```yaml\n([\s\S]*?)```/) || result.match(/```\n([\s\S]*?)```/);
    if (!yamlMatch) return;

    const parsed = yaml.load(yamlMatch[1].trim());
    if (!parsed || !Array.isArray(parsed.patterns)) return;

    const validated = parsed.patterns
      .filter(p => p.type && p.summary && p.confidence >= 0.7)
      .slice(0, 3)
      .map(p => ({
        type: p.type,
        summary: p.summary,
        detected: new Date().toISOString().slice(0, 10),
        surfaced: null,
        confidence: p.confidence,
      }));

    if (validated.length === 0) return;

    const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    const freshProfile = yaml.load(rawProfile) || {};
    if (!freshProfile.growth) freshProfile.growth = {};
    freshProfile.growth.patterns = validated;

    const zoneHistory = recent.slice(-10).map(s => {
      if (s.zone === 'comfort') return 'C';
      if (s.zone === 'stretch') return 'S';
      if (s.zone === 'panic') return 'P';
      return '?';
    });
    freshProfile.growth.zone_history = zoneHistory;

    fs.writeFileSync(BRAIN_FILE, yaml.dump(freshProfile, { lineWidth: -1 }), 'utf8');
  } catch {
    // Non-fatal
  }
}

module.exports = { distill, writeSessionLog, detectPatterns };

if (require.main === module) {
  const result = distill();
  if (result.behavior) {
    writeSessionLog(result.behavior, result.signalCount || 0);
  }
  detectPatterns();
  if (result.updated) {
    console.log(`${result.summary}`);
  } else {
    console.log(`${result.summary}`);
  }
}
