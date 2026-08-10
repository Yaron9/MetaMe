'use strict';

const fs = require('fs');
const path = require('path');
const { buildSync } = require('esbuild');

const ENTRYPOINT = path.join(__dirname, 'metame-mcp-server-sdk.mjs');
const OUTPUT = path.join(__dirname, 'metame-mcp-server-sdk.bundle.mjs');
const PROBE_ENTRYPOINT = path.join(__dirname, 'metame-mcp-stdio-probe-bundle-entry.mjs');
const PROBE_OUTPUT = path.join(__dirname, 'metame-mcp-stdio-probe.bundle.mjs');
const NOTICE = path.join(__dirname, 'metame-mcp-server-sdk.bundle.NOTICES.txt');
const MAX_BUNDLE_BYTES = 1024 * 1024;

const SERVER_PACKAGES = [
  { name: '@modelcontextprotocol/server', version: '2.0.0', license: 'MIT' },
  { name: '@modelcontextprotocol/core', version: '2.0.0', license: 'MIT' },
  { name: 'zod', version: '4.4.3', license: 'MIT' },
];
const CLIENT_PACKAGES = [
  { name: '@modelcontextprotocol/client', version: '2.0.0', license: 'MIT' },
  { name: '@modelcontextprotocol/core', version: '2.0.0', license: 'MIT' },
  { name: 'zod', version: '4.4.3', license: 'MIT' },
  { name: 'cross-spawn', version: '7.0.6', license: 'MIT' },
  { name: 'isexe', version: '2.0.0', license: 'ISC' },
  { name: 'path-key', version: '3.1.1', license: 'MIT' },
  { name: 'pkce-challenge', version: '5.0.1', license: 'MIT' },
  { name: 'shebang-command', version: '2.0.0', license: 'MIT' },
  { name: 'shebang-regex', version: '3.0.0', license: 'MIT' },
  { name: 'which', version: '2.0.2', license: 'ISC' },
];
const BUNDLED_PACKAGES = [...new Map(
  [...SERVER_PACKAGES, ...CLIENT_PACKAGES].map(packageInfo => [packageInfo.name, packageInfo]),
).values()];

function findPackageRoot(packageName) {
  const entry = require.resolve(packageName);
  let current = path.dirname(entry);
  while (current !== path.dirname(current)) {
    const packageFile = path.join(current, 'package.json');
    if (fs.existsSync(packageFile)) return current;
    current = path.dirname(current);
  }
  throw new Error(`Cannot locate package metadata for ${packageName}`);
}

function readBundledPackageMetadata() {
  return BUNDLED_PACKAGES.map((expected) => {
    const packageRoot = findPackageRoot(expected.name);
    const packageFile = path.join(packageRoot, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (metadata.version !== expected.version || metadata.license !== expected.license) {
      throw new Error(
        `${expected.name} must remain ${expected.version} ${expected.license}; `
        + `found ${metadata.version} ${metadata.license}`,
      );
    }
    return { ...expected, packageFile };
  });
}

function buildBundle(entrypoint, output) {
  if (!fs.existsSync(entrypoint)) throw new Error(`MCP SDK entrypoint missing: ${entrypoint}`);

  // The outputs are deliberately unminified: a plugin user can audit the SDK
  // boundary, while the size guard below prevents accidental dependency creep.
  buildSync({
    entryPoints: [entrypoint],
    outfile: output,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    legalComments: 'eof',
    sourcemap: false,
    minify: false,
    treeShaking: true,
    // cross-spawn is a maintained client transitive that uses a normal
    // CommonJS builtin require. Provide the ESM-compatible require bridge
    // for the bundled client probe without changing the repository boundary.
    banner: output === PROBE_OUTPUT
      ? { js: "import { createRequire as __mcpCreateRequire } from 'node:module'; const require = __mcpCreateRequire(import.meta.url);" }
      : undefined,
    logLevel: 'silent',
  });

  // esbuild preserves whitespace-only lines inside generated SDK template
  // literals. Normalize only lines made solely of spaces/tabs so generated
  // artifacts pass the repository's diff hygiene check without changing
  // meaningful text.
  const built = fs.readFileSync(output, 'utf8');
  const normalized = built.replace(/^[ \t]+$/gm, '');
  if (normalized !== built) fs.writeFileSync(output, normalized, 'utf8');

  const size = fs.statSync(output).size;
  if (size > MAX_BUNDLE_BYTES) {
    throw new Error(`MCP SDK bundle is ${size} bytes; limit is ${MAX_BUNDLE_BYTES}`);
  }
  return size;
}

function buildMcpBundle() {
  const serverSize = buildBundle(ENTRYPOINT, OUTPUT);
  const probeSize = buildBundle(PROBE_ENTRYPOINT, PROBE_OUTPUT);

  const packages = readBundledPackageMetadata();
  const notice = [
    'MetaMe MCP SDK transport bundle notices',
    '',
    'The sibling *.bundle.mjs files are generated from the maintained ESM',
    'SDK boundaries with esbuild. They embed these runtime dependencies so',
    'the no-npm Claude plugin can use the official MCP SDK:',
    '',
    `Server bundle (${path.basename(OUTPUT)}, ${serverSize} bytes):`,
    ...SERVER_PACKAGES.map(({ name, version, license }) => `  ${name} ${version} — ${license}`),
    '',
    `Client probe bundle (${path.basename(PROBE_OUTPUT)}, ${probeSize} bytes):`,
    ...CLIENT_PACKAGES.map(({ name, version, license }) => `  ${name} ${version} — ${license}`),
    '',
    'The bundle is not a replacement implementation of MCP; it is a reproducible',
    'distribution form of the official SDK. The project keeps the SDK boundary',
    'source and exact dependency versions in package.json/package-lock.json.',
    '',
  ].join('\n');
  fs.writeFileSync(NOTICE, notice, 'utf8');

  return {
    output: OUTPUT,
    probeOutput: PROBE_OUTPUT,
    notice: NOTICE,
    size: serverSize,
    probeSize,
    packages,
  };
}

if (require.main === module) {
  const result = buildMcpBundle();
  console.log(`MCP SDK bundle built (${result.size} bytes)`);
}

module.exports = {
  BUNDLED_PACKAGES,
  CLIENT_PACKAGES,
  ENTRYPOINT,
  MAX_BUNDLE_BYTES,
  NOTICE,
  OUTPUT,
  PROBE_ENTRYPOINT,
  PROBE_OUTPUT,
  SERVER_PACKAGES,
  buildBundle,
  buildMcpBundle,
  findPackageRoot,
  readBundledPackageMetadata,
};
