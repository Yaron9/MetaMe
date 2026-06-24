# Loop Engineering Code Review — P0/P1 Findings

**Date:** 2026-06-23
**Scope:** spec.md §5.2, §7-10; scripts reviewed: handoff.js, completion-contract.js, daemon-engine-runtime.js, daemon-background-runner.js, daemon-task-scheduler.js, daemon-verifier.js, daemon-workspace-broker.js, daemon-loop-coordinator.js, daemon-loop-reconciler.js, daemon.js, daemon-default.yaml, index.js, and core/loop-*.js tests.

---

## P0 Issues (Security/Correctness)

### P0-1: Buffer Mode Switching Silently Changes Output Retention
**File:** `scripts/daemon-background-runner.js:88`
**Severity:** P0 — Structured Output Parsing

```javascript
stdoutBufferMode: structured || runtime.name === 'codex' ? 'tail' : 'prefix'
```

**Issue:**
- Claude background runners default to `prefix` mode (first N bytes retained)
- Codex background runners default to `tail` mode (last N bytes retained)
- When structured output is expected, both use `tail` mode
- This implicit contract difference can cause:
  - Structured output parsing failures if prologue text exceeds buffer limits
  - Silent loss of different parts of the output between engines
  - No explicit error or logging about which bytes were dropped

**Reproduction:**
1. Configure background runner for Codex with structured output
2. If output exceeds max buffer and has prologue before JSON, JSON might be retained
3. Same config on Claude might lose JSON if prologue is retained
4. Parser would fail differently by engine, breaking output contract

**Minimal Fix:**
Document the buffer mode explicitly in runtime contract. Either:
- Force both to same mode when structured output is required, OR
- Detect and reject outputs that hit buffer limit before parsing

```javascript
// Option: explicit buffer mode in contract
const bufferMode = structured ? 'tail' : (runtime.name === 'codex' ? 'tail' : 'prefix');
// Add validator
if (commandResult.output && commandResult.output.length >= maxStdoutBytes) {
  return { ok: false, error: 'output_buffer_full', errorCode: 'BUFFER_LIMIT_EXCEEDED' };
}
```

---

### P0-2: Codex Permission Escalation via Default Policy
**Files:** `scripts/daemon-engine-runtime.js:386-393, 424-426`
**Severity:** P0 — Permission Escalation

```javascript
// Line 386-392
const sandboxMode = normalizeCodexSandboxMode(
  codexCfg.sandbox_mode /* or various aliases */,
  'danger-full-access'  // <-- DEFAULT
);
const approvalPolicy = normalizeCodexApprovalPolicy(
  codexCfg.approval_policy,
  sandboxMode === 'danger-full-access' ? 'never' : 'on-failure'
);

// Line 424-426
if (effectivePermissionProfile.sandboxMode === 'danger-full-access' && effectivePermissionProfile.approvalPolicy === 'never') {
  args.push('--dangerously-bypass-approvals-and-sandbox');  // <-- ESCALATED
}
```

**Issue:**
- Default Codex permission profile is `sandboxMode='danger-full-access'` + `approvalPolicy='never'`
- This immediately escalates to `--dangerously-bypass-approvals-and-sandbox` with no approval required
- Applies to ALL background runners (daemon heartbeat tasks, loop goals, etc.) unless explicitly overridden
- No explicit logging when permission escalation occurs
- Spec §5.6 requires R2/R3 actions to go through approval gate, but loop background goals can bypass this

**Reproduction:**
1. Create loop goal with Codex engine
2. No explicit `codex.sandbox_mode` or `codex.approval_policy` in daemon.yaml
3. Codex execution automatically gets full access + no approvals
4. Goal can modify main repo without review

**Minimal Fix:**
Change default Codex sandbox mode to `read-only` or `workspace-write`:
```javascript
// daemon-engine-runtime.js:386
const sandboxMode = normalizeCodexSandboxMode(
  codexCfg.sandbox_mode,
  'workspace-write'  // <-- was 'danger-full-access'
);
```

