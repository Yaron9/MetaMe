#!/usr/bin/env node

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { probeWithSdk } from './metame-mcp-stdio-probe-core.mjs';

const sdk = { Client, StdioClientTransport };
const probe = serverPath => probeWithSdk(sdk, serverPath);

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
