#!/usr/bin/env node

/**
 * Read-only MCP doctor probe.
 *
 * The regular npm path loads the official SDK client modules directly. A
 * no-npm plugin copy falls back to its sibling SDK bundle; both paths share
 * the same probe logic and transport semantics.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probeWithSdk } from './metame-mcp-stdio-probe-core.mjs';

function isMissingOfficialSdk(error) {
  const message = error && error.message ? error.message : String(error || '');
  return error && error.code === 'ERR_MODULE_NOT_FOUND'
    && /@modelcontextprotocol\/(?:client|core)|(?:^|[\s'])zod(?:[\/'"]|$)/.test(message);
}

let probeImplementation;
async function resolveProbeImplementation() {
  if (probeImplementation) return probeImplementation;
  try {
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/client'),
      import('@modelcontextprotocol/client/stdio'),
    ]);
    probeImplementation = serverPath => probeWithSdk({ Client, StdioClientTransport }, serverPath);
  } catch (error) {
    if (!isMissingOfficialSdk(error)) throw error;
    const bundled = await import('./metame-mcp-stdio-probe.bundle.mjs');
    probeImplementation = bundled.probe;
  }
  return probeImplementation;
}

async function probe(serverPath) {
  return (await resolveProbeImplementation())(serverPath);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const result = await probe(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export { probe };
