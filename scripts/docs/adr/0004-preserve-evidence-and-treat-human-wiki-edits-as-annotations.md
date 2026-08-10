# ADR 0004: Preserve evidence and treat human Wiki edits as annotations

Status: Accepted  
Date: 2026-08-10

## Context

MetaMe stores session-derived evidence and claims in SQLite, then builds Wiki pages, project dossiers, and playbooks as derived knowledge. Managed Wiki artifacts already carry source membership, revision, and content-hash metadata.

Two tempting optimizations are difficult to reverse:

1. collapse many fine-grained memory rows into a new summary and archive or delete the originals; and
2. treat an edited Obsidian page as the new authoritative `wiki_pages` content.

Both approaches conflate evidence, accepted claims, and presentation. A lossy collapse makes later conflict resolution and provenance audit impossible. Direct back-sync lets an edited projection bypass the same admission and consistency rules applied to session-derived knowledge, while regeneration can silently erase human changes.

## Decision

MetaMe keeps a one-way authority graph:

```text
Evidence -> Candidate Claim -> Canonical Claim -> Synthesis
                  ^                                |
                  |                                v
             Human Annotation <---- human edits / notes
```

- Evidence and provenance are preserved.
- Consolidation creates or refreshes Synthesis artifacts; it does not replace source evidence.
- Only claims deterministically proven equivalent or superseded may transition to archived/superseded state.
- Human factual or policy edits are captured as revision-bound Human Annotations and admitted as high-authority Candidate Claims.
- Presentation-only human edits may remain projection overrides.
- Conflicting human edits require explicit review and are excluded from reliable recall until resolved.
- Regeneration never silently overwrites an unresolved Human Annotation.

## Consequences

Positive:

- provenance and historical queries remain intact;
- automated and human knowledge use one consistency model;
- Wiki regeneration is deterministic and recoverable;
- conflict handling is explicit instead of last-write-wins;
- consolidation can evolve without data loss.

Costs:

- human editing needs a delimited notes region or sidecar artifact;
- reconciliation must store base revision/hash and conflict state;
- storage grows modestly because evidence is retained.

## Rejected alternatives

### Direct bidirectional synchronization of generated Markdown

Rejected because full-page diffs cannot reliably distinguish factual changes, formatting changes, and generated reorderings, and because last-write-wins breaks the authority model.

### Replace fine-grained claims with one generated playbook

Rejected because synthesis quality is probabilistic while provenance, conflict resolution, and historical recall require the original assertions.

### Keep human notes outside MetaMe entirely

Rejected because corrections would survive in Obsidian but could never improve recall or canonical knowledge.
