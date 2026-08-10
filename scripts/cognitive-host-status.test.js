'use strict';

require('./test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { probeServer, render } = require('./cognitive-host-status');

test('probeServer verifies the real MetaMe MCP tool contract', () => {
  const probe = probeServer(path.join(__dirname, 'metame-mcp-server.js'));
  assert.equal(probe.reachable, true);
  for (const required of ['memory_search', 'memory_get', 'memory_feedback', 'profile_get', 'skill_list']) {
    assert.ok(probe.tools.includes(required), `missing ${required}`);
  }
});

test('render exposes host state and missing capabilities', () => {
  const text = render([{
    host: 'codex', state: 'configured', reachable: false, verified: false,
    capabilities: {
      runtime: 'detected', session_source: 'detected', mcp: 'configured',
      automatic_context: 'detected', outcome_feedback: 'configured',
      mcp_access: 'configured',
    }, missing_tools: ['memory_feedback'],
    mcp: { protocol_version: null, error: { code: 'CONNECTION_CLOSED' } },
  }]);
  assert.match(text, /codex: configured/);
  assert.match(text, /runtime: detected/);
  assert.match(text, /session_source: detected/);
  assert.match(text, /automatic_context: detected/);
  assert.match(text, /outcome_feedback: configured/);
  assert.match(text, /memory_feedback/);
  assert.match(text, /mcp_error: CONNECTION_CLOSED/);
});
