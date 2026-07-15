'use strict';

const AGY_DEFAULT_MODEL = 'Gemini 3.5 Flash (Medium)';

const AGY_MODEL_ALIASES = new Map([
  ['sonnet', 'Claude Sonnet 4.6 (Thinking)'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'],
  ['opus', 'Claude Opus 4.6 (Thinking)'],
  ['claude-opus-4-6', 'Claude Opus 4.6 (Thinking)'],
]);

function isForeignModelId(model) {
  const lower = String(model || '').trim().toLowerCase();
  if (!lower) return false;
  if (lower === 'haiku' || lower.startsWith('claude-')) return true;
  if (lower.includes('codex')) return true;
  if (/^gpt-(?!oss\b)/.test(lower)) return true;
  return /^(?:o1|o3|o4)(?:-|$)/.test(lower);
}

function normalizeAgyModel(model, fallback = AGY_DEFAULT_MODEL) {
  const raw = String(model || '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  if (lower === 'auto' || lower === 'agy') return fallback;
  if (AGY_MODEL_ALIASES.has(lower)) return AGY_MODEL_ALIASES.get(lower);
  if (isForeignModelId(lower)) return fallback;
  return raw;
}

module.exports = {
  AGY_DEFAULT_MODEL,
  normalizeAgyModel,
  _internal: { isForeignModelId },
};
