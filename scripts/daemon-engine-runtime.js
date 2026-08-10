'use strict';

const os = require('os');
const { normalizeEngineName } = require('./daemon-utils');
const { isEnginePlugin } = require('./engines/engine-plugin');
const {
  BUILTIN_RUNTIME_CATALOG,
  createBuiltinEngineRegistry,
} = require('./engines/native-runtime-factory');

// The facade exposes catalog policies only.  Built-in adapter assembly and
// native operations stay behind engines/native-runtime-factory.js.
const DEFINITIONS = new Map(BUILTIN_RUNTIME_CATALOG.map(definition => [definition.id, definition]));
const DEFAULT_DEFINITION = BUILTIN_RUNTIME_CATALOG.find(definition => definition.defaultEngine)
  || BUILTIN_RUNTIME_CATALOG[0];

function definitionFor(engineName) {
  const normalized = String(normalizeEngineName(engineName, DEFAULT_DEFINITION.id) || '')
    .trim().toLowerCase();
  return DEFINITIONS.get(normalized) || DEFAULT_DEFINITION;
}

function resolveEngineModel(engineName, daemonCfg = {}, overrideModel = '') {
  const definition = definitionFor(engineName);
  const models = daemonCfg && daemonCfg.models && typeof daemonCfg.models === 'object'
    ? daemonCfg.models
    : {};
  const explicit = String(overrideModel || '').trim();
  if (explicit) return definition.model.normalizeConfiguredModel(explicit, definition.model.main);

  const configured = String(models[definition.id] || '').trim();
  if (configured) return definition.model.normalizeConfiguredModel(configured, definition.model.main);

  const legacy = String((daemonCfg && daemonCfg.model) || '').trim();
  if (!legacy) return definition.model.main;
  return definition.model.resolveLegacyModel(legacy, definition.model.main);
}

function normalizeEngineModel(engineName, value, fallback) {
  const definition = definitionFor(engineName);
  const defaultValue = fallback === undefined ? definition.model.main : fallback;
  return definition.model.normalizeConfiguredModel(value, defaultValue);
}

function detectDefaultEngine(deps = {}) {
  const home = deps.HOME || deps.home || os.homedir();
  const candidates = BUILTIN_RUNTIME_CATALOG
    .filter(definition => Number.isFinite(definition.autodetectPriority))
    .sort((left, right) => left.autodetectPriority - right.autodetectPriority);
  for (const definition of candidates) {
    const configured = typeof definition.configuredBinary === 'function'
      ? definition.configuredBinary(deps)
      : '';
    const binary = String(configured || '').trim()
      || definition.resolveBinary({ ...deps, HOME: home, home });
    const probe = definition.probeBinary(binary, { ...deps, HOME: home, home });
    if (probe && probe.available) return definition.id;
  }
  return DEFAULT_DEFINITION.id;
}

function resolveEngineTimeouts(engineName) {
  return { ...definitionFor(engineName).timeouts };
}

function resolveEnginePlugin(value, engineName = '') {
  const requestedId = String(engineName || '').trim().toLowerCase();
  if (isEnginePlugin(value)) return value;
  throw new TypeError(requestedId
    ? `engine_plugin_required:${requestedId}`
    : 'engine_plugin_required');
}

function createEngineRuntimeFactory(deps = {}) {
  const registry = createBuiltinEngineRegistry({
    ...deps,
    normalizeEngineName,
  });
  return engineName => registry.get(engineName);
}

const ENGINE_MODEL_CONFIG = Object.freeze(Object.fromEntries(
  BUILTIN_RUNTIME_CATALOG.map(definition => [definition.id, Object.freeze({
    main: definition.model.main,
    distill: definition.model.distill,
    options: definition.model.options,
    provider: definition.model.provider,
    hint: definition.model.hint,
  })])
));

const ENGINE_DISTILL_MAP = Object.freeze(Object.fromEntries(
  Object.entries(ENGINE_MODEL_CONFIG).map(([id, config]) => [id, config.distill])
));

const ENGINE_DEFAULT_MODEL = Object.freeze(Object.fromEntries(
  Object.entries(ENGINE_MODEL_CONFIG).map(([id, config]) => [id, config.main])
));

module.exports = {
  createEngineRuntimeFactory,
  resolveEnginePlugin,
  normalizeEngineName,
  detectDefaultEngine,
  resolveEngineModel,
  normalizeEngineModel,
  resolveEngineTimeouts,
  ENGINE_MODEL_CONFIG,
  ENGINE_DISTILL_MAP,
  ENGINE_DEFAULT_MODEL,
};
