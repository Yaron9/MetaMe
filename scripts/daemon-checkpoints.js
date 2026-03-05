'use strict';

function createCheckpointUtils(deps) {
  const { execSync, execFile, path, log } = deps;
  const { promisify } = require('util');
  const execFileAsync = execFile ? promisify(execFile) : null;

  const CHECKPOINT_PREFIX = '[metame-checkpoint]';
  const MAX_CHECKPOINTS = 20;

  function cpExtractTimestamp(message) {
    const parenMatch = message.match(/\((\d{4}-\d{2}-\d{2}T[\d-]{8})\)$/);
    if (parenMatch) {
      return parenMatch[1].replace(/-/g, (m, offset) => {
        if (offset === 4 || offset === 7) return '-';
        if (offset === 10) return 'T';
        if (offset === 13 || offset === 16) return ':';
        return m;
      });
    }
    const raw = message.replace(CHECKPOINT_PREFIX, '').trim();
    return raw.replace(/-/g, (m, offset) => {
      if (offset === 4 || offset === 7) return '-';
      if (offset === 10) return 'T';
      if (offset === 13 || offset === 16) return ':';
      return m;
    });
  }

  function cpDisplayLabel(message) {
    const newMatch = message.match(/Before:\s*(.+?)\s*\((\d{4}-\d{2}-\d{2}T([\d-]{8}))\)$/);
    if (newMatch) {
      const label = newMatch[1].slice(0, 30);
      const time = newMatch[3].replace(/-/g, ':').slice(0, 5);
      return `${label} (${time})`;
    }
    return message.replace(CHECKPOINT_PREFIX, '').trim();
  }

  function gitCheckpoint(cwd, label) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore' });
      execSync('git add -A', { cwd, stdio: 'ignore', timeout: 5000 });
      const status = execSync('git status --porcelain', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
      if (!status) return null;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeLabel = label
        ? ' Before: ' + label.replace(/["\n\r]/g, ' ').slice(0, 60).trim()
        : '';
      const msg = `${CHECKPOINT_PREFIX}${safeLabel} (${ts})`;
      execSync(`git commit -m "${msg}" --no-verify`, { cwd, stdio: 'ignore', timeout: 10000 });
      const hash = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 3000 }).trim();
      log('INFO', `Git checkpoint: ${hash.slice(0, 8)} in ${path.basename(cwd)}${safeLabel}`);
      return hash;
    } catch {
      return null;
    }
  }

  // Async version: runs git commands without blocking the event loop.
  // Call fire-and-forget before spawning Claude; completes well before Claude's first file write.
  async function gitCheckpointAsync(cwd, label) {
    if (!execFileAsync) return gitCheckpoint(cwd, label); // fallback
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 3000 });
      await execFileAsync('git', ['add', '-A'], { cwd, timeout: 5000 });
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', timeout: 5000 });
      if (!status.trim()) return null;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeLabel = label
        ? ' Before: ' + label.replace(/["\n\r]/g, ' ').slice(0, 60).trim()
        : '';
      const msg = `${CHECKPOINT_PREFIX}${safeLabel} (${ts})`;
      await execFileAsync('git', ['commit', '-m', msg, '--no-verify'], { cwd, timeout: 10000 });
      const { stdout: hash } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000 });
      log('INFO', `Git checkpoint: ${hash.trim().slice(0, 8)} in ${path.basename(cwd)}${safeLabel}`);
      return hash.trim();
    } catch {
      return null;
    }
  }

  function listCheckpoints(cwd, limit = 20) {
    try {
      const raw = execSync(
        `git log --fixed-strings --oneline --all --grep="${CHECKPOINT_PREFIX}" -n ${limit} --format="%H %s"`,
        { cwd, encoding: 'utf8', timeout: 5000 }
      ).trim();
      if (!raw) return [];
      return raw.split('\n').map(line => {
        const spaceIdx = line.indexOf(' ');
        return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
      });
    } catch { return []; }
  }

  function cleanupCheckpoints(cwd) {
    try {
      const all = listCheckpoints(cwd, 100);
      if (all.length <= MAX_CHECKPOINTS) return;
      log('INFO', `${all.length} checkpoints in ${path.basename(cwd)}, consider: git rebase -i`);
    } catch { /* ignore */ }
  }

  return {
    cpExtractTimestamp,
    cpDisplayLabel,
    gitCheckpoint,
    gitCheckpointAsync,
    listCheckpoints,
    cleanupCheckpoints,
  };
}

module.exports = { createCheckpointUtils };
