#!/usr/bin/env node

/**
 * Read-only MCP doctor probe.
 *
 * This helper deliberately uses the official SDK client so initialize,
 * protocol-version negotiation, stdio framing and transport failures are not
 * reimplemented in the CommonJS doctor command.
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function errorReport(error) {
  const message = error && error.message ? error.message : String(error || 'MCP probe failed');
  return {
    code: error && (error.code || error.name) ? String(error.code || error.name) : 'MCP_PROBE_FAILED',
    message: message.slice(0, 300),
  };
}

async function probe(serverPath) {
  const target = path.resolve(String(serverPath || ''));
  if (!serverPath) return { reachable: false, tools: [], error: { code: 'MCP_SERVER_PATH_REQUIRED', message: 'server path is required' } };

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [target],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'metame-doctor', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = Array.isArray(listed.tools)
      ? listed.tools.map(tool => String(tool && tool.name || '')).filter(Boolean).sort()
      : [];
    const protocolVersion = client.getNegotiatedProtocolVersion?.() || null;
    const serverInfo = client.getServerVersion?.() || null;
    const capabilities = client.getServerCapabilities?.() || {};
    return {
      reachable: true,
      tools,
      protocol_version: protocolVersion,
      server_info: serverInfo,
      server_capabilities: capabilities,
      client_verified: !!serverInfo,
      protocol_verified: !!protocolVersion,
    };
  } catch (error) {
    return { reachable: false, tools: [], error: errorReport(error) };
  } finally {
    try { await client.close(); } catch { /* best effort for a read-only probe */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await probe(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export { probe };
