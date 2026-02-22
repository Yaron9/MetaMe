#!/usr/bin/env node

/**
 * MetaMe Profile Schema — Field Whitelist
 *
 * Defines every allowed field in the profile, its tier, data type,
 * and constraints. The distiller can ONLY write keys listed here.
 * This is the #1 anti-bloat measure.
 *
 * Tiers:
 *   T1 — Identity (LOCKED, never auto-modify)
 *   T2 — Core Values (LOCKED, deep personality)
 *   T3 — Preferences (auto-writable, needs confidence)
 *   T4 — Context (free overwrite, current state)
 *   T5 — Evolution (system-managed, strict limits)
 */

const SCHEMA = {
  // === T1: Identity (USER's identity, not agent's) ===
  'identity.role': { tier: 'T1', type: 'string', locked: false },
  'identity.locale': { tier: 'T1', type: 'string', locked: true },

  // === T2: Core Values / Traits ===
  'core_values.*': { tier: 'T2', type: 'string', locked: true },
  'core_traits.crisis_reflex': { tier: 'T2', type: 'enum', locked: true, values: ['Action', 'Analysis', 'Delegation', 'Freeze'] },
  'core_traits.flow_trigger': { tier: 'T2', type: 'enum', locked: true, values: ['Ideation', 'Execution', 'Teaching', 'Debugging'] },
  'core_traits.shadow_self': { tier: 'T2', type: 'string', locked: true, maxChars: 80 },
  'core_traits.learning_style': { tier: 'T2', type: 'enum', locked: true, values: ['Hands-on', 'Conceptual', 'Social', 'Reflective'] },
  'core_traits.north_star.aspiration': { tier: 'T2', type: 'string', locked: true, maxChars: 80 },
  'core_traits.north_star.realistic': { tier: 'T2', type: 'string', locked: true, maxChars: 80 },

  // === T3: Preferences ===
  'preferences.code_style': { tier: 'T3', type: 'enum', values: ['concise', 'verbose', 'documented'] },
  'preferences.communication': { tier: 'T3', type: 'enum', values: ['direct', 'gentle', 'socratic'] },
  'preferences.language_mix': { tier: 'T3', type: 'enum', values: ['zh-only', 'en-only', 'zh-main-en-term', 'code-switch'] },
  'preferences.tech_terms_language': { tier: 'T3', type: 'enum', values: ['zh', 'en'] },
  'preferences.code_comments_language': { tier: 'T3', type: 'enum', values: ['zh', 'en', null] },
  'preferences.explanation_depth': { tier: 'T3', type: 'enum', values: ['result_only', 'brief_rationale', 'deep_dive'] },
  'preferences.interaction_tempo': { tier: 'T3', type: 'enum', values: ['batch', 'incremental'] },
  'preferences.tools': { tier: 'T3', type: 'array', maxItems: 10 },

  // === T3b: Cognition ===
  'cognition.decision_style': { tier: 'T3', type: 'enum', values: ['intuitive', 'analytical', 'adaptive'] },
  'cognition.info_processing.entry_point': { tier: 'T3', type: 'enum', values: ['big_picture', 'details', 'examples'] },
  'cognition.info_processing.preferred_format': { tier: 'T3', type: 'enum', values: ['structured', 'narrative', 'visual_metaphor'] },
  'cognition.abstraction.default_level': { tier: 'T3', type: 'enum', values: ['strategic', 'architectural', 'implementation', 'operational'] },
  'cognition.cognitive_load.chunk_size': { tier: 'T3', type: 'enum', values: ['small', 'medium', 'large'] },
  'cognition.motivation.driver': { tier: 'T3', type: 'enum', values: ['autonomy', 'competence', 'meaning', 'creation', 'optimization'] },
  'cognition.metacognition.receptive_to_challenge': { tier: 'T3', type: 'enum', values: ['yes', 'sometimes', 'no'] },
  'cognition.metacognition.error_response': { tier: 'T3', type: 'enum', values: ['quick_pivot', 'root_cause_first', 'seek_help', 'retry_same'] },

  // === T4: Context ===
  'context.focus': { tier: 'T4', type: 'string', maxChars: 80 },
  'context.focus_since': { tier: 'T4', type: 'string' },
  'context.active_projects': { tier: 'T4', type: 'array', maxItems: 5 },
  'context.blockers': { tier: 'T4', type: 'array', maxItems: 3 },
  'context.energy': { tier: 'T4', type: 'enum', values: ['high', 'medium', 'low', null] },
  'status.focus': { tier: 'T4', type: 'string', maxChars: 80 },
  'status.language': { tier: 'T4', type: 'string' },

  // === T5: Evolution (system-managed) ===
  'evolution.last_distill': { tier: 'T5', type: 'string' },
  'evolution.distill_count': { tier: 'T5', type: 'number' },
  'evolution.recent_changes': { tier: 'T5', type: 'array', maxItems: 5 },
  'evolution.auto_distill': { tier: 'T5', type: 'array', maxItems: 10 },

  // === T5: Growth (metacognition, system-managed) ===
  'growth.patterns': { tier: 'T5', type: 'array', maxItems: 3 },
  'growth.zone_history': { tier: 'T5', type: 'array', maxItems: 10 },
  'growth.reflections_answered': { tier: 'T5', type: 'number' },
  'growth.reflections_skipped': { tier: 'T5', type: 'number' },
  'growth.last_reflection': { tier: 'T5', type: 'string' },
  'growth.quiet_until': { tier: 'T5', type: 'string' },
  'growth.mirror_enabled': { tier: 'T5', type: 'boolean' },
};

