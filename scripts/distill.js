#!/usr/bin/env node

/**
 * MetaMe Passive Distiller
 *
 * Reads raw signal buffer, calls Claude (haiku, non-interactive)
 * to extract persistent preferences/identity, merges into profile.
 *
 * Runs automatically before each MetaMe session launch.
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

/**
 * Main distillation process.
 * Returns { updated: boolean, summary: string }
 */
function distill() {
  // 1. Check if buffer exists and has content
  if (!fs.existsSync(BUFFER_FILE)) {
    return { updated: false, summary: 'No signals to process.' };
  }

  const raw = fs.readFileSync(BUFFER_FILE, 'utf8').trim();
  if (!raw) {
    return { updated: false, summary: 'Empty buffer.' };
  }

  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length === 0) {
    return { updated: false, summary: 'No signals to process.' };
  }

  // 2. Prevent concurrent distillation
  if (fs.existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge < 120000) { // 2 min timeout
      return { updated: false, summary: 'Distillation already in progress.' };
    }
    // Stale lock, remove it
    fs.unlinkSync(LOCK_FILE);
  }
  fs.writeFileSync(LOCK_FILE, process.pid.toString());

  try {
    // 3. Parse signals (preserve confidence from signal-capture)
    const signals = [];
    let highConfidenceCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.prompt) {
          signals.push(entry.prompt);
          if (entry.confidence === 'high') highConfidenceCount++;
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (signals.length === 0) {
      cleanup();
      return { updated: false, summary: 'No valid signals.' };
    }

    // 4. Read current profile
    let currentProfile = '';
    try {
      currentProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    } catch {
      currentProfile = '(empty profile)';
    }

    // 5. Build distillation prompt
    const userMessages = signals
      .map((s, i) => `${i + 1}. "${s}"`)
      .join('\n');

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

COGNITIVE BIAS PREVENTION:
- A single observation is a STATE, not a TRAIT. Do NOT infer T3 cognition fields from one message.
- Never infer cognitive style from identity/demographics.
- If a new signal contradicts an existing profile value, do NOT output the field — contradictions need accumulation.
- Signal weight hierarchy:
  L1 Surface (word choice, tone) → low weight, needs 5+ observations
  L2 Behavior (question patterns, decision patterns) → medium weight, needs 3 observations
  L3 Self-declaration ("I prefer...", "以后一律...") → high weight, can write directly

CONFIDENCE TAGGING:
- If a message contains strong directives (以后一律/永远/always/never/记住/from now on), mark as HIGH.
- Add a _confidence block mapping field keys to "high" or "normal".
- Add a _source block mapping field keys to the quote that triggered the extraction.

OUTPUT FORMAT — respond with ONLY a YAML code block:
\`\`\`yaml
preferences:
  code_style: concise
context:
  focus: "API redesign"
_confidence:
  preferences.code_style: high
  context.focus: normal
_source:
  preferences.code_style: "以后代码一律简洁风格"
  context.focus: "我现在在做API重构"
\`\`\`

If nothing worth saving: respond with exactly NO_UPDATE
Do NOT repeat existing unchanged values. Only output NEW or CHANGED fields.`;

    // 6. Call Claude in print mode with haiku
    let result;
    try {
      result = execSync(
        `claude -p --model haiku`,
        {
          input: distillPrompt,
          encoding: 'utf8',
          timeout: 60000, // 60s — runs in background, no rush
          stdio: ['pipe', 'pipe', 'pipe']
        }
      ).trim();
    } catch (err) {
      // Don't cleanup buffer on API failure — retry next launch
      try { fs.unlinkSync(LOCK_FILE); } catch {}
      const isTimeout = err.killed || (err.signal === 'SIGTERM');
      if (isTimeout) {
        return { updated: false, summary: 'Skipped — API too slow. Will retry next launch.' };
      }
      return { updated: false, summary: 'Skipped — Claude not available. Will retry next launch.' };
    }

    // 7. Parse result
    if (!result || result.includes('NO_UPDATE')) {
      cleanup();
      return { updated: false, summary: `Analyzed ${signals.length} messages — no persistent insights found.` };
    }

    // Extract YAML block from response — require explicit code block, no fallback
    const yamlMatch = result.match(/```yaml\n([\s\S]*?)```/) || result.match(/```\n([\s\S]*?)```/);
    if (!yamlMatch) {
      cleanup();
      return { updated: false, summary: `Analyzed ${signals.length} messages — no persistent insights found.` };
    }
    const yamlContent = yamlMatch[1].trim();

    if (!yamlContent) {
      cleanup();
      return { updated: false, summary: 'Distiller returned empty result.' };
    }

    // 8. Validate against schema + merge into profile
    try {
      const yaml = require('js-yaml');
      const updates = yaml.load(yamlContent);
      if (!updates || typeof updates !== 'object') {
        cleanup();
        return { updated: false, summary: 'Distiller returned invalid data.' };
      }

      // Schema whitelist filter: drop any keys not in schema or locked
      const filtered = filterBySchema(updates);
      if (Object.keys(filtered).length === 0) {
        cleanup();
        return { updated: false, summary: `Analyzed ${signals.length} messages — all extracted fields rejected by schema.` };
      }

      const profile = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

      // Read raw content to find locked lines and comments
      const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
      const lockedKeys = extractLockedKeys(rawProfile);
      const inlineComments = extractInlineComments(rawProfile);

      // Strategic merge: tier-aware upsert with pending traits
      const pendingTraits = loadPending();
      const confidenceMap = updates._confidence || {};
      const sourceMap = updates._source || {};
      const merged = strategicMerge(profile, filtered, lockedKeys, pendingTraits, confidenceMap, sourceMap);
      savePending(pendingTraits);

      // Add distillation log entry (keep last 10, compact format)
      if (!merged.evolution) merged.evolution = {};
      if (!merged.evolution.auto_distill) merged.evolution.auto_distill = [];
      merged.evolution.auto_distill.push({
        ts: new Date().toISOString(),
        signals: signals.length,
        fields: Object.keys(filtered).join(', ')
      });
      // Cap at 10 entries
      if (merged.evolution.auto_distill.length > 10) {
        merged.evolution.auto_distill = merged.evolution.auto_distill.slice(-10);
      }

      // Dump and restore comments (yaml.dump strips all comments)
      let dumped = yaml.dump(merged, { lineWidth: -1 });
      let restored = restoreComments(dumped, inlineComments);

      // A3: Token budget check — degrade gracefully if over budget
      let tokens = estimateTokens(restored);
      if (tokens > TOKEN_BUDGET) {
        // Step 1: Clear evolution.recent_changes
        if (merged.evolution.recent_changes) {
          merged.evolution.recent_changes = [];
        }
        dumped = yaml.dump(merged, { lineWidth: -1 });
        restored = restoreComments(dumped, inlineComments);
        tokens = estimateTokens(restored);
      }
      if (tokens > TOKEN_BUDGET) {
        // Step 2: Truncate all arrays to half
        truncateArrays(merged);
        dumped = yaml.dump(merged, { lineWidth: -1 });
        restored = restoreComments(dumped, inlineComments);
        tokens = estimateTokens(restored);
      }
      if (tokens > TOKEN_BUDGET) {
        // Step 3: Reject write entirely, keep previous version
        cleanup();
        return { updated: false, summary: `Profile too large (${tokens} tokens > ${TOKEN_BUDGET}). Write rejected to prevent bloat.` };
      }

      fs.writeFileSync(BRAIN_FILE, restored, 'utf8');

      cleanup();
      return {
        updated: true,
        summary: `${Object.keys(filtered).length} new trait${Object.keys(filtered).length > 1 ? 's' : ''} absorbed. (${tokens} tokens)`
      };

    } catch (err) {
      cleanup();
      return { updated: false, summary: `Profile merge failed: ${err.message}` };
    }

  } catch (err) {
    cleanup();
    return { updated: false, summary: `Distillation error: ${err.message}` };
  }
}

