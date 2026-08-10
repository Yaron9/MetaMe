# MetaMe Universal Agent CLI Infrastructure

Status: Proposed implementation design

Decision baseline: `scripts/docs/adr/0001-separate-agent-runtime-session-and-cognitive-adapters.md`

## 1. Outcome

MetaMe becomes a user-owned Agent Runtime and Cognitive Plane that can:

1. invoke independently installed Agent CLIs through stable execution contracts;
2. preserve native session continuity without owning Agent internals;
3. discover and normalize eligible native sessions;
4. derive traceable Episodes, Claims, Synthesis, and Capability candidates;
5. expose cognition to every capable Host through a small common interface;
6. add an Agent without introducing engine branches throughout the daemon.

The target is a modular monolith with explicit ports and adapters. Implementation may be incremental, but every landed slice must use the final contracts defined here. No throwaway protocol, duplicate pipeline, or permanent compatibility layer is allowed.

## 2. Scope

### In scope

- Trusted local Agent CLIs installed independently from MetaMe.
- Built-in Engine Plugins for Claude, Codex, agy, and Pi.
- A language-neutral subprocess protocol for future external adapters.
- Native session discovery from files, SQLite, or a Host-supported local API.
- Incremental, provenance-preserving cognitive ingestion.
- MCP-based cognitive consumption and Host capability diagnosis.
- Per-capability degradation when an Agent lacks resume, streaming, session discovery, usage, tools, or MCP.

### Out of scope

- Treating every LLM provider or HTTP model API as an Agent CLI.
- Replacing native Host authentication, model configuration, tools, or sandboxing.
- Loading arbitrary third-party JavaScript into the daemon process.
- Copying every native transcript into MetaMe by default.
- Assuming every Host supports every MetaMe feature.
- A distributed plugin marketplace, service mesh, message bus, or microservice split.
- Remote Agent transport. A future remote transport may implement the same stable ports, but it is not part of this CLI-focused product boundary.

## 3. Architectural invariants

1. **One component, one reason to change.** Execution, session observation, cognitive connection, extraction, and persistence are separate modules.
2. **Host-specific data stops at the adapter boundary.** Core modules never branch on Claude, Codex, Pi, or agy event shapes.
3. **Capabilities are declared and verified.** Engine identity never implies feature parity.
4. **Native sessions remain opaque to execution core.** Only the owning adapter creates, validates, resumes, or interprets a native session handle.
5. **Episodes are evidence, not truth.** No Agent output enters trusted memory without the normal verification and promotion rules.
6. **Provenance survives derivation.** Every derived asset can identify its source revision and extraction run.
7. **At-least-once ingestion, idempotent effects.** Repeated discovery or crashes cannot duplicate durable cognitive assets.
8. **No shell interpolation.** Commands and arguments are arrays; executable resolution and environment construction are explicit.
9. **External code is isolated.** Third-party adapters run as child processes with bounded input, output, environment, and permissions.
10. **Core remains policy-free where possible.** Pure logic returns decisions and intent flags; edge modules perform I/O.
11. **Compatibility is tested, not inferred.** Installed, configured, reachable, protocol-compatible, and behaviorally verified are distinct states.
12. **Migration does not create a second architecture.** Existing engines move directly onto the final plugin contract.

## 4. Context boundaries

```text
Inbound channels and scheduler
             |
             v
        Run Coordinator
             |
             v
       Engine Registry ---------------- Capability/health view
             |
       Engine Plugin
      /      |       \
 Runtime  Session   Cognitive
 Adapter  Source    Host Adapter
    |        |          |
 Agent CLI  Native     MCP / Skills /
            Session    Context projection
                \
                 v
          Cognitive Ingestion
                 |
      Episode -> Claim -> Synthesis/Capability
                 |
          Cognitive Plane / MCP
```

### 4.1 Run Coordinator

Owns run lifecycle orchestration only: routing, timeout policy, cancellation, normalized event delivery, and durable session-slot updates. It does not construct engine-specific arguments or inspect transcript files.

