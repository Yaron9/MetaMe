'use strict';

const crypto = require('crypto');
const path = require('path');

const ADAPTER_IDS = Object.freeze(new Set(['cargo_clean', 'brew_cleanup']));

function validateAdapterCandidate(candidate, { home }) {
  if (!candidate || candidate.execution_mode !== 'native_adapter') return { ok: false, reason: 'not-native-adapter' };
  if (!ADAPTER_IDS.has(candidate.adapter_id)) return { ok: false, reason: 'adapter-not-allowlisted' };
  if (candidate.active_guard) return { ok: false, reason: 'active-guard' };
  if (candidate.adapter_id === 'cargo_clean') {
    if (candidate.rule_id !== 'rust-target' || !candidate.project_root) return { ok: false, reason: 'invalid-cargo-candidate' };
    if (path.resolve(candidate.path) !== path.join(path.resolve(candidate.project_root), 'target')) {
      return { ok: false, reason: 'cargo-target-mismatch' };
    }
  }
  if (candidate.adapter_id === 'brew_cleanup') {
    const expected = path.join(home, 'Library', 'Caches', 'Homebrew');
    if (candidate.rule_id !== 'homebrew-cache' || path.resolve(candidate.path) !== expected) {
      return { ok: false, reason: 'homebrew-cache-mismatch' };
    }
  }
  return { ok: true };
}

function adapterInvocation(item, phase) {
  if (item.adapter_id === 'cargo_clean') {
    const manifest = path.join(item.project_root, 'Cargo.toml');
    if (phase === 'preview') {
      return { command: 'cargo', args: ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', manifest] };
    }
    if (phase === 'execute') return { command: 'cargo', args: ['clean', '--manifest-path', manifest] };
  }
  if (item.adapter_id === 'brew_cleanup') {
    if (phase === 'preview') return { command: 'brew', args: ['cleanup', '--dry-run'] };
    if (phase === 'execute') return { command: 'brew', args: ['cleanup'] };
  }
  return null;
}

function preflightEvidence(invocation, stdout, nowMs) {
  return {
    command: invocation.command,
    args: invocation.args.slice(),
    output_hash: sha256(normalizeOutput(stdout)),
    completed_at: new Date(nowMs).toISOString(),
  };
}

function preflightMatches(evidence, invocation, stdout) {
  if (!evidence || !invocation) return false;
  return evidence.command === invocation.command
    && JSON.stringify(evidence.args) === JSON.stringify(invocation.args)
    && evidence.output_hash === sha256(normalizeOutput(stdout));
}

function normalizeOutput(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  ADAPTER_IDS,
  validateAdapterCandidate,
  adapterInvocation,
  preflightEvidence,
  preflightMatches,
  _internal: { normalizeOutput, sha256 },
};
