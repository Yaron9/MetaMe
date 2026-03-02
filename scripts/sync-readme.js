#!/usr/bin/env node
'use strict';

/**
 * sync-readme.js — Translate README.md (English) → README中文版.md
 *
 * Usage: node scripts/sync-readme.js
 * Or:    npm run sync:readme
 *
 * Uses claude CLI to translate. English README is the source of truth.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'README.md');
const DST = path.join(ROOT, 'README中文版.md');

const english = fs.readFileSync(SRC, 'utf8');

const prompt = `You are a professional translator. Translate the following GitHub README from English to Chinese (简体中文).

Rules:
- Keep ALL markdown formatting, links, code blocks, HTML tags, and badges EXACTLY as-is
- Keep all technical terms, CLI commands, file paths, and config examples in English
- Translate prose, descriptions, and comments naturally — not word-by-word
- The first tagline should be: > **住在你电脑里的数字分身。**
- Change "Your machine, your data" to "不上云。你的机器，你的数据。"
- Keep the <p align="center"> header block unchanged
- Output ONLY the translated markdown, no extra explanation

Here is the README to translate:

${english}`;

console.log('Translating README.md → README中文版.md ...');

try {
  const result = execSync(
    `claude -p --model haiku --output-format text`,
    {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 120000,
      cwd: ROOT,
    }
  );

  const translated = result.trim();

  if (translated.length < 500) {
    console.error('Translation too short, likely failed. Aborting.');
    process.exit(1);
  }

  fs.writeFileSync(DST, translated + '\n', 'utf8');
  console.log(`✅ README中文版.md updated (${translated.length} chars)`);
} catch (e) {
  console.error('Translation failed:', e.message);
  process.exit(1);
}
