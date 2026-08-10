#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HOST_NAMES, inspectHosts, planInstall } = require('./core/cognitive-host');

function probeServer(serverPath, { probeScript = path.join(__dirname, 'metame-mcp-stdio-probe.mjs') } = {}) {
  const result = spawnSync(process.execPath, [probeScript, serverPath], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return {
      reachable: false,
      tools: [],
      error: { code: result.error?.code || 'MCP_PROBE_FAILED', message: result.error?.message || 'MCP probe failed' },
    };
  }
  try {
    const payload = JSON.parse(String(result.stdout || '').trim());
    return {
      reachable: !!payload.reachable,
      tools: Array.isArray(payload.tools) ? payload.tools : [],
      protocol_version: payload.protocol_version || null,
      server_info: payload.server_info || null,
      server_capabilities: payload.server_capabilities || {},
      client_verified: payload.client_verified === true,
      protocol_verified: payload.protocol_verified === true,
      error: payload.error || null,
    };
  } catch {
    return {
      reachable: false,
      tools: [],
      error: { code: 'MCP_PROBE_OUTPUT_INVALID', message: 'MCP probe returned invalid JSON' },
    };
  }
}

function render(hosts) {
  const lines = ['MetaMe cognitive host status'];
  for (const host of hosts) {
    const unsupported = host.capabilities && host.capabilities.mcp === 'unsupported';
    const icon = unsupported ? '○' : host.verified ? '✓' : host.reachable ? '△' : '✗';
    lines.push(`${icon} ${host.host}: ${host.state}`);
    for (const [name, state] of Object.entries(host.capabilities)) lines.push(`  - ${name}: ${state}`);
    const missingTools = Array.isArray(host.missing_tools) ? host.missing_tools : [];
    if (missingTools.length > 0) lines.push(`  - missing_tools: ${missingTools.join(', ')}`);
    if (host.mcp && host.mcp.protocol_version) lines.push(`  - mcp_protocol: ${host.mcp.protocol_version}`);
    if (host.mcp && host.mcp.error) lines.push(`  - mcp_error: ${host.mcp.error.code}`);
  }
  return lines.join('\n');
}

function renderPlan(plan) {
  const lines = [
    `MetaMe cognitive host plan: ${plan.host}`,
    `  status: ${plan.status}`,
    `  mode: ${plan.mode}`,
    `  reversible: ${plan.reversible ? 'yes' : 'no'}`,
    `  requires_authorization: ${plan.requires_authorization ? 'yes' : 'no'}`,
  ];
  if (plan.config_file) lines.push(`  config_file: ${plan.config_file}`);
  if (plan.reason) lines.push(`  reason: ${plan.reason}`);
  for (const change of plan.changes || []) {
    lines.push(`  - ${change.action} ${change.target} (${change.entry})`);
    lines.push(`    rollback: ${change.rollback}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const planIndex = argv.includes('--plan') ? argv.indexOf('--plan') : argv.indexOf('--repair');
  if (planIndex >= 0) {
    const host = argv[planIndex + 1];
    if (!host) throw new Error('--plan requires a host name');
    const plan = planInstall(host, { home: os.homedir(), cwd: process.cwd(), fs });
    console.log(argv.includes('--json') ? JSON.stringify(plan, null, 2) : renderPlan(plan));
    process.exitCode = plan.supported ? 0 : 1;
    return plan;
  }
  const hosts = inspectHosts({
    fs,
    home: os.homedir(),
    cwd: process.cwd(),
    probeServer,
    hosts: HOST_NAMES,
  });
  console.log(argv.includes('--json') ? JSON.stringify({ hosts }, null, 2) : render(hosts));
  const applicable = hosts.filter(host => host.capabilities.mcp !== 'unsupported');
  process.exitCode = applicable.every(host => host.verified) ? 0 : 1;
  return hosts;
}

if (require.main === module) main();

module.exports = { main, probeServer, render, renderPlan };
