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
  assert.match(assembly, /claude-cli-adapter/);
  assert.match(assembly, /codex-cli-adapter/);
  assert.match(assembly, /agy-cli-adapter/);
  assert.match(assembly, /pi-cli-adapter/);
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
