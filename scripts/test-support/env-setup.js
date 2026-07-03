'use strict';

if (global.__METAME_TEST_ENV_SETUP__) {
  return;
}
global.__METAME_TEST_ENV_SETUP__ = true;

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_DISABLE_COMPILE_CACHE = '1';

const originalTmpdir = os.tmpdir;
if (path.resolve(originalTmpdir()) === process.cwd()) {
  os.tmpdir = () => '/tmp';
}

const originalMkdtempSync = fs.mkdtempSync;
const createdDirs = new Set();
const cleanupPrefixes = [
  'metame-',
  'gc-retention-',
  'daemon-recall-e2e-',
  'wiki-export-test-',
  'ops-queue-',
  'ops-active-',
  'ops-next-',
  'ops-scan-',
  'ops-info-',
  'ops-watchdog-',
  'ops-bootstrap-',
];

fs.mkdtempSync = function(prefix, options) {
  const dir = originalMkdtempSync.call(fs, prefix, options);
  const base = path.basename(dir);
  if (cleanupPrefixes.some(cleanupPrefix => base.startsWith(cleanupPrefix))) {
    createdDirs.add(dir);
  }
  return dir;
};

process.on('exit', () => {
  for (const dir of createdDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  }
  try {
    const compileCacheDir = path.join(process.cwd(), 'node-compile-cache');
    if (fs.existsSync(compileCacheDir)) {
      fs.rmSync(compileCacheDir, { recursive: true, force: true });
    }
  } catch {
    // ignore cleanup errors
  }
});
