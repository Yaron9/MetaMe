'use strict';

/**
 * Built-in Session Source capability registry.
 *
 * The registry is deliberately adapter-facing: shared analytics receives an
 * opaque source seam and never imports a Host's storage implementation.
 */

const { createClaudeSessionSourceAdapter } = require('./claude-session-source-adapter');
const { createCodexSessionSourceAdapter } = require('./codex-session-source-adapter');
const { createAgySessionSourceAdapter } = require('./agy-session-source-adapter');
const { createPiSessionSourceAdapter } = require('./pi-session-source-adapter');

const FACTORIES = Object.freeze([
  Object.freeze({ id: 'claude', create: createClaudeSessionSourceAdapter }),
  Object.freeze({ id: 'codex', create: createCodexSessionSourceAdapter }),
  Object.freeze({ id: 'agy', create: createAgySessionSourceAdapter }),
  Object.freeze({ id: 'pi', create: createPiSessionSourceAdapter }),
]);

function createBuiltinSessionSourceAdapters(options = {}) {
  return FACTORIES.map(({ id, create }) => [
    id,
    create({ ...options, ...(options[id] || {}) }),
  ]);
}

function createBuiltinSessionSourceMap(options = {}) {
  return new Map(createBuiltinSessionSourceAdapters(options));
}

module.exports = {
  FACTORIES,
  createBuiltinSessionSourceAdapters,
  createBuiltinSessionSourceMap,
};
