'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveScopedEngine, fallbackForUnavailableRuntime } = require('./engine-policy');

describe('scoped engine policy', () => {
  const enabled = { experimental_engines: { agy: { enabled: true, allowed_projects: ['munger', 'digital_me'] } } };

  it('leaves existing engines untouched', () => {
    assert.equal(resolveScopedEngine({ requestedEngine: 'codex', daemonCfg: enabled }).engine, 'codex');
    assert.equal(resolveScopedEngine({ requestedEngine: 'claude', daemonCfg: enabled }).engine, 'claude');
  });

  it('allows agy only for enabled allowlisted projects', () => {
    assert.equal(resolveScopedEngine({ requestedEngine: 'agy', projectKey: 'munger', daemonCfg: enabled }).engine, 'agy');
    const denied = resolveScopedEngine({ requestedEngine: 'agy', projectKey: 'other', project: { fallback_engine: 'codex' }, daemonCfg: enabled });
    assert.deepEqual({ engine: denied.engine, reason: denied.reason }, { engine: 'codex', reason: 'project_not_allowlisted' });
  });

  it('allows agy for the isolated background boundary independently of foreground opt-in', () => {
    const resolved = resolveScopedEngine({ requestedEngine: 'agy', scope: 'background', daemonCfg: {} });
    assert.equal(resolved.engine, 'agy');
    assert.equal(resolved.fallback, false);
  });

  it('falls back deterministically when disabled or unavailable', () => {
    const disabled = resolveScopedEngine({
      requestedEngine: 'agy', projectKey: 'digital_me', project: { fallback_engine: 'claude' }, daemonCfg: {},
    });
    assert.equal(disabled.engine, 'claude');
    const unavailable = fallbackForUnavailableRuntime({ engine: 'agy', requested: 'agy' }, { fallback_engine: 'codex' });
    assert.equal(unavailable.engine, 'codex');
    assert.equal(unavailable.reason, 'agy_unavailable');
  });
});