### 4.2 Engine Registry

Owns Engine Plugin identity, uniqueness, protocol version, descriptor validation, and capability lookup. Unknown engine IDs remain distinguishable from a configured fallback; lookup must never silently present the fallback as the requested engine.

### 4.3 Cognitive Ingestion

Consumes only canonical Session Sources and events. It does not scan Claude or Codex directories itself and does not know native event schemas.

### 4.4 Cognitive Plane

Owns canonical Claims, Episodes, Synthesis, Profile, policies, Skills, retrieval, consistency, provenance, and consumption audit. MCP is one delivery protocol for this plane, not its internal domain model.

## 5. Engine Plugin contract

An Engine Plugin is immutable metadata plus optional adapters:

```js
{
  protocolVersion: 1,
  descriptor,
  runtime: RuntimeAdapter | null,
  sessionSource: SessionSourceAdapter | null,
  cognitiveHost: CognitiveHostAdapter | null,
}
```

Absence is meaningful. A Host may expose cognition but not be runnable, or be runnable without exposing native session history.

### 5.1 Descriptor

The descriptor is pure data and contains:

```js
{
  id,
  displayName,
  vendor,
  executableNames,
  contextProjection,
  nativeSessionKind,
  capabilities,
  configSchemaVersion,
}
```

Capability fields use explicit states where operationally relevant:

```text
unsupported -> detected -> configured -> reachable -> verified
```

Boolean declarations are acceptable only for intrinsic format traits. Runtime health must not be collapsed into a boolean.

### 5.2 Runtime Adapter

Required operations:

```js
probe(runtimeContext) -> RuntimeProbe
buildInvocation(runRequest) -> ProcessInvocation
parseEvent(nativeRecord) -> RunEvent[]
classifyFailure(nativeFailure) -> EngineFailure
validateSession(nativeSession, context) -> SessionValidation
updateSession(previous, observation) -> NativeSession
```

`ProcessInvocation` contains an executable, argument array, bounded environment delta, cwd, stdin strategy, output framing, kill strategy, and timeouts. It never contains a shell command string.

The existing `scripts/engines/native-cli-adapter.js`, `native-cli-turn.js`, `core/handoff.js`, and platform process helpers are the implementation base. Their engine-neutral behavior is retained; engine branches move behind adapters.

### 5.3 Normalized run events

The stable event vocabulary is deliberately small:

```text
run_started
session_observed
message_delta
thinking_delta
tool_started
tool_updated
tool_finished
usage_observed
run_completed
run_failed
```

Every event carries `runId`, `engineId`, monotonic sequence, timestamp, and an engine-native provenance reference when available. Terminal events are exclusive. Unknown native events are ignored or preserved as bounded diagnostics; they never leak directly into daemon business logic.

### 5.4 Session Source Adapter

Required operations:

```js
probe(sourceContext) -> SessionSourceProbe
discover(discoveryRequest) -> AsyncIterable<SessionRef>
inspect(sessionRef) -> SessionRevision
read(sessionRef, readRequest) -> AsyncIterable<CanonicalSessionEvent>
validate(sessionRef) -> SessionValidation
```

`SessionRef` is opaque outside its adapter except for stable identity and routing metadata:

```js
{
  engineId,
  nativeSessionId,
  sourceLocator,
  project,
  cwd,
}
```

`SessionRevision` contains a content fingerprint, size, first/last timestamps, and optional append cursor. A revision changes whenever eligible source evidence changes. The existing `source_hash` is the revision identity; no parallel revision column is introduced.

### 5.5 Canonical session events

```js
{
  eventId,
  engineId,
  nativeSessionId,
  sourceRevision,
  sequence,
  timestamp,
  actor,       // user | assistant | tool | system
  kind,        // message | tool_call | tool_result | checkpoint
  text,
  tool,
  outcome,
  provenance,
}
```

