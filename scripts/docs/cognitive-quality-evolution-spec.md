# MetaMe Cognitive Quality Evolution Spec

Status: Accepted for implementation  
Owner: MetaMe  
Decision basis: ADR 0004  
Supersedes: GitHub #3–#10 after replacement-ticket mapping is recorded

## 1. Outcome

Evolve MetaMe from a connected memory store into a trustworthy cognitive plane that:

1. admits only durable, correctly scoped claims into long-term memory;
2. preserves evidence while consolidating redundant claims into useful syntheses;
3. gives every supported Agent Host bounded project context without relying on the Agent to remember to search;
4. accepts human corrections without allowing an edited projection to overwrite canonical knowledge silently; and
5. exposes honest, actionable memory and recall health from a read-only CLI.

The design extends the existing SQLite/FTS5 memory, Wiki, recall-audit, Engine Plugin, and Cognitive Host Adapter seams. It adds no vector database, dashboard service, scheduler, file watcher, or second retrieval backend.

## 2. Evidence and current problems

The production database audit on 2026-08-10 found:

- 2,383 active memory items, including 1,593 conventions (66.8%);
- 1,223 active conventions had never been searched;
- 77 duplicate-title convention groups covering 304 rows;
- 298 Wiki pages, including 76 project dossiers and 8 playbooks;
- 209 Wiki pages already contained Wikilinks; all dossiers did, while only one playbook did;
- 8,028 recall-audit rows, but only nine recent trace IDs had a complete enough lifecycle to reason about utilization.

Code inspection explains the skew:

- extraction does not explicitly classify lifetime, scope, authority, or canonical identity;
- five of seven extracted relation types are mapped directly to `convention`;
- `saveFacts()` creates candidates but does not implement semantic equivalence, conflict, or supersession;
- automatic recall exists inside the MetaMe daemon, while a native Host session started outside that path may receive only static bootstrap context;
- Wiki is already a derived projection with evidence and hash metadata, so direct Obsidian-to-`wiki_pages` overwrite would invert the current authority model;
- existing recall records are insufficient to call injection counts a historical “hit rate”.

These measurements prove a classification and observability problem. They do not prove that every never-searched convention is useless, so no destructive bulk cleanup is allowed.

## 3. Architectural decisions

### 3.1 One cognitive lifecycle

```text
Session Source
  -> Evidence / Episode
  -> Candidate Claim
  -> admission and reconciliation
  -> Canonical Claim
  -> Synthesis (Project Dossier / Playbook / Wiki)
  -> Context Manifest + just-in-time Recall
  -> Consumption Evidence
```

Each stage has one responsibility:

- ingestion preserves what happened;
- admission decides whether an assertion deserves long-term status;
- reconciliation decides equivalence, supersession, conflict, or complement;
- synthesis organizes claims without becoming their source of truth;
- retrieval selects bounded context;
- audit records lifecycle evidence without changing ranking or retention semantics.

### 3.2 Admission before collapsing

Every extracted assertion must carry or deterministically derive:

- `lifecycle`: `task`, `project`, or `global`;
- `canonical_key`: stable identity within scope;
- source authority sufficient to prevent a lower-authority candidate replacing an active claim;
- provenance linking it to its Session Source or human annotation.

Rules:

- missing or uncertain lifecycle fails closed to `task`;
- task-local and one-off instructions use the existing `task_key` boundary, remain Episode evidence, and are not promoted to long-term convention;
- durable project or global assertions enter as Candidate Claims;
- exact equivalents merge provenance into one canonical assertion;
- a different value for the same canonical identity becomes a conflict; recency and confidence never choose a winner automatically;
- unresolved contradictions are isolated from reliable recall;
- complementary assertions remain separate;
- synthesis never deletes underlying evidence.

