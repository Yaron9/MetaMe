#!/usr/bin/env node

/**
 * MetaMe Intent Engine — Unified UserPromptSubmit Hook
 *
 * Config-driven intent dispatcher. Replaces the standalone team-context.js hook.
 * Each intent module detects a specific pattern and returns a hint string or null.
 * Only injects an additionalSystemPrompt when at least one intent fires.
 *
 * Enabled intents are controlled via daemon.yaml `hooks:` section:
 *
 *   hooks:
 *     team_dispatch: true   # team member communication hints (default: on)
 *     ops_assist: true      # /undo /restart /logs etc. hints (default: on)
 *     task_create: true     # task scheduling hints (default: on)
 *
 * Set any key to false to disable that intent module.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const METAME_DIR = path.join(os.homedir(), '.metame');
const { sanitizePrompt, isInternalPrompt } = require('./hook-utils');

// Default: all intents enabled unless explicitly set to false in daemon.yaml
const DEFAULTS = {
  team_dispatch:  true,
  ops_assist:     true,
  task_create:    true,
  file_transfer:  true,
  memory_recall:  true,
  doc_router:     true,
};

// Intent registry — loaded lazily so startup is fast even if a module has issues
const INTENT_MODULES = {
  team_dispatch:  './intent-team-dispatch',
  ops_assist:     './intent-ops-assist',
  task_create:    './intent-task-create',
  file_transfer:  './intent-file-transfer',
  memory_recall:  './intent-memory-recall',
  doc_router:     './intent-doc-router',
};

function exit() { process.exit(0); }

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  try { run(JSON.parse(raw)); } catch { exit(); }
});

function run(data) {
  // Internal daemon subprocesses set this env flag — never inject hints into them
  if (process.env.METAME_INTERNAL_PROMPT === '1') return exit();

  const projectKey = process.env.METAME_PROJECT || '';
  const rawPrompt = (data.prompt || data.user_prompt || '').trim();
  if (!rawPrompt) return exit();

  // Strip daemon-injected blocks, then bail if this is a system prompt
  if (isInternalPrompt(rawPrompt)) return exit();
  const prompt = sanitizePrompt(rawPrompt);
  if (!prompt) return exit();

  // Load daemon.yaml config (graceful: intents that don't need config still run)
  let config = {};
  try {
    const yaml = require('../resolve-yaml');
    config = yaml.load(fs.readFileSync(path.join(METAME_DIR, 'daemon.yaml'), 'utf8')) || {};
  } catch { /* proceed with defaults */ }

  // Merge daemon.yaml hooks section with defaults
  const hooksCfg = (config.hooks && typeof config.hooks === 'object') ? config.hooks : {};
  const enabled = { ...DEFAULTS, ...hooksCfg };

  // Run each enabled intent module, collect non-null hints
  const hints = [];
  for (const [key, modulePath] of Object.entries(INTENT_MODULES)) {
    if (enabled[key] === false) continue;
    try {
      const detect = require(modulePath);
      const result = detect(prompt, config, projectKey);
      if (result) hints.push(result);
    } catch (e) {
      process.stderr.write(`[intent-engine] ${key}: ${e.message}\n`);
    }
  }

  if (hints.length === 0) return exit();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { additionalSystemPrompt: hints.join('\n\n') },
  }));
  exit();
}
