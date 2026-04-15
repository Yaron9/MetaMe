# Wiki Document Import — Design Spec

**Date:** 2026-04-15  
**Status:** Approved (3-round Codex review)  
**Feature:** Import local files (md/txt/PDF) into two-tier wiki structure

---

## 1. Overview

Extend the existing wiki system to ingest local documents as wiki pages. Two-tier architecture:

- **Tier 1 — Document Page**: one wiki page per source file, LLM-structured, hash-tracked for incremental updates
- **Tier 2 — Topic Cluster Page**: N:1 synthesis of related documents via embedding clustering, with `[[wikilinks]]` pointing to Tier 1 pages

Existing memory-driven wiki pipeline (`buildMemoryWikiPage` / `runWikiReflect`) is **untouched**.

---

## 2. Architecture

```
/wiki import <path>
       │
       ▼
wiki-import.js  (orchestrator)
  ① scan files → realpath() normalize
  ② extract text (wiki-extract.js)
  ③ SHA256 hash check vs doc_sources
  ④ upsert doc_sources, mark changed as stale
  ⑤ Tier 1: buildDocWikiPage() per stale file
  ⑥ wait for embedding_queue batch drain
  ⑦ Tier 2: wiki-cluster.js → buildTopicClusterPage()

wiki-extract.js        — md/txt: direct read; PDF: pdftotext → pdf-parse fallback
wiki-cluster.js        — cosine similarity clustering on doc-level embeddings
wiki-reflect-build.js  — extended with shared primitives + new builders
```

---

## 3. Data Model

### 3.1 New table: `doc_sources`

```sql
CREATE TABLE doc_sources (
  id                  INTEGER PRIMARY KEY,
  file_path           TEXT UNIQUE NOT NULL,    -- realpath() normalized
  file_hash           TEXT NOT NULL,           -- SHA256 of file content
  mtime_ms            INTEGER,                 -- pre-check before hashing
  size_bytes          INTEGER,
  extracted_text_hash TEXT,                    -- SHA256 of extracted text (extractor-sensitive)
  file_type           TEXT NOT NULL CHECK (file_type IN ('md','txt','pdf')),
  extractor           TEXT,                    -- 'direct'|'pdftotext'|'pdf-parse'
  extract_status      TEXT DEFAULT 'pending'
                      CHECK (extract_status IN ('ok','empty_or_scanned','error','pending')),
  title               TEXT,
  slug                TEXT UNIQUE NOT NULL,    -- 1:1 with wiki_pages.slug
  status              TEXT DEFAULT 'active'
                      CHECK (status IN ('active','orphaned','missing')),
  error_message       TEXT,
  indexed_at          TEXT NOT NULL,
  last_seen_at        TEXT,
  built_at            TEXT,
  content_stale       INTEGER DEFAULT 1   -- 1 = needs (re)build, 0 = current
  -- NOTE: staleness lives here (not on wiki_pages) for doc-source-driven rebuild logic
);

CREATE INDEX idx_doc_sources_status       ON doc_sources(status);
CREATE INDEX idx_doc_sources_file_hash    ON doc_sources(file_hash);
CREATE INDEX idx_doc_sources_slug         ON doc_sources(slug);
CREATE INDEX idx_doc_sources_content_stale ON doc_sources(content_stale);
```

### 3.2 New join table: `wiki_page_doc_sources`

```sql
CREATE TABLE wiki_page_doc_sources (
  page_slug     TEXT NOT NULL,
  doc_source_id INTEGER NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('primary','cluster_member')),
  PRIMARY KEY (page_slug, doc_source_id, role),
  FOREIGN KEY (page_slug)     REFERENCES wiki_pages(slug)    ON DELETE CASCADE,
  FOREIGN KEY (doc_source_id) REFERENCES doc_sources(id)     ON DELETE CASCADE
);
```

### 3.3 `wiki_pages` additions

```sql
ALTER TABLE wiki_pages ADD COLUMN source_type TEXT DEFAULT 'memory';
-- values: 'memory' | 'doc' | 'topic_cluster'

ALTER TABLE wiki_pages ADD COLUMN membership_hash TEXT;
-- cluster pages only: hash(sorted member doc slugs) — for change detection

ALTER TABLE wiki_pages ADD COLUMN cluster_size INTEGER;
-- cluster pages only: number of member documents

-- Backfill existing rows
UPDATE wiki_pages SET source_type = 'memory' WHERE source_type IS NULL;
```

### 3.4 `embedding_queue` — no schema change

