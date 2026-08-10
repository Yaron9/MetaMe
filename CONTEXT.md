# MetaMe Agent Infrastructure

MetaMe is a user-owned runtime and cognitive control plane that connects independent Agent hosts without replacing them or treating their outputs as truth.

## Language

**Host**:
An independently installed Agent application or CLI, such as Claude Code, Codex, Pi, or agy. A Host becomes usable by MetaMe only through an explicitly installed, registered, and trusted Engine Plugin.
_Avoid_: Engine, Provider, Agent CLI when referring to the installed product

**Engine**:
A Host execution capability that MetaMe may select to perform a run.
_Avoid_: Provider, Model

**Engine Plugin**:
The declared bundle of capabilities by which MetaMe can execute an Engine, observe its sessions, or connect it to MetaMe cognition. A plugin may provide only a subset of those capabilities.
_Avoid_: Universal adapter, integration

**Trusted Local Plugin**:
An Engine Plugin that the user has explicitly installed, registered, and allowed for local execution. A CLI being present on `PATH` does not make it trusted.
_Avoid_: Any installed CLI, auto-detected Host

**Capability Registry**:
The authoritative set of Engine Plugin descriptors and the capabilities they declare. Routing, diagnostics, and conformance use this registry instead of maintaining per-Host lists.
_Avoid_: Engine map, host switch table

**Runtime Adapter**:
The Engine Plugin capability that translates between a MetaMe run and one Engine's native execution protocol.
_Avoid_: Host Adapter, Session Adapter

**Session Source Adapter**:
The Engine Plugin capability that discovers and projects native Host sessions as engine-neutral evidence.
_Avoid_: Transcript parser, Runtime Adapter

**Cognitive Host Adapter**:
The Engine Plugin capability that detects and connects a Host to MetaMe's memory, identity, skills, and knowledge interfaces.
_Avoid_: Runtime Adapter, Engine Adapter

**Native Session**:
The Host-owned conversation state referenced opaquely by MetaMe for continuation and provenance.
_Avoid_: MetaMe Session

**Session Source**:
A revisioned reference to native session evidence eligible for cognitive ingestion.
_Avoid_: Memory, Fact

**Extraction Run**:
A durable attempt to ingest one Session Source revision for one cognitive pipeline, with claim, lease, and completion state.
_Avoid_: Processed marker, analytics state

**Episode**:
An engine-neutral account of what occurred in a session. An Episode is evidence, not a trusted assertion.
_Avoid_: Fact, Memory

**Candidate Claim**:
An assertion awaiting scope, durability, authority, and consistency checks before it can become canonical.
_Avoid_: Fact, Convention

**Canonical Claim**:
The currently accepted assertion for one canonical key, scope, and validity interval, supported by provenance.
_Avoid_: Raw memory, Transcript fact

**Synthesis**:
Derived, organized knowledge built from Claims and Episodes, such as a Wiki page.
_Avoid_: Fact

**Human Annotation**:
A revision-bound user correction or note that becomes evidence for claim admission; it does not overwrite a Synthesis directly.
_Avoid_: Wiki back-sync, Canonical Claim

**Project Context Manifest**:
A bounded, revisioned selection of verified project constraints and Synthesis pointers supplied at cold start or project switch.
_Avoid_: Memory dump, Prompt snapshot

**Capability**:
A reusable way of working whose value has been verified through explicit approval or repeated successful outcomes.
_Avoid_: Tool, one-off behavior

**Cognitive Plane**:
MetaMe's user-owned memory, identity, policy, knowledge, skill, retrieval, and governance capabilities shared across Hosts.
_Avoid_: MCP Server

**Official MCP Transport**:
The protocol transport used by the maintained MCP SDK at the integration boundary for Cognitive Plane capabilities. It is a transport boundary, not a second runtime or session-ingestion path.
_Avoid_: Hand-written MCP transport, custom protocol shim

**Capability Contract**:
A versioned declaration of what an Engine Plugin can actually support and what MetaMe has behaviorally verified.
_Avoid_: Feature flag, compatibility promise
