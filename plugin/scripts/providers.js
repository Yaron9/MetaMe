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

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const PROVIDERS_FILE = path.join(METAME_DIR, 'providers.yaml');

// Resolve js-yaml (same pattern as daemon.js)
let yaml;
try {
  yaml = require('js-yaml');
} catch {
  const metameRoot = process.env.METAME_ROOT;
  if (metameRoot) {
    try { yaml = require(path.join(metameRoot, 'node_modules', 'js-yaml')); } catch {}
  }
  if (!yaml) {
    const candidates = [
      path.resolve(__dirname, '..', 'node_modules', 'js-yaml'),
      path.resolve(__dirname, 'node_modules', 'js-yaml'),
    ];
    for (const p of candidates) {
      try { yaml = require(p); break; } catch {}
    }
  }
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
  };
}

// ---------------------------------------------------------
// LOAD / SAVE
// ---------------------------------------------------------
function loadProviders() {
  try {
    if (!fs.existsSync(PROVIDERS_FILE)) return defaultConfig();
    const data = yaml.load(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    if (!data || typeof data !== 'object') return defaultConfig();
    // Ensure anthropic always exists
    if (!data.providers) data.providers = {};
    if (!data.providers.anthropic) data.providers.anthropic = { label: 'Anthropic (Official)' };
    return {
      active: data.active || 'anthropic',
      providers: data.providers,
      distill_provider: data.distill_provider || null,
      daemon_provider: data.daemon_provider || null,
    };
  } catch {
    return defaultConfig();
  }
}

function saveProviders(config) {
  if (!fs.existsSync(METAME_DIR)) fs.mkdirSync(METAME_DIR, { recursive: true });
  fs.writeFileSync(PROVIDERS_FILE, yaml.dump(config, { lineWidth: -1 }), 'utf8');
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

  return lines.join('\n');
}

// ---------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------
module.exports = {
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
  listFormatted,
  PROVIDERS_FILE,
};
