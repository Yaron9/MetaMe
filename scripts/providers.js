#!/usr/bin/env node

/**
 * providers.js — MetaMe Provider Management
 *
 * Manages API provider configurations for Claude Code.
 * Injects credentials via environment variables at spawn time — zero file mutation.
 *
 * Mechanism: Claude Code respects ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY
 * env vars. By setting these before spawn(), we redirect Claude Code to any
 * Anthropic-compatible API relay without touching ~/.claude/settings.json.
 *
 * Compatible relays must accept the Anthropic Messages API format.
 * Model routing is handled by the relay — Claude Code sends standard model
 * names (haiku, sonnet, opus) and the relay maps them as configured.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const yaml = require('./resolve-yaml');
const { createEngineRuntimeFactory } = require('./daemon-engine-runtime');
const { createBackgroundRunner } = require('./daemon-background-runner');
const { normalizeAgyModel } = require('./core/agy-model');

const DEFAULT_DISTILL_ENGINE = 'agy';
const DEFAULT_DISTILL_MODEL = 'auto';
const DISTILL_MODEL_ALIASES = new Map([
  ['agy', 'auto'],
  ['5.1mini', 'gpt-5.1-codex-mini'],
  ['gpt5.1mini', 'gpt-5.1-codex-mini'],
  ['gpt-5.1-mini', 'gpt-5.1-codex-mini'],
  ['gpt5.1-codex-mini', 'gpt-5.1-codex-mini'],
  ['codex-mini', 'gpt-5.1-codex-mini'],
  ['5mini', 'gpt-5-mini'],
  ['gpt5mini', 'gpt-5-mini'],
]);
const LEGACY_NON_AGY_DISTILL_MODELS = new Set([
  'haiku',
  'sonnet',
  'opus',
  'gpt-5-mini',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.3-codex',
  'gpt-5-codex',
]);

function canonicalizeAliasKey(input) {
  return String(input || '').trim().toLowerCase().replace(/[\s_]+/g, '').replace(/^gpt[-\s]?/i, 'gpt');
}

function normalizeDistillModel(model, { allowEmpty = false } = {}) {
  const raw = String(model || '').trim();
  if (!raw) {
    if (allowEmpty) return null;
    throw new Error('蒸馏模型不能为空。');
  }
  const alias = DISTILL_MODEL_ALIASES.get(canonicalizeAliasKey(raw));
  const normalized = (alias || raw).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._() -]{1,79}$/.test(normalized)) {
    throw new Error(`无效蒸馏模型: ${raw}`);
  }
  return normalized;
}

function resolveDistillModel(config, overrideModel) {
  if (overrideModel !== undefined && overrideModel !== null && String(overrideModel).trim() !== '') {
    return normalizeDistillModel(overrideModel);
  }
  const configured = config && config.distill_model ? String(config.distill_model).trim() : '';
  if (configured) return normalizeDistillModel(configured);
  return DEFAULT_DISTILL_MODEL;
}

function resolveDistillEngine(config, overrideEngine) {
  const raw = String(
    overrideEngine
    || process.env.METAME_DISTILL_ENGINE
    || process.env.METAME_ENGINE
    || (config && config.distill_engine)
    || DEFAULT_DISTILL_ENGINE
  ).trim().toLowerCase();
  if (raw === 'agy' || raw === 'codex' || raw === 'claude') return raw;
  return DEFAULT_DISTILL_ENGINE;
}

function resolveDistillModelForEngine(config, engine, overrideModel) {
  const model = resolveDistillModel(config, overrideModel);
  if (engine === 'agy') return normalizeAgyModel(model, DEFAULT_DISTILL_MODEL);
  return model;
}

// ---------------------------------------------------------
// DEFAULT CONFIG
// ---------------------------------------------------------
function defaultConfig() {
  return {
    active: 'anthropic',
    providers: {
      anthropic: { label: 'Anthropic (Official)' },
    },
    distill_provider: null,
    daemon_provider: null,
    distill_engine: DEFAULT_DISTILL_ENGINE,
    distill_model: null,
  };
}

// ---------------------------------------------------------
// LOAD / SAVE (cached — file rarely changes)
// ---------------------------------------------------------
let _providersCache = null;
let _providersCachePath = '';
let _providersCacheStamp = '';

function getProvidersFilePath() {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.metame', 'providers.yaml');
}

function computeFileStamp(filePath) {
  try {
    if (!fs.existsSync(filePath)) return 'missing';
    const st = fs.statSync(filePath);
    return `${Math.trunc(st.mtimeMs)}:${st.size}`;
  } catch {
    return 'error';
  }
}

function loadProviders(options = {}) {
  const force = !!(options && options.force);
  const providersFile = getProvidersFilePath();
  const currentStamp = computeFileStamp(providersFile);
  if (_providersCachePath && _providersCachePath !== providersFile) {
    _providersCache = null;
    _providersCacheStamp = '';
  }
  if (!force && _providersCache && _providersCachePath === providersFile && _providersCacheStamp === currentStamp) {
    return _providersCache;
  }
  try {
    if (!fs.existsSync(providersFile)) {
      _providersCachePath = providersFile;
      _providersCacheStamp = currentStamp;
      _providersCache = defaultConfig();
      return _providersCache;
    }
    const data = yaml.load(fs.readFileSync(providersFile, 'utf8'));
    if (!data || typeof data !== 'object') {
      _providersCachePath = providersFile;
      _providersCacheStamp = currentStamp;
      _providersCache = defaultConfig();
      return _providersCache;
    }
    if (!data.providers) data.providers = {};
    if (!data.providers.anthropic) data.providers.anthropic = { label: 'Anthropic (Official)' };
    const explicitDistillEngine = String(data.distill_engine || '').trim();
    const resolvedDistillEngine = resolveDistillEngine(data);
    const loadedDistillModel = (() => {
      try { return normalizeDistillModel(data.distill_model, { allowEmpty: true }); } catch { return null; }
    })();
    _providersCache = {
      active: data.active || 'anthropic',
      providers: data.providers,
      distill_provider: data.distill_provider || null,
      daemon_provider: data.daemon_provider || null,
      distill_engine: resolvedDistillEngine,
      distill_model: (!explicitDistillEngine && resolvedDistillEngine === 'agy' && LEGACY_NON_AGY_DISTILL_MODELS.has(String(loadedDistillModel || '').toLowerCase()))
        ? null
        : loadedDistillModel,
    };
    _providersCachePath = providersFile;
    _providersCacheStamp = currentStamp;
    return _providersCache;
  } catch {
    _providersCachePath = providersFile;
    _providersCacheStamp = currentStamp;
    _providersCache = defaultConfig();
    return _providersCache;
  }
}

function saveProviders(config) {
  const providersFile = getProvidersFilePath();
  const metameDir = path.dirname(providersFile);
  if (!fs.existsSync(metameDir)) fs.mkdirSync(metameDir, { recursive: true });
  fs.writeFileSync(providersFile, yaml.dump(config, { lineWidth: -1 }), 'utf8');
  _providersCache = null;
  _providersCachePath = providersFile;
  _providersCacheStamp = '';
}

// ---------------------------------------------------------
// PROVIDER ENV BUILDER (Core mechanism)
// ---------------------------------------------------------

/**
 * Read the env mapping defined in ~/.claude/settings.json.
 * Returns a plain string→string object (only string values are kept).
 * Returns {} on any error or if the file/env block is missing.
 */