Adapters normalize structure only. They must not decide that a statement is true, useful, memorable, or promotable.

### 5.6 Cognitive Host Adapter

Required operations:

```js
detect(hostContext) -> HostDetection
inspectCapabilities(hostContext) -> HostCapabilityReport
planInstall(hostContext) -> ReversibleChangePlan
verify(hostContext) -> HostVerification
```

Detection and verification are read-only. Installation or repair produces an explicit reversible plan and requires authorization before mutating Host configuration.

This adapter does not run prompts and does not read native sessions.

## 6. External adapter process protocol

Built-in adapters remain ordinary repository modules. Future third-party adapters execute out of process and communicate using strict LF-delimited JSON over stdin/stdout.

The protocol begins with a versioned handshake and capability declaration. Requests include a correlation ID; responses and events repeat it. Records are bounded, schema-validated, and stdout is protocol-only. Human diagnostics go to bounded stderr.

```json
{"type":"initialize","protocolVersion":1,"engineId":"example"}
{"type":"initialized","protocolVersion":1,"capabilities":{}}
```

The protocol supports `probe`, `run`, `cancel`, `session.discover`, `session.inspect`, `session.read`, and `shutdown`. An adapter that does not declare a capability must return a stable `CAPABILITY_UNSUPPORTED` error rather than emulate it.

Security rules:

- explicit installation and allowlisting;
- resolved executable path recorded during verification;
- no shell execution;
- environment allowlist plus credential redaction;
- cwd restricted to the selected project;
- output, record, prompt, and stderr limits;
- timeout and process-tree termination owned by MetaMe;
- protocol version and manifest schema validated before launch;
- no adapter may mutate MetaMe identity, policy, or credential stores.

## 7. Cognitive ingestion pipeline

```text
discover
  -> fingerprint
  -> claim ingestion lease
  -> normalize events
  -> sanitize and classify evidence
  -> assemble Episode
  -> extract candidates
  -> resolve identity/scope/time
  -> verify and detect conflicts
  -> promote Canonical Claims
  -> mark dependent Synthesis stale
  -> derive Wiki/Capability candidates
  -> audit later consumption and outcomes
```

### 7.1 Revision and idempotency

Processing identity is:

```text
engine_id + native_session_id + source_revision + pipeline_version
```

A session ID alone is never a sufficient processed marker because native sessions can grow after their first extraction. Crashes may repeat work; database uniqueness and deterministic canonical keys make effects idempotent.

### 7.2 Source ownership

MetaMe does not copy complete native transcripts by default. It stores:

- stable source identity;
- opaque locator;
- revision hash and source metrics;
- bounded evidence references or excerpts required for provenance;
- extraction-run status and errors;
- derived Episodes, Claims, and lineage.

Optional encrypted archival of original sessions, if ever added, is a separate user-controlled product capability and not an ingestion prerequisite.

### 7.3 Sanitization

Before extraction, the pipeline excludes or bounds:

- system/bootstrap prompts;
- injected memory and duplicated context packages;
- secrets and credential-shaped values;
- binary or oversized tool output;
- subagent sessions already owned by a parent run;
- generated summaries that would recursively re-enter as original evidence.

Sanitization records classifications and counts, not sensitive discarded bodies.

### 7.4 Authority and promotion

Evidence authority, from strongest to weakest:

1. explicit user correction or approval;
2. current authoritative code, configuration, or deterministic test evidence;
3. verified task outcome;
4. repeated independent observations;
5. Agent conclusion or self-report.

Low-authority evidence may create a candidate or Episode but cannot silently replace an active Claim. Scope and validity interval are evaluated before declaring a contradiction. Unresolved conflicts are isolated from normal recall.

### 7.5 Derived knowledge

Synthesis and Capability records retain dependency links to source Claims and Episodes. A changed or invalidated dependency marks derived assets stale or review-required; it does not delete them automatically.

Consumption signals are recorded separately from truth and promotion. A frequently retrieved claim is not necessarily true, and a rarely retrieved safety rule is not necessarily low value.

