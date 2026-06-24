#!/usr/bin/env node
'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const args = [
  '-y',
  '@playwright/mcp@0.0.76',
  '--browser',
  'chrome',
  '--user-data-dir',
  path.join(os.homedir(), '.metame', 'browser-profile'),
];
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
let killTimer = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch { /* already exited */ }
    if (!killTimer) killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { } }, 5000);
  });
}
child.on('error', (err) => { console.error(err.message); process.exit(1); });
child.on('exit', (code, signal) => {
  if (killTimer) clearTimeout(killTimer);
  process.exit(signal ? 1 : (code == null ? 1 : code));
});