Also add explicit audit logging:
```javascript
if (effectivePermissionProfile.sandboxMode === 'danger-full-access') {
  log('AUDIT', `Codex execution with full access escalation: engine=${engine}, sandboxMode=${sandboxMode}`);
}
```

---

## P1 Issues (Reliability/Consistency)

### P1-1: Feature Flag Default Silently Switches Execution Path
**File:** `scripts/daemon-default.yaml:195-196`
**Severity:** P1 — Feature Flag Default Flow

```yaml
loop:
  enabled: false
  execute_v2: false
  reactive_v2: false
```

**Issue:**
- All three loop flags default to `false`
- When flipped to `true`, execution path changes from legacy scheduler to loop coordinator
- No explicit logging when flag is enabled
- No validation that required loop infrastructure is initialized
- Users upgrading might not know their automation switched from heartbeat to loop

**Reproduction:**
1. Legacy heartbeat task runs via old scheduler
2. Admin flips `loop.execute_v2: true`
3. Same task now runs via loop coordinator with different state tracking
4. If loop DB initialization fails, task silently stops with no clear error

**Minimal Fix:**
Add explicit feature flag logging and validation:
```javascript
// daemon.js startup
if (daemonConfig.loop?.enabled || daemonConfig.loop?.execute_v2) {
  log('INFO', `Loop engineering v2 enabled: execute_v2=${daemonConfig.loop.execute_v2}`);
  // Validate that control-db and loop tables are initialized
  try {
    controlDb.run(db => {
      const goals = db.prepare('SELECT COUNT(*) as cnt FROM goals').get();
      log('INFO', `Loop DB ready: ${goals.cnt} goals`);
    });
  } catch (err) {
    log('ERROR', `Loop v2 enabled but DB not initialized: ${err.message}`);
    process.exit(1);
  }
}
```

---

### P1-2: Session Resume Contract Differs Between Engines
**Files:** `scripts/daemon-engine-runtime.js:331-337, 412-415`
**Severity:** P1 — Runtime Parameter Contract

```javascript
// Claude (line 331-337)
if (session.id === '__continue__') {
  args.push('--continue');
} else if (session.started && session.id) {
  args.push('--resume', session.id);
} else if (session.id) {
  args.push('--session-id', session.id);
}

// Codex (line 412-415)
const isResume = (session && session.started && session.id && session.id !== '__continue__');
const args = isResume
  ? ['exec', 'resume', session.id]
  : ['exec'];
```

**Issue:**
- Claude checks `session.id === '__continue__'` first (special marker for persistent pool resume)
- Codex does NOT special-case `'__continue__'` in resume logic
- If session.id is `'__continue__'`, Claude creates a persistent session but Codex treats it as a fresh exec
- Loop goals using persistent sessions (from warm pool) will behave differently by engine
- Spec §5.2 claims "resume" is supported uniformly, but implementation differs

**Reproduction:**
1. Loop goal configured with `persistent_session: true`
2. Session ID is `'__continue__'` (from warm pool)
3. Claude runs with `--continue` flag
4. Codex runs fresh `exec` without the session
5. Same goal produces different runtime context on Claude vs Codex

**Minimal Fix:**
Codex resume must handle `__continue__` marker:
```javascript
// daemon-engine-runtime.js:412-415
const isResume = (session && session.started && session.id && session.id !== '__continue__');
const isContinue = session && session.id === '__continue__';
const args = isContinue
  ? ['exec', 'continue', session.id]
  : (isResume ? ['exec', 'resume', session.id] : ['exec']);
```

Or document that Codex does not support persistent session resume and gate it:
```javascript
if (session.id === '__continue__' && engine === 'codex') {
  throw new Error('codex_does_not_support_continue_sessions');
}
```

---

### P1-3: Worktree Cleanup Lifecycle Not Explicitly Owned
**Files:** `scripts/daemon-workspace-broker.js:40-48`; `scripts/daemon-loop-reconciler.js`
**Severity:** P1 — Worktree Main Directory Pollution

