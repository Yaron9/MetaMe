'use strict';

function createCheckpointUtils(deps) {
  const { execSync: _execSync, execFile, path, log } = deps;
  const { promisify } = require('util');
  const execFileAsync = execFile ? promisify(execFile) : null;

  const CHECKPOINT_PREFIX = '[metame-checkpoint]';
  const CHECKPOINT_REF_PREFIX = 'refs/metame/checkpoints/';

  // Build the ref path for a checkpoint.
  // When agentKey is provided: refs/metame/checkpoints/<agentKey>/<ts>
  // Otherwise:                 refs/metame/checkpoints/<ts>  (backward compat)
  function _checkpointRef(ts, agentKey) {
    if (agentKey && String(agentKey).trim()) {
      const safe = String(agentKey).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
      return `${CHECKPOINT_REF_PREFIX}${safe}/${ts}`;
    }
    return `${CHECKPOINT_REF_PREFIX}${ts}`;
  }
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

  // Shared helper: build the commit message and timestamp for a checkpoint.
  function buildCheckpointMsg(label) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeLabel = label
      ? ' Before: ' + label.replace(/["\n\r]/g, ' ').slice(0, 60).trim()
      : '';
    return { ts, safeLabel, msg: `${CHECKPOINT_PREFIX}${safeLabel} (${ts})` };
  }

  // Build a checkpoint commit stored under refs/metame/checkpoints/{agentKey}/{ts} — never pushed by git push.
  // Returns the commit SHA, or null if nothing changed.
  function gitCheckpoint(cwd, label, agentKey) {
    const { execFileSync } = require('child_process');
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore', ...WIN_HIDE });

      // Snapshot current index so we can restore it after staging
      const originalTree = execFileSync('git', ['write-tree'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).toString().trim();

      // Stage everything to get a full snapshot tree
      execFileSync('git', ['add', '-A'], { cwd, stdio: 'ignore', timeout: 5000, ...WIN_HIDE });
      const cpTree = execFileSync('git', ['write-tree'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).toString().trim();

      // Restore index immediately — leave the user's staged state intact
      execFileSync('git', ['read-tree', originalTree], { cwd, stdio: 'ignore', timeout: 3000, ...WIN_HIDE });

      // Compare against HEAD tree — skip if nothing changed
      let headTree = '';
      try { headTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).toString().trim(); } catch { /* no commits yet */ }
      if (cpTree === headTree) return null;

      const { ts, safeLabel, msg } = buildCheckpointMsg(label);

      // Build parent args (-p HEAD, or empty for initial commit)
      let parentArgs = [];
      try { parentArgs = ['-p', execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }).toString().trim()]; } catch { /* no HEAD */ }

      // Create an orphaned commit object — NOT on any branch
      const cpSha = execFileSync('git', ['commit-tree', cpTree, ...parentArgs, '-m', msg],
        { cwd, encoding: 'utf8', timeout: 10000, ...WIN_HIDE }
      ).toString().trim();

      // Point a local-only ref at it — git push never transfers refs/metame/*
      execFileSync('git', ['update-ref', _checkpointRef(ts, agentKey), cpSha], { cwd, stdio: 'ignore', timeout: 3000, ...WIN_HIDE });

      log('INFO', `Git checkpoint: ${cpSha.slice(0, 8)} in ${path.basename(cwd)}${safeLabel}`);
      return cpSha;
    } catch (e) {
      log('WARN', `Git checkpoint failed in ${path.basename(cwd)}: ${e.message}`);
      return null;
    }
  }

  // Async version: same logic but non-blocking.
  async function gitCheckpointAsync(cwd, label, agentKey) {
    if (!execFileAsync) return gitCheckpoint(cwd, label, agentKey);
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

      const { ts, safeLabel, msg } = buildCheckpointMsg(label);

      let parentArgs = [];
      try { const r = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 3000, ...WIN_HIDE }); parentArgs = ['-p', r.stdout.trim()]; } catch { /* no HEAD */ }

      const { stdout: cpShaOut } = await execFileAsync('git', ['commit-tree', cpTree, ...parentArgs, '-m', msg], { cwd, encoding: 'utf8', timeout: 10000, ...WIN_HIDE });
      const cpSha = cpShaOut.trim();

      await execFileAsync('git', ['update-ref', _checkpointRef(ts, agentKey), cpSha], { cwd, timeout: 3000, ...WIN_HIDE });

      log('INFO', `Git checkpoint: ${cpSha.slice(0, 8)} in ${path.basename(cwd)}${safeLabel}`);
      return cpSha;
    } catch (e) {
      log('WARN', `Git checkpoint (async) failed in ${path.basename(cwd)}: ${e.message}`);
      return null;
    }
  }

  // List checkpoints, newest first. Returns [{hash, message, ref, parentHash}].
  // Uses %(parent) in for-each-ref format — no extra subprocess per checkpoint.
  function listCheckpoints(cwd, limit = 20) {
    const { execFileSync } = require('child_process');
    try {
      const raw = execFileSync('git', [
        'for-each-ref', '--sort=-committerdate',
        `--format=%(objectname)|%(refname)|%(parent)|%(contents:subject)`,
        `--count=${limit}`, CHECKPOINT_REF_PREFIX,
      ], { cwd, encoding: 'utf8', timeout: 5000, ...WIN_HIDE }).toString().trim();
      if (!raw) return [];
      return raw.split('\n').filter(Boolean).map(line => {
        const [hash, ref, parent, ...rest] = line.split('|');
        return { hash, ref, parentHash: parent || null, message: rest.join('|') };
      });
    } catch { return []; }
  }

  // Delete checkpoints beyond MAX_CHECKPOINTS (oldest first).
  function cleanupCheckpoints(cwd) {
    const { execFileSync } = require('child_process');
    try {
      const all = listCheckpoints(cwd, 100);
      if (all.length <= MAX_CHECKPOINTS) return;
      const toDelete = all.slice(MAX_CHECKPOINTS); // oldest (for-each-ref sorted newest-first)
      for (const cp of toDelete) {
        try { execFileSync('git', ['update-ref', '-d', cp.ref], { cwd, stdio: 'ignore', timeout: 3000, ...WIN_HIDE }); } catch { /* ignore */ }
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
