'use strict';

/**
 * core/chunker.js — Recursive delimiter-aware text chunker
 *
 * Pure function, no I/O, no dependencies.
 *
 * Exports:
 *   chunkText(text, opts?) → string[]
 */

// Delimiter hierarchy: paragraphs → lines → sentences → words
const DELIMITERS = [
  /\n\n+/,           // paragraphs
  /\n/,              // lines
  /(?<=[.!?。！？])\s+/, // sentences
  /\s+/,             // words
];

/**
 * Split text into chunks of approximately targetWords size.
 *
 * Algorithm:
 * 1. Split by highest-level delimiter that produces >1 segment.
 * 2. Greedily merge consecutive segments until adding the next would exceed targetWords.
 * 3. If a single segment exceeds targetWords, recurse with the next finer delimiter.
 * 4. Fragments smaller than targetWords * 0.3 are merged into the previous chunk.
 *
 * @param {string} text
 * @param {{ targetWords?: number }} [opts]
 * @returns {string[]}
 */
function chunkText(text, { targetWords = 300 } = {}) {
  if (!text || typeof text !== 'string') return [];
  const trimmed = text.trim();
  if (!trimmed) return [];

  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount <= targetWords * 1.5) return [trimmed];

  return _splitRecursive(trimmed, targetWords, 0);
}

/**
 * @param {string} text
 * @param {number} target
 * @param {number} delimIdx — current position in DELIMITERS hierarchy
 * @returns {string[]}
 */
function _splitRecursive(text, target, delimIdx) {
  if (delimIdx >= DELIMITERS.length) return [text];

  const segments = text.split(DELIMITERS[delimIdx]).filter(s => s.trim());
  if (segments.length <= 1) {
    return _splitRecursive(text, target, delimIdx + 1);
  }

  // Greedy merge
  const chunks = [];
  let current = '';

  for (const seg of segments) {
    const segWords = seg.split(/\s+/).length;
    const curWords = current ? current.split(/\s+/).length : 0;

    if (current && curWords + segWords > target) {
      chunks.push(current.trim());
      current = seg;
    } else {
      current = current ? current + '\n\n' + seg : seg;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // Recurse on oversized chunks
  const result = [];
  for (const chunk of chunks) {
    const cw = chunk.split(/\s+/).length;
    if (cw > target * 1.5) {
      result.push(..._splitRecursive(chunk, target, delimIdx + 1));
    } else {
      result.push(chunk);
    }
  }

  // Merge tiny trailing fragments into previous chunk
  const merged = [];
  for (const chunk of result) {
    const cw = chunk.split(/\s+/).length;
    if (merged.length > 0 && cw < target * 0.3) {
      merged[merged.length - 1] += '\n\n' + chunk;
    } else {
      merged.push(chunk);
    }
  }

  return merged;
}

module.exports = { chunkText };
