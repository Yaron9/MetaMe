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

const DEFAULT_DISTILL_MODEL = 'haiku';
const DISTILL_MODEL_ALIASES = new Map([
  ['5.1mini', 'gpt-5.1-codex-mini'],
  ['gpt5.1mini', 'gpt-5.1-codex-mini'],
  ['gpt-5.1-mini', 'gpt-5.1-codex-mini'],
  ['gpt5.1-codex-mini', 'gpt-5.1-codex-mini'],
  ['codex-mini', 'gpt-5.1-codex-mini'],
  ['5mini', 'gpt-5-mini'],
  ['gpt5mini', 'gpt-5-mini'],
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
  if (!/^[a-zA-Z0-9._-]{2,80}$/.test(normalized)) {
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
    _providersCache = {
      active: data.active || 'anthropic',
      providers: data.providers,
      distill_provider: data.distill_provider || null,
      daemon_provider: data.daemon_provider || null,
      distill_model: (() => {
        try { return normalizeDistillModel(data.distill_model, { allowEmpty: true }); } catch { return null; }
      })(),
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
 * Build env var overrides for a named provider.
 * Returns {} for 'anthropic' (official) — use Claude Code defaults.
 * Returns { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY } for relays.
 */
function buildEnv(providerName) {
  const config = loadProviders();
  const name = providerName || config.active;

  if (name === 'anthropic') return {};

  const provider = config.providers[name];
  if (!provider) return {};

  const env = {};
  if (provider.base_url) env.ANTHROPIC_BASE_URL = provider.base_url;
  if (provider.api_key) env.ANTHROPIC_API_KEY = provider.api_key;
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

function setDistillModel(model) {
  const config = loadProviders();
  const normalized = normalizeDistillModel(model, { allowEmpty: true });
  config.distill_model = normalized || null;
  saveProviders(config);
  return config.distill_model;
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
  return callDistillModel(input, extraEnv, timeout, options);
}

/**
 * Call distill model as a subprocess with extra env vars.
 * Engine-aware: claude uses `claude -p --model`, codex uses `codex exec --json -m`.
 */
function callDistillModel(input, extraEnv, timeout, options = {}) {
  const { execFile } = require('child_process');
  const env = { ...process.env, ...extraEnv, METAME_INTERNAL_PROMPT: '1' };
  delete env.CLAUDECODE;
  // Force refresh to pick up cross-process edits to providers.yaml immediately.
  const config = loadProviders({ force: true });
  const model = resolveDistillModel(config, options.model);
  const engine = options.engine || _currentEngine;
  const bin = engine === 'codex' ? 'codex' : 'claude';
  const args = engine === 'codex'
    ? ['exec', '--json', '-m', model, '--full-auto', '-']
    : ['-p', '--model', model, '--no-session-persistence'];
  // On Windows, bare binary names need shell:true to resolve .cmd wrappers.
  // For codex, also sanitize CODEX_HOME if it points to a non-existent path.
  const isWin = process.platform === 'win32';
  if (isWin && engine === 'codex' && env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) {
    delete env.CODEX_HOME;
  }
  const spawnOpts = {
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    ...(isWin ? { shell: process.env.COMSPEC || true, windowsHide: true } : {}),
  };
  return new Promise((resolve, reject) => {
    const proc = execFile(
      bin, args,
      spawnOpts,
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || '').trim().split('\n')[0];
          err.message = detail || err.message;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          // codex --json outputs JSON lines; extract agent message text
          if (engine === 'codex') {
            try {
              const lines = stdout.trim().split('\n');
              for (let i = lines.length - 1; i >= 0; i--) {
                const evt = JSON.parse(lines[i]);
                if (evt.type === 'item.completed' && evt.item && evt.item.type === 'agent_message') {
                  // item.text (string) is the primary field; content[] is an alternative format
                  const text = evt.item.text
                    || (evt.item.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
                  if (text && text.trim()) { resolve(text.trim()); return; }
                }
              }
            } catch { /* fall through */ }
          }
          resolve(stdout.trim());
        }
      },
    );
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------
// ENGINE AWARENESS (set by daemon.js setDefaultEngine)
// ---------------------------------------------------------
let _currentEngine = process.env.METAME_ENGINE === 'codex' ? 'codex' : 'claude';
function setEngine(name) { _currentEngine = (name === 'codex') ? 'codex' : 'claude'; }
function getEngine() { return _currentEngine; }

// ---------------------------------------------------------
const api = {
  loadProviders,
  saveProviders,
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
  setDistillModel,
  normalizeDistillModel,
  listFormatted,
  callDistillModel,
  callHaiku,
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