## 8. Persistence model

Reuse the existing SQLite memory infrastructure and extend it rather than adding a second database.

### `session_sources`

Retains source identity and revision provenance. Engine IDs use a stable validated identifier syntax and are never reused. The active Engine Registry validates new work, while persistence continues to preserve and read historical sources after a plugin is disabled or removed. Required logical uniqueness remains:

```text
(engine_id, native_session_id, source_hash)
```

Add or formalize:

- `adapter_protocol_version`
- `discovery_cursor`
- `last_ingested_sequence`
- `parent_native_session_id`
- `classification`

### `extraction_runs`

Tracks leases and terminal results independently from source metadata:

```text
id, session_source_id, pipeline_version, status,
started_at, completed_at, error_code, metrics_json
```

Unique key:

```text
(session_source_id, pipeline_version)
```

This replaces engine-specific boolean processed markers for the universal path.

### Existing cognitive tables

Canonical memory items, provenance, Wiki pages, lineage, Profile, Skills, and audit remain authoritative. Session integration must use their public operations instead of writing parallel representations.

## 9. Dependency decisions

### 9.1 Reuse without adding packages

| Capability | Decision | Reason |
|---|---|---|
| Process spawning | Keep Node `child_process` and existing lifecycle modules | MetaMe already owns tested process-tree, timeout, permission, and session semantics that a generic runner cannot replace |
| Streaming primitives | Keep Node streams, `StringDecoder`, and one shared strict-LF framer | Existing runtime already handles process streams; the required framing is small and protocol-specific |
| Persistence | Keep `node:sqlite` | Already widely used in the project and covered by the Node baseline |
| YAML configuration | Keep `js-yaml` | Already declared and sufficient for trusted user configuration |
| Hashing and IDs | Keep `node:crypto` | Stable standard-library capability |
| Tests | Keep `node:test` and deterministic fake CLIs | Already the repository standard and suitable for conformance testing |

### 9.2 Add when implementation begins

| Library | Decision | Boundary |
|---|---|---|
| `ajv` | Adopt | Validate versioned Engine Plugin manifests, adapter protocol records, and canonical event schemas using JSON Schema 2020-12 in strict mode |
| Official MCP TypeScript SDK v2 packages | Adopt for MCP server/client transport | Replace hand-written MCP protocol framing behind the existing MetaMe tool handlers; isolate the ESM SDK in a narrow ESM entrypoint instead of converting the CommonJS codebase |

Ajv is justified because manifests and external protocol records are public extension contracts. Continuing hand-written property checks would duplicate a mature standard validator and risk divergent validation.

The official MCP SDK is justified because MCP versioning, initialization, transports, and protocol compliance are external standards. MetaMe should own tool semantics, not reimplement the protocol.

### 9.3 Explicitly rejected

| Library/category | Decision | Reason |
|---|---|---|
| Execa | Do not adopt | Current Execa is ESM-only and overlaps existing mature MetaMe lifecycle code without replacing domain-specific kill, session, and permission behavior |
| Generic plugin framework | Do not adopt | The required plugin surface is narrow, security-sensitive, and domain-specific; out-of-process isolation is more important than lifecycle hooks |
| Event bus/message broker | Do not adopt | A modular monolith and direct function contracts provide adequate isolation without distributed failure modes |
| ORM | Do not adopt | Existing explicit SQLite schema and migrations are small, inspectable, and transaction-oriented |
| File-watcher dependency | Do not adopt by default | Session discovery must be restart-safe and cursor-based; watchers may reduce latency but cannot be the correctness mechanism |

Any later dependency proposal must document: missing verified capability, existing-code audit, maintenance status, license, Node/CommonJS fit, transitive cost, security exposure, removal cost, and acceptance evidence.

## 10. Source layout

Preserve existing project conventions and avoid a new framework layer:

```text
scripts/
  engines/
    engine-registry.js
    engine-plugin.js
    runtime-adapter.js
    session-source-adapter.js
    external-adapter-client.js
    claude-cli-adapter.js
    claude-session-source.js
    codex-cli-adapter.js
    codex-session-source.js
    agy-cli-adapter.js
    agy-session-source.js
    pi-cli-adapter.js
    pi-session-source.js
  core/
    engine-descriptors.js
    engine-capabilities.js
    canonical-session-event.js
    ingestion-plan.js
    evidence-authority.js
  cognitive-ingestion.js
  session-analytics.js
  memory-extract.js
```

Rules:

- `scripts/core/` contains pure validation, normalization, decisions, and state transitions only.
- `scripts/engines/` contains Host-specific execution and session-source boundaries.
- `cognitive-ingestion.js` coordinates side effects and transactions.
- Existing analytics and extraction modules consume canonical inputs; native discovery/parsing leaves them.
- Public exports are minimal; test-only helpers remain under `_internal`.

## 11. Configuration

Configuration selects installed Engine Plugins; it does not define executable shell fragments.

```yaml
daemon:
  engines:
    pi:
      enabled: true
      command: /usr/local/bin/pi
      allowed_projects:
        - metame
```

Built-in descriptors own supported argument construction and protocol mapping. A future external adapter manifest references an adapter executable and validated declarative metadata, not arbitrary JavaScript or shell templates.

Unknown engine configuration is an error with an explicit fallback decision. It must not be silently normalized to Claude while reporting success.

## 12. Diagnostics and observability

`metame engine doctor [id]` reports each stage independently:

```text
registered
installed
configured
executable reachable
runtime protocol verified
session source reachable
cognitive host configured
MCP reachable
behavior verified
```

Operational records use stable error codes and bounded redacted diagnostics. They include engine, adapter protocol version, run/session source ID, stage, latency, byte/event counts, and terminal class. Prompt bodies, credentials, full recalled content, and raw transcripts are excluded.

## 13. Conformance testing

Create one reusable conformance suite, not one bespoke integration test strategy per engine.

### Runtime fixtures

- new run and resume;
- UTF-8 split across chunks;
- malformed and unknown JSONL records;
- text, thinking, and tool streaming;
- session observation and atomic persistence;
- user cancellation, idle timeout, tool timeout, and process-tree cleanup;
- non-zero exit with and without terminal events;
- bounded stderr and secret redaction;
- cross-engine session rejection.

### Session source fixtures

- empty, growing, truncated, and rewritten sessions;
- stable revision fingerprints;
- cursor continuation and replay;
- parent/subagent ownership;
- internal-prompt and injected-memory exclusion;
- missing or moved source;
- idempotent extraction for the same revision;
- re-extraction after revision or pipeline-version change.

### Cognitive fixtures

- Agent assertion remains an Episode/candidate;
- verified code or user correction can promote a Claim;
- scope and time differences do not create false conflicts;
- real conflicts are isolated;
- Claim changes mark dependent Synthesis stale;
- provenance reaches retrieval results;
- token budgets and cross-type deduplication remain deterministic.

Each built-in Engine Plugin must pass the same applicable conformance cases. Capability-specific tests are skipped only when the descriptor declares the capability unsupported.

## 14. Migration plan

These are final architectural slices, not temporary implementations.

### Slice 1: Contracts and registry

- Introduce final Engine Plugin, capability, run-event, and session-source contracts.
- Replace registry assumptions with descriptor-driven validation.
- Migrate Claude, Codex, and agy directly to the final plugin shape.
- Preserve existing observable behavior through characterization tests.

Exit criterion: no daemon/core module outside Engine Plugins constructs native CLI args or parses native run events.

### Slice 2: Session source extraction

- Move Claude and Codex discovery/parsing behind Session Source Adapters.
- Route analytics and memory extraction through canonical session events.
- Replace engine-specific processed markers with revisioned extraction runs.
- Preserve current memory output through golden tests.