/**
 * Extract keys that are on lines marked with # [LOCKED]
 */
function extractLockedKeys(rawYaml) {
  const locked = new Set();
  const lines = rawYaml.split('\n');
  for (const line of lines) {
    if (line.includes('# [LOCKED]')) {
      const match = line.match(/^\s*([\w_]+)\s*:/);
      if (match) {
        locked.add(match[1]);
      }
    }
  }
  return locked;
}

/**
 * Extract inline comments from original YAML (key → comment mapping)
 * e.g. "  nickname: 3D # [LOCKED]" → { "nickname: 3D": "# [LOCKED]" }
 */
function extractInlineComments(rawYaml) {
  const comments = new Map();
  for (const line of rawYaml.split('\n')) {
    const commentMatch = line.match(/^(\s*[\w_]+\s*:.+?)\s+(#.+)$/);
    if (commentMatch) {
      // Key: the content part (trimmed), Value: the comment
      const content = commentMatch[1].trim();
      const comment = commentMatch[2];
      comments.set(content, comment);
    }
    // Also handle top-level keys with comments but no value on same line
    const keyCommentMatch = line.match(/^(\s*[\w_]+\s*:)\s+(#.+)$/);
    if (keyCommentMatch) {
      const content = keyCommentMatch[1].trim();
      const comment = keyCommentMatch[2];
      comments.set(content, comment);
    }
  }
  return comments;
}

/**
 * Restore inline comments to dumped YAML output
 */
function restoreComments(dumpedYaml, comments) {
  const lines = dumpedYaml.split('\n');
  const restored = lines.map(line => {
    const trimmed = line.trim();
    for (const [content, comment] of comments) {
      if (trimmed === content || trimmed.startsWith(content)) {
        // Only restore if the comment isn't already present
        if (!line.includes('#')) {
          return `${line} ${comment}`;
        }
      }
    }
    return line;
  });
  return restored.join('\n');
}

/**
 * Strategic merge: tier-aware upsert with pending trait support.
 *
 * - T1/T2: Never auto-write (locked)
 * - T3: High confidence → direct write; Normal → pending accumulation
 * - T4: Direct overwrite
 * - T5: Direct overwrite (system-managed)
 *
 * Also promotes mature pending traits (count >= 3 or high confidence).
 */
function strategicMerge(profile, updates, lockedKeys, pendingTraits, confidenceMap, sourceMap) {
  const result = JSON.parse(JSON.stringify(profile)); // deep clone

  // Walk flat entries from updates
  const flat = flattenObject(updates);
  for (const [key, value] of Object.entries(flat)) {
    // Skip internal metadata keys
    if (key.startsWith('_')) continue;

    // Schema check already done by filterBySchema, but double-check locks
    if (lockedKeys.has(key.split('.')[0])) continue;
    if (isLocked(key)) continue;

    // Null/empty protection — never delete existing values
    if (value === null || value === '') continue;

    const tier = getTier(key);
    if (!tier) continue;

    switch (tier) {
      case 'T1':
      case 'T2':
        continue; // Never auto-write

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
        setNested(result, key, value);
        // Auto-set focus_since when focus changes
        if (key === 'context.focus') {
          setNested(result, 'context.focus_since', new Date().toISOString().slice(0, 10));
        }
        break;

      case 'T5':
        setNested(result, key, value);
        break;
    }
  }

  // Promote mature pending traits
  const promotable = getPromotable(pendingTraits);
  for (const { key, value } of promotable) {
    setNested(result, key, value);
  }
  removePromoted(pendingTraits, promotable.map(p => p.key));

  return result;
}

/**
 * Flatten a nested object into dot-path keys.
 * { preferences: { code_style: 'concise' } } → { 'preferences.code_style': 'concise' }
 */
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

/**
 * Set a nested property by dot-path key.
 */
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

/**
 * Filter updates object: only keep keys that exist in schema and are not locked.
 * Walks nested objects and builds dot-path keys for checking.
 */
function filterBySchema(obj, parentKey = '') {
  const result = {};
  for (const key of Object.keys(obj)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    const value = obj[key];

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = filterBySchema(value, fullKey);
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      // Check schema whitelist — allow if key exists and is not locked
      if (hasKey(fullKey) && !isLocked(fullKey)) {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Truncate all arrays in the profile to half their length.
 */
function truncateArrays(obj) {
  for (const key of Object.keys(obj)) {
    if (Array.isArray(obj[key]) && obj[key].length > 1) {
      obj[key] = obj[key].slice(-Math.ceil(obj[key].length / 2));
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      truncateArrays(obj[key]);
    }
  }
}

/**
 * Clean up: remove buffer and lock
 */
function cleanup() {
  try { fs.unlinkSync(BUFFER_FILE); } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// Export for use in index.js
module.exports = { distill };

// Also allow direct execution
if (require.main === module) {
  const result = distill();
  if (result.updated) {
    console.log(`🧠 ${result.summary}`);
  } else {
    console.log(`💤 ${result.summary}`);
  }
}
