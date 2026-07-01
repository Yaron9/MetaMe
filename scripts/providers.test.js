'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('./resolve-yaml');

function loadProvidersWithHome(home) {
  process.env.HOME = home;
  delete require.cache[require.resolve('./providers')];
  return require('./providers');
}

describe('providers distill model config', () => {
  const oldHome = process.env.HOME;
  let tmpHome = '';

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-providers-'));
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    delete require.cache[require.resolve('./providers')];
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('defaults background distill to agy/auto when distill_model is empty', () => {
    const providers = loadProvidersWithHome(tmpHome);
    assert.equal(providers.getDistillEngine(), 'agy');
    assert.equal(providers.getDistillModel(), 'auto');
  });

  it('treats agy as the auto model alias for background distill', () => {
    const providers = loadProvidersWithHome(tmpHome);
    providers.setDistillModel('agy');
    assert.equal(providers.getDistillModel(), 'auto');
  });

  it('normalizes common aliases and persists model', () => {
    const providers = loadProvidersWithHome(tmpHome);
    providers.setDistillModel('5.1mini');
    assert.equal(providers.getDistillModel(), 'gpt-5.1-codex-mini');

    delete require.cache[require.resolve('./providers')];
    const providersReloaded = require('./providers');
    assert.equal(providersReloaded.getDistillModel(), 'gpt-5.1-codex-mini');
  });

  it('reloads distill model after external providers.yaml change', () => {
    const providers = loadProvidersWithHome(tmpHome);
    providers.setDistillModel('haiku');
    const cfgPath = providers.PROVIDERS_FILE;
    const cfg = yaml.load(fs.readFileSync(cfgPath, 'utf8')) || {};
    cfg.distill_engine = 'codex';
    cfg.distill_model = 'gpt-5-mini';
    fs.writeFileSync(cfgPath, yaml.dump(cfg, { lineWidth: -1 }), 'utf8');
    const bumped = new Date(Date.now() + 1500);
    fs.utimesSync(cfgPath, bumped, bumped);
    assert.equal(providers.getDistillModel(), 'gpt-5-mini');
  });

  it('migrates legacy Claude/Codex distill model config to agy auto when engine is absent', () => {
    const providers = loadProvidersWithHome(tmpHome);
    const metameDir = path.join(tmpHome, '.metame');
    fs.mkdirSync(metameDir, { recursive: true });
    fs.writeFileSync(path.join(metameDir, 'providers.yaml'), yaml.dump({
      active: 'anthropic',
      providers: { anthropic: { label: 'Anthropic (Official)' } },
      distill_model: 'haiku',
    }), 'utf8');
    assert.equal(providers.getDistillEngine(), 'agy');
    assert.equal(providers.getDistillModel(), 'auto');
  });

  it('maps legacy per-call model overrides to auto for agy execution', () => {
    const providers = loadProvidersWithHome(tmpHome);
    assert.equal(providers._internal.resolveDistillModelForEngine({}, 'agy', 'sonnet'), 'auto');
    assert.equal(providers._internal.resolveDistillModelForEngine({}, 'agy', 'gpt-5.1-codex-mini'), 'auto');
    assert.equal(providers._internal.resolveDistillModelForEngine({}, 'codex', 'gpt-5.1-codex-mini'), 'gpt-5.1-codex-mini');
  });

  it('rejects malformed model name', () => {
    const providers = loadProvidersWithHome(tmpHome);
    assert.throws(() => providers.setDistillModel('gpt@5mini'), /无效蒸馏模型/);
  });

  it('parses Codex JSONL agent output and failure details', () => {
    const providers = loadProvidersWithHome(tmpHome);
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
    ].join('\n');
    const failure = JSON.stringify({ type: 'turn.failed', error: { message: 'model is not supported' } });
    assert.equal(providers._internal.extractCodexAgentText(stdout), 'done');
    assert.equal(providers._internal.extractCodexError(failure), 'model is not supported');
  });

  it('parses agy adapter JSONL output and failure details', () => {
    const providers = loadProvidersWithHome(tmpHome);
    const stdout = [
      JSON.stringify({ type: 'session', session_id: 'a1' }),
      JSON.stringify({ type: 'text', text: 'agy done' }),
      JSON.stringify({ type: 'done' }),
    ].join('\n');
    const failure = JSON.stringify({ type: 'error', code: 'AGY_AUTH_REQUIRED', message: 'login required' });
    assert.equal(providers._internal.extractAgyAgentText(stdout), 'agy done');
    assert.equal(providers._internal.extractAgyError(failure), 'login required');
  });

  it('inherits Claude Code env mapping from ~/.claude/settings.json', () => {
    const providers = loadProvidersWithHome(tmpHome);
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'token-1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.1',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.1',
      },
    }), 'utf8');

    assert.deepEqual(providers.readClaudeSettingsEnv(), {
      ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'token-1',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M2.1',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M2.1',
    });

    const env = providers.buildEnv('anthropic');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.minimaxi.com/anthropic');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'token-1');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'MiniMax-M2.1');
  });

  it('overrides Claude Code auth endpoint with custom provider while keeping slot mapping env', () => {
    const providers = loadProvidersWithHome(tmpHome);
    const claudeDir = path.join(tmpHome, '.claude');
    const metameDir = path.join(tmpHome, '.metame');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(metameDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'token-1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M2.1',
      },
    }), 'utf8');
    fs.writeFileSync(path.join(metameDir, 'providers.yaml'), yaml.dump({
      active: 'relay',
      providers: {
        anthropic: { label: 'Anthropic (Official)' },
        relay: { label: 'relay', base_url: 'https://relay.example.com/anthropic', api_key: 'relay-key' },
      },
    }), 'utf8');

    const env = providers.buildEnv('relay');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://relay.example.com/anthropic');
    assert.equal(env.ANTHROPIC_API_KEY, 'relay-key');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'relay-key');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'MiniMax-M2.1');
  });
});