The existing queue schema (`id, item_type, item_id, attempts, last_error`) is **unchanged**.  
Processed items are deleted; failed items stay with incremented `attempts`.  
Drain detection uses chunk IDs tracked in memory during import (see Section 5.4).

---

## 4. Module Structure

### New files (all in `scripts/`)

| File | Responsibility |
|------|---------------|
| `wiki-import.js` | Orchestrator: scan → extract → hash check → build Tier1 → drain → build Tier2 |
| `wiki-extract.js` | Text extraction: md/txt (direct), PDF (pdftotext → pdf-parse) |
| `wiki-cluster.js` | Embedding clustering: cosine similarity → topic grouping |

### Modified files

| File | Change |
|------|--------|
| `wiki-reflect-build.js` | Extract shared primitives; add `buildDocWikiPage()`, `buildTopicClusterPage()` |
| `core/wiki-db.js` | Schema migration; extend `upsertWikiPage()` for `source_type`; add doc_sources CRUD |
| `daemon-wiki.js` | Add `/wiki import <path>` command |
| `memory-wiki-schema.js` | Add new tables to schema init |

### Shared primitives (extracted from existing `wiki-reflect-build.js`)

```js
// Pure LLM call — no knowledge of source type
generateWikiContent(prompt, providers, allowedSlugs) → string

// Atomic DB write — transaction boundary
writeWikiPageWithChunks(db, pageSpec, content, meta) → void
  // pageSpec: { slug, title, source_type, membership_hash?, cluster_size?, ... }
  // Full signature:
  // writeWikiPageWithChunks(db, pageSpec, content, { docSourceIds, role })
  //
  // pageSpec required fields (must satisfy wiki_pages NOT NULL constraints):
  //   slug           TEXT  — unique identifier
  //   title          TEXT  — display title
  //   primary_topic  TEXT  — for doc pages: doc slug; for cluster pages: cluster label
  //   source_type    TEXT  — 'doc' | 'topic_cluster' | 'memory'
  //   staleness      REAL  — set to 0.0 on successful build
  //   membership_hash TEXT? — cluster pages only
  //   cluster_size   INT?  — cluster pages only
  //
  // docSourceIds: integer[] — written to wiki_page_doc_sources (empty for memory pages)
  // role: 'primary' | 'cluster_member' (omit for memory pages)
  //
  // wiki_pages.staleness (REAL) is used for listing/export staleness display
  // doc_sources.content_stale (INTEGER) is used for import rebuild triggering
  // Both are set together: staleness=0.0 + content_stale=0 on successful build
  // Transaction:
  //   1. UPSERT wiki_pages
  //   2. DELETE content_chunks WHERE slug = pageSpec.slug
  //   3. INSERT new content_chunks
  //   4. INSERT INTO embedding_queue per chunk
  // On failure: full rollback, page stays stale
```

---

## 5. Key Algorithms

### 5.1 Change detection

```
scan file → mtime_ms + size_bytes match stored? → skip hash
           → mismatch → compute SHA256
             → hash unchanged AND extracted_text_hash unchanged? → up to date
             → changed → mark staleness = 1
```

File not seen in scan → mark `status = 'missing'`, cascade stale to cluster pages.

### 5.2 Slug generation (doc pages)

```
slug = kebab-case(basename without extension)
conflict → append -2, -3, etc.
slug is stable across content changes (only content triggers staleness, not rename)
rename/move = old file_path not seen in scan → mark old record status='missing'
              new file_path with same hash → new doc_sources row, new slug, new wiki page
              (no automatic merge; user can /wiki page <old-slug> to see orphaned page)
              future: --merge flag to transfer old slug to new path
```

### 5.3 Cluster identity (stable slugs)

```
Slug generation (first creation only):
  slug = 'cluster-' + randomBytes(4).toString('hex')   -- e.g. cluster-a3f2c1b0
  slug is NEVER regenerated — it is the stable public identity

membership_hash = SHA256(sorted member doc slugs joined by ',')
  — metadata only, used for change detection; NOT used to derive slug

Locating prior cluster on re-clustering (Jaccard overlap):
  For each existing cluster page:
    stored_members = SELECT doc_source_id FROM wiki_page_doc_sources
                     WHERE page_slug = cluster.slug AND role = 'cluster_member'
    overlap = |new_members ∩ stored_members| / |new_members ∪ stored_members|
    if overlap > 0.5 → treat as same cluster, reuse slug
  If no cluster has overlap > 0.5 → new cluster, generate new slug
  Multiple matches → pick highest overlap; tie-break by larger stored cluster

On cluster update (same slug, new members):
  UPDATE wiki_pages SET membership_hash = new_hash, cluster_size = n, staleness = 1
  DELETE FROM wiki_page_doc_sources WHERE page_slug = slug AND role = 'cluster_member'
  INSERT new wiki_page_doc_sources rows for current member set
  → rebuilt on next /wiki sync
```