The implementation reuses existing `project`, `scope`, `task_key`, `state`, `supersedes_id`, `source_*`, `origin_class`, `knowledge_lineage`, and provenance fields. The minimum proven schema gaps are a nullable `canonical_key` and a supported `conflict` state. No `durability`, `scope_level`, authority-score, or duplicate evidence table is added. Legacy rows keep a null canonical key; title, tags, and popularity must not be used to invent one.

An active Synthesis may depend only on active, non-task-local, non-conflicting Canonical Claims. Draft synthesis may reference candidates. A changed dependency marks the Synthesis stale or review-required rather than deleting its Markdown or evidence.

#### Claim contract v1

Storage mapping:

| Extracted lifecycle | Storage and eligibility |
|---|---|
| `task` or unknown | `kind=episode`, `state=active`, `task_key=<Session Source id>`; excluded from Claim promotion, default fact recall, and Synthesis evidence |
| `project` | `kind=convention` or `insight`, `state=candidate`, `task_key=NULL`, current `project` and `scope`; eligible for admission |
| `global` | `kind=convention` or `insight`, `state=candidate`, `task_key=NULL`, `project='*'`, `scope='*'`; eligible for admission |

`canonical_key` is an extractor-proposed, validated identifier. It is Unicode-normalized, lower-cased, limited to 160 characters, and must match dot-separated `[a-z0-9][a-z0-9_-]*` segments. Invalid or uncertain keys become `NULL` and remain append-only candidates. The identity tuple is `canonical_key + project + scope`; title is display-only.

For exact-content comparison, normalize content with Unicode NFC, LF newlines, trailing whitespace removed per line, and outer whitespace trimmed; comparison remains case-sensitive. The content digest is SHA-256 of those UTF-8 bytes. Equality requires the same identity tuple and digest.

Admission outcomes:

| Existing identity | New candidate | Outcome |
|---|---|---|
| none | valid key | `candidate`; explicit promotion may make it `active` |
| active, same digest | same content | `duplicate`; merge a `knowledge_lineage` evidence edge and do not duplicate content |
| active, different digest | different content | new row becomes `conflict`; active row remains unchanged and both are excluded from reliable synthesis for that identity |
| candidate/conflict, same digest | same content | merge lineage into the existing non-active row |
| null key | any content | append-only `candidate`; no automatic merge except identical source revision idempotency |

Legal state transitions are `candidate -> active|conflict|archived`, `active -> archived`, and `conflict -> active|archived`. Promotion is explicit and rejects task-local rows. Conflict resolution is one transaction that activates the selected row, archives replaced rows with reason and supersession link, preserves lineage, and marks dependent Synthesis stale. No source class, confidence, recency, title, tag, or search count can replace an active claim automatically.

Legacy active rows with `canonical_key=NULL` remain searchable under current scope rules and are never silently reclassified or deleted. They are excluded from newly activated Synthesis and Project Context Manifests; existing dependent artifacts are reported as legacy/review-required until their evidence is explicitly curated.

### 3.3 Two-layer context consumption

Automatic context is split by lifecycle rather than by Host:

1. **Project Context Manifest** — deterministic, bounded cold-start/project-switch context containing critical verified claims, current project constraints, dossier pointers, and a revision hash.
2. **Just-in-time Recall** — per-turn retrieval driven by the current intent and the same scope, consistency, budget, and audit contracts used by explicit search.

The Cognitive Host Adapter owns Host-specific projection or hook configuration. Core builds Host-neutral context. Runtime Adapters continue to own execution only; Session Source Adapters continue to own session discovery only.

No unconditional “top five popular memories” injection is allowed. A Host that cannot support automatic context must report that capability as partial or unavailable rather than simulate it.

The manifest is built under a trusted access context derived from a managed binding or registered Host adapter. Host or agent identifiers supplied by an MCP caller are not authorization. Without a trusted agent identity, selection is limited to project-level non-private knowledge and must not fall back to another agent's working memory or unrelated global profile.

