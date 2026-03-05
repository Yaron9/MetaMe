'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

  it('defaults to haiku when distill_model is empty', () => {
    const providers = loadProvidersWithHome(tmpHome);
    assert.equal(providers.getDistillModel(), 'haiku');
  });

  it('normalizes common aliases and persists model', () => {
    const providers = loadProvidersWithHome(tmpHome);
    providers.setDistillModel('5.1mini');
    assert.equal(providers.getDistillModel(), 'gpt-5.1-codex-mini');

    delete require.cache[require.resolve('./providers')];
    const providersReloaded = require('./providers');
    assert.equal(providersReloaded.getDistillModel(), 'gpt-5.1-codex-mini');
  });

  it('rejects malformed model name', () => {
    const providers = loadProvidersWithHome(tmpHome);
    assert.throws(() => providers.setDistillModel('gpt@5mini'), /无效蒸馏模型/);
  });
});
