'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createExternalAdapterPlugin } = require('./external-adapter-plugin');
const { runEnginePluginConformance } = require('./engine-plugin');

const FIXTURE = path.join(__dirname, 'fixtures', 'external-adapter-cli.js');
const OPERATIONS = ['probe', 'run', 'cancel', 'session.discover', 'session.inspect', 'session.read', 'shutdown'];

function createFixturePlugin() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-external-plugin-'));
  const manifest = {
    protocolVersion: 1,
    engineId: 'fixture-external',
    displayName: 'Fixture External Agent',
    vendor: 'metame-test',
    executable: { path: process.execPath, args: [FIXTURE] },
    allowlistedPaths: [process.execPath],
    allowedProjects: [cwd],
    capabilities: Object.fromEntries(OPERATIONS.map(operation => [operation, true])),
  };
  return { cwd, plugin: createExternalAdapterPlugin({ manifest, projectCwd: cwd }) };
}

test('fixture external adapter runs through Engine Plugin and Session Source seams', async () => {
  const { cwd, plugin } = createFixturePlugin();
  try {
    const conformance = runEnginePluginConformance(plugin);
    assert.equal(conformance.ok, true);
    assert.equal(plugin.descriptor.id, 'fixture-external');
    assert.equal(plugin.runtime !== null, true);
    assert.equal(plugin.sessionSource !== null, true);
    await plugin.runtime.probe({ cwd });
    const events = [];
    const run = await plugin.runtime.run({ input: 'plugin run', runId: 'plugin-run' }, { events });
    assert.equal(run.output, 'fixture:plugin run');
    assert.equal(plugin.runtime.parseEvent({
      type: 'event', operation: 'run', correlationId: 'event-1',
      event: { type: 'message_delta', text: 'event' },
    })[0].type, 'message_delta');
    const refs = [];
    for await (const ref of plugin.sessionSource.discover({})) refs.push(ref);
    assert.equal(refs.length, 1);
    const revision = await plugin.sessionSource.inspect(refs[0]);
    assert.equal(revision.sourceRevision.length > 0, true);
    const canonical = [];
    for await (const event of plugin.sessionSource.read(refs[0], { sourceRevision: revision.sourceRevision })) canonical.push(event);
    assert.deepEqual(canonical.map(event => event.actor), ['user', 'assistant']);
    assert.ok(canonical.every(event => event.version === 1 && event.engineId === 'fixture-external'));
    assert.equal((await plugin.sessionSource.validate(refs[0])).valid, true);
    await plugin.runtime.shutdown();
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('external plugin can intentionally expose only an unsupported capability set', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-external-plugin-source-'));
  try {
    const plugin = createExternalAdapterPlugin({
      projectCwd: cwd,
      manifest: {
        protocolVersion: 1,
        engineId: 'fixture-source-only',
        executable: { path: process.execPath, args: [FIXTURE] },
        allowlistedPaths: [process.execPath],
        allowedProjects: [cwd],
        capabilities: Object.fromEntries(OPERATIONS.map(operation => [operation, false])),
      },
    });
    assert.equal(plugin.runtime, null);
    assert.equal(plugin.sessionSource, null);
    assert.equal(plugin.descriptor.capabilities.runtime.supported, false);
    assert.equal(plugin.descriptor.capabilities.sessionSource.supported, false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
