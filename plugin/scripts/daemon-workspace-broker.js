'use strict';

const { execFileSync } = require('child_process');

function createWorkspaceBroker(deps = {}) {
  if (!deps.worktreeUtils || typeof deps.worktreeUtils.getOrCreateWorktree !== 'function') {
    throw new TypeError('createWorkspaceBroker requires worktreeUtils');
  }
  const worktreeUtils = deps.worktreeUtils;
  const git = deps.execFileSync || execFileSync;

  function revision(cwd) {
    try {
      return String(git('git', ['rev-parse', 'HEAD'], {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
      })).trim();
    } catch {
      return 'none';
    }
  }

  function prepare(options = {}) {
    const mode = String(options.mode || 'none');
    const baseRevision = revision(options.cwd);
    if (mode === 'none') {
      return { strategy: 'none', workspaceId: 'none', cwd: options.cwd, baseRevision };
    }
    if (mode === 'directory') {
      return {
        strategy: 'directory',
        workspaceId: String(options.cwd || ''),
        cwd: options.cwd,
        baseRevision,
      };
    }
    if (mode !== 'worktree' && mode !== 'auto') throw new Error(`workspace_mode_invalid:${mode}`);
    const key = `run_${String(options.runId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const worktreePath = worktreeUtils.getOrCreateWorktree(options.cwd, key);
    if (!worktreePath) throw new Error('workspace_create_failed');
    return {
      strategy: 'external_worktree',
      workspaceId: worktreePath,
      cwd: worktreePath,
      baseRevision,
      cleanup: 'retain_until_reconciled',
    };
  }

  return { prepare };
}

module.exports = { createWorkspaceBroker };
