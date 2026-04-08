'use strict';

/**
 * toSlug(tag) → string
 * Rules:
 *   - lowercase
 *   - keep only \w chars, Chinese [\u4e00-\u9fa5], spaces, hyphens
 *   - spaces → hyphens
 *   - collapse multiple hyphens → single hyphen
 *   - trim leading/trailing hyphens
 *   - truncate to 80 chars
 *   - if result is empty → throw Error
 */
function toSlug(tag) {
  if (typeof tag !== 'string') {
    throw new Error('toSlug: input must be a string');
  }

  // lowercase
  let s = tag.toLowerCase();

  // keep only: word chars (\w = [a-z0-9_]), Chinese, spaces, hyphens
  s = s.replace(/[^\w\u4e00-\u9fa5 -]/g, '');

  // spaces → hyphens
  s = s.replace(/ /g, '-');

  // collapse multiple hyphens
  s = s.replace(/-{2,}/g, '-');

  // trim leading/trailing hyphens
  s = s.replace(/^-+|-+$/g, '');

  // truncate to 80 chars
  s = s.slice(0, 80);

  if (s.length === 0) {
    throw new Error('toSlug: result is empty after normalization');
  }

  return s;
}

/**
 * sanitizeFts5(input) → string | null
 * Strips FTS5 special characters: " * ^ ( ) { } :
 * Returns null if result is empty after trim.
 */
function sanitizeFts5(input) {
  if (typeof input !== 'string') {
    return null;
  }

  // Remove FTS5 special chars: " * ^ ( ) { } :
  let s = input.replace(/["*^(){}:]/g, '');

  s = s.trim();

  if (s.length === 0) {
    return null;
  }

  return s;
}

module.exports = { toSlug, sanitizeFts5 };
