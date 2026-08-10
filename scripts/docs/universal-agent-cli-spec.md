# Spec: Universal Agent CLI Runtime and Cognitive Session Ingestion

## Problem Statement

MetaMe currently integrates selected Agent CLIs deeply enough to execute work, preserve some native session continuity, and extract knowledge from some session formats. The execution side has begun to converge on a registry and native CLI adapter contract, but Host-specific assumptions still leak into routing, configuration, diagnostics, session storage, analytics, and memory extraction. Adding another Agent such as Pi therefore risks becoming another repository-wide branch rather than a bounded integration.

From the user's perspective, MetaMe should be durable infrastructure above individual Agent products. The user should be able to choose an independently installed Agent CLI without losing MetaMe identity, mobile access, session continuity, knowledge extraction, or long-term memory. A session produced by any supported Host should be eligible for careful cognitive ingestion, while Agent-generated claims must not be mistaken for verified truth.

The current system also mixes three independent concerns: asking a Host to execute work, reading the Host's native sessions, and connecting the Host to MetaMe cognition. These concerns evolve independently and are not universally supported. Treating them as one universal adapter would create false feature parity, tight coupling, and unsafe fallbacks.

Finally, public extension contracts need durable validation, protocol versioning, security isolation, and conformance tests. MetaMe must reuse its existing process lifecycle, SQLite, YAML, registry, memory, Wiki, and MCP capabilities, and use mature maintained libraries for external standards instead of creating parallel infrastructure.

## Solution

MetaMe will become a modular Agent Runtime and Cognitive Plane organized around an immutable Engine Plugin. An Engine Plugin declares identity and verified capabilities and may independently provide a Runtime Adapter, Session Source Adapter, and Cognitive Host Adapter.

The Runtime Adapter translates a MetaMe run into the Host's native CLI invocation and normalizes native output into a small stable event vocabulary. The Session Source Adapter discovers and projects Host-owned native sessions into engine-neutral session evidence. The Cognitive Host Adapter detects and connects the Host to MetaMe's memory, identity, knowledge, and skills without owning execution or native session semantics.

MetaMe Core will consume only versioned, schema-validated contracts. Host-specific argument construction, event parsing, session discovery, transcript parsing, authentication hints, and recovery policy remain inside the owning Engine Plugin. Feature availability is determined by capability negotiation and behavioral verification rather than by engine-name branches.

Native session evidence will flow through one cognitive ingestion pipeline. The pipeline fingerprints each source revision, normalizes and sanitizes events, creates Episodes, extracts candidates, evaluates authority, scope, time, and conflicts, promotes only justified Canonical Claims, updates dependent Synthesis state, and records provenance and consumption outcomes. Complete native transcripts remain Host-owned by default.

Pi will be the first new reference Engine Plugin proving that the architecture can add a runnable and ingestible Agent without adding Pi-specific branches to core routing, memory, or daemon logic. Existing Claude, Codex, and agy behavior will migrate directly to the final contracts and remain protected by characterization and conformance tests.

## User Stories

