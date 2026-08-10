'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createEnginePlugin } = require('./engine-plugin');
const { createEngineRegistry, createDefaultEngineRegistry } = require('./engine-registry');
const { inspectHosts, planInstall, verifyHost } = require('../core/cognitive-host');

test('built-in Engine Plugins source Cognitive Host capability from the registry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-context-host-'));
  const registry = createDefaultEngineRegistry({ HOME: home, fs, path });
  const codex = registry.lookup('codex');
  assert.equal(codex.descriptor.capabilities.cognitiveHost.state, 'verified');
  assert.equal(typeof codex.cognitiveHost.detect, 'function');
  assert.equal(typeof codex.cognitiveHost.projectContext, 'function');
  assert.deepEqual(registry.lookup('pi').descriptor.capabilities.cognitiveHost, { state: 'unsupported' });
  assert.equal(registry.lookup('pi').cognitiveHost, null);
  assert.deepEqual(
    codex.cognitiveHost.projectContext({ manifest: { revision: 'rev-1' }, phase: 'cold_start' }),
    { state: 'projected', phase: 'cold_start', fingerprint: 'codex:rev-1' },
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('a fixture Cognitive Host is inspected through the registry without a core host branch', () => {
  const report = { host: 'fixture', capabilities: { automatic_context: 'verified' } };
  const fixture = createEnginePlugin({
    protocolVersion: 1,
    descriptor: {
      id: 'fixture', displayName: 'Fixture', vendor: 'test', executableNames: ['fixture'],
      contextProjection: 'mcp', nativeSessionKind: 'none', configSchemaVersion: 1,
      capabilities: {
        runtime: { state: 'unsupported' }, sessionSource: { state: 'unsupported' },
        cognitiveHost: { state: 'verified' },
      },
    },
    runtime: null,
    sessionSource: null,
    cognitiveHost: {
      detect: () => report,
      inspectCapabilities: () => report,
      planInstall: () => ({ supported: true }),
      verify: () => ({ ok: true }),
      projectContext: () => ({ state: 'projected', fingerprint: 'fixture:revision' }),
    },
  });
  const registry = createEngineRegistry([fixture]);
  assert.deepEqual(inspectHosts({ registry, hosts: ['fixture'] }), [report]);
  assert.deepEqual(planInstall('fixture', { registry }), { supported: true });
  assert.deepEqual(verifyHost('fixture', { registry }), { ok: true });
});
