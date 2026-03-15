'use strict';

/**
 * MetaMe Hook Utilities — Shared helpers for Claude Code hooks
 *
 * Provides prompt sanitization and internal prompt detection used by
 * multiple hooks to avoid triggering on daemon-injected system content.
 */

// Daemon-injected blocks that should be stripped before intent analysis
const BLOCK_PATTERNS = [
  /<!--\s*FACTS:START\s*-->[\s\S]*?<!--\s*FACTS:END\s*-->/gi,
  /<!--\s*MEMORY:START\s*-->[\s\S]*?<!--\s*MEMORY:END\s*-->/gi,
  /\[System hints - DO NOT mention these to user:[\s\S]*?\]/gi,
  /\[Mac automation policy - do NOT expose this block:[\s\S]*?\]/gi,
  /\[Task notification\][\s\S]*?(?=\n{2,}|$)/gi,
  /<task-notification\b[\s\S]*?<\/task-notification>/gi,
  /<task-notification\b[\s\S]*$/gi,
];

// Patterns that identify internal/system prompts (daemon subprocesses)
const INTERNAL_PATTERNS = [
  /You are a MetaMe cognitive profile distiller/i,
  /You are a metacognition pattern detector/i,
  /你是精准的知识提取引擎/,
  /RECALLED LONG-TERM FACTS \(context only/i,
  /\[System hints - DO NOT mention these to user:/i,
  /\[Mac automation policy - do NOT expose this block:/i,
  /MANDATORY FIRST ACTION: The user has not been calibrated yet/i,
  /<!--\s*FACTS:START\s*-->/i,
  /<!--\s*MEMORY:START\s*-->/i,
  /\[Task notification\]/i,
  /<task-notification\b/i,
];

/**
 * Strip daemon-injected blocks from prompt text.
 * Returns clean user payload or empty string.
 * @param {string} text
 * @returns {string}
 */
function sanitizePrompt(text) {
  let s = String(text || '');
  for (const re of BLOCK_PATTERNS) {
    s = s.replace(re, ' ');
  }
  return s.trim();
}

/**
 * Returns true if the text matches a known internal/system prompt template.
 * These come from daemon subprocesses (distill, memory-extract, skill-evolution).
 * @param {string} text
 * @returns {boolean}
 */
function isInternalPrompt(text) {
  const s = String(text || '');
  return INTERNAL_PATTERNS.some(re => re.test(s));
}

module.exports = { sanitizePrompt, isInternalPrompt };
