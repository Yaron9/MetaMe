# MetaMe scoped agy Engine Plugin integration record

> Status: Implemented historical migration record; current architecture is governed by the universal Engine Plugin contract and ADR 0003.
> Scope: scoped foreground AGY plus isolated background subconscious inference
> Last reviewed: 2026-07-17

## 1. Decision

MetaMe added `agy` as a scoped Engine Plugin without changing the configured default descriptor, desktop CLI entrypoints, or the behavior of existing registered plugin sessions.

Foreground and background are deliberately separate boundaries:

- Existing `digital_me`（3D）and `munger`（芒格）bindings keep their configured foreground AGY sessions and tool permissions.
- Model-backed maintenance uses the configured distill engine (`agy/auto` by default) in an isolated cwd, read-only, with tools and MCP disabled.
- Deterministic maintenance such as memory GC/indexing, embeddings, and OpenWiki projection does not receive AGY engine labels or environment variables.
- A model-backed scheduled task gets at most three attempts (initial run, then 1-minute and 5-minute retries). Retry state is durable across daemon restarts. Only terminal success or terminal failure is sent through the existing admin notification channel.

The integration follows a Unix adapter model:

```text
MetaMe prompt
    -> agy protocol adapter (stdin)
    -> PTY-hosted agy process
    -> agy cache + transcript
    -> normalized JSONL events (stdout)
    -> existing MetaMe handoff/streaming pipeline
```

Antigravity-specific behavior stays at the process boundary. Core handoff code consumes the same normalized event vocabulary it already uses and must not read Antigravity files directly.

## 2. Goals

1. Allow the `digital_me` and `munger` projects to select `engine: agy` for daemon-driven chat turns.
2. Route model-backed wiki, distillation, memory, reflection, skill-evolution, and health-analysis maintenance through the shared background inference interface.
3. Preserve conversation continuity through agy's durable conversation IDs.
4. Reuse each workspace's existing instructions, skills, MCP configuration, credentials, and output files without copying credentials into MetaMe.
5. Provide a deterministic rollback to the current engines:
   - `digital_me` -> `claude`
   - `munger` -> `codex`
6. Keep all existing built-in plugin tests and runtime behavior unchanged.

## 3. Non-goals

The first release does not add:

- a global `metame agy` desktop command;
- global `/engine agy` switching;
- automatic agy selection for newly created Agents;
- agy support for projects other than `digital_me` and `munger`;
- agy session discovery in the general `/resume` browser;
- `/compact` support for agy;
- warm-process pooling;
- token/usage accounting beyond the existing text-length estimate;
- byte-identical streaming parity with every other built-in plugin;
- automatic import, mutation, or credential migration of Antigravity plugins/MCP servers.

## 4. Current-state findings

### 4.1 Engine routing

The daemon route is:

```text
chat_agent_map -> project -> project.engine -> getEngineRuntime()
```

The runtime interface already normalizes engine output into `session`, `text`, `tool_use`, `tool_result`, `done`, and `error` events. This historical record captured several legacy two-name choices that Ticket #22 now keeps behind plugin boundaries:

- `daemon-utils.js:normalizeEngineName()` rejects every value except `claude` and `codex`;
- `daemon-engine-runtime.js` resolves only the two existing binaries and models;
- `daemon-session-store.js` treats non-Codex sessions as Claude sessions;
- `daemon-admin-commands.js`, Agent creation, scheduler selection, orphan cleanup, and diagnostics contain explicit two-engine branches.

Unknown engine values currently degrading to Claude is a compatibility behavior. It must remain true for genuinely unknown values, but `agy` must become a recognized value only when its feature gate permits the current project.

### 4.2 agy protocol observed on this machine

The installed `agy` CLI exposes:

- `--print` / `-p` for a non-interactive turn;
- `--conversation <uuid>` for continuation;
- `--continue` for the most recent conversation;
- `--model`;
- `--dangerously-skip-permissions`;
- `--print-timeout`;
- `--add-dir`;
- plugin import from Claude or Gemini.

Its durable state is under `~/.gemini/antigravity-cli/`:

- `cache/last_conversations.json`: latest conversation UUID keyed by canonical cwd;
- `conversations/<uuid>.pb`: durable conversation data;
- `brain/<uuid>/.system_generated/logs/transcript.jsonl`: readable event transcript;
- `log/cli-*.log`: diagnostic log, not a source of truth.

