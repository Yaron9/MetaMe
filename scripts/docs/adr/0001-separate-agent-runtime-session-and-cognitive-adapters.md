---
status: accepted
---

# Separate Agent runtime, session source, and cognitive host adapters

MetaMe will remain a modular monolith and represent each supported Agent through an Engine Plugin composed of three independent capability boundaries: a Runtime Adapter for native execution, a Session Source Adapter for native-session evidence, and a Cognitive Host Adapter for access to MetaMe cognition. MCP remains the northbound cognitive capability protocol and is not used as a substitute for process lifecycle or session ingestion. This separation was chosen over a universal adapter or MCP-only integration because execution, native session storage, and host configuration evolve independently; coupling them would force every new Agent to implement unsupported capabilities and would make memory extraction depend on CLI-specific formats.

## Consequences

- Capability negotiation replaces assumed feature parity between Agents.
- Native session content remains Host-owned; MetaMe stores revisioned provenance and derived cognitive assets rather than cloning complete transcripts by default.
- External adapters execute out of process through a versioned protocol instead of loading arbitrary third-party code into the daemon.
- Implementation phases must land final contract slices and may not introduce a second temporary protocol or leave permanent compatibility wrappers.