1. As a MetaMe user, I want to select any registered trusted local Agent CLI per project, so that I am not locked into one Agent product.
2. As a MetaMe user, I want the same MetaMe identity and policies across Hosts, so that switching Engines does not change who the Agent is serving.
3. As a MetaMe user, I want mobile messages to reach the selected Engine, so that the execution experience remains consistent across devices.
4. As a MetaMe user, I want Engine changes to preserve independent native sessions, so that switching away and back does not destroy continuity.
5. As a MetaMe user, I want unavailable capabilities reported honestly, so that MetaMe does not pretend an Agent supports resume, compact, MCP, or usage when it does not.
6. As a MetaMe user, I want an unknown Engine configuration to fail visibly or follow an explicit fallback policy, so that work is never silently executed by the wrong Agent.
7. As a MetaMe user, I want disabling an Engine Plugin to preserve its existing sessions and derived knowledge, so that rollback is nondestructive.
8. As a MetaMe user, I want Host authentication and provider configuration to remain Host-owned, so that MetaMe does not duplicate credentials.
9. As a MetaMe user, I want project permissions to remain enforced when changing Engines, so that a different CLI cannot silently gain authority.
10. As a MetaMe user, I want MetaMe upgrades to preserve current Claude, Codex, and agy behavior, so that infrastructure refactoring does not break existing work.
11. As a MetaMe operator, I want every Engine Plugin to declare a stable identity, so that configuration, sessions, diagnostics, and provenance refer to the same Engine.
12. As a MetaMe operator, I want Engine IDs never to be reused, so that historical provenance cannot be reinterpreted by another plugin.
13. As a MetaMe operator, I want duplicate or malformed Engine Plugins rejected at registration, so that the daemon starts from a coherent registry.
14. As a MetaMe operator, I want capabilities represented independently, so that a runnable Host may intentionally lack session discovery or cognitive connectivity.
15. As a MetaMe operator, I want capability states to distinguish detected, configured, reachable, and verified, so that status reflects operational reality.
16. As a MetaMe operator, I want Engine selection to consult the registry rather than scattered allowlists, so that adding an Agent has one identity boundary.
17. As a MetaMe operator, I want project allowlisting available for experimental Engines, so that rollout can be bounded without hardcoded project names.
18. As a MetaMe operator, I want Engine fallback recorded with an explicit reason, so that diagnosis can explain why the requested Engine was not used.
19. As a MetaMe maintainer, I want one immutable Engine Plugin contract, so that integrations cannot mutate their declared behavior after registration.
20. As a MetaMe maintainer, I want minimal public exports from plugin modules, so that internal Host behavior can evolve without widening the core API.
21. As a MetaMe user, I want a new native run to stream useful progress, so that mobile interaction does not wait for terminal output.
22. As a MetaMe user, I want resumed runs to use only the owning Engine's native session, so that session state never crosses Engines.
23. As a MetaMe user, I want `/stop` and cancellation to terminate the whole Agent process tree, so that abandoned tools do not remain running.
24. As a MetaMe user, I want idle and tool activity to use appropriate timeouts, so that long legitimate work is not confused with a hung process.
25. As a MetaMe user, I want terminal success and failure reported exactly once, so that duplicate completion messages do not corrupt session state.
26. As a MetaMe user, I want partial UTF-8 output handled correctly, so that multilingual messages are not corrupted by stream chunking.
27. As a MetaMe user, I want thinking and tool activity normalized consistently where supported, so that different Hosts produce coherent progress cards.
28. As a MetaMe user, I want malformed native output bounded and diagnosed, so that one bad record does not flood chat or crash the daemon.
29. As a MetaMe user, I want native usage recorded when available and estimated honestly otherwise, so that accounting does not fabricate precision.
30. As a MetaMe user, I want session observation persisted atomically after a successful run, so that a daemon restart can resume the correct conversation.
31. As a MetaMe maintainer, I want CLI command and arguments passed without shell interpolation, so that prompts and paths cannot become shell commands.
32. As a MetaMe maintainer, I want environment construction owned by the Runtime Adapter, so that Host-specific credentials and flags do not leak into core.
33. As a MetaMe maintainer, I want native event shapes to stop at the Runtime Adapter boundary, so that routing and UI do not branch on Agent protocols.
34. As a MetaMe maintainer, I want shared process lifecycle behavior reused, so that each plugin does not reinvent spawning, timeout, and cleanup.
35. As a MetaMe maintainer, I want stable Engine failure classes, so that user messages and retry policy do not depend on raw stderr text.
36. As a MetaMe maintainer, I want unsupported operations rejected explicitly, so that plugins do not emulate unsafe or unreliable parity.
37. As a MetaMe user, I want MetaMe to discover eligible native sessions from every supported Session Source, so that knowledge is not limited to one Host.
38. As a MetaMe user, I want externally created Host sessions to be eligible for ingestion, so that work done directly in a CLI can still improve MetaMe cognition.
39. As a MetaMe user, I want growing sessions reprocessed only when their eligible evidence changes, so that ingestion is current without needless repetition.
40. As a MetaMe user, I want rewritten or truncated sessions recognized as new revisions, so that provenance reflects actual source state.
41. As a MetaMe user, I want parent and subagent sessions attributed correctly, so that the same work is not learned twice.
42. As a MetaMe user, I want removed native session files handled without deleting derived knowledge, so that Host cleanup does not erase cognition.
43. As a MetaMe maintainer, I want session discovery isolated from execution, so that a session-only source can exist without a runnable Engine.
44. As a MetaMe maintainer, I want session references opaque outside their owning adapter, so that core does not depend on file layouts or database schemas.
45. As a MetaMe maintainer, I want canonical session events independent of Host formats, so that analytics and extraction share one input contract.
46. As a MetaMe maintainer, I want discovery cursors and revision fingerprints to be restart-safe, so that watchers are never the correctness mechanism.
47. As a MetaMe maintainer, I want ingestion identity to include source revision and pipeline version, so that a session ID alone cannot suppress later evidence.
48. As a MetaMe maintainer, I want repeated ingestion attempts idempotent, so that crashes and retries do not duplicate cognitive assets.
49. As a MetaMe maintainer, I want one authoritative ingestion path per source, so that migrations do not double-extract sessions.
50. As a MetaMe operator, I want extraction leases and terminal status persisted, so that interrupted work can recover deterministically.
51. As a MetaMe user, I want each conversation treated first as an Episode, so that plausible Agent output is not automatically trusted.
52. As a MetaMe user, I want explicit corrections and authoritative evidence to outrank Agent self-report, so that long-term memory remains reliable.
53. As a MetaMe user, I want scope and validity time considered before conflict detection, so that legitimate exceptions are not erased.
54. As a MetaMe user, I want unresolved conflicts isolated from normal recall, so that Agents are not given contradictory claims as truth.
55. As a MetaMe user, I want every promoted Claim traceable to bounded evidence and a source revision, so that important memory can be audited.
56. As a MetaMe user, I want secrets, bootstrap prompts, injected memory, and oversized tool output excluded from extraction, so that cognition is safe and non-recursive.
57. As a MetaMe user, I want repeated retrieval to avoid duplicating equivalent Facts and Wiki content, so that repetition does not consume tokens or imply credibility.
58. As a MetaMe user, I want changed Claims to mark dependent Synthesis stale, so that derived knowledge does not outlive its foundations unnoticed.
59. As a MetaMe user, I want Capability candidates based on approval or repeated verified outcomes, so that a one-off behavior does not become a permanent Skill.
60. As a MetaMe user, I want complete native transcripts to remain Host-owned by default, so that MetaMe does not become an unnecessary surveillance archive.
61. As a MetaMe user, I want derived knowledge preserved when a plugin is uninstalled, so that product churn does not destroy user-owned cognition.
62. As a MetaMe maintainer, I want extraction metrics separated from cognitive quality, so that higher volume is not mistaken for learning.
63. As a MetaMe maintainer, I want consumption audit separated from truth promotion, so that popularity cannot make a statement true.
64. As a MetaMe maintainer, I want low-value production controlled by verified opportunity and outcome signals, so that background extraction does not grow without benefit.
65. As a Host user, I want MetaMe memory, Wiki, Profile, and Skills available through a small cognitive interface, so that every capable Agent can reuse the same cognition.
66. As a Host user, I want cognition retrieved on demand with bounded summaries, so that large histories do not pollute every prompt.
67. As a Host user, I want explicit memory lookup treated as demand, so that an internal intent gate does not reject the tool call I requested.
68. As a MetaMe operator, I want Host detection to be read-only, so that diagnosis never mutates external Agent settings.
69. As a MetaMe operator, I want Host installation and repair expressed as reversible plans, so that external configuration changes remain controlled.
70. As a MetaMe operator, I want MCP protocol compliance delegated to the official SDK, so that MetaMe owns cognitive semantics rather than protocol reimplementation.
71. As a MetaMe operator, I want current MCP tool behavior preserved during transport migration, so that Hosts do not lose working cognitive capabilities.
72. As a MetaMe maintainer, I want Host integration distinct from native execution, so that MCP configuration changes do not destabilize run lifecycle.
73. As a MetaMe maintainer, I want public results to expose type, scope, freshness, confidence, and provenance, so that Agents can judge how to use cognition.
74. As a MetaMe maintainer, I want MCP audits to exclude prompt bodies and full recalled content, so that observability does not duplicate sensitive data.
75. As a MetaMe operator, I want one doctor command to report each integration stage, so that failures identify registration, installation, configuration, reachability, protocol, session source, or behavioral verification.
76. As a MetaMe operator, I want stable bounded diagnostics and error codes, so that support does not rely on unbounded raw logs.
77. As a MetaMe operator, I want adapter binaries resolved and recorded during verification, so that PATH drift cannot silently change executable identity.
78. As a MetaMe operator, I want external adapters explicitly installed and allowlisted, so that repository discovery cannot execute arbitrary code.
79. As a MetaMe operator, I want external adapters confined to selected project directories and minimal environments, so that plugin compromise has a bounded blast radius.
80. As a MetaMe operator, I want protocol record, prompt, output, and stderr limits, so that faulty adapters cannot exhaust daemon resources.
81. As a MetaMe operator, I want a disabled Engine to stop accepting new work without deleting history, so that rollback is immediate and safe.
82. As a MetaMe maintainer, I want versioned JSON Schemas for manifests and protocol records, so that extension compatibility is deterministic.
83. As a MetaMe maintainer, I want mature schema validation rather than handwritten property checks, so that public contracts follow a maintained standard.
84. As a MetaMe maintainer, I want external adapters to run out of process, so that third-party crashes and dependencies do not enter the daemon process.
85. As a third-party adapter author, I want a language-neutral strict-LF protocol, so that I can integrate a CLI without writing MetaMe-specific JavaScript.
86. As a third-party adapter author, I want a reusable conformance suite and fixture CLI, so that compatibility can be proven before installation.
87. As a third-party adapter author, I want capability-specific tests skipped only for explicitly unsupported features, so that partial integrations remain honest.
88. As a MetaMe maintainer, I want only capabilities proven by built-in plugins admitted to protocol version one, so that the public contract avoids speculation.
89. As a MetaMe maintainer, I want dependency proposals to include fit, maintenance, license, compatibility, transitive cost, security, and removal analysis, so that package growth remains intentional.
90. As a MetaMe maintainer, I want the modular monolith preserved, so that extensibility does not introduce distributed operational failure modes.
91. As a MetaMe maintainer, I want Pi added without a Pi branch outside its plugin and declarative UX/configuration surfaces, so that it proves the architecture rather than bypassing it.
92. As a MetaMe maintainer, I want existing Engines migrated directly to the final plugin contract, so that no permanent compatibility wrapper remains.
93. As a MetaMe maintainer, I want characterization tests before moving behavior, so that refactoring preserves externally visible semantics.
94. As a MetaMe maintainer, I want each implementation slice independently verifiable and reversible, so that failures have a narrow rollback boundary.
95. As a release owner, I want all daemon tests and lint checks green before deployment, so that users are not asked to validate the refactor manually.
96. As a release owner, I want the final result reviewed against the Spec and accepted ADR, so that passing tests do not hide architectural drift.

