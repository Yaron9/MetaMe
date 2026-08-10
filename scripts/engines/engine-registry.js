'use strict';

const { createClaudeCliAdapter } = require('./claude-cli-adapter');
const { createCodexCliAdapter } = require('./codex-cli-adapter');
const { createAgyCliAdapter } = require('./agy-cli-adapter');
const { createPiCliAdapter } = require('./pi-cli-adapter');
const {
  createEnginePlugin,
  isEnginePlugin,
  negotiateCapabilities,
} = require('./engine-plugin');

function registryError(code, detail = '') {
  const error = new TypeError(detail ? `${code}:${detail}` : code);
  error.code = code;
  return error;
}

function pluginId(plugin) {
  return plugin && plugin.descriptor && plugin.descriptor.id;
}

function normalizePlugin(value) {
  if (isEnginePlugin(value)) return value;
  try {
    return createEnginePlugin(value);
  } catch (error) {
    throw registryError('engine_plugin_invalid', error.message);
  }
}

/**
 * Build a registry from immutable Engine Plugins.
 *
 * Generic registries use strict `get()`/`lookup()` semantics.  The built-in
 * registry opts into the historical default-to-Claude read path explicitly;
 * new code should use `lookup()` or `resolve()` when an unknown Engine must
 * remain distinguishable from an explicit fallback decision.
 */
function createEngineRegistry(plugins, options = {}) {
  const normalizeEngineName = typeof options.normalizeEngineName === 'function'
    ? options.normalizeEngineName
    : value => String(value || '').trim().toLowerCase();
  const defaultEngineId = String(options.defaultEngineId || 'claude').trim().toLowerCase();
  const legacyFallback = options.legacyFallback === true;
  const byId = new Map();
  const disabled = new Set();
  const retired = new Set((options.retiredIds || []).map(value => String(value).trim().toLowerCase()).filter(Boolean));

  function register(value) {
    const plugin = normalizePlugin(value);
    const id = pluginId(plugin);
    if (!id) throw registryError('engine_plugin_id_required');
    if (retired.has(id)) throw registryError('engine_id_reused', id);
    if (byId.has(id)) {
      // Keep the legacy diagnostic token while making the new registration
      // unit explicit for callers that classify registry failures by code.
      const error = registryError('duplicate_engine_plugin', `${id}:duplicate_engine_adapter`);
      throw error;
    }
    byId.set(id, plugin);
    return plugin;
  }

  for (const plugin of plugins || []) register(plugin);
  if (byId.size === 0) throw registryError('engine_plugin_required');

  function normalizeRequestedId(engineName) {
    const raw = String(engineName || '').trim().toLowerCase();
    if (!raw) return '';
    // Some legacy normalizers intentionally return Claude for unknown input.
    // Preserve the raw ID when that candidate is not registered so strict
    // lookup can still distinguish an unknown Engine from fallback behavior.
    // Case normalization is already represented by `raw`.  Do not accept a
    // legacy normalizer's default value for an unregistered raw ID: that
    // would turn an unknown request into a known Engine before `resolve()`
    // can report the explicit fallback decision.
    const normalized = String(normalizeEngineName(engineName) || '').trim().toLowerCase();
    return byId.has(raw) && byId.has(normalized) ? normalized : raw;
  }

  function lookup(engineName, { includeDisabled = true } = {}) {
    const id = normalizeRequestedId(engineName);
    if (!byId.has(id)) return null;
    if (!includeDisabled && disabled.has(id)) return null;
    return byId.get(id) || null;
  }

  function resolve(engineName, { fallbackEngine, allowDisabled = false } = {}) {
    const requestedId = normalizeRequestedId(engineName);
    const requested = lookup(requestedId, { includeDisabled: allowDisabled });
    if (requested) {
      return Object.freeze({
        requestedId,
        engineId: requestedId,
        plugin: requested,
        fallback: false,
        reason: '',
      });
    }
    const fallbackId = fallbackEngine === undefined || fallbackEngine === null
      ? ''
      : normalizeRequestedId(fallbackEngine);
    const fallback = fallbackId ? lookup(fallbackId, { includeDisabled: allowDisabled }) : null;
    if (fallback) {
      return Object.freeze({
        requestedId,
        engineId: fallbackId,
        plugin: fallback,
        fallback: true,
        reason: disabled.has(requestedId) ? 'engine_disabled' : 'unknown_engine',
      });
    }
    return Object.freeze({
      requestedId,
      engineId: null,
      plugin: null,
      fallback: false,
      reason: disabled.has(requestedId) ? 'engine_disabled' : 'unknown_engine',
    });
  }

  const registry = {
    // Strict public lookup.  `get()` below is retained only as a compatibility
    // read path for existing daemon callers.
    lookup,
    resolve,
    get(engineName) {
      return lookup(engineName) || (legacyFallback
        ? lookup(defaultEngineId, { includeDisabled: false })
        : null);
    },
    getOrDefault(engineName) {
      return lookup(engineName) || lookup(defaultEngineId, { includeDisabled: false });
    },
    getStrict: lookup,
    has(engineName) {
      return !!lookup(engineName);
    },
    isDisabled(engineName) {
      return disabled.has(normalizeRequestedId(engineName));
    },
    disable(engineName) {
      const id = normalizeRequestedId(engineName);
      if (!byId.has(id)) return false;
      disabled.add(id);
      return true;
    },
    enable(engineName) {
      const id = normalizeRequestedId(engineName);
      if (!byId.has(id)) return false;
      disabled.delete(id);
      return true;
    },
    remove(engineName) {
      const id = normalizeRequestedId(engineName);
      if (!byId.has(id)) return false;
      byId.delete(id);
      disabled.delete(id);
      retired.add(id);
      return true;
    },
    register,
    capabilities(engineName, requested) {
      const plugin = lookup(engineName);
      if (!plugin) return null;
      return negotiateCapabilities(plugin, requested);
    },
    list({ includeDisabled = true } = {}) {
      const pluginsInRegistry = [...byId.values()].filter(plugin => (
        includeDisabled || !disabled.has(pluginId(plugin))
      ));
      return Object.freeze(pluginsInRegistry);
    },
    retiredIds() {
      return Object.freeze([...retired].sort());
    },
  };
  return Object.freeze(registry);
}

function createDefaultEngineRegistry(deps = {}) {
  const adapters = [
    createClaudeCliAdapter(deps.claude),
    createCodexCliAdapter(deps.codex),
    createAgyCliAdapter(deps.agy),
    createPiCliAdapter(deps.pi),
  ];
  const plugins = adapters.map(runtime => createEnginePlugin({
    protocolVersion: 1,
    descriptor: runtime.descriptor,
    runtime,
    sessionSource: null,
    cognitiveHost: null,
  }));
  return createEngineRegistry(plugins, {
    normalizeEngineName: deps.normalizeEngineName,
    defaultEngineId: 'claude',
    legacyFallback: true,
  });
}

module.exports = {
  createEngineRegistry,
  createDefaultEngineRegistry,
};
