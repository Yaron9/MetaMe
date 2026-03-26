'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectDeployGroups, collectSyntaxCheckFiles } = require('./deploy-manifest');

function makeTempScriptsTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metame-deploy-manifest-'));
  const scriptsDir = path.join(root, 'scripts');
  const coreDir = path.join(scriptsDir, 'core');
  const nestedDir = path.join(coreDir, 'nested');
  fs.mkdirSync(nestedDir, { recursive: true });

  fs.writeFileSync(path.join(scriptsDir, 'daemon.js'), 'console.log("daemon");\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'daemon.test.js'), 'test\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'daemon-default.yaml'), 'enabled: false\n', 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'sync-readme.js'), 'console.log("skip");\n', 'utf8');
  fs.writeFileSync(path.join(coreDir, 'audit.js'), 'module.exports = {};\n', 'utf8');
  fs.writeFileSync(path.join(nestedDir, 'deeper.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(coreDir, 'audit.test.js'), 'test\n', 'utf8');

  return { root, scriptsDir };
}

describe('collectDeployGroups', () => {
  it('includes top-level runtime files and configured nested dirs', () => {
    const { scriptsDir } = makeTempScriptsTree();
    const groups = collectDeployGroups(fs, path, scriptsDir, {
      excludedScripts: new Set(['sync-readme.js', 'daemon.yaml']),
      includeNestedDirs: ['core'],
    });

    assert.equal(groups.length, 3);
    assert.deepEqual(groups[0].fileList.sort(), ['daemon-default.yaml', 'daemon.js']);
    assert.equal(groups[1].destSubdir, 'core');
    assert.deepEqual(groups[1].fileList, ['audit.js']);
    assert.equal(groups[2].destSubdir, path.join('core', 'nested'));
    assert.deepEqual(groups[2].fileList, ['deeper.js']);
  });
});

describe('collectSyntaxCheckFiles', () => {
  it('returns js files from both top-level and nested deploy groups', () => {
    const { scriptsDir } = makeTempScriptsTree();
    const groups = collectDeployGroups(fs, path, scriptsDir, {
      excludedScripts: new Set(['sync-readme.js', 'daemon.yaml']),
      includeNestedDirs: ['core'],
    });

    const files = collectSyntaxCheckFiles(path, groups).map((file) => path.relative(scriptsDir, file)).sort();
    assert.deepEqual(files, ['core/audit.js', 'core/nested/deeper.js', 'daemon.js']);
  });
});