### 5.4 Embedding queue drain (batch-scoped)

```
No schema change to embedding_queue. Drain tracked in memory:

enqueued_chunk_ids = all content_chunks.id values written during this import
drain check: SELECT COUNT(*) FROM embedding_queue
             WHERE item_type = 'content_chunk'
             AND item_id IN (enqueued_chunk_ids)
             -- processed items are deleted from queue; result = 0 means drained
poll interval: 5s, timeout: 5min
on timeout: skip clustering for this batch, log warning, doc pages still usable
```

### 5.5 Clustering algorithm

```
min cluster size: 3 docs (else only doc pages, no cluster pages)
algorithm: thresholded connected components
  - cosine similarity threshold: 0.75
  - if doc has no neighbour above threshold → unclustered (no cluster page)
  - cluster page only created when ≥ 3 docs in component
```

---

## 6. `/wiki sync` Extension (phased, locked)

```
Acquire wiki-reflect.lock (existing mechanism)

Phase 1 — Doc pages
  For each doc_sources WHERE content_stale = 1:
    buildDocWikiPage()              ← per-page transaction, independent failure
    SET doc_sources.content_stale = 0, built_at = now() on success
    SET doc_sources.error_message on failure (content_stale stays 1)

Phase 2 — Cascade stale cluster pages
  rebuilt_slugs = slugs of doc pages successfully rebuilt in Phase 1
  affected_cluster_slugs = SELECT DISTINCT page_slug FROM wiki_page_doc_sources
    WHERE doc_source_id IN (SELECT id FROM doc_sources WHERE slug IN rebuilt_slugs)
    AND role = 'cluster_member'
  UPDATE wiki_pages SET staleness = 1 WHERE slug IN affected_cluster_slugs

Phase 3 — Cluster pages (after embedding drain for Phase 1 batch)
  For each wiki_pages WHERE source_type = 'topic_cluster' AND staleness = 1:
    buildTopicClusterPage()

Release lock
```

Ordering invariant: doc pages always rebuilt before their dependent cluster pages.  
Failure model: each page fails independently; failed pages stay stale with `error_message`; do not block other pages.

---

## 7. PDF Extraction

```
1. Check pdftotext available: execSync('command -v pdftotext')
   → if missing: emit actionable error "Install poppler: brew install poppler"
   → use execFile (not exec) to avoid shell injection

2. Extract text, check if empty → status = 'empty_or_scanned'
   → warn user: "PDF may be scanned image, OCR not supported"

3. Fallback to pdf-parse if pdftotext fails
4. Store extractor name in doc_sources.extractor
5. If extracted_text_hash changes (extractor upgraded) → mark stale even if file_hash unchanged
```

---

## 8. Commands

```
/wiki import <path>            — import directory or single file (md/txt/PDF)
/wiki import <path> --no-cluster  — skip Tier 2 clustering
/wiki sync                     — extended: rebuilds stale memory + doc + cluster pages
/wiki                          — existing listing (now shows source_type column)
/wiki research <query>         — unchanged
/wiki page <slug>              — unchanged
```

---

## 9. Error Handling

| Scenario | Behavior |
|----------|----------|
| PDF with no pdftotext | Clear error: "brew install poppler" |
| Scanned PDF (empty text) | `extract_status = 'empty_or_scanned'`, skip build, warn user |
| File deleted between scan and build | Mark `missing`, skip, no crash |
| LLM build failure | Page stays stale, `error_message` updated, next sync retries |
| Embedding timeout | Skip clustering for batch, log warning, doc pages still usable |
| Concurrent `/wiki sync` | Second invocation sees lock, logs warning and exits |

---

## 10. Testing

- `core/wiki-db.test.js` — doc_sources CRUD, join table ops, schema migration
- `wiki-extract.test.js` — md/txt extraction, PDF detection, empty PDF handling
- `wiki-cluster.test.js` — clustering logic, min size guard, membership hash stability
- `wiki-import.test.js` — hash change detection, realpath normalization, orphan detection
- `wiki-reflect-build.test.js` — shared primitives contract, transaction rollback
- Integration: `daemon-wiki.test.js` — `/wiki import` command routing
