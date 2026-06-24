'use strict';

const { spawn } = require('child_process');
const { runAsyncCommand, createPlatformSpawn } = require('./core/handoff');

function normalizeChecks(spec = {}) {
  const source = Array.isArray(spec.commands)
    ? spec.commands
    : (spec.command ? [{ command: spec.command }] : []);
  return source.map((item, index) => {
    if (typeof item === 'string') return { name: `check-${index + 1}`, command: item };
    return {
      name: String(item.name || `check-${index + 1}`),
      command: String(item.command || ''),
      timeoutMs: Number(item.timeout_ms || item.timeoutMs) || 300000,
    };
  }).filter(item => item.command);
}

function createDeterministicVerifier(deps = {}) {
  const runCommand = deps.runCommand || runAsyncCommand;
  const spawnProcess = deps.spawn || createPlatformSpawn({
    fs: deps.fs || require('fs'),
    path: deps.path || require('path'),
    spawn,
    execSync: deps.execSync || require('child_process').execSync,
  }).spawn;
  const platform = deps.platform || process.platform;

  async function verify(options = {}) {
    const checks = normalizeChecks(options.spec);
    if (checks.length === 0) throw new Error('verification_commands_required');
    const protectedPaths = Array.isArray(options.spec && options.spec.protected_paths)
      ? options.spec.protected_paths.map(String).filter(Boolean)
      : [];
    const baseRevision = String(options.baseRevision || '');
    if (protectedPaths.length > 0 && /^[a-f0-9]{7,64}$/i.test(baseRevision)) {
      const integrity = await runCommand({
        spawn: spawnProcess,
        cmd: 'git',
        args: ['diff', '--name-only', baseRevision, '--', ...protectedPaths],
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        timeoutMs: 30000,
        useProcessGroup: platform !== 'win32',
        signal: options.signal || null,
        maxStdoutBytes: 64 * 1024,
      });
      const modified = String(integrity.output || '').trim();
      if (integrity.error || modified) {
        return {
          passed: false,
          checks: ['verifier_integrity'],
          failures: [integrity.error || `verifier_modified:${modified}`],
          evidence: [{ name: 'verifier_integrity', modified_paths: modified.split('\n').filter(Boolean) }],
          retryable: false,
          infra_failure: !!integrity.error,
          verifier_modified: !!modified,
        };
      }
    }
    const evidence = [];
    const failures = [];
    let infraFailure = false;
    for (const check of checks) {
      const shell = platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
      const args = platform === 'win32' ? ['/d', '/s', '/c', check.command] : ['-lc', check.command];
      const result = await runCommand({
        spawn: spawnProcess,
        cmd: shell,
        args,
        cwd: options.cwd,
        env: { ...process.env, ...(options.env || {}) },
        timeoutMs: check.timeoutMs,
        useProcessGroup: platform !== 'win32',
        signal: options.signal || null,
        maxStdoutBytes: 256 * 1024,
        maxStderrBytes: 256 * 1024,
        stdoutBufferMode: 'tail',
      });
      const passed = !result.error;
      evidence.push({
        name: check.name,
        command: check.command,
        passed,
        output: String(result.output || '').slice(-4000),
        error: result.error || null,
      });
      if (!passed) {
        failures.push(`${check.name}: ${result.error}`);
        if (result.errorCode === 'INTERRUPTED' || result.errorCode === 'TIMEOUT') infraFailure = true;
        break;
      }
    }
    return {
      passed: failures.length === 0,
      checks: evidence.map(item => item.name),
      failures,
      evidence,
      retryable: failures.length > 0,
      infra_failure: infraFailure,
    };
  }

  return { verify };
}

module.exports = { createDeterministicVerifier, _internal: { normalizeChecks } };