```javascript
// daemon-workspace-broker.js:40-48
const worktreePath = worktreeUtils.getOrCreateWorktree(options.cwd, key);
if (!worktreePath) throw new Error('workspace_create_failed');
return {
  strategy: 'external_worktree',
  workspaceId: worktreePath,
  cwd: worktreePath,
  baseRevision,
  cleanup: 'retain_until_reconciled',  // <-- Who owns this cleanup?
};
```

**Issue:**
- Workspace broker marks worktree for `'retain_until_reconciled'`
- No explicit code shown that reconciler actually cleans up these worktrees
- If reconciler fails or doesn't run, worktrees accumulate
- No GC policy or retention limit shown
- Main repo working tree could be polluted with stale branches from failed runs
- Spec §5.5 mentions "only available for diagnostics then garbage collected" but no implementation shown

**Reproduction:**
1. Loop run creates worktree for code task
2. Run fails during verifier phase
3. Reconciler never runs (daemon crash, launchd failure, etc.)
4. Worktree branch left behind
5. Next run for same goal creates new branch, main repo gitdir grows
6. After N failed runs, performance degrades due to stale branches

**Minimal Fix:**
Explicit worktree cleanup in reconciler or periodic GC:
```javascript
// daemon-loop-reconciler.js
function cleanupUnreachableWorktrees(worktreeUtils, runStore, maxAgeMs = 24*60*60*1000) {
  const recentRuns = runStore.listRecentRuns(maxAge: 48*60*60*1000);
  const activeWorkspaceIds = new Set(recentRuns.map(r => r.workspace_id).filter(Boolean));

  for (const workspace of worktreeUtils.listWorktrees()) {
    if (!activeWorkspaceIds.has(workspace.path) && Date.now() - workspace.created_at > maxAgeMs) {
      try {
        worktreeUtils.removeWorktree(workspace.path);
      } catch (err) {
        log('WARN', `Failed to cleanup worktree ${workspace.path}: ${err.message}`);
      }
    }
  }
}
```

---

### P1-4: Detached Process Cleanup Not Verified on Shutdown
**Files:** `scripts/core/handoff.js:180, 469`; `scripts/daemon.js:20-33`
**Severity:** P1 — Detached Leaks

```javascript
// handoff.js:180
detached: useDetached,  // <-- spawned with detached=true for Codex

// daemon.js:20-33 — unhandledRejection handler
process.on('unhandledRejection', (reason) => {
  try {
    const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    const line = `[${new Date().toISOString()}] [ERROR] [UNHANDLED_REJECTION] ${msg}\n`;
    fs.appendFileSync(path.join(os.homedir(), '.metame', 'daemon.log'), line);
  } catch { /* last resort: don't crash */ }
  // NOTE: no process.exit() — daemon stays alive
});
```

