'use strict';

const { createClaudeCliAdapter } = require('./claude-cli-adapter');
const { createCodexCliAdapter } = require('./codex-cli-adapter');
const { createAgyCliAdapter } = require('./agy-cli-adapter');

function createEngineRegistry(adapters, options = {}) {
  const normalizeEngineName = typeof options.normalizeEngineName === 'function'
    ? options.normalizeEngineName
    : value => String(value || '').trim().toLowerCase();
  const byName = new Map();

  for (const adapter of adapters || []) {
    if (!adapter || !adapter.name) throw new TypeError('engine_adapter_required');
    if (byName.has(adapter.name)) {
      throw new TypeError(`duplicate_engine_adapter:${adapter.name}`);
    }
    byName.set(adapter.name, adapter);
  }
  if (!byName.has('claude')) throw new TypeError('claude_engine_adapter_required');

  return Object.freeze({
    get(engineName) {
      const normalized = normalizeEngineName(engineName);
      return byName.get(normalized) || byName.get('claude');
    },
    has(engineName) {
      return byName.has(normalizeEngineName(engineName));
    },
    list() {
      return Object.freeze([...byName.values()]);
    },
  });
}

function createDefaultEngineRegistry(deps = {}) {
  return createEngineRegistry([
    createClaudeCliAdapter(deps.claude),
    createCodexCliAdapter(deps.codex),
    createAgyCliAdapter(deps.agy),
  ], {
    normalizeEngineName: deps.normalizeEngineName,
  });
}

module.exports = {
  createEngineRegistry,
  createDefaultEngineRegistry,
};
