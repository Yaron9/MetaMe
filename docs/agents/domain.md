# Domain Docs

MetaMe is a single-context repository.

## Before architecture or implementation work

- Read `CONTEXT.md` and use its canonical terms in Specs, tickets, code, tests, and reviews.
- Read relevant accepted decisions under `scripts/docs/adr/`.
- Read `scripts/docs/pointer-map.md` to locate current authoritative modules.
- Read only the relevant sections of `scripts/docs/maintenance-manual.md` when the task touches engine routing, session semantics, daemon lifecycle, configuration reload, or release compatibility.

## Rules

- Do not silently contradict an accepted ADR; identify the conflict and reopen the decision explicitly.
- If a required domain term is missing or overloaded, resolve it through domain modeling before adding a synonym.
- `CONTEXT.md` contains domain language only. Implementation and technology decisions belong in architecture documents or ADRs.