Exit criterion: cognitive ingestion contains no Host directory, SQLite table, or native event knowledge.

### Slice 3: Pi reference plugin

- Implement Pi runtime and session source adapters using native JSON/session interfaces.
- Keep Pi authentication, provider, model, tools, and native session ownership inside Pi.
- Verify interactive run, continuation, cancellation, session ingestion, and provenance end to end.

Exit criterion: Pi is added without adding a Pi branch outside its plugin, configuration/UX declarations, and tests.

### Slice 4: Cognitive Host convergence

- Move MCP protocol handling to the official SDK while retaining MetaMe's existing tool semantics.
- Unify Host detection, capability status, install planning, and doctor output.
- Verify Claude, Codex, and Pi independently.

Exit criterion: every Host has a truthful capability matrix and a tested read path to MetaMe cognition where supported.

### Slice 5: External adapter boundary

- Publish the versioned manifest and subprocess protocol only after built-in plugins prove the same contracts.
- Ship a fixture adapter and conformance command.
- Keep third-party adapters explicitly installed, allowlisted, isolated, and removable.

Exit criterion: a fixture CLI can execute and expose sessions without changing MetaMe core or daemon routing code.

## 15. Acceptance criteria

The architecture is complete when:

1. adding a conforming Agent does not modify core routing, ingestion, or memory logic;
2. every Host-specific branch lives in its Engine Plugin;
3. Runtime, Session Source, and Cognitive Host capabilities can exist independently;
4. all native session slots are engine-scoped and cross-engine reuse is rejected;
5. ingestion is revision-aware, restart-safe, and idempotent;
6. no Agent output is promoted to trusted memory solely because the Agent stated it;
7. every retrieved Claim or Synthesis can expose bounded provenance;
8. MCP behavior is implemented through the official SDK while tool semantics remain MetaMe-owned;
9. external adapter records and manifests are schema-validated;
10. diagnostics distinguish installation, configuration, reachability, protocol, and behavioral verification;
11. Claude, Codex, agy, and Pi pass applicable shared conformance tests;
12. rollback disables an Engine Plugin without deleting native sessions or existing cognitive assets;
13. no temporary protocol, duplicate ingestion path, or permanent migration wrapper remains.

## 16. Principal risks

### False universality

Declaring every Host equivalent would push unsupported behavior into unreliable emulation. Capability negotiation and explicit refusal are mandatory.

### Memory contamination

Universal ingestion increases evidence volume faster than truth quality. Revision tracking, authority, conflict isolation, and production backpressure must land with the ingestion contract.

### Plugin privilege escalation

An Agent adapter can inherit local user authority. External adapters therefore remain opt-in child processes with explicit binaries, environment minimization, cwd scoping, bounded protocol records, and no direct cognitive-store mutation.

### Migration drift

Running old and new ingestion paths in parallel would produce duplicate or inconsistent memory. Migrations use characterization fixtures and one authoritative path per source; cutover and rollback happen at the adapter registration boundary.

### Protocol lock-in

The adapter message semantics and schemas are versioned independently from transport; v1 deliberately supports only the local strict-LF subprocess transport. Only capabilities proven by built-in plugins enter v1, and speculative fields are excluded.

## 17. Review questions

Before implementation, reviewers must be able to answer:

1. Can a runnable Host intentionally have no Session Source Adapter?
2. Can a session-only source be ingested without allowing MetaMe to run that Host?
3. Where does a native event shape stop being visible?
4. What exact key prevents duplicate extraction after restart?
5. What causes a growing session to be reconsidered?
6. Why can an Agent conclusion not directly overwrite a Claim?
7. Which component owns MCP protocol compliance versus memory tool semantics?
8. How is an external adapter prevented from executing arbitrary shell fragments?
9. How does `/doctor` distinguish installed from behaviorally verified?
10. Can Pi be removed without touching Claude/Codex sessions or cognitive assets?

If any answer requires an engine-specific branch in core or a second pipeline, the design has been violated.
