'use strict';

/**
 * Shared intent registry for all MetaMe runtime adapters.
 *
 * Detection logic lives here so Claude hooks and daemon-driven runtimes
 * (for example Codex) stay behaviorally aligned.
 */

const DEFAULTS = Object.freeze({
  team_dispatch: true,
  ops_assist: true,
  task_create: true,
  file_transfer: true,
  memory_recall: true,
  doc_router: true,
  perpetual: true,
});

const INTENT_MODULES = Object.freeze({
  team_dispatch: require('./hooks/intent-team-dispatch'),
  ops_assist: require('./hooks/intent-ops-assist'),
  task_create: require('./hooks/intent-task-create'),
  file_transfer: require('./hooks/intent-file-transfer'),
  memory_recall: require('./hooks/intent-memory-recall'),
  doc_router: require('./hooks/intent-doc-router'),
  perpetual: require('./hooks/intent-perpetual'),
});

function resolveEnabledIntents(config = {}) {
  const hooksCfg = (config.hooks && typeof config.hooks === 'object') ? config.hooks : {};
  return { ...DEFAULTS, ...hooksCfg };
}

function collectIntentHints(prompt, config = {}, projectKey = '') {
  const text = String(prompt || '').trim();
  if (!text) return [];

  const enabled = resolveEnabledIntents(config);
  const hints = [];
  for (const [key, detect] of Object.entries(INTENT_MODULES)) {
    if (enabled[key] === false) continue;
    const hint = detect(text, config, projectKey);
    if (hint) hints.push({ key, hint });
  }
  return hints;
}

function buildIntentHintBlock(prompt, config = {}, projectKey = '') {
  return collectIntentHints(prompt, config, projectKey)
    .map(item => item.hint)
    .join('\n\n');
}

module.exports = {
  DEFAULTS,
  INTENT_MODULES,
  resolveEnabledIntents,
  collectIntentHints,
  buildIntentHintBlock,
};