/**
 * Check if a dotted key matches the schema.
 * Supports wildcard entries like 'core_values.*'
 */
function hasKey(key) {
  if (SCHEMA[key]) return true;
  // Check wildcard patterns
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const wildcard = parts.slice(0, i).join('.') + '.*';
    if (SCHEMA[wildcard]) return true;
  }
  return false;
}

/**
 * Get schema definition for a key (or its wildcard parent).
 */
function getDefinition(key) {
  if (SCHEMA[key]) return SCHEMA[key];
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const wildcard = parts.slice(0, i).join('.') + '.*';
    if (SCHEMA[wildcard]) return SCHEMA[wildcard];
  }
  return null;
}

/**
 * Get the tier for a key.
 */
function getTier(key) {
  const def = getDefinition(key);
  return def ? def.tier : null;
}

/**
 * Check if a key is locked.
 */
function isLocked(key) {
  const def = getDefinition(key);
  return def ? !!def.locked : false;
}

/**
 * Validate a value against its schema definition.
 * Returns { valid: boolean, reason?: string }
 */
function validate(key, value) {
  const def = getDefinition(key);
  if (!def) return { valid: false, reason: 'Key not in schema' };

  if (def.type === 'enum') {
    if (!def.values.includes(value)) {
      return { valid: false, reason: `Value must be one of: ${def.values.join(', ')}` };
    }
  }

  if (def.type === 'string' && typeof value === 'string') {
    if (def.maxChars && value.length > def.maxChars) {
      return { valid: false, reason: `String exceeds ${def.maxChars} chars` };
    }
  }

  if (def.type === 'array' && Array.isArray(value)) {
    if (def.maxItems && value.length > def.maxItems) {
      return { valid: false, reason: `Array exceeds ${def.maxItems} items` };
    }
  }

  return { valid: true };
}

/**
 * Get all allowed keys as a formatted list (for injection into prompts).
 */
function getAllowedKeysForPrompt() {
  const lines = [];
  let currentTier = '';
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (def.tier !== currentTier) {
      currentTier = def.tier;
      lines.push(`\n# ${currentTier}${def.locked ? ' (LOCKED — do NOT write)' : ''}:`);
    }
    let desc = `  ${key}: ${def.type}`;
    if (def.values) desc += ` [${def.values.join('|')}]`;
    if (def.maxChars) desc += ` (max ${def.maxChars} chars)`;
    if (def.maxItems) desc += ` (max ${def.maxItems} items)`;
    if (def.locked) desc += ' [LOCKED]';
    lines.push(desc);
  }
  return lines.join('\n');
}

/**
 * Get only writable keys (T3-T5) as a formatted list for the distill prompt.
 * Saves ~150 tokens by omitting T1/T2 LOCKED fields the distiller can't write anyway.
 */
function getWritableKeysForPrompt() {
  const lines = [];
  let currentTier = '';
  for (const [key, def] of Object.entries(SCHEMA)) {
    if (def.tier === 'T1' || def.tier === 'T2') continue;
    if (def.tier !== currentTier) {
      currentTier = def.tier;
      lines.push(`\n# ${currentTier}:`);
    }
    let desc = `  ${key}: ${def.type}`;
    if (def.values) desc += ` [${def.values.join('|')}]`;
    if (def.maxChars) desc += ` (max ${def.maxChars} chars)`;
    if (def.maxItems) desc += ` (max ${def.maxItems} items)`;
    lines.push(desc);
  }
  return lines.join('\n');
}

/**
 * Estimate token count for a YAML string (conservative for mixed zh/en).
 */
function estimateTokens(yamlString) {
  return Math.ceil(yamlString.length / 3);
}

const TOKEN_BUDGET = 800;

module.exports = {
  SCHEMA,
  hasKey,
  getDefinition,
  getTier,
  isLocked,
  validate,
  getAllowedKeysForPrompt,
  getWritableKeysForPrompt,
  estimateTokens,
  TOKEN_BUDGET,
};
