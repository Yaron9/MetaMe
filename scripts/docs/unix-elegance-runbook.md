# Unix Elegance Runbook

## Loop
1. Implement one narrow slice.
2. Run targeted tests and lint.
3. Send a focused code review.
4. Fix findings.
5. Re-run the same verification set.
6. Append the outcome to `scripts/docs/unix-elegance-log.md`.
7. Only then open the next slice.

## Current Focus
- Lane: `handoff`
- Slice: unify live streaming event handling and buffered-tail folding in `scripts/daemon-claude-engine.js`

## Verification Baseline
- `node --test scripts/core/handoff.test.js`
- `node --test scripts/daemon-claude-engine.test.js`
- `node -c scripts/daemon-claude-engine.js`
- `npx eslint scripts/daemon-claude-engine.js scripts/core/handoff*.js`

## Recovery
- Run `bash scripts/bin/bootstrap-worktree.sh` if worktree dependencies drift.
- Read `SESSION_START.md`, `scripts/docs/unix-elegance-task.yaml`, and `scripts/docs/unix-elegance-log.md` before continuing after context loss.

## Boundaries
- Keep `handoff` focused on spawn, signal, stdin/stdout/stderr lifecycle, timeout, and child cleanup.
- Do not mix `memory`, `session`, `routing`, or higher-level orchestration semantics into `scripts/core/handoff.js`.
