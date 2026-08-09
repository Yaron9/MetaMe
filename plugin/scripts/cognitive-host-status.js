#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { inspectHosts } = require('./core/cognitive-host');

function probeServer(serverPath) {
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    '',
  ].join('\n');
  const result = spawnSync(process.execPath, [serverPath], { input, encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0 || result.error) return { reachable: false, tools: [] };
  const replies = String(result.stdout || '').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const listed = replies.find(reply => reply.id === 2);
  return {
    reachable: !!listed?.result?.tools,
    tools: (listed?.result?.tools || []).map(tool => tool.name),
  };
}

function render(hosts) {
  const lines = ['MetaMe cognitive host status'];
  for (const host of hosts) {
    lines.push(`${host.verified ? '✓' : host.reachable ? '△' : '✗'} ${host.host}: ${host.state}`);
    for (const [name, state] of Object.entries(host.capabilities)) lines.push(`  - ${name}: ${state}`);
    if (host.missing_tools.length > 0) lines.push(`  - missing_tools: ${host.missing_tools.join(', ')}`);
  }
  return lines.join('\n');
}

function main(argv = process.argv.slice(2)) {
  const hosts = inspectHosts({ fs, home: os.homedir(), cwd: process.cwd(), probeServer });
  console.log(argv.includes('--json') ? JSON.stringify({ hosts }, null, 2) : render(hosts));
  process.exitCode = hosts.every(host => host.verified) ? 0 : 1;
  return hosts;
}

if (require.main === module) main();

module.exports = { main, probeServer, render };