function readClaudeSettingsEnv() {
  const home = process.env.HOME || os.homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!data || typeof data.env !== 'object' || data.env === null) return {};
    const out = {};
    for (const [k, v] of Object.entries(data.env)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Build env var overrides for a named provider.
 *
 * Always inherits the env mapping from ~/.claude/settings.json (slot mappings
 * like ANTHROPIC_DEFAULT_*_MODEL stay in place across providers).
 * For 'anthropic' (official): returns the inherited Claude settings env unchanged.
 * For custom providers: overrides ANTHROPIC_BASE_URL plus both
 * ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN with the provider's credentials.
 */
function buildEnv(providerName) {
  const config = loadProviders();
  const name = providerName || config.active;

  const env = readClaudeSettingsEnv();

  if (name === 'anthropic') return env;

  const provider = config.providers[name];
  if (!provider) return env;

  if (provider.base_url) env.ANTHROPIC_BASE_URL = provider.base_url;
  if (provider.api_key) {
    env.ANTHROPIC_API_KEY = provider.api_key;
    env.ANTHROPIC_AUTH_TOKEN = provider.api_key;
  }
  return env;
}

/**
 * Build a complete env object for spawn(), merging process.env + provider env.
 */
function buildSpawnEnv(providerName) {
  return { ...process.env, ...buildEnv(providerName) };
}

/**
 * Build env for the active provider.
 */
function buildActiveEnv() {
  return buildEnv(null); // null → uses active
}

/**
 * Build env for distill tasks (distill_provider → active fallback).
 */
function buildDistillEnv() {
  const config = loadProviders();
  return buildEnv(config.distill_provider || config.active);
}

/**
 * Build env for daemon tasks (daemon_provider → active fallback).
 */
function buildDaemonEnv() {
  const config = loadProviders();
  return buildEnv(config.daemon_provider || config.active);
}

// ---------------------------------------------------------
// CRUD
// ---------------------------------------------------------
function getActiveProvider() {
  const config = loadProviders();
  const p = config.providers[config.active];
  return p ? { name: config.active, ...p } : null;
}

function getActiveName() {
  return loadProviders().active;
}

function setActive(name) {
  const config = loadProviders();
  if (!config.providers[name]) {
    throw new Error(`Provider "${name}" not found. Available: ${Object.keys(config.providers).join(', ')}`);
  }
  config.active = name;
  saveProviders(config);
}

function addProvider(name, providerConfig) {
  if (name === 'anthropic') throw new Error('Cannot overwrite the default Anthropic provider.');
  const config = loadProviders();
  config.providers[name] = providerConfig;
  saveProviders(config);
}

function removeProvider(name) {
  if (name === 'anthropic') throw new Error('Cannot remove the default Anthropic provider.');
  const config = loadProviders();
  if (!config.providers[name]) throw new Error(`Provider "${name}" not found.`);
  if (config.active === name) config.active = 'anthropic';
  if (config.distill_provider === name) config.distill_provider = null;
  if (config.daemon_provider === name) config.daemon_provider = null;
  delete config.providers[name];
  saveProviders(config);
}

function setRole(role, providerName) {
  const config = loadProviders();
  if (providerName && !config.providers[providerName]) {
    throw new Error(`Provider "${providerName}" not found.`);
  }
  if (role === 'distill') {
    config.distill_provider = providerName || null;
  } else if (role === 'daemon') {
    config.daemon_provider = providerName || null;
  } else {
    throw new Error(`Unknown role "${role}". Use: distill, daemon`);
  }
  saveProviders(config);
}

function getDistillModel() {
  const config = loadProviders();
  return resolveDistillModel(config);
}

function getDistillEngine() {
  const config = loadProviders();
  return resolveDistillEngine(config);
}

function setDistillModel(model) {
  const config = loadProviders();
  const normalized = normalizeDistillModel(model, { allowEmpty: true });
  config.distill_model = normalized || null;
  saveProviders(config);
  return config.distill_model;
}

function setDistillEngine(engine) {
  const config = loadProviders();
  config.distill_engine = resolveDistillEngine(config, engine);
  saveProviders(config);
  return config.distill_engine;
}

// ---------------------------------------------------------
// DISPLAY
// ---------------------------------------------------------
function listFormatted() {
  const config = loadProviders();
  const lines = [''];
  for (const [name, p] of Object.entries(config.providers)) {
    const active = name === config.active;
    const icon = active ? '→' : ' ';
    const label = p.label || name;
    const url = p.base_url || 'official';
    const badge = active ? ' (active)' : '';
    lines.push(`  ${icon} ${name}: ${label} [${url}]${badge}`);
  }

  const d = config.distill_provider;
  const dm = config.daemon_provider;
  if (d || dm) {
    lines.push('');
    if (d) lines.push(`  Distill provider: ${d}`);
    if (dm) lines.push(`  Daemon provider:  ${dm}`);
  }
  lines.push(`  Distill model:    ${resolveDistillModel(config)}`);
  lines.push(`  Distill engine:   ${resolveDistillEngine(config)}`);

  return lines.join('\n');
}

// ---------------------------------------------------------
// Claude subprocess helper (shared by distill.js + skill-evolution.js)
// ---------------------------------------------------------
/**
 * Historical name: now this helper calls the configured distill model,
 * not necessarily Haiku.
 */
function callHaiku(input, extraEnv, timeout, options = {}) {
  return runBackgroundInference(input, extraEnv, timeout, options);
}

/**
 * Historical public name retained for consumers outside this package.
 */
function callDistillModel(input, extraEnv, timeout, options = {}) {
  return runBackgroundInference(input, extraEnv, timeout, options);
}

let backgroundRunner = null;

function getBackgroundRunner() {
  if (backgroundRunner) return backgroundRunner;
  const home = process.env.HOME || os.homedir();
  const getEngineRuntime = createEngineRuntimeFactory({
    HOME: home,
    getActiveProviderEnv: buildDistillEnv,
  });
  backgroundRunner = createBackgroundRunner({ getEngineRuntime });
  return backgroundRunner;
}

function ensureBackgroundCwd() {
  const home = process.env.HOME || os.homedir();
  const cwd = path.join(home, '.metame', 'runtime', 'background-inference');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

function backgroundPrompt(input, purpose) {
  return [
    '[MetaMe background inference]',
    `Purpose: ${String(purpose || 'subconscious-maintenance')}`,
    'Do not call tools, inspect files, browse, or modify external state.',
    'Use only the material contained in this prompt and return the requested answer directly.',
    '',
    String(input || ''),
  ].join('\n');
}

async function runBackgroundInference(input, extraEnv, timeout, options = {}) {
  const config = loadProviders({ force: true });
  const engine = resolveDistillEngine(config, options.engine);
  const model = resolveDistillModelForEngine(config, engine, options.model);
  const runner = options.runner || getBackgroundRunner();
  const result = await runner.startTurn({
    engine,
    model,
    prompt: backgroundPrompt(input, options.purpose),
    cwd: ensureBackgroundCwd(),
    timeoutMs: Number(timeout || 60_000),
    readOnly: true,
    forbidTools: true,
    structured: false,
    allowedTools: [],
    mcpConfig: '',
    providerEnv: { ...(extraEnv || {}) },
    internalPrompt: true,
  });
  if (result.ok) return result.output;
  const err = new Error(result.error || 'background_inference_failed');
  err.code = result.errorCode || 'BACKGROUND_INFERENCE_FAILED';
  throw err;
}

function parseCodexEvents(stdout) {
  return String(stdout || '').trim().split('\n').map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function extractCodexAgentText(stdout) {
  const events = parseCodexEvents(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type !== 'item.completed' || !evt.item || evt.item.type !== 'agent_message') continue;
    const text = evt.item.text
      || (evt.item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (text && text.trim()) return text.trim();
  }
  return '';
}

function extractCodexError(stdout) {
  const events = parseCodexEvents(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type === 'turn.failed' && evt.error && evt.error.message) return String(evt.error.message);
    if (evt.type === 'error' && evt.message) return String(evt.message);
  }
  return '';
}

function extractAgyAgentText(stdout) {
  const events = parseCodexEvents(stdout);
  const texts = events.filter(evt => evt.type === 'text' && evt.text).map(evt => String(evt.text).trim()).filter(Boolean);
  return texts.length ? texts[texts.length - 1] : '';
}

function extractAgyError(stdout) {
  const events = parseCodexEvents(stdout);
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.type === 'error' && evt.message) return String(evt.message);
  }
  return '';
}

