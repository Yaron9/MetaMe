'use strict';

/**
 * core/reactive-prompt.js — Pure function to wrap reactive prompts
 *
 * Injects reactive mode instructions, working memory, and retry warnings
 * into agent prompts. Zero I/O, zero side effects.
 */

/**
 * Build a reactive-mode prompt wrapper around the original prompt.
 *
 * @param {string} originalPrompt - The original prompt text
 * @param {object} opts
 * @param {number} opts.depth - Current reactive depth
 * @param {number} opts.maxDepth - Maximum allowed depth
 * @param {string} opts.completionSignal - Signal string for mission completion
 * @param {string} [opts.workingMemory] - Optional working memory content
 * @param {boolean} [opts.isRetry] - Whether this is a retry after no signal
 * @returns {string} Wrapped prompt string
 */
function buildReactivePrompt(originalPrompt, opts) {
  const { depth, maxDepth, completionSignal, workingMemory, isRetry } = opts;

  const parts = [];

  parts.push(`[REACTIVE MODE] depth ${depth}/${maxDepth}`);
  parts.push('Rules:');
  parts.push('1. After completing the current step, you MUST output NEXT_DISPATCH: <target> "<prompt>" to trigger the next step');
  parts.push(`2. Only output ${completionSignal} when ALL objectives are achieved`);
  parts.push('3. Do NOT exit silently — failing to output a signal means the task chain breaks');

  if (isRetry) {
    parts.push('');
    parts.push('Warning: you did not output any signal in the previous round, causing task interruption. Check progress and continue.');
  }

  if (workingMemory && workingMemory.trim()) {
    parts.push('');
    parts.push('[Working Memory]');
    parts.push(workingMemory.trim());
  }

  parts.push('');
  parts.push('---');
  parts.push(originalPrompt);

  return parts.join('\n');
}

module.exports = { buildReactivePrompt };