Observed transcript records include `USER_INPUT`, `PLANNER_RESPONSE`, `RUN_COMMAND`, `VIEW_FILE`, `LIST_DIRECTORY`, `SEARCH_WEB`, `ERROR_MESSAGE`, and `SYSTEM_MESSAGE`, with `RUNNING`, `DONE`, and `ERROR` statuses.

`agy -p` is TTY-sensitive in headless callers. A normal piped `spawn()` can exit successfully with empty stdout. Therefore PTY hosting is a correctness requirement, not an optimization.

### 4.3 Project-specific dependencies

`digital_me` currently uses Claude and has:

- project instructions in `AGENTS.md` and `CLAUDE.md`;
- project skills under `.claude/skills/`, including publish preflight/orchestration and platform publishers;
- `.mcp.json` servers used by its research/publishing workflow;
- external credentials and browser login state that must remain in their current locations;
- side-effecting publication steps whose duplicate execution is unacceptable.

`munger` currently uses Codex and has:

- project instructions in `AGENTS.md` and `CLAUDE.md`;
- an `akshare-stock` MCP server in `.mcp.json`;
- two enabled heartbeat analysis tasks;
- no task-level engine override, so the current scheduler actually defaults those tasks to Claude rather than inheriting the project's Codex engine.

## 5. Design principles

### 5.1 One adapter, one responsibility

The agy adapter owns only:

- PTY process launch and termination;
- conversation cache snapshot/capture;
- transcript cursoring and parsing;
- agy error classification;
- conversion to MetaMe normalized JSONL events.

It does not own routing, cards, memory, publishing policy, heartbeat scheduling, or project configuration.

### 5.2 Files are the agy API of last resort

Use the CLI for execution and continuation. Read the cache/transcript only because the CLI does not expose a structured event stream. Never modify protobuf conversation files, transcript files, agy settings, or agy logs.

### 5.3 Add capability, do not emulate parity

Callers test declared capabilities instead of checking engine names. Initial agy capabilities are:

```js
{
  interactiveTurns: true,
  backgroundTurns: true,
  durableSessions: true,
  structuredEvents: 'adapter',
  nativeUsage: false,
  compact: false,
  warmPool: false,
  outputSchema: false,
  projectMcp: 'probe-required',
  projectSkills: 'probe-required',
}
```

### 5.4 No speculative fallback after side effects may begin

Automatic fallback is allowed only before agy starts executing the user prompt, for example binary missing, unsupported platform, failed capability preflight, or authentication unavailable.

After the prompt has been accepted by agy, timeout, transcript failure, process crash, or ambiguous completion must be surfaced as an error. MetaMe must not replay the same 3D publication request on Claude because the first attempt may already have published content.

## 6. Proposed module boundaries

### 6.1 Engine identity

Keep the single source of truth in `scripts/daemon-utils.js`:

- export `ENGINE_NAMES = ['claude', 'codex', 'agy']`;
- make `normalizeEngineName()` recognize `agy`;
- retain the existing fallback for unknown values;
- add a pure `isKnownEngineName()` helper where rejection, rather than fallback, is required.

No module may independently normalize an engine with `=== 'codex' ? 'codex' : 'claude'` after this change.

### 6.2 agy protocol adapter

Add `scripts/bin/agy-adapter.js` as an executable Node process.

Input:

- request metadata through arguments: cwd, model, conversation ID, timeout, permission mode;
- the composed MetaMe prompt through adapter stdin. The installed agy 1.0.0
  requires the prompt as the value of `-p`; the adapter therefore forwards the
  bounded prompt as one argv element to agy without shell interpolation.

Output:

- stdout: normalized JSONL events only;
- stderr: bounded human-readable diagnostics only;
- exit code: non-zero when no valid terminal result can be established.

The adapter launches `agy` inside a PTY. The initial macOS implementation may use `/usr/bin/script` without shell interpolation. Platform-specific PTY construction is isolated behind a small internal function and returns `UNSUPPORTED_PLATFORM` elsewhere until a tested implementation exists.

