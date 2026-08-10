'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TOOLS } = require('./metame-mcp-server');
const { probeServer } = require('./cognitive-host-status');
const { mkdtempForTest } = require('./test-support/test-utils');

function runServer(lines, entry = path.join(__dirname, 'metame-mcp-server.js')) {
  return spawnSync(process.execPath, [entry], {
    input: `${lines.map(line => JSON.stringify(line)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
}

function responses(output) {
  return String(output || '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

test('official SDK server owns initialize, protocol version and stdio framing', () => {
  const result = runServer([
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: {} } },
  ]);
  assert.equal(result.status, 0, result.stderr);
  const replies = responses(result.stdout);
  const initialized = replies.find(reply => reply.id === 1);
  const listed = replies.find(reply => reply.id === 2);
  const invalid = replies.find(reply => reply.id === 3);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), TOOLS.map(tool => tool.name).sort());
  assert.equal(invalid.result.isError, true);
  assert.match(invalid.result.content[0].text, /required property 'query'/);
});

test('doctor probe uses the official SDK client and verifies server behavior', () => {
  const probe = probeServer(path.join(__dirname, 'metame-mcp-server.js'));
  assert.equal(probe.reachable, true);
  assert.equal(probe.protocol_verified, true);
  assert.equal(probe.client_verified, true);
  assert.equal(probe.protocol_version, '2025-11-25');
  assert.equal(probe.server_info.name, 'metame');
  assert.ok(probe.tools.includes('memory_feedback'));
});

test('no-npm plugin copy starts from its bundled official SDK transport', () => {
  const root = mkdtempForTest('metame-plugin-isolated-');
  const pluginRoot = path.join(root, 'plugin');
  fs.cpSync(path.join(__dirname, '..', 'plugin'), pluginRoot, { recursive: true });
  const entry = path.join(pluginRoot, 'scripts', 'metame-mcp-server.js');
  const result = spawnSync(process.execPath, [entry], {
    input: `${[
      {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'plugin-test', version: '1' } },
      },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map(line => JSON.stringify(line)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, NODE_PATH: '' },
  });
  assert.equal(fs.existsSync(path.join(pluginRoot, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, 'scripts', 'metame-mcp-server-sdk.bundle.mjs')), true);
  assert.equal(result.status, 0, result.stderr);
  const replies = responses(result.stdout);
  assert.equal(replies.find(reply => reply.id === 1).result.protocolVersion, '2025-11-25');
  assert.deepEqual(
    replies.find(reply => reply.id === 2).result.tools.map(tool => tool.name).sort(),
    TOOLS.map(tool => tool.name).sort(),
  );
  const probe = probeServer(entry, {
    probeScript: path.join(pluginRoot, 'scripts', 'metame-mcp-stdio-probe.mjs'),
  });
  assert.equal(probe.reachable, true);
  assert.equal(probe.protocol_verified, true);
  assert.equal(probe.client_verified, true);
});
