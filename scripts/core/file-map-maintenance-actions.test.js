'use strict';

require('../test-support/env-setup');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const actions = require('./file-map-maintenance-actions');

describe('file-map maintenance actions', () => {
  it('accepts only exact, built-in adapter candidates', () => {
    const cargo = {
      execution_mode: 'native_adapter', adapter_id: 'cargo_clean', rule_id: 'rust-target',
      project_root: '/work/app', path: '/work/app/target', active_guard: null,
    };
    assert.equal(actions.validateAdapterCandidate(cargo, { home: '/home/u' }).ok, true);
    assert.equal(actions.validateAdapterCandidate({ ...cargo, path: '/work/other/target' }, { home: '/home/u' }).reason, 'cargo-target-mismatch');
    assert.equal(actions.validateAdapterCandidate({ ...cargo, adapter_id: 'shell' }, { home: '/home/u' }).reason, 'adapter-not-allowlisted');
    const brew = {
      execution_mode: 'native_adapter', adapter_id: 'brew_cleanup', rule_id: 'homebrew-cache',
      path: '/home/u/Library/Caches/Homebrew', active_guard: null,
    };
    assert.equal(actions.validateAdapterCandidate(brew, { home: '/home/u' }).ok, true);
    assert.equal(actions.validateAdapterCandidate({ ...brew, path: '/tmp/Homebrew' }, { home: '/home/u' }).reason, 'homebrew-cache-mismatch');
  });

  it('builds argv arrays without a shell surface', () => {
    assert.deepEqual(actions.adapterInvocation({ adapter_id: 'cargo_clean', project_root: '/work/app' }, 'execute'), {
      command: 'cargo', args: ['clean', '--manifest-path', '/work/app/Cargo.toml'],
    });
    assert.deepEqual(actions.adapterInvocation({ adapter_id: 'brew_cleanup' }, 'preview'), {
      command: 'brew', args: ['cleanup', '--dry-run'],
    });
    assert.equal(actions.adapterInvocation({ adapter_id: 'unknown' }, 'execute'), null);
  });

  it('binds execution to normalized preflight output and exact argv', () => {
    const invocation = { command: 'brew', args: ['cleanup', '--dry-run'] };
    const evidence = actions.preflightEvidence(invocation, 'Would remove A\r\n', Date.parse('2026-07-18T00:00:00Z'));
    assert.equal(actions.preflightMatches(evidence, invocation, 'Would remove A\n'), true);
    assert.equal(actions.preflightMatches(evidence, invocation, 'Would remove B\n'), false);
    assert.equal(actions.preflightMatches(evidence, { ...invocation, args: ['cleanup'] }, 'Would remove A\n'), false);
  });
});