**Issue:**
- Background runners spawn child processes with `detached: true` (so daemon restart doesn't kill them)
- On daemon shutdown/restart, these detached processes are not collected
- SIGTERM handler in daemon.js doesn't explicitly wait for children to exit
- Loop coordinator has abort controller but shutdown sequence unclear
- Long-running tasks (Codex inference > 1 hour) could spawn multiple orphaned processes

**Reproduction:**
1. Daemon starts a 2-hour Codex background task (detached=true)
2. After 30 min, admin restarts daemon
3. Original Codex process continues in background (detached, orphaned)
4. New daemon starts another Codex task for same goal
5. Two Codex processes now run in parallel, competing for resources
6. After repeated restarts, N orphaned processes accumulate

**Minimal Fix:**
Explicit process cleanup on daemon shutdown:
```javascript
// daemon.js
const runningChildren = new Set();
function trackChild(child) {
  runningChildren.add(child.pid);
  child.on('exit', () => runningChildren.delete(child.pid));
}

process.on('SIGTERM', async () => {
  log('INFO', 'SIGTERM: stopping coordinator and cleaning up children');
  if (loopCoordinator) loopCoordinator.stop();  // abort running loops

  // Give graceful shutdown 5 seconds
  const gracefulTimeout = setTimeout(() => {
    log('WARN', `Forcefully killing ${runningChildren.size} child processes`);
    for (const pid of runningChildren) {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 5000);

  // Wait for children to exit
  await Promise.allSettled(Array.from(runningChildren).map(pid =>
    new Promise(resolve => {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      setTimeout(resolve, 5000);
    })
  ));
  clearTimeout(gracefulTimeout);
  process.exit(0);
});
```

---

### P1-5: Structured Output Parsing Does Not Reject Partial Buffers
**Files:** `scripts/core/completion-contract.js`; `scripts/daemon-background-runner.js:102-106`
**Severity:** P1 — Structured Output Parsing

```javascript
// daemon-background-runner.js:102-106
const native = collectNativeResult(runtime, commandResult.output);
if (native.classifiedError) {
  return { ok: false, error: native.classifiedError.message, errorCode: native.classifiedError.code };
}
const normalized = structured ? normalizeCompletionResult(native.finalValue) : native.finalValue;
```

**Issue:**
- If output buffer fills (stdoutBufferMode='tail'), last N bytes might be partial JSON
- `collectNativeResult` tries to parse each line, might extract incomplete structured output
- `normalizeCompletionResult` then fails parsing the partial JSON
- Error message is generic "completion_result_not_json" but root cause (buffer overflow) is hidden
- No indication to user that output was truncated

**Reproduction:**
1. Goal produces verbose maker output (logs, intermediate results)
2. Tail buffer fills with last 1MB of output, which ends mid-JSON
3. Line: `{"status": "candidate_complete", "summary": "done", "artifacts": ["a.txt", "b...` (truncated)
4. Parser fails: `SyntaxError: Unexpected end of JSON input`
5. User sees "completion_result_not_json" with no hint that output was truncated

**Minimal Fix:**
Detect and reject partial buffers:
```javascript
// daemon-background-runner.js:88
// Add buffer exhaustion check
if (commandResult.output && commandResult.output.length >= maxStdoutBytes * 0.95) {
  return {
    ok: false,
    error: 'output_buffer_exhausted: structured output may be incomplete',
    errorCode: 'BUFFER_LIMIT',
  };
}
```

---

## P0/P1 Summary

| Issue | File | Line | Impact | Status |
|-------|------|------|--------|--------|
| Buffer mode switching | daemon-background-runner.js | 88 | Structured output parsing may fail silently | **OPEN** |
| Codex permission default | daemon-engine-runtime.js | 386, 424 | Full access + no approvals by default | **OPEN** |
| Feature flag logging | daemon-default.yaml | 195-196 | Silent path switching on flag flip | **OPEN** |
| Resume contract diff | daemon-engine-runtime.js | 331, 412 | Different behavior for __continue__ sessions | **OPEN** |
| Worktree cleanup | daemon-workspace-broker.js + daemon-loop-reconciler.js | 47 + impl | Stale branches pollute main repo | **OPEN** |
| Detached process leaks | core/handoff.js + daemon.js | 180 + 20-33 | Orphaned processes on restart | **OPEN** |
| Partial buffer parsing | completion-contract.js + daemon-background-runner.js | 102 | Truncated JSON parsed as corruption | **OPEN** |

---

## Recommendation

All 7 P0/P1 issues should be addressed before loop v2 transitions to execute mode. Suggest prioritizing:

1. **P0-1 & P1-5** (buffer handling) — blocks reliable structured output
2. **P0-2** (permission escalation) — blocks safe Codex integration
3. **P1-2** (resume contract) — blocks persistent session correctness
4. **P1-3 & P1-4** (cleanup) — blocks production stability

---

## Files Passing Review

- `core/loop-state.js` — State machine properly defined
- `core/loop-contract.js` — Contract normalization solid
- `daemon-verifier.js` — Deterministic verification sound
- `daemon-loop-coordinator.js` — Run orchestration logic correct (given upstream contracts fixed)
- `daemon-loop-reconciler.js` — Outbox retry logic correct
- `control-db.js` — DB schema and ownership clear
- `loop-store.js` — Transaction semantics correct

---

**CONCLUSION:** No passing grade without addressing buffer handling and permission escalation.
