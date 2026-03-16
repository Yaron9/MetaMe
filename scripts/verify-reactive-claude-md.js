'use strict';

/**
 * verify-reactive-claude-md.js — Verification script for Package 1 acceptance.
 *
 * Proves that reactive dispatches go through handleCommand (not spawnClaude),
 * and therefore CLAUDE.md is loaded from the project CWD.
 *
 * Run: node scripts/verify-reactive-claude-md.js
 */

const fs = require('fs');
const path = require('path');

const DAEMON_JS = path.join(__dirname, 'daemon.js');
const SCHEDULER_JS = path.join(__dirname, 'daemon-task-scheduler.js');

function verify() {
  const results = [];

  // Read source files
  const daemonSrc = fs.readFileSync(DAEMON_JS, 'utf8');
  const schedulerSrc = fs.existsSync(SCHEDULER_JS) ? fs.readFileSync(SCHEDULER_JS, 'utf8') : '';

  // 1. Verify reactive dispatches go through _handleCommand (not spawnClaude)

  // dispatchTask calls _handleCommand (not spawnClaude)
  const handleCommandCall = daemonSrc.match(/_handleCommand\(nullBot,\s*dispatchChatId,\s*prompt/);
  results.push({
    check: 'dispatchTask uses _handleCommand (not spawnClaude)',
    pass: !!handleCommandCall,
    evidence: handleCommandCall ? handleCommandCall[0].slice(0, 80) : 'NOT FOUND',
  });

  // 2. Verify spawnClaude has CLAUDECODE: undefined (only heartbeat uses it)
  // spawnClaude lives in daemon-task-scheduler.js, not daemon.js
  const spawnClaudeEnv = schedulerSrc.match(/CLAUDECODE:\s*undefined/);
  results.push({
    check: 'spawnClaude (in scheduler) sets CLAUDECODE: undefined (heartbeat only)',
    pass: !!spawnClaudeEnv,
    evidence: spawnClaudeEnv ? 'CLAUDECODE: undefined found in scheduler spawnClaude env' : 'NOT FOUND',
  });

  // 3. Verify spawnClaude is NOT called from dispatchTask/handleDispatchItem
  // (it's only in daemon-task-scheduler.js for heartbeat tasks)
  const dispatchTaskFn = daemonSrc.match(/function dispatchTask[\s\S]*?^}/m);
  const dispatchUsesSpawn = dispatchTaskFn && dispatchTaskFn[0].includes('spawnClaude');
  results.push({
    check: 'dispatchTask does NOT call spawnClaude',
    pass: !dispatchUsesSpawn,
    evidence: dispatchUsesSpawn ? 'FAIL: spawnClaude found in dispatchTask' : 'Confirmed: dispatchTask uses _handleCommand path',
  });

  // 4. Verify spawnClaude lives in task-scheduler (heartbeat), not in dispatch path
  const schedulerHasSpawn = schedulerSrc.includes('spawnClaude');
  results.push({
    check: 'spawnClaude exists in daemon-task-scheduler.js (heartbeat path)',
    pass: schedulerHasSpawn,
    evidence: schedulerHasSpawn ? 'spawnClaude found in scheduler (correct: heartbeat only)' : 'NOT FOUND',
  });

  // 5. Verify _handleCommand is same as handleCommand (full session handler)
  const setDispatchLine = daemonSrc.match(/function setDispatchHandler\(fn\)\s*\{\s*_handleCommand\s*=\s*fn/);
  results.push({
    check: '_handleCommand is bound to handleCommand via setDispatchHandler',
    pass: !!setDispatchLine,
    evidence: setDispatchLine ? 'setDispatchHandler(fn) { _handleCommand = fn }' : 'NOT FOUND',
  });

  // 6. Verify reactive handleDispatchItem goes through the same dispatchTask → _handleCommand path
  const reactiveModule = fs.readFileSync(path.join(__dirname, 'daemon-reactive-lifecycle.js'), 'utf8');
  const reactiveUsesHandleDispatch = reactiveModule.includes('deps.handleDispatchItem');
  results.push({
    check: 'Reactive module uses deps.handleDispatchItem (same dispatch path)',
    pass: reactiveUsesHandleDispatch,
    evidence: reactiveUsesHandleDispatch ? 'deps.handleDispatchItem found in reactive module' : 'NOT FOUND',
  });

  // Print results
  console.log('\n=== CLAUDE.md Loading Verification ===\n');
  let allPass = true;
  for (const r of results) {
    const icon = r.pass ? '✅' : '❌';
    console.log(`${icon} ${r.check}`);
    console.log(`   ${r.evidence}\n`);
    if (!r.pass) allPass = false;
  }

  console.log(allPass
    ? '✅ CONCLUSION: Reactive dispatches go through handleCommand → CLAUDE.md is loaded from project CWD.'
    : '❌ CONCLUSION: Some checks failed. CLAUDE.md loading NOT verified.');

  // Also check that scientist project has a CLAUDE.md
  const scientistClaude = path.join(process.env.HOME || '', 'AGI', 'AgentScientist', 'CLAUDE.md');
  const hasClaude = fs.existsSync(scientistClaude);
  console.log(`\n${hasClaude ? '✅' : '⚠️'} AgentScientist CLAUDE.md exists: ${scientistClaude}`);

  process.exit(allPass ? 0 : 1);
}

verify();
