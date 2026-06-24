#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');

const command = process.platform === 'win32' ? 'uvx.exe' : 'uvx';
const child = spawn(command, ['akshare-one-mcp==0.3.9'], { stdio: 'inherit', windowsHide: true });
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