The adapter must never concatenate an executable shell command. Arguments are passed as arrays and prompt transport is capped at 512 KiB. On agy 1.0.0 the prompt is briefly visible to local process-list readers; this is an upstream CLI limitation. A future agy version with stdin/file prompt support may remove that exposure without changing the runtime contract.

### 6.3 Pure agy state helpers

Add `scripts/core/agy-state.js` for pure or dependency-injected logic:

- canonical cwd key resolution;
- tolerant cache parsing with one retry for torn reads;
- before/after conversation capture;
- transcript cursor calculation;
- transcript record normalization;
- terminal response selection;
- tool name mapping;
- stale-lock decisions.

Only this module knows Antigravity transcript record names. It returns data and intent flags; filesystem reads, polling, locking, and process control remain in `agy-adapter.js`.

### 6.4 Runtime registration

Extend `scripts/daemon-engine-runtime.js` with an agy runtime whose binary is Node and whose executable entry is `scripts/bin/agy-adapter.js`.

The runtime continues to satisfy the existing contract:

```js
{
  name,
  binary,
  defaultModel,
  capabilities,
  stdinBehavior,
  killSignal,
  timeouts,
  buildArgs,
  buildEnv,
  parseStreamEvent,
  classifyError,
}
```

`parseAgyStreamEvent()` parses only the adapter's normalized JSONL. It does not parse raw TUI output.

`ENGINE_MODEL_CONFIG.agy.main` initially uses `auto`, meaning no `--model` argument. Model discovery and quick-pick UI are deferred until verified against the installed CLI.

### 6.5 Session backend

Extend `daemon-session-store.js` through explicit backend functions rather than another fallback branch:

```js
const sessionBackends = {
  claude: claudeSessionBackend,
  codex: codexSessionBackend,
  agy: agySessionBackend,
};
```

The agy backend validates a session by UUID plus at least one durable artifact:

- `conversations/<uuid>.pb`, or
- `brain/<uuid>/.system_generated/logs/transcript.jsonl`.

The cache's cwd mapping is supporting evidence, not mandatory validation, because a newer conversation in the same cwd can replace it.

General cross-plugin session listing is capability-driven. In the historical phase-1 implementation, the bound chat's stored `engines.agy` slot was sufficient for continuation; current `/sessions` uses registered Session Source Adapters.

### 6.6 Concurrency

Fresh agy runs in the same canonical cwd must be serialized until their conversation IDs are captured; otherwise `last_conversations.json` can attribute one run's UUID to another.

Use an atomic per-cwd lock under `~/.metame/runtime/agy-locks/`. The lock record contains PID, cwd hash, and creation time. Stale lock cleanup is explicit and tested. Continued runs with distinct known conversation IDs may run concurrently.

This is separate from MetaMe's per-chat patch queue: one protects agy's cwd-keyed cache, the other protects daemon state writes.

### 6.7 Scheduler

Replace scheduler-local binary coercion with the shared normalizer. Phase 1 requires an explicit task engine:

```yaml
projects:
  munger:
    engine: agy
    heartbeat_tasks:
      - name: morning-market-brief
        engine: agy
      - name: weekly-radar
        engine: agy
```

Do not silently introduce project-engine inheritance in the same change. Existing Munger tasks currently default to Claude; changing global inheritance semantics would be an unrelated behavior change.

Persistent heartbeat sessions may use the returned agy conversation UUID. Workflows share that UUID sequentially. A fresh-session collision returns a retryable busy result rather than silently queueing for an unbounded period.

### 6.8 Scoped feature gate

Add a daemon feature gate:

```yaml
daemon:
  experimental_engines:
    agy:
      enabled: false
      allowed_projects:
        - digital_me
        - munger
```

Rules:

1. Default is disabled.
2. `engine: agy` is accepted only when enabled and the resolved bound project is allowlisted.
3. Unbound chats and other projects cannot select agy.
4. The global default remains the configured default descriptor; agy is never auto-detected as the default.
5. Agent creation and natural-language engine selection do not advertise agy in phase 1.

This is a generic configuration gate, not a hardcoded `if project === 'munger'` in the execution path.

## 7. Prompt, identity, skills, and MCP

### 7.1 Identity and project instructions

