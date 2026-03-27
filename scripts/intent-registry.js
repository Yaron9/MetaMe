'use strict';

const detectDocRouter = require('./hooks/intent-doc-router');

/**
 * Shared intent registry for all MetaMe runtime adapters.
 *
 * Detection logic lives here so Claude hooks and daemon-driven runtimes
 * (for example Codex) stay behaviorally aligned.
 */

const DEFAULTS = Object.freeze({
  agent_capability: true,
  team_dispatch: true,
  ops_assist: true,
  file_transfer: true,
  weixin_bridge: true,
  memory_recall: true,
  doc_router: true,
  perpetual: true,
  research: true,
});

const INTENT_MODULES = Object.freeze({
  agent_capability: {
    detect: require('./hooks/intent-agent-capability'),
    priority: 100,
  },
  team_dispatch: require('./hooks/intent-team-dispatch'),
  ops_assist: {
    detect: require('./hooks/intent-ops-assist'),
    priority: 80,
  },
  file_transfer: {
    detect: require('./hooks/intent-file-transfer'),
    priority: 95,
  },
  weixin_bridge: {
    detect: require('./hooks/intent-weixin-bridge'),
    priority: 90,
  },
  memory_recall: {
    detect: require('./hooks/intent-memory-recall'),
    priority: 70,
  },
  doc_router: {
    detect: detectDocRouter,
    priority: 10,
    fallbackOnly: true,
  },
  perpetual: {
    detect: require('./hooks/intent-perpetual'),
    priority: 60,
  },
  research: {
    detect: require('./hooks/intent-research'),
    priority: 55,
  },
});

const DEFAULT_MAX_HINTS = 2;
const DEFAULT_MAX_HINT_CHARS = 1200;

function normalizeIntentModule(entry) {
  if (typeof entry === 'function') return { detect: entry, priority: 50, fallbackOnly: false };
  return {
    detect: entry.detect,
    priority: Number.isFinite(entry.priority) ? entry.priority : 50,
    fallbackOnly: !!entry.fallbackOnly,
  };
}

function resolveEnabledIntents(config = {}) {
  const hooksCfg = (config.hooks && typeof config.hooks === 'object') ? config.hooks : {};
  return { ...DEFAULTS, ...hooksCfg };
}

function collectIntentHints(prompt, config = {}, projectKey = '') {
  const text = String(prompt || '').trim();
  if (!text) return [];

  const enabled = resolveEnabledIntents(config);
  const hints = [];
  for (const [key, rawEntry] of Object.entries(INTENT_MODULES)) {
    if (enabled[key] === false) continue;
    const entry = normalizeIntentModule(rawEntry);
    const hint = entry.detect(text, config, projectKey);
    if (hint) hints.push({ key, hint });
  }
  return hints;
}

function buildIntentHintBlock(prompt, config = {}, projectKey = '') {
  const maxHints = Number.isInteger(config && config.intent_max_hints) && config.intent_max_hints > 0
    ? config.intent_max_hints
    : DEFAULT_MAX_HINTS;
  const maxChars = Number.isInteger(config && config.intent_max_hint_chars) && config.intent_max_hint_chars > 0
    ? config.intent_max_hint_chars
    : DEFAULT_MAX_HINT_CHARS;

  let hits = collectIntentHints(prompt, config, projectKey)
    .map((item) => ({ ...item, ...normalizeIntentModule(INTENT_MODULES[item.key]) }));

  if (hits.some(item => !item.fallbackOnly) && !(typeof detectDocRouter.hasExplicitDocIntent === 'function' && detectDocRouter.hasExplicitDocIntent(prompt))) {
    hits = hits.filter(item => !item.fallbackOnly);
  }

  hits.sort((a, b) => b.priority - a.priority);

  const selected = [];
  let usedChars = 0;
  for (const item of hits) {
    if (selected.length >= maxHints) break;
    const nextChars = usedChars + item.hint.length;
    if (selected.length > 0 && nextChars > maxChars) continue;
    selected.push(item);
    usedChars = nextChars;
  }

  return selected.map(item => item.hint).join('\n\n');
}

module.exports = {
  DEFAULTS,
  INTENT_MODULES,
  resolveEnabledIntents,
  collectIntentHints,
  buildIntentHintBlock,
};
