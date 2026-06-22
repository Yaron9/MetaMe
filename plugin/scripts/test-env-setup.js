'use strict';

const fs = require('fs');
const path = require('path');

const originalMkdtempSync = fs.mkdtempSync;
const createdDirs = new Set();

fs.mkdtempSync = function(prefix, options) {
  const dir = originalMkdtempSync.call(fs, prefix, options);
  const base = path.basename(dir);
  if (
    base.startsWith('metame-') ||
    base.startsWith('gc-retention-') ||
    base.startsWith('daemon-recall-e2e-') ||
    base.startsWith('wiki-export-test-') ||
    base.startsWith('ops-queue-') ||
    base.startsWith('ops-active-')
  ) {
    createdDirs.add(dir);
  }
  return dir;
};

// Cleanup on exit
process.on('exit', () => {
  for (const dir of createdDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      // ignore
    }
  }
});