Delivery is idempotent for `host + native session + project + access identity + manifest revision`. A warm session does not receive an unchanged manifest again; revision or access changes cause one refresh. JIT recall shares source fingerprints with the manifest so the same asset is not injected twice. The delivery ledger reuses existing daemon/session state rather than creating a new database.

The authoritative Engine Plugin registry supplies Cognitive Host Adapters. Adding a fixture Host must not require a new shared Host branch. Host adapters project, install, inspect, and verify context support; they do not retrieve memories, decide access, or read native sessions.

#### Context contract v1

Core accepts a trusted `AccessContext` created by a managed binding or registered adapter:

```json
{
  "principal": "stable local principal",
  "project": "project key",
  "agent_id": "optional trusted agent key",
  "scopes": ["project"],
  "host": "registered engine key",
  "trust": "managed|registered|direct-hook"
}
```

Unknown or untrusted identity produces project-scoped, non-profile context only; an absent project produces an empty manifest. MCP-supplied host, project, or agent values cannot upgrade this context.

The manifest JSON model is versioned:

```json
{
  "schema_version": 1,
  "project": "project key",
  "generated_at": "ISO-8601",
  "expires_at": "ISO-8601",
  "revision": "sha256",
  "budget_chars": 1200,
  "entries": [{
    "id": "stable asset id",
    "type": "claim|synthesis|policy",
    "summary": "bounded text",
    "scope": "project scope",
    "updated_at": "ISO-8601",
    "expires_at": null,
    "provenance_ref": "opaque source reference",
    "source_fingerprint": "type:id:revision-or-digest"
  }]
}
```

Eligibility is active canonical project/global Claim, accepted policy artifact, or active non-stale project Synthesis. Episode, profile, candidate, conflict, archived, stale, expired, and wrong-scope assets are excluded. Selection is stable by type priority `policy, claim, synthesis`, then `updated_at` descending, then `id` ascending. It admits at most eight entries and 1,200 rendered characters. Manifest plus JIT output shares one 4,000-character per-turn ceiling; the manifest is admitted first and JIT receives the remainder.

Revision is SHA-256 over canonical JSON containing schema version, project, access identity/scopes, and ordered entry IDs, fingerprints, summaries, and expiry values; volatile generation timestamps are excluded. The delivery key is SHA-256 of host, native session ID, project, access identity, and revision. Atomic compare-and-set against the existing persisted logical-session metadata guarantees at-most-once delivery for that key; a missing ledger permits one safe delivery.

The optional adapter method is `projectContext({ manifest, phase })`, returning `{ state: 'projected', fingerprint }`, `{ state: 'unsupported' }`, or `{ state: 'failed', error }`. `phase` is `cold_start`, `project_switch`, or `refresh`. Adapter methods never mutate Host configuration unless a separately authorized installation plan is executed.

### 3.4 Human edits are evidence, not canonical state

Managed Wiki content remains a Synthesis projection. A human correction is captured as a **Human Annotation** with base revision/hash and provenance.

Reconciliation uses a three-way comparison:

- generated base;
- current generated revision;
- human annotation or explicit user-notes region.

Presentation-only edits may remain projection overrides. Factual or policy edits become high-authority Candidate Claims and follow the same admission/reconciliation path as other claims. Conflicts are surfaced for confirmation; they are never silently written into canonical claims or overwritten by regeneration.

The initial implementation uses a sidecar `<generated-page>.notes.md`, which the projector never overwrites. There is no watcher. `metame wiki annotate <slug> --from-file <path> [--claim-key <canonical_key>]` explicitly imports bounded notes: without a claim key they remain a Human Annotation; with a valid claim key they create a project-scoped Candidate Claim through the normal admission path. The command records the generated page's base projection hash. Editing the generated page itself never changes canonical data.

