'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('bootstrapRuntimeModulePaths reads runtime-env.json and exposes node_modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-runtime-bootstrap-'));
  const runtimeDir = path.join(root, '.metame');
  const installRoot = path.join(root, 'pkg');
  const nodeModulesDir = path.join(installRoot, 'node_modules');

  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(nodeModulesDir, { recursive: true });
  fs.writeFileSync(
    path.join(runtimeDir, 'runtime-env.json'),
    JSON.stringify({ metameRoot: installRoot, nodeModules: nodeModulesDir }),
    'utf8'
  );

  const originalNodePath = process.env.NODE_PATH;
  const originalMetameRoot = process.env.METAME_ROOT;
  delete process.env.NODE_PATH;
  delete process.env.METAME_ROOT;

  try {
    const { bootstrapRuntimeModulePaths } = require('./runtime-bootstrap');
    const result = bootstrapRuntimeModulePaths(runtimeDir);
    assert.equal(result.metameRoot, installRoot);
    assert.match(result.nodePath, new RegExp(nodeModulesDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    if (originalNodePath === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = originalNodePath;
    if (originalMetameRoot === undefined) delete process.env.METAME_ROOT;
    else process.env.METAME_ROOT = originalMetameRoot;
  }
});
