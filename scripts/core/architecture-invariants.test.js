'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');

// These modules are shared policy/analytics boundaries.  Engine identity and
// native layouts belong to Engine Plugins or declarative UX/configuration, so
// a new Host must not require a branch in any of these files.
const SHARED_MODULES = [
  'scripts/session-analytics.js',
  'scripts/cognitive-ingestion.js',
  'scripts/memory-extract.js',
  'scripts/core/canonical-session-analytics.js',
];

const HOST_TOKEN = /\b(?:claude|codex|agy|pi)\b|\.(?:claude|codex|agy|pi)\b|state_5|rollout(?:_|\b)|transcript/i;

test('shared cognition modules stay Engine-neutral', () => {
  for (const relativePath of SHARED_MODULES) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      HOST_TOKEN,
      `${relativePath} must not contain Host-native identity, path, or transcript tokens`,
    );
    assert.doesNotMatch(
      source,
      /require\(['"]\.\/engines\/(?:claude|codex|agy|pi)-/i,
      `${relativePath} must not import a Host adapter directly`,
    );
  }
});

test('runtime facade reaches native adapters only through the plugin assembly boundary', () => {
  const facade = fs.readFileSync(path.join(ROOT, 'scripts/daemon-engine-runtime.js'), 'utf8');
  const assembly = fs.readFileSync(path.join(ROOT, 'scripts/engines/native-runtime-factory.js'), 'utf8');
  assert.doesNotMatch(facade, /require\(['"]\.\/engines\/(?:claude|codex|agy|pi)-cli-adapter['"]\)/i);
  assert.doesNotMatch(
    facade,
    /\b(?:claude|codex|agy|pi)\b|\.(?:claude|codex|agy|pi)\b/i,
    'the shared facade must remain free of built-in Engine identity tokens',
  );
  assert.doesNotMatch(facade, /_private|(?:build|parse)(?:Claude|Codex|Agy|Pi)/i);
  assert.doesNotMatch(facade, /classify(?:Claude|Codex|Agy|Pi)|normalize(?:Claude|Codex|Agy|Pi)/i);
  assert.match(assembly, /claude-cli-adapter/);
  assert.match(assembly, /codex-cli-adapter/);
  assert.match(assembly, /agy-cli-adapter/);
  assert.match(assembly, /pi-cli-adapter/);
  assert.match(assembly, /BUILTIN_RUNTIME_CATALOG/);
});

test('catalog definitions own adapter, model, binary, timeout, and source policies', () => {
  const { BUILTIN_RUNTIME_CATALOG } = require('../engines/native-runtime-factory');
  assert.ok(BUILTIN_RUNTIME_CATALOG.length >= 1);
  for (const definition of BUILTIN_RUNTIME_CATALOG) {
    assert.equal(typeof definition.id, 'string');
    assert.equal(typeof definition.createRuntime, 'function');
    assert.equal(typeof definition.resolveBinary, 'function');
    assert.equal(typeof definition.probeBinary, 'function');
    assert.equal(typeof definition.model.normalizeConfiguredModel, 'function');
    assert.equal(typeof definition.model.resolveLegacyModel, 'function');
    assert.ok(definition.timeouts && typeof definition.timeouts.idleMs === 'number');
    assert.ok(definition.structuredOutput && typeof definition.structuredOutput.schema === 'string');
  }
});

test('analytics keeps one revision-scoped processing identity', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/session-analytics.js'), 'utf8');
  assert.doesNotMatch(source, /processed_sessions|processed_source_revisions|analytics_state\.(?:json|db)/);
  assert.match(source, /ensureExtractionRunSchema/);
  assert.match(source, /claimExtractionLease/);
  assert.match(source, /completeExtractionRun/);
  assert.match(source, /sourceRevision/);
  assert.match(source, /pipeline_version/);
});

test('published metadata and operator docs describe the universal trust boundary', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.description, /Claude Code and Codex$/i);
  assert.ok(pkg.keywords.includes('engine-plugin'));
  assert.ok(pkg.keywords.includes('universal-agent'));

  const activeDocs = [
    'README.md',
    'README中文版.md',
    'scripts/docs/maintenance-manual.md',
    'scripts/docs/pointer-map.md',
  ];
  for (const relativePath of activeDocs) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /Claude\/Codex 双引擎|Claude Code and Codex are first-class hosts|project\.engine:\s*claude\|codex/i,
      `${relativePath} must not advertise the retired two-host architecture`,
    );
    assert.match(source, /registered|已注册|Capability Registry|capability registry/i);
  }
});