MetaMe continues composing daemon, memory, intent, and language hints exactly once. On the first agy turn, the daemon prompt-context layer adds a minimal bootstrap instruction to read and follow the workspace's `AGENTS.md` and `SOUL.md` when present. It does not duplicate their full contents into every prompt. The protocol adapter receives the already-composed prompt unchanged and owns no prompt policy.

The existing memory snapshot remains prompt-injected by `buildAgentContextForEngine()`.

### 7.2 Skills

No global skill directories are copied or rewritten during initial rollout.

Before enabling 3D, a capability probe must demonstrate that agy can discover or explicitly follow the project-local `.claude/skills/<name>/SKILL.md` workflow for:

- `publish-preflight`;
- `publish-orchestrator`;
- `wechat-publisher`;
- `xiaohongshu-publisher`;
- any platform publisher included in the release canary.

If native discovery fails, the fallback design is a read-only skill resolver hint containing the exact project-local SKILL.md path. Do not transform skill contents or maintain a second copy.

### 7.3 MCP

`agy --help` does not expose a per-run `--mcp-config` flag. MetaMe therefore must not assume that Claude's project `.mcp.json` is loaded.

Before enabling each project, a read-only probe must verify:

- `digital_me`: required research/publishing server visibility;
- `munger`: `akshare-stock` visibility and one harmless query.

Live probing confirmed that agy 1.0.0 does not consume project `.mcp.json`.
Its hidden `--gemini_dir` / `--app_data_dir` switches are filesystem
virtualization roots rather than safe per-run config overrides, so MetaMe must
not use them or mutate the global MCP file. Munger may ship because its actual
daily path is the deterministic `quant_signals.py --json` script and its weekly
task already specifies WebSearch fallback. Any 3D publisher that strictly
requires an unavailable MCP server remains gated; script/CLI-based publishers
may pass their own capability canary.

## 8. Error contract

The adapter emits stable error codes:

- `AGY_NOT_INSTALLED`
- `AGY_AUTH_REQUIRED`
- `AGY_UNSUPPORTED_PLATFORM`
- `AGY_PTY_FAILED`
- `AGY_SESSION_NOT_FOUND`
- `AGY_SESSION_CAPTURE_FAILED`
- `AGY_TRANSCRIPT_UNAVAILABLE`
- `AGY_CWD_BUSY`
- `AGY_TIMEOUT`
- `AGY_EXEC_FAILURE`
- `AGY_CAPABILITY_MISSING`

Raw diagnostics are bounded and redacted before reaching chat. Error classification must not tell users to run `codex login` for agy failures.

## 9. Side-effect safety for 3D

Publication is the highest-risk path and has stricter rules:

1. Run `publish-preflight` before any publisher.
2. Preserve the workspace's existing publish-status file as the idempotency record.
3. Never replay a started publish turn automatically on another engine.
4. On timeout or ambiguous completion, inspect status/transcript and report `unknown outcome`; do not infer failure.
5. Preserve the existing per-platform update-after-success discipline.
6. Canary rollout starts with dry-run/preflight, then one reversible draft creation. Public publication requires the existing user confirmation semantics.

## 10. Configuration and rollback

Target configuration after successful probes:

```yaml
daemon:
  experimental_engines:
    agy:
      enabled: true
      allowed_projects: [digital_me, munger]

projects:
  digital_me:
    engine: agy
    model: auto
    fallback_engine: claude

  munger:
    engine: agy
    model: auto
    fallback_engine: codex
    heartbeat_tasks:
      - name: morning-market-brief
        engine: agy
      - name: weekly-radar
        engine: agy
```

`fallback_engine` is consulted only during pre-execution availability checks. It is not a general retry policy.

Rollback changes only project/task engine fields and disables the feature gate. Existing `engines.claude` and `engines.codex` session slots remain untouched; agy uses its own `engines.agy` slot.

## 11. Implementation slices

### Slice A: protocol foundation

- engine identity recognizes agy;
- pure cache/transcript helpers and tests;
- PTY adapter producing normalized JSONL;
- runtime registration and error classification;
- no project enabled.

### Slice B: daemon chat canary

- agy session slot and validation;
- scoped feature gate;
- Munger read-only interactive canary;
- stop/timeout/orphan cleanup support;
- rollback verification.

### Slice C: background analysis

- scheduler accepts explicit `engine: agy`;
- Munger heartbeat canary;
- conversation persistence and cwd concurrency tests;
- MCP capability probe.