Before export, hashes compare the last safe generated projection (`Base`), the newly rendered projection (`Current`), and the on-disk generated page (`User`). Hashing uses the exact UTF-8 rendered file after LF normalization. If `User=Base`, Current may be written. If only User changed, preserve it and report `user_modified`. If Current and User both differ from Base, preserve both states and report `conflict`. A legacy page without Base is `untracked/degraded` and is not overwritten until an explicit adopt/rebuild action outside automatic sync. No LLM semantic merge or presentation/factual classifier is used in v1.

### 3.5 Honest observability

Extend the existing `metame cognition audit`, `metame wiki doctor`, and
`recall-report.js` seams, and provide the memory-focused read-only entry points:

```text
metame memory status [--json]
metame memory doctor [--json]
```

`status` reports stable measurements; `doctor` reports diagnosis and recommended reversible actions. Human text and JSON must be projections of the same result model. These commands aggregate existing audit and doctor modules; they do not create a parallel telemetry implementation.

Required metric families:

- inventory: active/candidate/archived by kind and scope;
- hygiene: duplicate-equivalent candidates, unresolved conflicts, stale claims, never-consumed items;
- recall opportunity: turns where policy says memory should help;
- delivery: opportunities that received context, deduplicated by trace rather than raw audit rows;
- utilization: delivered assets with opened/applied/validated evidence where the Host can report it;
- outcome: useful, missed, harmful, or unknown evidence;
- efficiency: items/tokens delivered per opportunity;
- pipeline health: Session Sources and Extraction Runs by state and age.

The CLI must label incomplete coverage and unknown outcomes. It must report audit rows separately from unique traces, and must not publish a single “Recall Hit Rate” unless its numerator, denominator, coverage window, and supported Hosts are all explicit. Observe and inject records for one opportunity share a trace ID; successful injection records the injected outcome and size; public `memory_recall` delivery records asset/source references without copying recalled text.

#### Observability result model v1

Both memory commands emit the same versioned model; human output is a formatter over it:

```json
{
  "schema_version": 1,
  "window": { "days": 30, "from": "ISO-8601", "to": "ISO-8601" },
  "status": "ok|degraded|error",
  "inventory": { "by_state": {}, "by_kind": {}, "by_scope": {} },
  "hygiene": { "exact_duplicate_groups": 0, "conflicts": 0, "stale": 0, "never_consumed": 0 },
  "recall": {
    "audit_rows": 0, "unique_traces": 0, "opportunities": 0,
    "injected": 0, "delivered": 0, "opened": 0, "applied": 0, "validated": 0,
    "harmful": 0, "unknown_usage": 0, "feedback_coverage": null
  },
  "efficiency": { "delivered_items": 0, "delivered_chars": 0, "token_count": 0 },
  "pipeline": { "session_sources": {}, "extraction_runs": {}, "audit_dropped": 0 },
  "diagnostics": []
}
```

The default window is 30 days and `--days N` selects an integer from 1 through 365. An opportunity is a unique trace with `should_recall=1`; injected/delivered/opened/applied/validated/harmful count unique `(trace_id, source_ref)` pairs at that stage. `unknown_usage` is delivered pairs without later feedback. `feedback_coverage=(applied or validated or harmful pairs)/delivered pairs`, or `null` with an `insufficient_data` diagnostic when delivered is zero or trace/source coverage is incomplete. Existing recorded `token_count` is summed; missing token data remains zero and creates a coverage diagnostic rather than being estimated.

`memory status` exits 0 when the query succeeds. `memory doctor` exits 0 for `ok`, 1 for `degraded`, and 2 for `error` or an operational failure. At minimum, unresolved conflicts, broken lineage, or managed Wiki projection conflicts are `error`; legacy baselines, pending annotations, incomplete feedback coverage, or dropped audits are `degraded`.

## 4. Component boundaries

### Core pure logic (`scripts/core/`)

- admission classification and validation;
- canonical identity and reconciliation decisions;
- context-manifest selection and formatting;
- observability aggregation and diagnosis;
- human-annotation diff classification;
- deterministic Wiki relationship/link planning.

