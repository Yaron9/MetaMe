---
status: accepted
---

# Accept the universal Runtime and Cognitive Plane architecture

Ticket #22 accepts one Host-neutral Runtime + Cognitive Plane architecture. The core routes through the authoritative Engine Plugin capability registry, consumes revisioned Session Sources, and records cognitive ingestion as durable Extraction Runs; Host identity and native arguments may appear only in plugin adapters, declarative configuration/UX, or explicitly isolated persistence migrations. Claude Code, Codex, agy, Pi, and external fixtures therefore exercise the same contracts, while an installed CLI is never trusted merely because it is discoverable on `PATH`.

The official MCP SDK remains the sole production transport boundary. Legacy processed-marker tables, duplicate analytics state, hand-written transport shims, and permanent compatibility wrappers are not architecture surfaces; any unavoidable persisted compatibility is a named migration edge with tests and a removal owner.

## Consequences

- New Hosts add or register plugin capabilities and conformance fixtures without adding Host branches to routing, coordination, analytics, memory, or ingestion.
- The shared `memory.db` `session_sources`/`extraction_runs` model is authoritative for ingestion provenance and idempotency.
- Diagnostics report discovery separately from trust and registration; no CLI is invoked unless its plugin is explicitly enabled/allowlisted.
- Worktree deployment acceptance is proven only with read-only commands or an isolated temporary target; a real checkout-to-`~/.metame` deploy remains guarded.