## Implementation Decisions

- MetaMe remains a modular monolith with explicit ports and adapters. No message broker, service mesh, or microservice split is introduced.
- The canonical integration unit is an immutable Engine Plugin composed of a descriptor plus optional Runtime Adapter, Session Source Adapter, and Cognitive Host Adapter.
- Runtime execution, native session observation, and cognitive Host connection are independent capabilities. No adapter is required to emulate a capability it does not possess.
- Engine identity is stable and never reused. Current plugin availability controls new work, while historical session and provenance records remain readable after disablement or removal.
- Unknown Engine configuration produces an explicit error or recorded fallback decision. Unknown values must not be silently represented as another Engine.
- The Runtime Adapter owns native executable arguments, environment construction, input transport, output parsing, failure classification, native session validation, and native session updates.
- The Run Coordinator owns routing, lifecycle policy, cancellation, normalized event delivery, and durable session-slot updates. It does not inspect native protocols.
- The normalized run vocabulary is limited to run start, session observation, message/thinking deltas, tool lifecycle, usage observation, and exclusive terminal completion or failure.
- Commands and arguments are passed without shell interpolation. MetaMe owns timeout and process-tree termination.
- The Session Source Adapter owns native discovery, inspection, validation, revision fingerprinting, cursor continuation, and canonical event projection.
- Session references are semantically opaque outside the owning adapter. Core may retain stable routing and provenance metadata without interpreting native locators.
- A source revision is identified by the existing source hash. Processing identity includes Engine ID, native session ID, source hash, and pipeline version.
- Session source metadata and extraction execution state are separate. Extraction runs use leases, terminal statuses, stable error codes, and a uniqueness constraint per source revision and pipeline version.
- Existing cognitive persistence remains authoritative. No second memory database or parallel Fact/Wiki representation is introduced.
- Native transcripts remain Host-owned by default. MetaMe stores revision metadata, bounded evidence required for provenance, extraction status, Episodes, Claims, and lineage.
- Canonical session events represent user, assistant, tool, and system evidence with stable sequence and provenance. Adapters normalize structure but make no memory-quality decisions.
- Cognitive ingestion is one pipeline: discover, fingerprint, lease, normalize, sanitize, assemble Episode, extract candidates, resolve scope/time, verify authority, detect conflict, promote Claims, update dependent Synthesis, and record later consumption/outcomes.
- Agent conclusions and self-reports are low-authority evidence. Explicit user correction, authoritative code/configuration/tests, and verified outcomes have higher authority.
- Unresolved conflicts are isolated from normal retrieval. Scope and validity interval are considered before two Claims are classified as contradictory.
- Synthesis and Capability records retain dependency lineage. Invalidated or changed dependencies mark derived assets stale or review-required instead of deleting them automatically.
- Consumption audit, truth promotion, ranking, and retention remain separate state machines.
- The Cognitive Host Adapter owns read-only detection, capability inspection, reversible installation planning, and behavioral verification. It does not execute prompts or read native sessions.
- MCP remains the northbound cognitive capability protocol. It does not replace process lifecycle or session ingestion.
- MCP protocol handling will use the official maintained TypeScript SDK v2 behind existing MetaMe tool semantics. Its ESM boundary remains isolated rather than forcing a repository-wide module-system migration.
- Ajv in strict JSON Schema 2020-12 mode will validate versioned Engine Plugin manifests, external adapter protocol records, and canonical event contracts.
- Existing Node process, stream, cryptography, SQLite, test, YAML, lifecycle, and platform modules are reused.
- Execa is not adopted because it overlaps tested MetaMe lifecycle behavior, is ESM-only in its current major version, and does not replace domain-specific session, permission, or kill semantics.
- No generic plugin framework, ORM, event broker, or correctness-critical file watcher is introduced.
- Built-in Engine Plugins remain repository modules. Third-party adapters execute as explicitly installed and allowlisted child processes.
- The external adapter protocol is versioned strict-LF JSON over stdin/stdout with schema-validated initialization, correlation IDs, bounded records, and stdout reserved for protocol traffic.
- External protocol capabilities include probe, run, cancel, session discovery, session inspection, session reading, and shutdown. Unsupported capabilities return a stable explicit error.
- External adapter security includes executable resolution, minimal environment, project cwd restriction, no shell execution, size/time limits, stderr bounds, credential redaction, and no direct mutation of cognitive stores.
- Pi is the reference plugin for proving the final contracts. Pi retains ownership of authentication, provider/model selection, tools, native sessions, and native configuration.
- Claude, Codex, and agy migrate directly to the final Engine Plugin contract. Implementation sequencing may be incremental, but a second temporary protocol or permanent wrapper is prohibited.
- The source tree preserves current boundaries: pure decisions and validation in core, Host-specific behavior under Engines, and side-effect orchestration at the daemon/ingestion edges.
- Public APIs remain minimal, dependencies are explicit, functions remain single-purpose, and new helpers receive tests at the appropriate pure or integration seam.
- Every new dependency requires a documented verified gap, existing-code audit, maintenance and license review, Node/module compatibility review, transitive/security cost, removal cost, and acceptance evidence.
- Remote Agent/API execution is outside this CLI-focused contract. The message schema is transport-independent, but protocol version one deliberately supports only the trusted local subprocess transport.

