# MetaMe Agent Infrastructure

MetaMe is a user-owned runtime and cognitive control plane that connects independent Agent hosts without replacing them or treating their outputs as truth.

## Language

**Host**:
An independently installed Agent application or CLI, such as Claude Code, Codex, Pi, or agy.
_Avoid_: Engine, Provider, Agent CLI when referring to the installed product

**Engine**:
A Host execution capability that MetaMe may select to perform a run.
_Avoid_: Provider, Model

**Engine Plugin**:
The declared bundle of capabilities by which MetaMe can execute an Engine, observe its sessions, or connect it to MetaMe cognition. A plugin may provide only a subset of those capabilities.
_Avoid_: Universal adapter, integration

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

**Episode**:
An engine-neutral account of what occurred in a session. An Episode is evidence, not a trusted assertion.
_Avoid_: Fact, Memory

**Canonical Claim**:
The currently accepted assertion for one canonical key, scope, and validity interval, supported by provenance.
_Avoid_: Raw memory, Transcript fact

**Synthesis**:
Derived, organized knowledge built from Claims and Episodes, such as a Wiki page.
_Avoid_: Fact

**Capability**:
A reusable way of working whose value has been verified through explicit approval or repeated successful outcomes.
_Avoid_: Tool, one-off behavior

**Cognitive Plane**:
MetaMe's user-owned memory, identity, policy, knowledge, skill, retrieval, and governance capabilities shared across Hosts.
_Avoid_: MCP Server

**Capability Contract**:
A versioned declaration of what an Engine Plugin can actually support and what MetaMe has behaviorally verified.
_Avoid_: Feature flag, compatibility promise