Pure functions return data and intent flags. They do not open databases, write files, invoke models, or mutate audit state.

### Edge modules (`scripts/`)

- extraction prompt/model invocation;
- SQLite schema migration and transactions;
- CLI argument parsing and presentation;
- Host hook/projection installation;
- Wiki file reads/writes;
- recall and consumption audit writes.

Existing dependencies are sufficient: built-in Node APIs, SQLite support already used by the project, FTS5, AJV/Zod where validation already occurs, and the official MCP SDK. Adding a package requires a concrete missing capability and maintenance review.

## 5. Delivery slices and dependencies

### Slice A — Observability contract and instrumentation

Define the shared metric model, complete trace/item attribution needed for opportunity, delivery, and utilization measurements, and add `memory status/doctor`. This slice is read-only except for normal audit writes on the existing consumption path.

### Slice B — Admission and reconciliation foundation

Add pure policy, nullable canonical identity, explicit conflict state, candidate validation, lineage-based equivalence/supersession/conflict decisions, active-only Synthesis eligibility, and migration-safe defaults. Remove title-based supersession and confidence-only automatic replacement. No existing active memory is bulk-modified.

### Slice C — Extraction and non-destructive consolidation

Teach extraction to distinguish task/project/global lifecycle. Route uncertain or task-local material to Episodes. Add dry-run, stage, and guarded apply modes. Automatic apply is limited to exact-content duplicates after provenance is merged into lineage; semantic conflicts require explicit resolution. Existing dossier/playbook builders consume active canonical claims and preserve provenance rather than performing LLM-driven destructive collapsing.

### Slice D — Project Context Manifest and JIT recall

Build the Host-neutral manifest under a trusted access context, expose projection through registry-supplied Cognitive Host Adapters, reuse the existing recall pipeline for per-turn context, and cover cold start, warm/resume idempotency, project switch, source deduplication, unsupported Host, forged identity, empty result, and a unified deterministic budget.

### Slice E — Human annotation and Wiki relationships

Capture revision-bound human notes, classify presentation versus factual changes, turn factual corrections into Candidate Claims, surface conflicts, and improve deterministic playbook/dossier links. Projection hashes represent rendered files and remain distinct from source-membership hashes. Legacy pages without a projection baseline degrade safely and are not overwritten automatically. Do not sync arbitrary Markdown bidirectionally.

### Slice F — End-to-end acceptance and documentation

Run migrations on fixtures and a copy of representative data, verify observability coverage, execute Host-neutral contract tests, review every implementation commit, update README/maintenance/pointer documentation, and close superseded issues only after replacement acceptance is complete.

Dependencies:

```text
A ───────────────┐
B -> C ──────────┼-> F
B -> D ──────────┤
B -> E ──────────┘
```

A and B may proceed independently. C, D, and E use B's canonical claim contract and can proceed in parallel once it lands.

## 6. Acceptance criteria

- [ ] Task-local instructions are not promoted to durable conventions in fixture and integration tests.
- [ ] Equivalent, superseding, conflicting, and complementary claims produce distinct deterministic outcomes.
- [ ] Same-title content is never treated as semantic equivalence; exact duplicates merge lineage before archival.
- [ ] Active Synthesis rejects task-local, candidate, and conflicting evidence; drafts may use candidates.
- [ ] Consolidation preserves provenance and history; no bulk deletion occurs.
- [ ] Existing active data can be audited in dry-run mode before any state transition.
- [ ] Project Context Manifest is deterministic, bounded, scope-correct, revisioned, and Host-neutral.
- [ ] Manifest delivery is access-bound and idempotent across warm sessions and daemon resume; forged Host/agent inputs do not expand access.
- [ ] JIT recall reuses existing retrieval and audit seams and returns an honest empty result when appropriate.
- [ ] Supported Hosts report automatic-context capability accurately; unsupported Hosts degrade explicitly.
- [ ] Human factual edits become reviewable evidence/candidates and survive regeneration without silently replacing canonical knowledge.
- [ ] `memory status` and `memory doctor` support human and JSON output from one result model and clearly expose metric coverage.
- [ ] No new retrieval backend, vector store, dashboard service, scheduler, watcher, or production dependency is introduced without an accepted ADR.
- [ ] Targeted tests, full `npm test`, daemon lint, pre-publish audit, and independent code review pass with zero actionable findings.
- [ ] README, maintenance manual, pointer map, and relevant cognitive documentation match the shipped commands and authority model.