## Testing Decisions

- The primary acceptance seam is a registered Engine Plugin exercised through the real Engine Registry, Run Coordinator, and Cognitive Ingestion boundary against a deterministic fake CLI and temporary native session source. This single seam verifies execution, streaming, native session continuation, discovery, revisioning, extraction, provenance, and cognitive consumption without asserting internal call structure.
- Tests assert observable contracts: emitted normalized events, persisted engine-scoped session handles, capability reports, extraction results, provenance, MCP results, stable failure classes, and nondestructive rollback.
- Existing runtime adapter and daemon engine tests provide prior art for native CLI invocation, event normalization, resume behavior, permission handling, cancellation, timeouts, and session persistence.
- Existing session analytics and memory extraction tests provide prior art for transcript parsing, significant-session selection, Codex rollout discovery, processed markers, evidence budgeting, and Fact extraction.
- Existing session source database tests provide prior art for stable source identity, revision idempotency, status transitions, and filtered discovery.
- Existing MCP server tests provide prior art for tool discovery, argument validation, tool semantics, and newline-delimited protocol behavior. SDK migration tests preserve the tool-level contract rather than the hand-written transport implementation.
- Existing memory, Wiki, recall, staleness, and provenance tests provide prior art for candidate promotion, canonical identity, scope filtering, derived knowledge, and bounded recall.
- Characterization fixtures capture current Claude, Codex, and agy externally visible behavior before migration. Tests compare normalized outcomes rather than private function layouts.
- Runtime conformance covers new and resumed runs, cross-engine session rejection, UTF-8 chunk boundaries, malformed/unknown records, text/thinking/tool streams, usage, cancellation, idle/tool timeouts, process-tree cleanup, bounded stderr, secret redaction, and exclusive terminal events.
- Session Source conformance covers empty, growing, truncated, rewritten, missing, and moved sources; stable revision hashes; cursors; parent/subagent attribution; sanitization; replay; idempotency; and pipeline-version reprocessing.
- Cognitive conformance verifies that Agent assertions remain Episodes/candidates, authoritative evidence can promote Claims, scope/time avoids false conflict, real conflicts are isolated, dependent Synthesis becomes stale, and provenance survives retrieval.
- Capability conformance runs only applicable tests. A test is skipped only when the plugin descriptor declares the capability unsupported; detected but broken capabilities fail verification.
- Pi receives deterministic adapter fixtures plus a bounded live acceptance test using the installed CLI. Live tests must not be the only evidence and must not expose credentials or require the user to perform validation.
- External adapter conformance uses a fixture executable and validates handshake versions, framing, correlation, unsupported capability behavior, limits, cancellation, crash isolation, and shutdown.
- Schema tests validate accepted manifests/events and reject unknown versions, missing required fields, invalid capability combinations, oversized records, and additional fields where the contract is closed.
- Migration tests prove only one authoritative ingestion path processes a source revision and that rollback disables new work without deleting native sessions or cognitive assets.
- Diagnostics tests distinguish registered, installed, configured, executable reachable, runtime verified, session source reachable, cognitive Host configured, MCP reachable, and behavior verified.
- Full daemon lint and test suites are mandatory after any daemon modification. The release candidate also runs the complete repository test suite, prepublish audit, and credential scan.
- Final review compares the implementation directly with this Spec, the domain glossary, and the accepted ADR. Architectural violations fail acceptance even if individual tests pass.

