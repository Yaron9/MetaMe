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

// Global safety net: hooks must NEVER crash or exit non-zero
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

const fs = require('fs');
const path = require('path');
const os = require('os');

const METAME_DIR = path.join(os.homedir(), '.metame');
const { sanitizePrompt, isInternalPrompt } = require('./hook-utils');
const { buildIntentHintBlock } = require('../intent-registry');

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

  let intentBlock = '';
  try {
    intentBlock = buildIntentHintBlock(prompt, config, projectKey);
  } catch {
    return exit();
  }
  if (!intentBlock) return exit();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { additionalSystemPrompt: intentBlock },
  }));
  exit();
}
