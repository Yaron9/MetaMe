'use strict';

/**
 * Build a unified doc-routing hint for intent modules.
 *
 * @param {object} route
 * @param {RegExp[]} route.patterns
 * @param {string} route.title
 * @param {string} route.docPath
 * @param {string} route.summary
 * @returns {(prompt: string) => string|null}
 */
function createDocRoute(route) {
  const patterns = Array.isArray(route.patterns) ? route.patterns : [];
  const title = String(route.title || '').trim();
  const docPath = String(route.docPath || '').trim();
  const summary = String(route.summary || '').trim();

  if (!patterns.length || !title || !docPath || !summary) {
    throw new Error('doc-router requires patterns, title, docPath, and summary');
  }

  return function detectDocRoute(prompt) {
    if (!patterns.some((re) => re.test(prompt))) return null;
    return `[${title}]\n- ${summary} → 先 \`cat ${docPath}\``;
  };
}

module.exports = { createDocRoute };
