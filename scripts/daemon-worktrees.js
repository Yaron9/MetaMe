'use strict';

/**
 * daemon-worktrees.js — Isolated worktree per actor
 *
 * Every entity that runs Claude (real chatId, virtual _agent_*, _scope_*, _bound_*)
 * gets its own git worktree branching from the project repo.
 * This eliminates cross-contamination of checkpoints and working-tree state
 * between parallel agents — with a single, unified code path.
 *
 * Directory layout:
 *   ~/.metame/worktrees/<proj-basename>/<actor-key>/
 *
 * Branch convention:
 *   agent/<actor-key>   (created from parent HEAD if new)
 */

function createWorktreeUtils(deps) {
  const { fs, path, log, HOME } = deps;
  const { execFileSync } = require('child_process');

  const WIN_HIDE = process.platform === 'win32' ? { windowsHide: true } : {};
  const WORKTREES_BASE = path.join(HOME, '.metame', 'worktrees');

  /**
   * Derive a stable, filesystem-safe actor key from chatId.
   * This is the ONLY place in the codebase that distinguishes virtual vs real.
   */
  function resolveWorktreeKey(chatId) {
    const s = String(chatId || '');
    if (s.startsWith('_agent_'))  return s.slice(7);
    if (s.startsWith('_scope_'))  return s.slice(7).split('__')[0];
    if (s.startsWith('_bound_'))  return `bound_${s.slice(7)}`;
    return `chat_${s.replace(/[^a-zA-Z0-9_\-]/g, '_')}`;
  }

  function _sanitizeKey(key) {
    return String(key).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 60);
  }

  /** Walk up directories to find the git root containing .git */
  function _findGitRoot(dir) {
    let cur = path.resolve(dir);
    const root = path.parse(cur).root;
    while (cur !== root) {
      if (fs.existsSync(path.join(cur, '.git'))) return cur;
      cur = path.dirname(cur);
    }
    return null;
  }

  /**
   * Get or create an isolated worktree for the given actor.
   *
   * @param {string} parentCwd  - Project's main working directory (git repo root or subdir)
   * @param {string} worktreeKey - Actor identifier (from resolveWorktreeKey or member.key)
   * @returns {string|null} Path to the worktree, or null on unrecoverable failure
   */
  function getOrCreateWorktree(parentCwd, worktreeKey) {
    if (!parentCwd || !worktreeKey) return null;
    const safeKey = _sanitizeKey(worktreeKey);
    if (!safeKey) return null;

    const projBasename = path.basename(path.resolve(parentCwd));
    const worktreePath = path.join(WORKTREES_BASE, projBasename, safeKey);

    // Fast path: already exists (worktree or legacy plain repo)
    if (fs.existsSync(worktreePath)) {
      return worktreePath;
    }

    const gitRoot = _findGitRoot(parentCwd);

    // Ensure parent directory for the worktree
    try {
      fs.mkdirSync(path.join(WORKTREES_BASE, projBasename), { recursive: true });
    } catch (e) {
      log('WARN', `[worktrees] mkdir failed: ${e.message}`);
      return null;
    }

    if (!gitRoot) {
      // Not a git repo — plain mkdir + git init (fallback)
      try {
        fs.mkdirSync(worktreePath, { recursive: true });
        execFileSync('git', ['init', '-q'], { cwd: worktreePath, stdio: 'ignore', timeout: 5000, ...WIN_HIDE });
        log('INFO', `[worktrees] plain dir (no parent git): ${worktreePath}`);
      } catch (e) {
        log('WARN', `[worktrees] fallback git init failed: ${e.message}`);
      }
      return fs.existsSync(worktreePath) ? worktreePath : null;
    }

    // Git repo — create a proper linked worktree
    const branchName = `agent/${safeKey}`;
    try {
      // Does the branch already exist? (e.g. worktree was removed but branch remains)
      let branchExists = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', branchName],
          { cwd: gitRoot, stdio: 'ignore', timeout: 3000, ...WIN_HIDE });
        branchExists = true;
      } catch { /* branch is new */ }

      const addArgs = branchExists
        ? ['worktree', 'add', worktreePath, branchName]
        : ['worktree', 'add', '-b', branchName, worktreePath];

      execFileSync('git', addArgs,
        { cwd: gitRoot, stdio: 'ignore', timeout: 15000, ...WIN_HIDE });

      log('INFO', `[worktrees] created: ${worktreePath} → branch ${branchName}`);
    } catch (e) {
      log('WARN', `[worktrees] git worktree add failed (${e.message}); falling back to plain dir`);
      try {
        if (!fs.existsSync(worktreePath)) {
          fs.mkdirSync(worktreePath, { recursive: true });
          execFileSync('git', ['init', '-q'], { cwd: worktreePath, stdio: 'ignore', timeout: 5000, ...WIN_HIDE });
        }
      } catch { /* best-effort */ }
    }

    return fs.existsSync(worktreePath) ? worktreePath : null;
  }

  return { resolveWorktreeKey, getOrCreateWorktree };
}

module.exports = { createWorktreeUtils };