### Slice D: 3D publishing

- project instruction and skill discovery probe;
- MCP/server probe;
- publish preflight dry run;
- draft-only publication canary;
- ambiguous-outcome and no-replay verification.

No later slice starts until the previous slice's acceptance criteria pass.

## 12. Tests and verification

### 12.1 Pure tests

Add tests for:

- known/unknown engine normalization;
- agy argument generation without shell interpolation;
- cache capture before/after and torn-read retry;
- transcript cursoring with partial final lines;
- final assistant response selection;
- tool/error event mapping;
- duplicate transcript polling;
- stale/fresh cwd locks;
- unknown-outcome classification;
- fallback eligibility before versus after execution starts.

### 12.2 Integration tests with a fake agy

The fake CLI must cover:

- fresh conversation creation;
- continuation by UUID;
- empty non-TTY stdout;
- PTY output;
- timeout and cancellation;
- malformed/torn cache;
- transcript unavailable;
- concurrent fresh runs in one cwd;
- independent runs in different cwd values;
- a completed side effect followed by process failure.

### 12.3 Regression suite

At minimum:

```bash
npx eslint scripts/daemon*.js
node --test scripts/daemon-*.test.js
node --test scripts/core/*.test.js
```

Existing registered-plugin snapshots, arguments, session routing, permission behavior, and scheduler defaults must remain unchanged.

### 12.4 Live acceptance

1. Feature disabled: daemon behavior is byte-for-byte equivalent where practical.
2. Munger interactive read-only question returns a non-empty response and stores `engines.agy.id`.
3. A second Munger turn uses the same conversation UUID.
4. Munger MCP probe returns a harmless stock-data result.
5. Each Munger heartbeat task completes once on explicit `engine: agy`.
6. 3D loads its project instructions and resolves a named project skill.
7. 3D publish preflight completes without external publication.
8. Draft canary updates the existing status record exactly once.
9. Killing an active agy process stops its PTY child and leaves no orphan.
10. Switching both projects back restores their previous engines without deleting any session slot.

## 13. Required code touchpoints

Expected source changes are limited to:

- `scripts/daemon-utils.js`
- `scripts/daemon-engine-runtime.js`
- `scripts/bin/agy-adapter.js` (new)
- `scripts/core/agy-state.js` (new)
- `scripts/daemon-session-store.js`
- `scripts/daemon-claude-engine.js` only for capability-driven behavior that cannot remain runtime-neutral
- `scripts/daemon-background-runner.js`
- `scripts/daemon-task-scheduler.js`
- `scripts/daemon.js` for registration, gate wiring, diagnostics, and orphan recognition
- `scripts/daemon-admin-commands.js` for scoped status/diagnostics only; no global switch
- corresponding focused tests
- maintenance and pointer documentation after implementation

Do not modify `plugin/scripts/` or `~/.metame/` directly. Deployment remains `node index.js` after all required tests pass.

## 14. Open validation items

These are implementation gates, not design ambiguities:

1. Confirm the exact installed agy version through a stable version interface; local changelog currently reports `1.0.0` while external wrappers test newer releases.
2. Confirm macOS `/usr/bin/script` argument behavior with long Unicode prompts and cancellation.
3. Confirm whether agy natively discovers project `AGENTS.md` and `.agents/skills`/`.claude/skills`.
4. Confirm whether project `.mcp.json` is consumed, or document the required project-owned agy MCP configuration.
5. Confirm transcript completion semantics when the final `PLANNER_RESPONSE` also contains tool calls.
6. Confirm whether the CLI cache update is atomic; retain torn-read handling regardless.

Failure of items 3 or 4 blocks 3D publication rollout but does not block the Munger runtime foundation.

## Format sentinel (2026-07, plan P2.3)

The adapter now runs `assessTranscriptFormat` (core/agy-state.js) before any
recovery round: a transcript whose records match zero known types (USER_INPUT /
PLANNER_RESPONSE / tool types / GENERIC / ERROR_MESSAGE) is treated as an
Antigravity schema change and fails fast with `AGY_TRANSCRIPT_FORMAT_DRIFT`
instead of degrading into silent empty replies. When this fires, update the
known-type set and normalization in core/agy-state.js against the new schema.
