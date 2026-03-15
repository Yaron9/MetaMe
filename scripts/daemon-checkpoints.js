'use strict';

function createCheckpointUtils(deps) {
  const { execSync, execFile, path, log } = deps;
  const { promisify } = require('util');
  const execFileAsync = execFile ? promisify(execFile) : null;

  const CHECKPOINT_PREFIX = '[metame-checkpoint]';
  const CHECKPOINT_REF_PREFIX = 'refs/metame/checkpoints/';
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

  // On Windows, git.exe is a console app — windowsHide:true prevents flash
  const WIN_HIDE = process.platform === 'win32' ? { windowsHide: true } : {};

  // Build a checkpoint commit stored under refs/metame/checkpoints/{ts} — never pushed by git push.
  // Returns the commit SHA, or null if nothing changed.
  function gitCheckpoint(cwd, label) {
    try {
      execSync('git rev-parse --is-inside-work-tree', { cwd, stdio: 'ignore', ...WIN_HIDE });

      // Snapshot current index so we can restore it after staging
      const originalTree = execSync('git write-tree', { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).trim();

      // Stage everything to get a full snapshot tree
      execSync('git add -A', { cwd, stdio: 'ignore', timeout: 5000, ...WIN_HIDE });
      const cpTree = execSync('git write-tree', { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).trim();

      // Restore index immediately — leave the user's staged state intact
      execSync(`git read-tree ${originalTree}`, { cwd, stdio: 'ignore', timeout: 3000, ...WIN_HIDE });

      // Compare against HEAD tree — skip if nothing changed
      let headTree = '';
      try { headTree = execSync('git rev-parse HEAD^{tree}', { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).trim(); } catch { /* no commits yet */ }
      if (cpTree === headTree) return null;

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeLabel = label
        ? ' Before: ' + label.replace(/["\n\r]/g, ' ').slice(0, 60).trim()
        : '';
      const msg = `${CHECKPOINT_PREFIX}${safeLabel} (${ts})`;

      // Build parent arg (-p HEAD, or nothing for initial commit)
      let parentFlag = '';
      try { parentFlag = `-p ${execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).trim()}`; } catch { /* no HEAD */ }

      // Create an orphaned commit object — NOT on any branch
      const cpSha = execSync(
        `git commit-tree ${cpTree} ${parentFlag} -m "${msg}"`,
        { cwd, encoding: 'utf8', timeout: 10000, ...WIN_HIDE }
      ).trim();

      // Point a local-only ref at it — git push never transfers refs/metame/*
      execSync(`git update-ref ${CHECKPOINT_REF_PREFIX}${ts} ${cpSha}`, { cwd, stdio: 'ignore', timeout: 3000, ...WIN_HIDE });

      log('INFO', `Git checkpoint: ${cpSha.slice(0, 8)} in ${path.basename(cwd)}${safeLabel}`);
      return cpSha;
    } catch {
      return null;
    }
  }

  // Async version: same logic but non-blocking.
  async function gitCheckpointAsync(cwd, label) {
    if (!execFileAsync) return gitCheckpoint(cwd, label);
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 3000, ...WIN_HIDE });

      const { stdout: originalTreeOut } = await execFileAsync('git', ['write-tree'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE });
      const originalTree = originalTreeOut.trim();

      await execFileAsync('git', ['add', '-A'], { cwd, timeout: 5000, ...WIN_HIDE });
      const { stdout: cpTreeOut } = await execFileAsync('git', ['write-tree'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE });
      const cpTree = cpTreeOut.trim();

      // Restore index
      await execFileAsync('git', ['read-tree', originalTree], { cwd, timeout: 3000, ...WIN_HIDE });

      let headTree = '';
      try { const r = await execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }); headTree = r.stdout.trim(); } catch { /* no HEAD */ }
      if (cpTree === headTree) return null;

      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const safeLabel = label
        ? ' Before: ' + label.replace(/["\n\r]/g, ' ').slice(0, 60).trim()
        : '';
      const msg = `${CHECKPOINT_PREFIX}${safeLabel} (${ts})`;

      let parentArgs = [];
      try { const r = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }); parentArgs = ['-p', r.stdout.trim()]; } catch { /* no HEAD */ }

      const { stdout: cpShaOut } = await execFileAsync('git', ['commit-tree', cpTree, ...parentArgs, '-m', msg], { cwd, encoding: 'utf8', timeout: 10000, ...WIN_HIDE });
      const cpSha = cpShaOut.trim();

      await execFileAsync('git', ['update-ref', `${CHECKPOINT_REF_PREFIX}${ts}`, cpSha], { cwd, timeout: 3000, ...WIN_HIDE });

      log('INFO', `Git checkpoint: ${cpSha.slice(0, 8)} in ${path.basename(cwd)}${safeLabel}`);
      return cpSha;
    } catch {
      return null;
    }
  }

  // List checkpoints, newest first. Returns [{hash, message, ref, parentHash}].
  function listCheckpoints(cwd, limit = 20) {
    try {
      const raw = execSync(
        `git for-each-ref --sort=-committerdate --format="%(objectname) %(refname) %(contents:subject)" --count=${limit} ${CHECKPOINT_REF_PREFIX}`,
        { cwd, encoding: 'utf8', timeout: 5000, ...WIN_HIDE }
      ).trim();
      if (!raw) return [];
      return raw.split('\n').filter(Boolean).map(line => {
        const firstSpace = line.indexOf(' ');
        const secondSpace = line.indexOf(' ', firstSpace + 1);
        const hash = line.slice(0, firstSpace);
        const ref = line.slice(firstSpace + 1, secondSpace);
        const message = line.slice(secondSpace + 1);
        let parentHash = null;
        try { parentHash = execSync(`git rev-parse ${hash}^`, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 3000, ...WIN_HIDE }).trim(); } catch { /* initial commit */ }
        return { hash, message, ref, parentHash };
      });
    } catch { return []; }
  }

  // Delete checkpoints beyond MAX_CHECKPOINTS (oldest first).
  function cleanupCheckpoints(cwd) {
    try {
      const all = listCheckpoints(cwd, 100);
      if (all.length <= MAX_CHECKPOINTS) return;
      const toDelete = all.slice(MAX_CHECKPOINTS); // oldest (for-each-ref sorted newest-first)
      for (const cp of toDelete) {
        try { execSync(`git update-ref -d ${cp.ref}`, { cwd, stdio: 'ignore', timeout: 3000, ...WIN_HIDE }); } catch { /* ignore */ }
      }
      log('INFO', `Cleaned up ${toDelete.length} old checkpoints in ${path.basename(cwd)}`);
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
