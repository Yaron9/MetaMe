'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createExternalAdapterClient,
  buildMinimalEnvironment,
  normalizeExternalAdapterManifest,
  resolveExternalAdapterExecutable,
} = require('./external-adapter-client');

const FIXTURE = path.join(__dirname, 'fixtures', 'external-adapter-cli.js');
const OPERATIONS = ['probe', 'run', 'cancel', 'session.discover', 'session.inspect', 'session.read', 'shutdown'];

function fixture(options = {}) {
  const cwd = options.cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'metame-external-adapter-'));
  const capabilities = Object.fromEntries(OPERATIONS.map(operation => [operation, options.capabilities
    ? options.capabilities[operation] === true
    : true]));
  const envAllowlist = options.envAllowlist || [];
  const baseEnv = {
    ...process.env,
    ...(options.unsupported ? { METAME_FIXTURE_UNSUPPORTED: options.unsupported } : {}),
    ...(options.engineId ? { METAME_FIXTURE_ENGINE_ID: options.engineId } : {}),
    ...(options.protocolVersion ? { METAME_FIXTURE_PROTOCOL_VERSION: String(options.protocolVersion) } : {}),
  };
  const manifest = {
    protocolVersion: 1,
    engineId: 'fixture-external',
    executable: { path: process.execPath, args: [FIXTURE] },
    allowlistedPaths: [process.execPath],
    allowedProjects: [cwd],
    environmentAllowlist: envAllowlist,
    capabilities,
  };
  const client = createExternalAdapterClient({ manifest, projectCwd: cwd, baseEnv });
  return { client, cwd, manifest };
}

function cleanup(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

test('external client negotiates, runs, and exposes revisioned session operations', async () => {
  const { client, cwd } = fixture();
  try {
    const handshake = await client.start();
    assert.equal(handshake.protocolVersion, 1);
    assert.equal(handshake.capabilities.run, true);
    assert.deepEqual(await client.probe(), { state: 'verified', available: true, reachable: true, verified: true });
    const events = [];
    const run = await client.run({ input: 'hello external', runId: 'run-1' }, { events });
    assert.equal(run.output, 'fixture:hello external');
    assert.equal(events.at(-1).type, 'run_completed');
    const refs = await client.sessionDiscover();
    assert.equal(refs.length, 1);
    const revision = await client.sessionInspect(refs[0]);
    assert.match(revision.sourceRevision, /^fixture_[a-f0-9]+$/);
    const read = await client.sessionRead(refs[0], { sourceRevision: revision.sourceRevision });
    assert.deepEqual(read.map(event => event.actor), ['user', 'assistant']);
    assert.deepEqual((await client.shutdown()).response, { shuttingDown: true });
  } finally {
    cleanup(cwd);
  }
});

test('request keeps client correlation ownership when probe payload contains a correlationId', async () => {
  const records = [];
  const { client, cwd } = fixture();
  client.onRecord = record => records.push(record);
  try {
    await client.start();
    const response = await client.request('probe', { correlationId: 'payload-spoof' }, {
      correlationId: 'client-probe',
    });
    assert.deepEqual(response, { state: 'verified', available: true, reachable: true, verified: true });
    assert.equal(records.at(-1).correlationId, 'client-probe');
    assert.equal(client.pending.size, 0);
  } finally {
    await client.close();
    cleanup(cwd);
  }
});

test('unsupported operations are explicit and do not emulate capability', async () => {
  const { client, cwd } = fixture({ unsupported: 'session.inspect', envAllowlist: ['METAME_FIXTURE_UNSUPPORTED'] });
  try {
    await client.start();
    await assert.rejects(() => client.sessionInspect({ nativeSessionId: 'missing' }), error => error.code === 'CAPABILITY_UNSUPPORTED');
    await client.shutdown();
  } finally {
    cleanup(cwd);
  }
});

test('handshake version mismatch is isolated as a diagnostic boundary failure', async () => {
  const { client, cwd } = fixture({ protocolVersion: 2, envAllowlist: ['METAME_FIXTURE_PROTOCOL_VERSION'] });
  try {
    await assert.rejects(() => client.start(), error => error.code === 'PROTOCOL_VERSION_MISMATCH');
  } finally {
    await client.close();
    cleanup(cwd);
  }
});

test('installation, allowlisting, cwd, and environment boundaries are enforced', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-external-security-'));
  try {
    assert.throws(() => normalizeExternalAdapterManifest({
      protocolVersion: 1, engineId: 'fixture-external', unexpected: true,
    }), /EXTERNAL_ADAPTER_MANIFEST_PROPERTY_UNKNOWN/);
    assert.throws(() => normalizeExternalAdapterManifest({
      protocolVersion: 1, engineId: 'fixture-external', executablePath: process.execPath,
      allowlistedPaths: [], capabilities: { run: true },
    }), /EXTERNAL_ADAPTER_MANIFEST_INVALID|EXTERNAL_ADAPTER_CAPABILITIES/);
    const { manifest } = fixture({ cwd });
    assert.throws(() => resolveExternalAdapterExecutable({
      ...manifest, executable: { ...manifest.executable, path: path.join(cwd, 'missing') },
    }), /EXTERNAL_ADAPTER_NOT_INSTALLED/);
    assert.throws(() => resolveExternalAdapterExecutable({
      ...manifest, allowlistedPaths: [path.join(cwd, 'not-allowed')],
    }), /EXTERNAL_ADAPTER_NOT_ALLOWLISTED/);
    const env = buildMinimalEnvironment({ PATH: '/bin', SECRET_TOKEN: 'do-not-pass', HOME: '/tmp' });
    assert.deepEqual(env.SECRET_TOKEN, undefined);
    assert.equal(env.PATH, '/bin');
  } finally {
    cleanup(cwd);
  }
});

test('malformed stdout and adapter crashes are isolated with bounded diagnostics', async () => {
  const malformed = fixture();
  try {
    await malformed.client.start();
    await assert.rejects(() => malformed.client.run({ input: 'fixture-malformed' }), error => error.code === 'PROTOCOL_STDOUT_INVALID');
  } finally {
    await malformed.client.close();
    cleanup(malformed.cwd);
  }

  const crashed = fixture();
  try {
    await crashed.client.start();
    await assert.rejects(() => crashed.client.run({ input: 'fixture-crash' }), error => error.code === 'EXTERNAL_ADAPTER_CRASHED');
    const diagnostic = crashed.client.diagnostics();
    assert.doesNotMatch(String(diagnostic.stderr), /fixture-secret/);
    assert.match(String(diagnostic.stderr), /\[REDACTED\]/);
  } finally {
    await crashed.client.close();
    cleanup(crashed.cwd);
  }
});

test('AbortSignal cancellation requests cancellation and cleans up the process tree', async () => {
  const { client, cwd } = fixture();
  try {
    await client.start();
    const controller = new AbortController();
    const pending = client.run({ input: 'fixture-sleep', runId: 'slow-run' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 25).unref();
    await assert.rejects(() => pending, error => error.code === 'EXTERNAL_ADAPTER_CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(client.child, null);
  } finally {
    await client.close();
    cleanup(cwd);
  }
});
