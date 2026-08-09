'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REQUIRED_TOOLS, inspectHosts } = require('./cognitive-host');

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cognitive-host-'));
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(home, '.metame'), { recursive: true });
  fs.writeFileSync(path.join(home, '.metame', 'metame-mcp-server.js'), '// fixture');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# context');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# context');
  fs.writeFileSync(path.join(home, '.codex', 'state_5.sqlite'), 'fixture');
  return { home, cwd };
}

test('inspectHosts verifies Claude and Codex through one capability contract', () => {
  const { home, cwd } = fixture();
  const server = path.join(home, '.metame', 'metame-mcp-server.js');
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { metame: { command: 'node', args: [server] } } }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[mcp_servers.metame]\ncommand = "node"\nargs = ["${server}"]\n`);
  const hosts = inspectHosts({ fs, home, cwd, probeServer: () => ({ reachable: true, tools: REQUIRED_TOOLS }) });
  assert.deepEqual(hosts.map(host => host.state), ['verified', 'verified']);
  assert.ok(hosts.every(host => host.capabilities.outcome_feedback === 'verified'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('inspectHosts distinguishes configured-unreachable and partial contracts', () => {
  const { home, cwd } = fixture();
  const server = path.join(home, '.metame', 'metame-mcp-server.js');
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { metame: { command: 'node', args: [server] } } }));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), `[mcp_servers.metame]\ncommand = "node"\nargs = ["${server}"]\n`);
  const hosts = inspectHosts({
    fs, home, cwd,
    probeServer: () => ({ reachable: true, tools: ['memory_search'] }),
  });
  assert.ok(hosts.every(host => host.state === 'reachable'));
  assert.ok(hosts.every(host => host.capabilities.mcp_access === 'partial'));
  assert.ok(hosts.every(host => host.missing_tools.includes('memory_get')));
  fs.rmSync(home, { recursive: true, force: true });
});

test('inspectHosts is read-only when registrations are absent', () => {
  const { home, cwd } = fixture();
  const before = fs.readdirSync(cwd);
  const hosts = inspectHosts({ fs, home, cwd });
  assert.deepEqual(hosts.map(host => host.state), ['detected', 'detected']);
  assert.deepEqual(fs.readdirSync(cwd), before);
  fs.rmSync(home, { recursive: true, force: true });
});
