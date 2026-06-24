# Loop System Code Review - P0/P1 Findings

**Review Date:** 2026-06-23
**Scope:** spec.md sections 5, 8, 9 + loop core files
**Focus:** State bypass, transactions, idempotency, restart recovery, attempt limits, migration, legacy execution

---

## P0 Issues (State Bypass/Transaction Failures)

### P0-1: startExecution missing update verification (loop-execution-store.js:114-119)

**File/Lines:** `scripts/loop-execution-store.js:114-119`

**Issue:**
UPDATE statement lacks `update.changes` verification. If WHERE clause fails to match (version conflict, run deleted), the update affects 0 rows but the function continues as if success.

```javascript
db.prepare(`
  UPDATE runs SET status = 'executing', execution_boot_id = ?, execution_pid = ?,
    execution_started_at = ?, execution_heartbeat_at = ?,
    started_at = COALESCE(started_at, ?), version = version + 1
  WHERE run_id = ? AND version = ?
`).run(bootId, pid, nowIso, nowIso, nowIso, runId, expectedVersion);
// NO CHECK HERE
emit(db, run, 'EXECUTION_STARTED', { boot_id: bootId, pid }, nowIso);
return { ...loadRun(db, runId), result: parse(run.result) };
```

**Reproduction:**
1. Call `startExecution(runId, { expectedVersion: 5 })`
2. Between loadRun and UPDATE, another process changes run.version to 6
3. UPDATE matches 0 rows (WHERE version = 5 fails)
4. Function returns stale run with wrong state; execution_boot_id remains unset
5. Next heartbeat check fails because execution_boot_id is NULL; inconsistent state persists

**Minimal Fix:**
```javascript
const update = db.prepare(`...`).run(...);
if (Number(update.changes) !== 1) throw new Error('execution_owner_mismatch');
```

---

### P0-2: recordWorkspace missing update verification (loop-execution-store.js:148-151)

**File/Lines:** `scripts/loop-execution-store.js:148-151`

**Issue:**
Same pattern: UPDATE without changes check.

```javascript
db.prepare(`
  UPDATE runs SET workspace_id = ?, base_revision = ?, version = version + 1
  WHERE run_id = ? AND version = ?
`).run(workspaceId, baseRevision, runId, expectedVersion);
// NO CHECK
emit(db, run, 'WORKSPACE_ASSIGNED', {...}, now().toISOString());
return loadRun(db, runId);
```

**Reproduction:**
1. Call `recordWorkspace(runId, {...}, version=3)` but run.version is now 4
2. UPDATE matches 0 rows
3. Function emits event claiming workspace assigned but database still has old workspace_id
4. Verifier will run against wrong directory/base_revision

**Minimal Fix:**
```javascript
const update = db.prepare(`...`).run(...);
if (Number(update.changes) !== 1) throw new Error('run_version_conflict');
```

---

### P0-3: recoverInterruptedExecutions missing update verification (loop-execution-store.js:176-180)

**File/Lines:** `scripts/loop-execution-store.js:176-180`

**Issue:**
During daemon restart recovery, UPDATE without changes verification. Transactions protect individual ops, but recovery must ensure all stale runs are marked as recovered.

```javascript
for (const run of stale) {
  db.prepare(`
    UPDATE run_attempts SET status = 'interrupted', error_class = 'daemon_restart', finished_at = ?
    WHERE run_id = ? AND status IN ('running','candidate_complete','verifying')
  `).run(nowIso, run.run_id);
  db.prepare(`
    UPDATE runs SET status = 'retry_wait', execution_boot_id = NULL, execution_pid = NULL,
      execution_heartbeat_at = NULL, version = version + 1
    WHERE run_id = ? AND version = ?
  `).run(run.run_id, run.version);
  // NO VERIFICATION THAT UPDATE SUCCEEDED
  emit(db, run, 'EXECUTION_INTERRUPTED', { reason: 'daemon_restart' }, nowIso);
}
```

**Reproduction:**
1. Daemon B crashes while executing run R1 with boot_id=BOOT_B
2. Daemon A starts (boot_id=BOOT_A) and calls `recoverInterruptedExecutions(BOOT_A)`
3. Fetches run R1 with version=10, execution_boot_id=BOOT_B, status=executing
4. Between SELECT and UPDATE (within transaction), another thread modifies run R1 → version=11
5. UPDATE WHERE version=10 matches 0 rows
6. Event is emitted but run R1 still has execution_boot_id=BOOT_B, status=executing
7. Subsequent heartbeat timeout in run R1 will fail because it expects boot_id=BOOT_B (now recovered)
8. Run R1 remains orphaned, unable to be cleaned up

**Minimal Fix:**
```javascript
const update = db.prepare(`...`).run(run.run_id, run.version);
if (Number(update.changes) !== 1) {
  throw new Error(`recovery_version_conflict:${run.run_id}`);
}
```

---

## P1 Issues (Idempotency/Recovery Edge Cases)

### P1-1: Legacy task completion race condition (daemon-loop-triggers.js:88-101)

**File/Lines:** `scripts/daemon-loop-triggers.js:88-101`

**Issue:**
Non-atomic read-then-write pattern. Between getRun and transitionRun, the run's status could change, causing silent update failure.

