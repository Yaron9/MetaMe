#!/usr/bin/env node

/**
 * Official MCP SDK boundary for MetaMe's CommonJS tool semantics.
 *
 * The repository remains CommonJS. This small ESM entrypoint owns only MCP
 * server construction and stdio transport; handlers, validation intent and
 * result semantics remain in metame-mcp-server.js.
 */

import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const legacy = require('./metame-mcp-server.js');

const SERVER_INFO = Object.freeze({ name: 'metame', version: '1.0.0' });

function stringifyResult(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: 'mcp_result_not_serializable' });
  }
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: stringifyResult(value) }],
  };
}

function toolError(error) {
  const message = error && error.message ? error.message : String(error || 'unknown error');
  return {
    content: [{ type: 'text', text: stringifyResult({ error: message }) }],
    isError: true,
  };
}

/**
 * Build one SDK server from the existing public MetaMe tool table.
 *
 * `fromJsonSchema` keeps the existing JSON schemas visible on tools/list and
 * delegates type/required-property validation to the SDK instead of a second
 * hand-written protocol validator.
 */
export function createMcpServer({ callTool = legacy.callTool } = {}) {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
  for (const tool of legacy.TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
      },
      async (args) => {
        try {
          const result = await callTool(tool.name, args || {});
          return toolResult(result);
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
  return server;
}

/**
 * Serve MetaMe over the SDK's newline-delimited stdio transport.
 * `stdio` is intentionally the only production transport in this ticket:
 * local Hosts spawn this process and no Host configuration is mutated here.
 */
export async function startStdioServer({ stdin, stdout, maxBufferSize } = {}) {
  const transport = new StdioServerTransport(stdin, stdout, { maxBufferSize });
  transport.onerror = (error) => {
    const message = error && error.message ? error.message : String(error || 'transport error');
    process.stderr.write(`[metame-mcp] transport error: ${message}\n`);
  };
  const server = createMcpServer();
  await server.connect(transport);
  return { server, transport };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdioServer().catch((error) => {
    const message = error && error.message ? error.message : String(error || 'server startup failed');
    process.stderr.write(`[metame-mcp] ${message}\n`);
    process.exitCode = 1;
  });
}
