'use strict';

const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

const HOME = os.homedir();

/**
 * IPC socket path: Named Pipe on Windows, Unix Domain Socket elsewhere.
 */
function socketPath(metameDir) {
  if (IS_WIN) return `\\\\.\\pipe\\metame-daemon-${os.userInfo().username}`;
  return path.join(metameDir, 'daemon.sock');
}

/**
 * Cross-platform synchronous sleep.
 * On Windows, sleep command doesn't exist; use a busy-wait with Atomics for short durations.
 */
function sleepSync(ms) {
  if (IS_WIN) {
    // Atomics.wait on a SharedArrayBuffer — blocks the thread without shell dependency
    const buf = new SharedArrayBuffer(4);
    const arr = new Int32Array(buf);
    Atomics.wait(arr, 0, 0, ms);
  } else {
    const seconds = ms / 1000;
    execSync(`sleep ${seconds}`, { stdio: 'ignore' });
  }
}

/**
 * Find PIDs matching a command-line pattern.
 * Returns array of PID numbers (excluding current process).
 */
function findProcessesByPattern(pattern) {
  const pids = [];
  // Sanitize pattern to prevent command injection
  const safe = pattern.replace(/['"%;$`\\]/g, '');
  try {
    let output;
    if (IS_WIN) {
      // wmic is deprecated but widely available; fallback to tasklist
      try {
        output = execSync(
          `wmic process where "CommandLine like '%${safe}%'" get ProcessId /FORMAT:LIST`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
        );
        const matches = output.match(/ProcessId=(\d+)/g) || [];
        for (const m of matches) {
          const pid = parseInt(m.split('=')[1], 10);
          if (pid && pid !== process.pid) pids.push(pid);
        }
      } catch {
        // wmic not available, try PowerShell
        output = execSync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${safe}*' } | Select-Object -ExpandProperty ProcessId"`,
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
        );
        for (const line of output.trim().split('\n')) {
          const pid = parseInt(line.trim(), 10);
          if (pid && pid !== process.pid) pids.push(pid);
        }
      }
    } else {
      output = execSync(`pgrep -f '${safe}' 2>/dev/null || true`, { encoding: 'utf8' });
      for (const line of output.trim().split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (pid && pid !== process.pid) pids.push(pid);
      }
    }
  } catch { /* ignore errors */ }
  return pids;
}

/**
 * Whether the socket path needs fs.unlinkSync before server.listen().
 * Named Pipes on Windows are kernel-managed — no file to unlink.
 */
function needsSocketCleanup() {
  return !IS_WIN;
}

/**
 * GBK-safe icon mapping for Windows terminals.
 * Chinese Windows terminals use GBK encoding by default,
 * which cannot render emoji — replace with ASCII equivalents.
 */
const _icons = IS_WIN ? {
  // status
  ok:       '[OK]',
  fail:     '[FAIL]',
  warn:     '[!]',
  info:     '[i]',
  // objects
  pkg:      '[PKG]',
  brain:    '[*]',
  dna:      '[~]',
  new:      '[NEW]',
  magic:    '[>]',
  bot:      '[BOT]',
  green:    '[ON]',
  red:      '[OFF]',
  hook:     '[HOOK]',
  search:   '[?]',
  mirror:   '[M]',
  plug:     '[PLUG]',
  book:     '[DOC]',
  pin:      '[PIN]',
  arrow:    '->',
  down:     '[DL]',
  reload:   '[R]',
  stop:     '[X]',
  chart:    '[#]',
  thought:  '[.]',
  phone:    '[TEL]',
  feishu:   '[FS]',
  check:    '[v]',
  tool:     '[T]',
} : {
  ok:       '\u2705',     // ✅
  fail:     '\u274C',     // ❌
  warn:     '\u26A0\uFE0F', // ⚠️
  info:     '\u2139\uFE0F', // ℹ️
  pkg:      '\uD83D\uDCE6', // 📦
  brain:    '\uD83E\uDDE0', // 🧠
  dna:      '\uD83E\uDDEC', // 🧬
  new:      '\uD83C\uDD95', // 🆕
  magic:    '\uD83D\uDD2E', // 🔮
  bot:      '\uD83E\uDD16', // 🤖
  green:    '\uD83D\uDFE2', // 🟢
  red:      '\uD83D\uDD34', // 🔴
  hook:     '\uD83E\uDE9D', // 🪝
  search:   '\uD83D\uDD0D', // 🔍
  mirror:   '\uD83E\uDE9E', // 🪞
  plug:     '\uD83D\uDD0C', // 🔌
  book:     '\uD83D\uDCD6', // 📖
  pin:      '\uD83D\uDCCC', // 📌
  arrow:    '\u2192',     // →
  down:     '\u2B07\uFE0F', // ⬇️
  reload:   '\uD83D\uDD04', // 🔄
  stop:     '\uD83D\uDEAB', // 🚫
  chart:    '\uD83D\uDCCA', // 📊
  thought:  '\uD83D\uDCAD', // 💭
  phone:    '\uD83D\uDCF1', // 📱
  feishu:   '\uD83D\uDCD8', // 📘
  check:    '\u2714',     // ✔
  tool:     '\uD83D\uDEE0\uFE0F', // 🛠️
};

/**
 * Get a platform-appropriate icon by name.
 * Usage: icon('ok') → '✅' on macOS, '[OK]' on Windows
 */
function icon(name) {
  return _icons[name] || name;
}

module.exports = {
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  HOME,
  socketPath,
  sleepSync,
  findProcessesByPattern,
  needsSocketCleanup,
  icon,
};
