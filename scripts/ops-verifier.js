'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * MetaMe Ops verifier — hard gate based on syntax + test results.
 *
 * Phases:
 *   diagnose  — workspace/ops/diagnosis.md must exist
 *   plan      — workspace/ops/fix-plan.md must exist
 *   fix       — all .js files pass syntax check + all tests pass
 *   test      — same as fix (double-check after implementation)
 */

// ── Protected files: changes to these BLOCK the gate ─────────
// These are load-bearing files. If broken, the entire system dies.
// Agent can diagnose issues in these files, but fixes require human approval.

// Scripts that must not be modified (basename match)
const PROTECTED_SCRIPTS = [
  'daemon.js',                    // main daemon process
  'daemon-reactive-lifecycle.js', // perpetual loop engine
  'daemon-team-dispatch.js',      // dispatch + prompt enrichment
  'daemon-claude-engine.js',      // Claude API bridge
  'daemon-bridges.js',            // Feishu/Telegram bridges
  'daemon-remote-dispatch.js',    // cross-device dispatch
  'ops-verifier.js',              // this file — agent must not weaken its own gate
];

// Repo-root files that must not be modified (relative path match)
const PROTECTED_ROOT_FILES = [
  'perpetual.yaml',               // manifest — controls which verifier runs
  'perpetual.yml',
  'CLAUDE.md',                    // agent identity — weakening it weakens all safety
];

/**
 * Check if any protected file was modified (repo-internal only).
 * daemon.yaml lives outside repo and has its own backup mechanism — not our concern.
 * FAIL-CLOSED: if git is unavailable, returns ['__GIT_UNAVAILABLE__'].
 */
function checkProtectedFiles(cwd) {
  try {
    const diff = execSync('git diff --name-only HEAD', { cwd, timeout: 5000, encoding: 'utf8', stdio: 'pipe' }).trim();
    const staged = execSync('git diff --cached --name-only', { cwd, timeout: 5000, encoding: 'utf8', stdio: 'pipe' }).trim();
    const changed = [...new Set([...diff.split('\n'), ...staged.split('\n')])].filter(Boolean);

    const violations = [];
    for (const f of changed) {
      if (PROTECTED_SCRIPTS.includes(path.basename(f))) violations.push(path.basename(f));
    }
    for (const f of changed) {
      if (PROTECTED_ROOT_FILES.includes(f)) violations.push(f);
    }
    return violations;
  } catch {
    return ['__GIT_UNAVAILABLE__'];
  }
}

const GATES = {
  diagnose: {
    check: (cwd) => fileExists(cwd, 'workspace/ops/diagnosis.md'),
    failDetail: 'workspace/ops/diagnosis.md not found',
    hints: ['Scan logs and produce a diagnosis report at workspace/ops/diagnosis.md'],
  },
  plan: {
    check: (cwd) => fileExists(cwd, 'workspace/ops/fix-plan.md'),
    failDetail: 'workspace/ops/fix-plan.md not found',
    hints: ['Write a fix plan at workspace/ops/fix-plan.md before implementing'],
  },
  fix: {
    check: (cwd) => syntaxAndTests(cwd),
    failDetail: 'syntax check or tests failed',
    hints: ['Ensure all scripts pass `node -c` and `node --test`'],
  },
  test: {
    check: (cwd) => syntaxAndTests(cwd),
    failDetail: 'tests failed on verification pass',
    hints: ['All tests must pass before marking mission complete'],
  },
};

function fileExists(cwd, relPath) {
  try { return fs.statSync(path.join(cwd, relPath)).isFile(); } catch { return false; }
}

function syntaxAndTests(cwd) {
  try {
    // Find changed .js files (staged + unstaged) — only verify what was touched
    let changedFiles = [];
    try {
      const diff = execSync('git diff --name-only HEAD -- scripts/', { cwd, timeout: 5000, encoding: 'utf8', stdio: 'pipe' }).trim();
      const staged = execSync('git diff --cached --name-only -- scripts/', { cwd, timeout: 5000, encoding: 'utf8', stdio: 'pipe' }).trim();
      changedFiles = [...new Set([...diff.split('\n'), ...staged.split('\n')])]
        .filter(f => f.endsWith('.js'))
        .map(f => path.basename(f));
    } catch { /* git not available or not a repo — check all */ }

    // Syntax check changed .js files (or all if git unavailable)
    const srcFiles = changedFiles.length > 0
      ? changedFiles.filter(f => !f.endsWith('.test.js'))
      : fs.readdirSync(path.join(cwd, 'scripts')).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

    for (const f of srcFiles) {
      execSync(`node -c scripts/${f}`, { cwd, timeout: 5000, stdio: 'pipe' });
    }

    // Run associated test files
    const testFiles = changedFiles.length > 0
      ? changedFiles.filter(f => f.endsWith('.test.js'))
      : [];
    // Also run tests for changed source files (e.g., foo.js → foo.test.js)
    for (const f of srcFiles) {
      const testName = f.replace('.js', '.test.js');
      if (!testFiles.includes(testName)) {
        const testPath = path.join(cwd, 'scripts', testName);
        if (fs.existsSync(testPath)) testFiles.push(testName);
      }
    }

    // If no specific tests identified, run the core lifecycle test as baseline
    if (testFiles.length === 0) {
      testFiles.push('daemon-reactive-lifecycle.test.js');
    }

    for (const f of [...new Set(testFiles)]) {
      const testPath = path.join(cwd, 'scripts', f);
      if (!fs.existsSync(testPath)) continue;
      const out = execSync(`node --test scripts/${f}`, { cwd, timeout: 60000, encoding: 'utf8', stdio: 'pipe' });
      if (out.includes('# fail') && !out.includes('# fail 0')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function verify(cwd, phase) {
  const gate = GATES[phase];
  if (!gate) {
    return {
      passed: false, phase: phase || '',
      details: `unknown phase: "${phase || ''}"`,
      artifacts: [], hints: ['Valid phases: diagnose, plan, fix, test'],
    };
  }

  // Safety gate: block if protected files were touched
  if (phase === 'fix' || phase === 'test') {
    const violated = checkProtectedFiles(cwd);
    if (violated.length > 0) {
      return {
        passed: false, phase,
        details: `PROTECTED_FILE_VIOLATION: ${violated.join(', ')}`,
        artifacts: [],
        hints: [
          `These files are daemon-critical and cannot be auto-merged: ${violated.join(', ')}`,
          'Revert changes to protected files. Write the fix plan to workspace/ops/ and notify the user for manual review.',
        ],
      };
    }

  }

  const passed = gate.check(cwd);

  // Collect artifacts
  const opsDir = path.join(cwd, 'workspace', 'ops');
  let artifacts = [];
  try {
    if (fs.existsSync(opsDir)) {
      artifacts = fs.readdirSync(opsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => `workspace/ops/${f}`);
    }
  } catch { /* ok */ }

  return {
    passed, phase,
    details: passed ? `phase "${phase}" gate passed` : gate.failDetail,
    artifacts,
    hints: passed ? [] : gate.hints,
  };
}

// CLI entry
if (require.main === module) {
  const cwd = process.env.VERIFIER_CWD || process.cwd();
  const phase = process.env.VERIFIER_PHASE || 'unknown';
  const result = verify(cwd, phase);
  process.stdout.write(JSON.stringify(result));
}

module.exports = { verify };