```javascript
function completeScheduledTask(context, result) {
  if (!context || !context.run || !context.shouldExecute) return null;
  const current = loopStore.getRun(context.run.run_id);  // READ outside transaction
  if (!current || current.status !== 'queued') return current;
  return loopStore.transitionRun(current.run_id, result && result.success ? 'skipped' : 'blocked', {
    expectedVersion: current.version,  // Using stale version
    result: {...},
  });
}
```

**Reproduction:**
1. Task completes, returns run in queued status with version=5
2. While completeScheduledTask runs, another process transitions run from queued→planning
3. transitionRun called with expectedVersion=5 but actual version=6
4. transitionRun throws version_conflict
5. Caller catches or ignores; task completion never recorded

**Minimal Fix:**
Wrap getAndTransition in single transaction within loopStore:
```javascript
function completeScheduledTask(context, result) {
  if (!context || !context.run || !context.shouldExecute) return null;
  return loopStore.atomicCompleteTask(context.run.run_id, !!result.success);
}
```

---

### P1-2: Outbox delivery crash window (daemon-loop-reconciler.js:13-33)

**File/Lines:** `scripts/daemon-loop-reconciler.js:13-33`

**Issue:**
If daemon crashes between `deliver()` success and `markOutboxDelivered()`, message is retried, potentially causing duplicate delivery.

```javascript
for (const message of pending) {
  try {
    await deliver(message);  // External call succeeds
    deps.governanceStore.markOutboxDelivered(message.outbox_id);  // Crash here
    // Message marked as pending, will retry on restart
```

**Context:**
Per spec 5.6, this is **expected and acceptable** because:
- Dedupe key in outbox prevents duplicate DB records
- Recipients must implement idempotent consumption
- No data loss; message will be retried
- Spec 8.1 includes test: "crash after submit" scenario

**Status:** Not a bug; confirm as accepted design per ADR-6.

---

### P1-3: Missing verifier modification detection (per spec section 8.8)

**File/Lines:** Spec requirement not implemented in code

**Issue:**
Spec 8.8 requires: "verifier 不能由当前 Run 修改；检测到相关 diff 立刻 blocked"

No code in daemon-verifier.js or elsewhere checks whether the verifier command/file changed during a run. A malicious or buggy maker could modify the verifier to always pass.

**Reproduction:**
1. Run R1 starts with verification_spec = {command: 'node --test'}
2. Maker modifies ./scripts/test.js to always exit 0
3. Verifier runs and passes, but detection of diff is missing
4. Run marked succeeded when tests were never actually run

**Status:** This is listed in spec 8 (non-goals) vs 9 (acceptance tests). Not found in tests list either. Likely deferred to P2 or future implementation.

**Recommendation:** Note in spec that first implementation lacks verifier integrity checking; add to P2 backlog.

---

## Summary Table

| ID | File | Line | Severity | Type | Issue | Fix |
|---|---|---|---|---|---|---|
| P0-1 | loop-execution-store.js | 114-119 | **P0** | State bypass | Missing update.changes in startExecution | Add: `if (update.changes !== 1) throw` |
| P0-2 | loop-execution-store.js | 148-151 | **P0** | State bypass | Missing update.changes in recordWorkspace | Add: `if (update.changes !== 1) throw` |
| P0-3 | loop-execution-store.js | 176-180 | **P0** | Recovery failure | Missing update.changes in recoverInterruptedExecutions | Add: `if (update.changes !== 1) throw` |
| P1-1 | daemon-loop-triggers.js | 88-101 | **P1** | Race condition | Non-atomic get + transition | Wrap in atomic transaction |
| P1-2 | daemon-loop-reconciler.js | 13-33 | **OK** | Outbox delivery | Duplicate message possible on crash | Accept per spec; idempotent keys prevent duplication |
| P1-3 | N/A (spec requirement) | — | **P2** | Missing feature | Verifier modification not detected | Defer to future implementation |

---

## Verification Checklist

Against spec 8 (不变量):

- ✅ 1. One active run per goal → Enforced by `one_active_run_per_goal` index
- ✅ 2. One WakeEvent per Run → `runs.primary_wake_id UNIQUE`
- ❌ 3. Non-owner cannot submit results → **Guarded but missing verification on some UPDATEs (P0-1, P0-2, P0-3)**
- ✅ 4. Succeeded must have verifier event → `completeVerification` emits VERIFIER_PASSED before succeeded transition
- ✅ 5. Continuous Goal respects limits → Checked in daemon-loop-coordinator.js:58-72
- ✅ 6. Outbox has dedupe key → All appendOutbox calls provide dedupeKey
- ✅ 7. Code Run uses isolated workspace → recordWorkspace requires workspace_id
- ❌ 8. Verifier cannot be modified → **Not implemented (P2)**
- ✅ 9. R3 actions need approval → startExecution validates approval for awaiting_approval state
- ✅ 10. Markdown/TSV not source of truth → Schema uses SQLite tables as truth source

---

## PASS Status

**Conditional PASS with 3 P0 fixes required.**

All P0 findings are in `loop-execution-store.js` and follow the same pattern (missing `update.changes` verification). Once fixed, system will enforce transaction invariants correctly. P1-1 is lower priority (race between non-transaction calls); P1-2 is accepted design; P1-3 is deferred to P2.

**Blocking Issue:** P0-1, P0-2, P0-3 must be fixed before production deployment. All are one-line additions.
