---
status: accepted
---

# Use the official MCP SDK at an isolated transport boundary

MetaMe keeps its CommonJS tool handlers and cognitive semantics, but delegates
MCP protocol handling to the official TypeScript SDK. The production stdio
server is the narrow `scripts/metame-mcp-server-sdk.mjs` entrypoint; the
read-only doctor probe uses the SDK client from
`scripts/metame-mcp-stdio-probe.mjs`. Existing CommonJS consumers and direct
tool tests continue to use `metame-mcp-server.js`.

## Dependency decision

| Package | Pinned version | Decision and boundary |
| --- | --- | --- |
| `@modelcontextprotocol/server` | `2.0.0` | Adopt for server construction, tool registration, JSON-RPC initialize, protocol negotiation, stdio framing, input validation and transport errors. MIT, official `modelcontextprotocol/typescript-sdk` repository, Node `>=20`. |
| `@modelcontextprotocol/client` | `2.0.0` | Adopt only in the doctor probe to perform a real client handshake, `tools/list` verification and bounded transport-error reporting. MIT, same official repository, Node `>=20`. |
| `@modelcontextprotocol/core` | `2.0.0` | Transitive shared protocol package required by the official server/client packages; no direct import from MetaMe. MIT, same official repository, Node `>=20`. |
| `zod` | `4.4.3` | Direct, exact pin required by the SDK's public schema boundary. MIT, maintained upstream, Node-compatible. |

The [official server package metadata](https://www.npmjs.com/package/@modelcontextprotocol/server),
[official client package metadata](https://www.npmjs.com/package/@modelcontextprotocol/client),
and [official v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/)
describe v2 as the stable line and split the former monolith into
server/client/core packages. The v2 packages publish both ESM and CommonJS
export conditions, so the repository does not need a whole-project
module-system migration. The [official stdio server guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio)
and [client guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/stdio) are
the transport references for this boundary.

The legacy monolith `@modelcontextprotocol/sdk` remains published separately
(npm `latest` was `1.30.0` during this audit), but it is not selected: the v2
stable package boundary is the maintained `server`/`client`/`core` split and
matches the accepted architecture decision.

## Fit and maintenance

MCP initialization, version negotiation, JSON-RPC framing and stdio lifecycle
are external protocol obligations. Reusing the maintained SDK removes the
hand-written framing that previously lived in MetaMe while preserving the
existing tool table, handlers, validation intent, audit fields, result shape
and safety behavior. The SDK is maintained by the MCP project and publishes
signed npm provenance metadata.

## Transitive and security review

The client adds the SDK's stdio process transport and its declared transitive
OAuth/HTTP support (`cross-spawn`, `eventsource`, `eventsource-parser`,
`jose`, and `pkce-challenge`), even though this ticket uses only local stdio.
The transport is invoked with argument arrays and `shell: false` through the
SDK; no host configuration or credentials are written or copied. `npm audit
--omit=dev` is part of the ticket verification and must remain clean.

## Removal and rollback

The boundary is removable: delete the two SDK entrypoints and restore the
legacy executable path without changing cognitive handlers or stored data.
Host installation remains a plan-only operation; no config mutation is hidden
in server startup or doctor probing.
