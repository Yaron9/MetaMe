'use strict';

require('../test-support/env-setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  REQUIRED_TOOLS,
  inspectHosts,
  inspectCapabilityMatrix,
  planInstall,
} = require('./cognitive-host');

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

test('capability matrix keeps runtime, session source, MCP, context and feedback independent', () => {
  const { home, cwd } = fixture();
  fs.mkdirSync(path.join(home, '.pi'), { recursive: true });
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  const hosts = inspectCapabilityMatrix({ fs, home, cwd, probeServer: () => ({ reachable: false, tools: [] }) });
  const byHost = Object.fromEntries(hosts.map(host => [host.host, host]));

  assert.equal(byHost.claude.capabilities.runtime, 'detected');
  assert.equal(byHost.claude.capabilities.session_source, 'detected');
  assert.equal(byHost.claude.capabilities.mcp, 'missing');
  assert.equal(byHost.claude.capabilities.automatic_context, 'detected');
  assert.equal(byHost.claude.capabilities.outcome_feedback, 'missing');
  assert.equal(byHost.pi.capabilities.mcp, 'unsupported');
  assert.equal(byHost.pi.capabilities.outcome_feedback, 'unsupported');
  assert.equal(byHost.agy.capabilities.session_source, 'unsupported');
  assert.equal(byHost.limited.capabilities.runtime, 'unsupported');
  fs.rmSync(home, { recursive: true, force: true });
});

test('planInstall is explicit, reversible and never mutates Host configuration', () => {
  const { home, cwd } = fixture();
  const configFile = path.join(home, '.codex', 'config.toml');
  const before = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : null;
  const plan = planInstall('codex', { fs, home, cwd, serverPath: '/tmp/metame-mcp-server.js' });
  assert.equal(plan.status, 'planned');
  assert.equal(plan.mode, 'plan-only');
  assert.equal(plan.applied, false);
  assert.equal(plan.reversible, true);
  assert.equal(plan.requires_authorization, true);
  assert.equal(fs.existsSync(configFile), before !== null);
  if (before !== null) assert.equal(fs.readFileSync(configFile, 'utf8'), before);

  const unsupported = planInstall('pi', { fs, home, cwd });
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.reason, 'host_mcp_unsupported');
  assert.deepEqual(unsupported.changes, []);
  fs.rmSync(home, { recursive: true, force: true });
});