## Out of Scope

- Direct integration of arbitrary remote Agent APIs or model-provider HTTP endpoints.
- A distributed runtime, message broker, service mesh, or microservice decomposition.
- A public plugin marketplace or automatic execution of discovered third-party code.
- Repository-wide conversion from CommonJS to ESM.
- Replacing native Host authentication, provider/model configuration, tool implementation, sandboxing, or permission systems.
- Requiring all Hosts to support streaming, resume, compact, native usage, tools, MCP, Skills, or session discovery.
- Copying and retaining every complete native transcript by default.
- Automatic promotion of Agent output to trusted memory.
- Automatic deletion of conflicting, stale, disabled-plugin, or unavailable-source cognitive assets.
- Using file watchers as the correctness mechanism for ingestion.
- Redesigning MetaMe's existing memory, Wiki, Profile, Skill, or identity authority models beyond changes required for universal provenance and ingestion.
- Publishing npm packages, pushing git branches, or releasing MetaMe as part of implementation acceptance unless separately authorized.

## Further Notes

- The domain glossary defines Host, Engine, Engine Plugin, Runtime Adapter, Session Source Adapter, Cognitive Host Adapter, Native Session, Session Source, Episode, Canonical Claim, Synthesis, Capability, Cognitive Plane, and Capability Contract. Tickets and implementation must use these terms.
- The accepted architecture decision separates the three adapter capabilities and preserves MCP as the northbound cognitive protocol.
- The repository currently has a strong execution-adapter base, existing process lifecycle code, SQLite-backed session provenance, and mature cognitive stores. The largest structural gap is Host-specific session discovery and parsing inside analytics/extraction.
- Existing production dependencies are intentionally small. The selected additions are limited to a maintained schema validator for public contracts and the official MCP SDK for an external standard.
- Implementation phases are sequencing devices, not permission to land temporary architecture. Each ticket must leave a final, tested slice and must not introduce code marked for an unspecified future replacement.
- Success is measured by adding Pi without core Engine branches, preserving existing behavior, ingesting Pi session evidence with provenance, and proving that a fixture external CLI can conform without core changes.
- Inventory volume is not cognitive quality. Useful outcomes are fewer repeated user explanations, fewer policy violations, faster retrieval of prior decisions, lower duplicate/stale context, and continuity across Hosts.