// ---------------------------------------------------------
// ENGINE AWARENESS (set by daemon.js setDefaultEngine)
// ---------------------------------------------------------
let _currentEngine = resolveDistillEngine(null, process.env.METAME_DISTILL_ENGINE);
function setEngine(name) { _currentEngine = resolveDistillEngine(null, name); }
function getEngine() { return _currentEngine; }

// ---------------------------------------------------------
const api = {
  loadProviders,
  saveProviders,
  readClaudeSettingsEnv,
  buildEnv,
  buildSpawnEnv,
  buildActiveEnv,
  buildDistillEnv,
  buildDaemonEnv,
  getActiveProvider,
  getActiveName,
  setActive,
  addProvider,
  removeProvider,
  setRole,
  getDistillModel,
  getDistillEngine,
  setDistillModel,
  setDistillEngine,
  normalizeDistillModel,
  listFormatted,
  callDistillModel,
  callHaiku,
  runBackgroundInference,
  _internal: {
    extractCodexAgentText,
    extractCodexError,
    extractAgyAgentText,
    extractAgyError,
    resolveDistillEngine,
    resolveDistillModelForEngine,
    backgroundPrompt,
  },
  getProvidersFilePath,
  setEngine,
  getEngine,
};

Object.defineProperty(api, 'PROVIDERS_FILE', {
  enumerable: true,
  get: () => getProvidersFilePath(),
});

// EXPORTS
// ---------------------------------------------------------
module.exports = api;