## 7. Migration and safety

1. Schema changes are additive and idempotent.
2. Existing rows receive conservative defaults; uncertain scope or identity remains non-canonical until reviewed. Legacy active rows are not reclassified from titles or tags.
3. `metame memory reconcile --dry-run --json` emits a versioned plan and performs no writes. `--stage <path>` writes that plan to an explicit file but still performs no database mutation.
4. `metame memory reconcile --apply <path>` validates every row ID, state, identity, and content digest recorded in the plan, then applies all exact-duplicate actions in one transaction. Any stale precondition aborts the whole plan without mutation.
5. Automatic apply handles exact-content duplicates only, after lineage is preserved. Semantic conflicts pause for explicit resolution.
6. State transitions use existing archive/supersede mechanisms and transactions.
7. Generated Wiki content is recoverable from canonical claims and evidence; human annotations are stored separately.
8. Audit retention remains independent from memory promotion, ranking, and GC.
9. No production deployment, daemon restart, npm publish, git push, or live database mutation is part of implementation acceptance without separate user authorization.

## 8. Explicit non-goals

- replacing SQLite/FTS5 or the official MCP transport;
- embedding every session or adding a vector database;
- building a web dashboard;
- treating raw popularity or search count as truth;
- automatically deleting never-used memory;
- merging merely related claims into one lossy record;
- LLM-selected automatic conflict winners or confidence-only promotion;
- deriving legacy canonical identity from title, tags, project name, or search count;
- allowing Obsidian edits to overwrite `wiki_pages` or Canonical Claims directly;
- injecting a fixed number of popular dossiers into every turn;
- duplicating Host-specific memory logic in Runtime or Session Source adapters;
- promising full outcome attribution for Hosts that cannot report it.

## 9. Review standard

Each ticket must be implemented in its own worktree and commit, use the narrowest existing module seam, include tests for new helpers, and receive independent Codex review before integration. The integration branch is accepted only after the full regression chain passes and all actionable review findings are resolved.

Automated acceptance uses fixture databases, a fake clock, a fixture Host adapter, and fake native-session metadata. Tests assert the JSON result model and database/file state directly; human-formatted output is checked against the same result object. Process gates—independent review, documentation review, and issue closure—are recorded separately from automated test results.

## 10. Reproducible baseline audit

The production counts in section 2 came from read-only queries against `~/.metame/memory.db`; implementation tests use sanitized fixtures, not that live database.

```sql
SELECT state, kind, COUNT(*)
FROM memory_items
GROUP BY state, kind
ORDER BY state, kind;

SELECT COUNT(*)
FROM memory_items
WHERE state='active' AND kind='convention' AND COALESCE(search_count, 0)=0;

SELECT title, COUNT(*) AS n
FROM memory_items
WHERE state='active' AND kind='convention'
GROUP BY title
HAVING n > 1;

SELECT phase, outcome, COUNT(*)
FROM recall_audit
GROUP BY phase, outcome
ORDER BY phase, outcome;

SELECT COUNT(DISTINCT trace_id)
FROM recall_audit
WHERE trace_id IS NOT NULL AND ts >= datetime('now', '-30 days');
```

Baseline queries are diagnostics only. Their counts are not acceptance thresholds and never authorize mutation.
