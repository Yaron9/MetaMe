# Wiki Document Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import local md/txt/PDF files into a two-tier wiki — one page per document (Tier 1) plus auto-generated topic cluster pages synthesized from related documents (Tier 2).

**Architecture:** New files `wiki-extract.js`, `wiki-cluster.js`, `wiki-import.js` handle extraction, clustering, and orchestration. Shared primitives are extracted from `wiki-reflect-build.js` so memory-driven and doc-driven pages share one atomic write path. Schema adds `doc_sources`, `wiki_page_doc_sources`, and three columns to `wiki_pages`. The existing memory pipeline is completely untouched.

**Tech Stack:** Node.js, `better-sqlite3` (sync SQLite), `node:test` + `node:assert/strict` for tests, `node:crypto` for SHA256, `node:child_process.execFile` for pdftotext, `pdf-parse` npm for PDF fallback.

---

## File Map

### New files
| Path | Responsibility |
|------|---------------|
| `scripts/wiki-extract.js` | Extract text from md/txt/PDF; returns `{ text, title, extractor, extractStatus }` |
| `scripts/wiki-cluster.js` | Cosine similarity clustering of doc embeddings; Jaccard-based cluster identity |
| `scripts/wiki-import.js` | Orchestrator: scan → extract → hash check → Tier 1 build → drain → Tier 2 build |
| `scripts/wiki-extract.test.js` | Tests for extraction logic |
| `scripts/wiki-cluster.test.js` | Tests for clustering and Jaccard matching |
| `scripts/wiki-import.test.js` | Tests for hash detection, orphan marking, slug generation |

### Modified files
| Path | Change |
|------|--------|
| `scripts/memory-wiki-schema.js` | Add `doc_sources`, `wiki_page_doc_sources`; ALTER `wiki_pages` |
| `scripts/core/wiki-db.js` | Add doc_sources CRUD; extend `upsertWikiPage()` for new columns |
| `scripts/wiki-reflect-build.js` | Extract `generateWikiContent` + `writeWikiPageWithChunks`; add `buildDocWikiPage`, `buildTopicClusterPage` |
| `scripts/daemon-wiki.js` | Add `_handleImport()` subcommand; extend `_handleSync()` for phased rebuild |

---

## Task 1: Schema Migration

**Files:**
- Modify: `scripts/memory-wiki-schema.js`
- Modify: `scripts/core/wiki-db.test.js` (add migration tests)

- [ ] **Step 1.1: Write failing tests for new schema**

Add to `scripts/core/wiki-db.test.js`:

```js
describe('doc_sources schema', () => {
  it('creates doc_sources table', () => {
    const db = openTestDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_sources'").get();
    assert.ok(row, 'doc_sources table should exist');
  });

  it('creates wiki_page_doc_sources table', () => {
    const db = openTestDb();
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wiki_page_doc_sources'").get();
    assert.ok(row, 'wiki_page_doc_sources table should exist');
  });

  it('wiki_pages has source_type column defaulting to memory', () => {
    const db = openTestDb();
    // upsertWikiPage without source_type → should default
    const { upsertWikiPage } = require('./wiki-db');
    upsertWikiPage(db, { slug: 'test', primary_topic: 'test', title: 'T', content: 'C' });
    const row = db.prepare("SELECT source_type FROM wiki_pages WHERE slug='test'").get();
    assert.equal(row.source_type, 'memory');
  });

  it('wiki_pages has membership_hash and cluster_size columns', () => {
    const db = openTestDb();
    const cols = db.prepare("PRAGMA table_info(wiki_pages)").all().map(c => c.name);
    assert.ok(cols.includes('membership_hash'));
    assert.ok(cols.includes('cluster_size'));
  });
});
```

- [ ] **Step 1.2: Run tests to confirm they fail**

```bash
cd /Users/yaron/AGI/MetaMe
node --test scripts/core/wiki-db.test.js 2>&1 | grep -E "FAIL|PASS|Error" | head -20
```
Expected: FAILs on all 4 new tests.

- [ ] **Step 1.3: Add new tables to `memory-wiki-schema.js`**

In `applyWikiSchema(db)`, after the existing `embedding_queue` block, add:

```js
// ── doc_sources ───────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS doc_sources (
    id                  INTEGER PRIMARY KEY,
    file_path           TEXT UNIQUE NOT NULL,
    file_hash           TEXT NOT NULL,
    mtime_ms            INTEGER,
    size_bytes          INTEGER,
    extracted_text_hash TEXT,
    file_type           TEXT NOT NULL CHECK (file_type IN ('md','txt','pdf')),
    extractor           TEXT,
    extract_status      TEXT DEFAULT 'pending'
                        CHECK (extract_status IN ('ok','empty_or_scanned','error','pending')),
    title               TEXT,
    slug                TEXT UNIQUE NOT NULL,
    status              TEXT DEFAULT 'active'
                        CHECK (status IN ('active','orphaned','missing')),
    error_message       TEXT,
    indexed_at          TEXT NOT NULL,
    last_seen_at        TEXT,
    built_at            TEXT,
    content_stale       INTEGER DEFAULT 1
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_sources_status        ON doc_sources(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_sources_file_hash     ON doc_sources(file_hash)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_sources_slug          ON doc_sources(slug)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_doc_sources_content_stale ON doc_sources(content_stale)`);

// ── wiki_page_doc_sources ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS wiki_page_doc_sources (
    page_slug     TEXT NOT NULL,
    doc_source_id INTEGER NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('primary','cluster_member')),
    PRIMARY KEY (page_slug, doc_source_id, role),
    FOREIGN KEY (page_slug)     REFERENCES wiki_pages(slug)  ON DELETE CASCADE,
    FOREIGN KEY (doc_source_id) REFERENCES doc_sources(id)   ON DELETE CASCADE
  )
`);

// ── wiki_pages additions (idempotent ALTER) ───────────────────────────────
for (const [col, def] of [
  ['source_type',    "TEXT DEFAULT 'memory'"],
  ['membership_hash','TEXT'],
  ['cluster_size',   'INTEGER'],
]) {
  try { db.exec(`ALTER TABLE wiki_pages ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
}
db.exec("UPDATE wiki_pages SET source_type = 'memory' WHERE source_type IS NULL");
```

- [ ] **Step 1.4: Run tests**

```bash
node --test scripts/core/wiki-db.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```
Expected: all 4 new tests PASS, no existing tests broken.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/memory-wiki-schema.js scripts/core/wiki-db.test.js
git commit -m "feat: add doc_sources, wiki_page_doc_sources schema and wiki_pages columns"
```

---

## Task 2: `core/wiki-db.js` — doc_sources CRUD + extend upsertWikiPage

**Files:**
- Modify: `scripts/core/wiki-db.js`
- Modify: `scripts/core/wiki-db.test.js`

- [ ] **Step 2.1: Write failing tests**

```js
describe('upsertDocSource', () => {
  const { upsertDocSource, getDocSourceByPath, markDocSourcesMissing } = require('./wiki-db');

  it('inserts a new doc source', () => {
    const db = openTestDb();
    upsertDocSource(db, {
      filePath: '/tmp/test.md',
      fileHash: 'abc123',
      mtimeMs: 1000,
      sizeBytes: 500,
      fileType: 'md',
      extractor: 'direct',
      extractStatus: 'ok',
      extractedTextHash: 'def456',
      title: 'Test Doc',
      slug: 'test-doc',
    });
    const row = getDocSourceByPath(db, '/tmp/test.md');
    assert.equal(row.slug, 'test-doc');
    assert.equal(row.content_stale, 1);
    assert.equal(row.status, 'active');
  });

  it('updates file_hash and marks stale on hash change', () => {
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/a.md', fileHash: 'old', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'h1', title: 'A', slug: 'a' });
    db.prepare("UPDATE doc_sources SET content_stale=0 WHERE file_path='/tmp/a.md'").run();
    upsertDocSource(db, { filePath: '/tmp/a.md', fileHash: 'new', mtimeMs: 2, sizeBytes: 2, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'h2', title: 'A', slug: 'a' });
    const row = getDocSourceByPath(db, '/tmp/a.md');
    assert.equal(row.content_stale, 1);
  });

  it('markDocSourcesMissing sets status=missing for unseen paths', () => {
    const db = openTestDb();
    upsertDocSource(db, { filePath: '/tmp/gone.md', fileHash: 'x', mtimeMs: 1, sizeBytes: 1, fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'h', title: 'G', slug: 'gone' });
    markDocSourcesMissing(db, ['/tmp/other.md']); // gone.md not in seen list
    const row = getDocSourceByPath(db, '/tmp/gone.md');
    assert.equal(row.status, 'missing');
  });
});

describe('upsertWikiPage source_type support', () => {
  it('accepts source_type doc', () => {
    const db = openTestDb();
    const { upsertWikiPage } = require('./wiki-db');
    upsertWikiPage(db, { slug: 'doc-1', primary_topic: 'doc-1', title: 'D', content: 'C', source_type: 'doc' });
    const row = db.prepare("SELECT source_type FROM wiki_pages WHERE slug='doc-1'").get();
    assert.equal(row.source_type, 'doc');
  });

  it('accepts membership_hash and cluster_size for topic_cluster', () => {
    const db = openTestDb();
    const { upsertWikiPage } = require('./wiki-db');
    upsertWikiPage(db, { slug: 'cluster-abc', primary_topic: 'cluster-abc', title: 'C', content: 'C', source_type: 'topic_cluster', membership_hash: 'hash123', cluster_size: 3 });
    const row = db.prepare("SELECT membership_hash, cluster_size FROM wiki_pages WHERE slug='cluster-abc'").get();
    assert.equal(row.membership_hash, 'hash123');
    assert.equal(row.cluster_size, 3);
  });
});
```

- [ ] **Step 2.2: Run to confirm failures**

```bash
node --test scripts/core/wiki-db.test.js 2>&1 | grep -E "FAIL|not defined|TypeError" | head -10
```

- [ ] **Step 2.3: Add functions to `core/wiki-db.js`**

Add after existing exports:

```js
/**
 * Upsert a doc_sources row. Marks content_stale=1 if file_hash or extracted_text_hash changed.
 */
function upsertDocSource(db, { filePath, fileHash, mtimeMs, sizeBytes, fileType,
    extractor, extractStatus, extractedTextHash, title, slug }) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT file_hash, extracted_text_hash FROM doc_sources WHERE file_path=?').get(filePath);
  const stale = !existing || existing.file_hash !== fileHash || existing.extracted_text_hash !== extractedTextHash ? 1 : 0;

  db.prepare(`
    INSERT INTO doc_sources
      (file_path, file_hash, mtime_ms, size_bytes, extracted_text_hash, file_type, extractor,
       extract_status, title, slug, status, indexed_at, last_seen_at, content_stale)
    VALUES (?,?,?,?,?,?,?,?,?,?,'active',?,?,?)
    ON CONFLICT(file_path) DO UPDATE SET
      file_hash=excluded.file_hash, mtime_ms=excluded.mtime_ms,
      size_bytes=excluded.size_bytes, extracted_text_hash=excluded.extracted_text_hash,
      extractor=excluded.extractor, extract_status=excluded.extract_status,
      title=excluded.title, status='active', last_seen_at=excluded.last_seen_at,
      content_stale=CASE WHEN excluded.file_hash != file_hash
                         OR excluded.extracted_text_hash != extracted_text_hash
                    THEN 1 ELSE content_stale END
  `).run(filePath, fileHash, mtimeMs, sizeBytes, extractedTextHash, fileType, extractor,
         extractStatus, title, slug, now, now, stale);
}

function getDocSourceByPath(db, filePath) {
  return db.prepare('SELECT * FROM doc_sources WHERE file_path=?').get(filePath) || null;
}

function getDocSourceBySlug(db, slug) {
  return db.prepare('SELECT * FROM doc_sources WHERE slug=?').get(slug) || null;
}

function listStaleDocSources(db) {
  return db.prepare("SELECT * FROM doc_sources WHERE content_stale=1 AND status='active'").all();
}

/**
 * Mark doc_sources as missing when their file_path is not in the seenPaths set.
 */
function markDocSourcesMissing(db, seenPaths) {
  const set = new Set(seenPaths);
  const all = db.prepare("SELECT id, file_path FROM doc_sources WHERE status='active'").all();
  const missing = all.filter(r => !set.has(r.file_path)).map(r => r.id);
  if (missing.length === 0) return;
  const placeholders = missing.map(() => '?').join(',');
  db.prepare(`UPDATE doc_sources SET status='missing' WHERE id IN (${placeholders})`).run(...missing);
}

function upsertDocPageLink(db, pageSlug, docSourceId, role) {
  db.prepare(`
    INSERT OR IGNORE INTO wiki_page_doc_sources (page_slug, doc_source_id, role)
    VALUES (?, ?, ?)
  `).run(pageSlug, docSourceId, role);
}

function getClusterMemberIds(db, pageSlug) {
  return db.prepare("SELECT doc_source_id FROM wiki_page_doc_sources WHERE page_slug=? AND role='cluster_member'").all(pageSlug).map(r => r.doc_source_id);
}

function replaceClusterMembers(db, pageSlug, docSourceIds) {
  db.prepare("DELETE FROM wiki_page_doc_sources WHERE page_slug=? AND role='cluster_member'").run(pageSlug);
  const ins = db.prepare("INSERT INTO wiki_page_doc_sources (page_slug, doc_source_id, role) VALUES (?,?,'cluster_member')");
  for (const id of docSourceIds) ins.run(pageSlug, id);
}

function listClusterPages(db) {
  return db.prepare("SELECT slug, membership_hash, cluster_size FROM wiki_pages WHERE source_type='topic_cluster'").all();
}

// IMPORTANT: merge into the existing module.exports — do NOT replace it.
// Find the existing `module.exports = { ... }` block at the bottom of wiki-db.js
// and ADD the new functions to it. Do not remove any existing exports.
// Example of what to add:
// Object.assign(module.exports, {
//   upsertDocSource, getDocSourceByPath, getDocSourceBySlug,
//   listStaleDocSources, markDocSourcesMissing,
//   upsertDocPageLink, getClusterMemberIds, replaceClusterMembers, listClusterPages,
// });
```

Also extend `upsertWikiPage` to persist `source_type`, `membership_hash`, `cluster_size` — add them to the INSERT column list and ON CONFLICT UPDATE SET.

- [ ] **Step 2.4: Run tests**

```bash
node --test scripts/core/wiki-db.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```
Expected: all new tests PASS, existing tests unaffected.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/core/wiki-db.js scripts/core/wiki-db.test.js
git commit -m "feat: add doc_sources CRUD and extend upsertWikiPage for source_type/cluster fields"
```

---

## Task 3: `wiki-extract.js` — Text Extraction

**Files:**
- Create: `scripts/wiki-extract.js`
- Create: `scripts/wiki-extract.test.js`

- [ ] **Step 3.1: Write failing tests**

Create `scripts/wiki-extract.test.js`:

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { extractText, slugFromFilename } = require('./wiki-extract');

describe('slugFromFilename', () => {
  it('kebab-cases the basename', () => {
    assert.equal(slugFromFilename('/some/path/My Document.md'), 'my-document');
  });
  it('strips extension', () => {
    assert.equal(slugFromFilename('report_2026.pdf'), 'report-2026');
  });
  it('collapses multiple hyphens', () => {
    assert.equal(slugFromFilename('foo--bar  baz.txt'), 'foo-bar-baz');
  });
});

describe('extractText md/txt', () => {
  it('returns content and extractor=direct', async () => {
    const tmpFile = path.join(os.tmpdir(), 'test-extract.md');
    fs.writeFileSync(tmpFile, '# Hello\nWorld');
    const result = await extractText(tmpFile);
    assert.equal(result.extractStatus, 'ok');
    assert.equal(result.extractor, 'direct');
    assert.ok(result.text.includes('Hello'));
    assert.ok(result.title === 'Hello'); // first # heading
  });

  it('returns extractStatus=ok for plain txt', async () => {
    const tmpFile = path.join(os.tmpdir(), 'test-extract.txt');
    fs.writeFileSync(tmpFile, 'Just some text');
    const result = await extractText(tmpFile);
    assert.equal(result.extractStatus, 'ok');
    assert.ok(result.text.includes('Just some text'));
  });
});

describe('extractText PDF error handling', () => {
  it('returns extractStatus=error for nonexistent file', async () => {
    const result = await extractText('/nonexistent/file.pdf');
    assert.equal(result.extractStatus, 'error');
    assert.ok(result.errorMessage);
  });
});
```

- [ ] **Step 3.2: Run to confirm failures**

```bash
node --test scripts/wiki-extract.test.js 2>&1 | grep -E "FAIL|Error|cannot find" | head -10
```

- [ ] **Step 3.3: Create `scripts/wiki-extract.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

/**
 * Convert filename to wiki slug: kebab-case basename without extension.
 */
function slugFromFilename(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extract first # heading from markdown text as title.
 */
function extractMarkdownTitle(text) {
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/**
 * Extract text from a file. Returns:
 * { text, title, extractor, extractStatus, errorMessage? }
 */
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.md' || ext === '.txt') {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      const title = ext === '.md' ? extractMarkdownTitle(text) : null;
      return { text, title, extractor: 'direct', extractStatus: 'ok' };
    } catch (err) {
      return { text: '', title: null, extractor: 'direct', extractStatus: 'error', errorMessage: err.message };
    }
  }

  if (ext === '.pdf') {
    return extractPdf(filePath);
  }

  return { text: '', title: null, extractor: 'unknown', extractStatus: 'error',
           errorMessage: `Unsupported file type: ${ext}` };
}

async function extractPdf(filePath) {
  // Try pdftotext first
  const hasPdftotext = await checkCommand('pdftotext');
  if (hasPdftotext) {
    try {
      const { stdout } = await execFileAsync('pdftotext', [filePath, '-'], { maxBuffer: 10 * 1024 * 1024 });
      if (!stdout.trim()) {
        return { text: '', title: null, extractor: 'pdftotext', extractStatus: 'empty_or_scanned',
                 errorMessage: 'PDF produced no text — may be a scanned image. Install OCR for support.' };
      }
      return { text: stdout, title: null, extractor: 'pdftotext', extractStatus: 'ok' };
    } catch (err) {
      // fall through to pdf-parse
    }
  }

  // Fallback: pdf-parse
  try {
    const pdfParse = require('pdf-parse');
    const buf = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    if (!data.text.trim()) {
      return { text: '', title: null, extractor: 'pdf-parse', extractStatus: 'empty_or_scanned',
               errorMessage: 'PDF produced no text — may be a scanned image.' };
    }
    return { text: data.text, title: null, extractor: 'pdf-parse', extractStatus: 'ok' };
  } catch (err) {
    const hint = hasPdftotext ? '' : ' Install poppler for better PDF support: brew install poppler';
    return { text: '', title: null, extractor: 'pdf-parse', extractStatus: 'error',
             errorMessage: err.message + hint };
  }
}

async function checkCommand(cmd) {
  // Use 'which' without shell:true to avoid shell injection (spec Section 7 requirement)
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch { return false; }
}

/**
 * Compute SHA256 hash of a string.
 */
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

module.exports = { extractText, slugFromFilename, sha256 };
```

- [ ] **Step 3.4: Run tests**

```bash
node --test scripts/wiki-extract.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```
Expected: all PASS (PDF tests won't need real pdftotext — error path covered).

- [ ] **Step 3.5: Commit**

```bash
git add scripts/wiki-extract.js scripts/wiki-extract.test.js
git commit -m "feat: add wiki-extract.js — md/txt/PDF text extraction with pdftotext fallback"
```

---

## Task 4: Refactor `wiki-reflect-build.js` — Extract Shared Primitives

**Files:**
- Modify: `scripts/wiki-reflect-build.js`
- Modify: `scripts/wiki-reflect-build.test.js` (if exists, else create)

The goal: extract `generateWikiContent()` and `writeWikiPageWithChunks()` from the existing `buildWikiPage()` without changing any existing behavior.

- [ ] **Step 4.1: Write failing tests for the new primitive contract**

Create/add to `scripts/wiki-reflect-build.test.js`:

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite') || (() => { try { return require('better-sqlite3'); } catch { return null; } })();
const { applyWikiSchema } = require('./memory-wiki-schema');
const { writeWikiPageWithChunks } = require('./wiki-reflect-build');

function openTestDb() {
  // Use the existing test helper pattern
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  applyWikiSchema(db);
  return db;
}

describe('writeWikiPageWithChunks', () => {
  it('inserts wiki_page and content_chunks atomically', () => {
    const db = openTestDb();
    writeWikiPageWithChunks(db, {
      slug: 'test-doc',
      title: 'Test Doc',
      primary_topic: 'test-doc',
      source_type: 'doc',
      staleness: 0.0,
    }, 'Some content for the page', { docSourceIds: [], role: 'primary' });

    const page = db.prepare("SELECT slug, source_type FROM wiki_pages WHERE slug='test-doc'").get();
    assert.equal(page.source_type, 'doc');
    const chunks = db.prepare("SELECT * FROM content_chunks WHERE page_slug='test-doc'").all();
    assert.ok(chunks.length >= 1);
  });

  it('replaces existing chunks on rebuild', () => {
    const db = openTestDb();
    writeWikiPageWithChunks(db, { slug: 's', title: 'S', primary_topic: 's', source_type: 'doc', staleness: 0.0 }, 'old', { docSourceIds: [] });
    const firstChunks = db.prepare("SELECT id FROM content_chunks WHERE page_slug='s'").all();
    writeWikiPageWithChunks(db, { slug: 's', title: 'S', primary_topic: 's', source_type: 'doc', staleness: 0.0 }, 'new content here', { docSourceIds: [] });
    const secondChunks = db.prepare("SELECT id FROM content_chunks WHERE page_slug='s'").all();
    // IDs should be different (replaced)
    const firstIds = new Set(firstChunks.map(c => c.id));
    const secondIds = secondChunks.map(c => c.id);
    assert.ok(secondIds.every(id => !firstIds.has(id)), 'chunks should be replaced');
  });

  it('rolls back on error without corrupting existing page', () => {
    const db = openTestDb();
    writeWikiPageWithChunks(db, { slug: 'stable', title: 'S', primary_topic: 's', source_type: 'doc', staleness: 0.0 }, 'original', { docSourceIds: [] });
    // Inject a constraint violation by passing null title
    try {
      writeWikiPageWithChunks(db, { slug: 'stable', title: null, primary_topic: 's', source_type: 'doc', staleness: 0.0 }, 'new', { docSourceIds: [] });
    } catch { /* expected */ }
    const page = db.prepare("SELECT title FROM wiki_pages WHERE slug='stable'").get();
    assert.equal(page.title, 'S'); // unchanged
  });
});
```

- [ ] **Step 4.2: Run to confirm failures**

```bash
node --test scripts/wiki-reflect-build.test.js 2>&1 | grep -E "FAIL|Error" | head -10
```

- [ ] **Step 4.3: Extract primitives in `wiki-reflect-build.js`**

Locate the existing `buildWikiPage` function. Extract its inner logic into two new exported functions:

**`generateWikiContent(prompt, providers, allowedSlugs)`** — wraps the existing `callHaiku` + `validateWikilinks` call. Returns `{ content, strippedLinks }`. This is a pure extraction with no logic change.

**`writeWikiPageWithChunks(db, pageSpec, content, { docSourceIds = [], role } = {})`** — wraps the existing BEGIN/upsertWikiPage/resetPageStaleness/chunk/enqueue/COMMIT block. Extended to:
  1. Pass `source_type`, `membership_hash`, `cluster_size` from `pageSpec` into `upsertWikiPage()`
  2. After writing chunks, if `docSourceIds.length > 0`, INSERT into `wiki_page_doc_sources`
  3. Transaction covers both wiki_page write AND doc_source_ids linking

The existing `buildWikiPage` becomes a thin wrapper — the only behavioral requirement is:
- All existing calls to `resetPageStaleness(db, slug, count)` must be preserved. Since `resetPageStaleness` sets `staleness=0.0`, `new_facts_since_build=0`, AND `last_built_at=datetime('now')`, you MUST either:
  - Keep the `resetPageStaleness` call inside `writeWikiPageWithChunks` (recommended), OR
  - Add `last_built_at: new Date().toISOString()` to `pageSpec` and write it in the UPSERT
- Failing to call `resetPageStaleness` or set `last_built_at` will cause memory pages to show stale `last_built_at` values.

```js
function buildWikiPage(db, topic, queryResult, { allowedSlugs, providers }) {
  // ... existing prompt building code unchanged ...
  const prompt = buildWikiPrompt(topic, queryResult, allowedSlugs);
  const { content, strippedLinks } = generateWikiContent(prompt, providers, allowedSlugs);
  if (!content) return null;
  writeWikiPageWithChunks(db, {
    slug: topic.slug, title: topic.label, primary_topic: topic.tag,
    source_type: 'memory', staleness: 0.0,
    raw_source_ids: JSON.stringify(queryResult.facts.map(f => f.id)),
    // ... etc, same as before — pass all fields that were passed to upsertWikiPage before
  }, content, { docSourceIds: [] });
  // NOTE: writeWikiPageWithChunks must call resetPageStaleness(db, topic.slug, totalCount)
  // internally as part of its transaction — do not drop this call.
  return { slug: topic.slug, content, strippedLinks, rawSourceIds: queryResult.facts.map(f => f.id) };
}
```

- [ ] **Step 4.4: Run ALL wiki-reflect tests to ensure nothing broken**

```bash
node --test scripts/wiki-reflect-build.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```
Expected: all new tests PASS, and if existing tests exist they also PASS.

- [ ] **Step 4.5: Run full test suite**

```bash
node --test scripts/core/wiki-db.test.js scripts/wiki-extract.test.js scripts/wiki-reflect-build.test.js 2>&1 | tail -5
```

- [ ] **Step 4.6: Commit**

```bash
git add scripts/wiki-reflect-build.js scripts/wiki-reflect-build.test.js
git commit -m "refactor: extract generateWikiContent + writeWikiPageWithChunks shared primitives"
```

---

## Task 5: `buildDocWikiPage()` — Tier 1 Page Builder

**Files:**
- Modify: `scripts/wiki-reflect-build.js`
- Modify: `scripts/wiki-reflect-build.test.js`

- [ ] **Step 5.1: Write failing test**

```js
describe('buildDocWikiPage', () => {
  it('builds a wiki page from extracted document text', async () => {
    const db = openTestDb();
    // Insert a doc_source first
    const { upsertDocSource } = require('./core/wiki-db');
    upsertDocSource(db, { filePath: '/tmp/a.md', fileHash: 'h1', mtimeMs: 1, sizeBytes: 10,
      fileType: 'md', extractor: 'direct', extractStatus: 'ok', extractedTextHash: 'th1',
      title: 'My Doc', slug: 'my-doc' });
    const docSrc = db.prepare("SELECT * FROM doc_sources WHERE slug='my-doc'").get();

    const { buildDocWikiPage } = require('./wiki-reflect-build');
    // Use a mock providers that returns fixed content
    const providers = {
      callHaiku: async (prompt) => '## My Doc\n\nThis is the doc content.',
      buildDistillEnv: () => ({}),
    };
    const result = await buildDocWikiPage(db, docSrc, 'Full document text here', {
      allowedSlugs: ['my-doc'],
      providers,
    });

    assert.ok(result, 'should return result');
    assert.equal(result.slug, 'my-doc');
    const page = db.prepare("SELECT source_type, primary_topic FROM wiki_pages WHERE slug='my-doc'").get();
    assert.equal(page.source_type, 'doc');
    assert.equal(page.primary_topic, 'my-doc');
    const link = db.prepare("SELECT * FROM wiki_page_doc_sources WHERE page_slug='my-doc' AND role='primary'").get();
    assert.ok(link, 'should have wiki_page_doc_sources primary link');
  });
});
```

- [ ] **Step 5.2: Run to confirm failure**

```bash
node --test scripts/wiki-reflect-build.test.js 2>&1 | grep "buildDocWikiPage" | head -5
```

- [ ] **Step 5.3: Implement `buildDocWikiPage` in `wiki-reflect-build.js`**

```js
/**
 * Build a Tier 1 wiki page from a document source.
 * @param {object} db
 * @param {object} docSource — row from doc_sources
 * @param {string} extractedText — full text from wiki-extract.js
 * @param {{ allowedSlugs: string[], providers: object }} opts
 */
async function buildDocWikiPage(db, docSource, extractedText, { allowedSlugs, providers }) {
  const { slug, title, id: docSourceId } = docSource;
  const displayTitle = title || slug;

  const prompt = buildDocWikiPrompt(displayTitle, extractedText);
  const { content, strippedLinks } = await generateWikiContent(prompt, providers, allowedSlugs);
  if (!content) return null;

  writeWikiPageWithChunks(db, {
    slug,
    title: displayTitle,
    primary_topic: slug,
    source_type: 'doc',
    staleness: 0.0,
    raw_source_ids: '[]',
    topic_tags: '[]',
    word_count: content.split(/\s+/).length,
  }, content, { docSourceIds: [docSourceId], role: 'primary' });

  return { slug, content, strippedLinks };
}

function buildDocWikiPrompt(title, text) {
  // Truncate to ~8000 chars to stay within context limits
  const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n\n[...truncated]' : text;
  return `You are writing a wiki page for a knowledge base.

Title: ${title}

Source document content:
${truncated}

Write a well-structured wiki page that:
- Starts with a brief summary paragraph
- Organizes information under ## headings
- Preserves key facts, numbers, and terminology from the source
- Uses [[wikilink]] syntax for concepts that deserve their own pages
- Is 200–600 words

Respond with only the wiki page content, starting with the summary paragraph.`;
}
```

Export `buildDocWikiPage` alongside existing exports.

- [ ] **Step 5.4: Run tests**

```bash
node --test scripts/wiki-reflect-build.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```

- [ ] **Step 5.5: Commit**

```bash
git add scripts/wiki-reflect-build.js scripts/wiki-reflect-build.test.js
git commit -m "feat: add buildDocWikiPage — Tier 1 document wiki page builder"
```

---

## Task 6: `wiki-cluster.js` — Embedding Clustering

**Files:**
- Create: `scripts/wiki-cluster.js`
- Create: `scripts/wiki-cluster.test.js`

- [ ] **Step 6.1: Write failing tests**

Create `scripts/wiki-cluster.test.js`:

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cosineSimilarity, buildConnectedComponents, jaccardOverlap,
        findMatchingCluster, membershipHash } = require('./wiki-cluster');

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1);
  });
  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it('returns ~0.707 for 45-degree vectors', () => {
    const result = cosineSimilarity([1, 1], [1, 0]);
    assert.ok(Math.abs(result - Math.SQRT1_2) < 0.001);
  });
});

describe('buildConnectedComponents', () => {
  it('groups similar docs into clusters of >=3', () => {
    // 4 docs: first 3 mutually similar, last one isolated
    const embeddings = {
      'a': [1, 0.1, 0], 'b': [0.9, 0.2, 0], 'c': [0.95, 0, 0.1], 'd': [0, 0, 1]
    };
    const clusters = buildConnectedComponents(embeddings, { threshold: 0.7, minSize: 3 });
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].includes('a'));
    assert.ok(!clusters[0].includes('d'));
  });

  it('returns empty array when no cluster meets minSize', () => {
    const embeddings = { 'a': [1, 0], 'b': [0, 1] };
    const clusters = buildConnectedComponents(embeddings, { threshold: 0.7, minSize: 3 });
    assert.equal(clusters.length, 0);
  });
});

describe('jaccardOverlap', () => {
  it('returns 1 for identical sets', () => {
    assert.equal(jaccardOverlap([1, 2, 3], [1, 2, 3]), 1);
  });
  it('returns 0 for disjoint sets', () => {
    assert.equal(jaccardOverlap([1, 2], [3, 4]), 0);
  });
  it('returns 0.5 for half overlap', () => {
    assert.equal(jaccardOverlap([1, 2], [2, 3]), 0.5);
  });
});

describe('findMatchingCluster', () => {
  it('finds cluster with Jaccard > 0.5', () => {
    const existingClusters = [
      { slug: 'cluster-abc', memberIds: [1, 2, 3] },
    ];
    const result = findMatchingCluster(existingClusters, [1, 2, 3, 4]);
    assert.equal(result.slug, 'cluster-abc'); // 3/4 = 0.75 overlap
  });

  it('returns null when no cluster matches', () => {
    const existingClusters = [{ slug: 'cluster-abc', memberIds: [1, 2] }];
    const result = findMatchingCluster(existingClusters, [3, 4, 5]);
    assert.equal(result, null);
  });
});

describe('membershipHash', () => {
  it('is order-independent', () => {
    assert.equal(membershipHash(['b', 'a', 'c']), membershipHash(['c', 'a', 'b']));
  });
});
```

- [ ] **Step 6.2: Run to confirm failures**

```bash
node --test scripts/wiki-cluster.test.js 2>&1 | grep -E "FAIL|cannot find" | head -5
```

- [ ] **Step 6.3: Create `scripts/wiki-cluster.js`**

```js
'use strict';

const crypto = require('node:crypto');

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function membershipHash(slugs) {
  const sorted = [...slugs].sort().join(',');
  return crypto.createHash('sha256').update(sorted).digest('hex');
}

function jaccardOverlap(setA, setB) {
  const a = new Set(setA), b = new Set(setB);
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Find existing cluster with Jaccard overlap > 0.5 with newMemberIds.
 * @param {{ slug: string, memberIds: number[] }[]} existingClusters
 * @param {number[]} newMemberIds
 * @returns {{ slug: string, memberIds: number[] } | null}
 */
function findMatchingCluster(existingClusters, newMemberIds) {
  let best = null, bestScore = 0.5; // threshold
  for (const cluster of existingClusters) {
    const score = jaccardOverlap(cluster.memberIds, newMemberIds);
    if (score > bestScore) { best = cluster; bestScore = score; }
    else if (score === bestScore && best && cluster.memberIds.length > best.memberIds.length) {
      best = cluster; // tie-break: larger stored cluster
    }
  }
  return best;
}

/**
 * Build connected components from doc embeddings using cosine similarity threshold.
 * @param {{ [slug: string]: number[] }} embeddings
 * @param {{ threshold?: number, minSize?: number }} opts
 * @returns {string[][]} array of clusters (each = array of slugs)
 */
function buildConnectedComponents(embeddings, { threshold = 0.75, minSize = 3 } = {}) {
  const slugs = Object.keys(embeddings);
  const n = slugs.length;
  const parent = Object.fromEntries(slugs.map(s => [s, s]));

  function find(x) {
    if (parent[x] !== x) parent[x] = find(parent[x]);
    return parent[x];
  }
  function union(x, y) { parent[find(x)] = find(y); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineSimilarity(embeddings[slugs[i]], embeddings[slugs[j]]) >= threshold) {
        union(slugs[i], slugs[j]);
      }
    }
  }

  const groups = {};
  for (const s of slugs) {
    const root = find(s);
    if (!groups[root]) groups[root] = [];
    groups[root].push(s);
  }

  return Object.values(groups).filter(g => g.length >= minSize);
}

/**
 * Fetch doc-level embeddings from content_chunks.
 * Strategy: average all chunk embeddings for a given page_slug.
 * @param {object} db
 * @param {string[]} slugs
 * @returns {{ [slug: string]: number[] }}
 */
function getDocEmbeddings(db, slugs) {
  const result = {};
  for (const slug of slugs) {
    const chunks = db.prepare(
      "SELECT embedding FROM content_chunks WHERE page_slug=? AND embedding IS NOT NULL"
    ).all(slug);
    if (chunks.length === 0) continue;
    const vecs = chunks.map(c => {
      const buf = Buffer.isBuffer(c.embedding) ? c.embedding : Buffer.from(c.embedding);
      const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      return Array.from(arr);
    });
    const dim = vecs[0].length;
    const avg = new Array(dim).fill(0);
    for (const v of vecs) for (let i = 0; i < dim; i++) avg[i] += v[i] / vecs.length;
    result[slug] = avg;
  }
  return result;
}

module.exports = { cosineSimilarity, buildConnectedComponents, jaccardOverlap,
                   findMatchingCluster, membershipHash, getDocEmbeddings };
```

- [ ] **Step 6.4: Run tests**

```bash
node --test scripts/wiki-cluster.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```

- [ ] **Step 6.5: Commit**

```bash
git add scripts/wiki-cluster.js scripts/wiki-cluster.test.js
git commit -m "feat: add wiki-cluster.js — cosine similarity clustering and Jaccard identity matching"
```

---

## Task 7: `buildTopicClusterPage()` — Tier 2 Cluster Builder

**Files:**
- Modify: `scripts/wiki-reflect-build.js`
- Modify: `scripts/wiki-reflect-build.test.js`

- [ ] **Step 7.1: Write failing test**

```js
describe('buildTopicClusterPage', () => {
  it('builds a cluster page linking to member doc pages', async () => {
    const db = openTestDb();
    const { upsertDocSource } = require('./core/wiki-db');
    const { buildDocWikiPage, buildTopicClusterPage } = require('./wiki-reflect-build');
    const providers = {
      callHaiku: async () => '## Cluster\n\nA synthesis of related documents.',
      buildDistillEnv: () => ({}),
    };

    // Create 3 doc sources + their pages
    const docs = ['alpha', 'beta', 'gamma'];
    const docRows = [];
    for (const name of docs) {
      upsertDocSource(db, { filePath: `/tmp/${name}.md`, fileHash: name, mtimeMs: 1,
        sizeBytes: 10, fileType: 'md', extractor: 'direct', extractStatus: 'ok',
        extractedTextHash: name, title: name, slug: name });
      docRows.push(db.prepare(`SELECT * FROM doc_sources WHERE slug=?`).get(name));
      await buildDocWikiPage(db, docRows.at(-1), `Content of ${name}`, { allowedSlugs: docs, providers });
    }

    const clusterSlug = await buildTopicClusterPage(db, docRows, {
      allowedSlugs: docs,
      providers,
      existingClusters: [],
    });

    assert.ok(clusterSlug, 'should return a slug');
    assert.ok(clusterSlug.startsWith('cluster-'));
    const page = db.prepare(`SELECT source_type, cluster_size FROM wiki_pages WHERE slug=?`).get(clusterSlug);
    assert.equal(page.source_type, 'topic_cluster');
    assert.equal(page.cluster_size, 3);
    const members = db.prepare(`SELECT * FROM wiki_page_doc_sources WHERE page_slug=? AND role='cluster_member'`).all(clusterSlug);
    assert.equal(members.length, 3);
  });
});
```

- [ ] **Step 7.2: Run to confirm failure**

```bash
node --test scripts/wiki-reflect-build.test.js 2>&1 | grep "buildTopicClusterPage" | head -5
```

- [ ] **Step 7.3: Implement `buildTopicClusterPage` in `wiki-reflect-build.js`**

```js
const { membershipHash, findMatchingCluster } = require('./wiki-cluster');
const crypto = require('node:crypto');
const { replaceClusterMembers, listClusterPages, getClusterMemberIds } = require('./core/wiki-db');

/**
 * Build or update a Tier 2 topic cluster page from a set of doc_sources rows.
 * @returns {string} cluster slug
 */
async function buildTopicClusterPage(db, docSourceRows, { allowedSlugs, providers, existingClusters = [] }) {
  const memberIds = docSourceRows.map(r => r.id);
  const memberSlugs = docSourceRows.map(r => r.slug);
  const mHash = membershipHash(memberSlugs);

  // Find or create stable slug
  const match = findMatchingCluster(existingClusters, memberIds);
  const clusterSlug = match ? match.slug : 'cluster-' + crypto.randomBytes(4).toString('hex');

  // Build synthesis content
  const memberTitles = docSourceRows.map(r => r.title || r.slug);
  const prompt = buildClusterPrompt(memberTitles, memberSlugs);
  const { content } = await generateWikiContent(prompt, providers, allowedSlugs);
  if (!content) return null;

  const clusterLabel = inferClusterLabel(memberTitles);

  writeWikiPageWithChunks(db, {
    slug: clusterSlug,
    title: clusterLabel,
    primary_topic: clusterSlug,
    source_type: 'topic_cluster',
    staleness: 0.0,
    raw_source_ids: '[]',
    topic_tags: '[]',
    word_count: content.split(/\s+/).length,
    membership_hash: mHash,
    cluster_size: memberIds.length,
  }, content, { docSourceIds: memberIds, role: 'cluster_member' });

  return clusterSlug;
}

function inferClusterLabel(titles) {
  // Simple heuristic: find common words in titles
  const words = titles.flatMap(t => t.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  const top = Object.entries(freq).filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 2);
  return top.length ? top.map(([w]) => w).join(' & ') + ' cluster' : 'Document Cluster';
}

function buildClusterPrompt(titles, slugs) {
  const links = slugs.map((s, i) => `- [[${s}]] — ${titles[i]}`).join('\n');
  return `You are writing a wiki overview page that synthesizes multiple related documents.

Member documents:
${links}

Write a concise wiki overview page (150–300 words) that:
- Opens with a paragraph explaining what these documents share in common
- Briefly notes what each document covers (1 sentence each)
- Uses [[wikilink]] syntax when referencing the member documents by slug
- Ends with a "## See Also" section listing all members as [[wikilinks]]

Respond with only the wiki page content.`;
}
```

- [ ] **Step 7.4: Run tests**

```bash
node --test scripts/wiki-reflect-build.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```

- [ ] **Step 7.5: Commit**

```bash
git add scripts/wiki-reflect-build.js scripts/wiki-reflect-build.test.js
git commit -m "feat: add buildTopicClusterPage — Tier 2 cluster synthesis with Jaccard identity"
```

---

## Task 8: `wiki-import.js` — Orchestrator

**Files:**
- Create: `scripts/wiki-import.js`
- Create: `scripts/wiki-import.test.js`

- [ ] **Step 8.1: Write failing tests**

Create `scripts/wiki-import.test.js`:

```js
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyWikiSchema } = require('./memory-wiki-schema');
const Database = require('better-sqlite3');
const { scanFiles, generateUniqueSlug } = require('./wiki-import');

function openTestDb() {
  const db = new Database(':memory:');
  applyWikiSchema(db);
  return db;
}

describe('scanFiles', () => {
  it('returns realpath-normalized file list for a directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-test-'));
    fs.writeFileSync(path.join(tmpDir, 'a.md'), '# A');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'B');
    fs.writeFileSync(path.join(tmpDir, 'c.pdf'), '%PDF');
    fs.writeFileSync(path.join(tmpDir, 'skip.js'), 'skip'); // not imported

    const files = scanFiles(tmpDir);
    const names = files.map(f => path.basename(f));
    assert.ok(names.includes('a.md'));
    assert.ok(names.includes('b.txt'));
    assert.ok(names.includes('c.pdf'));
    assert.ok(!names.includes('skip.js'));
    // All paths should be realpath
    assert.ok(files.every(f => path.isAbsolute(f)));
  });

  it('returns array with single file path when given a file', () => {
    const tmpFile = path.join(os.tmpdir(), 'single.md');
    fs.writeFileSync(tmpFile, '# Single');
    const files = scanFiles(tmpFile);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('single.md'));
  });
});

describe('generateUniqueSlug', () => {
  it('returns slug when no conflict', () => {
    const db = openTestDb();
    const slug = generateUniqueSlug(db, 'my-document');
    assert.equal(slug, 'my-document');
  });

  it('appends -2 on conflict', () => {
    const db = openTestDb();
    const { upsertWikiPage } = require('./core/wiki-db');
    upsertWikiPage(db, { slug: 'my-doc', title: 'X', primary_topic: 'x', content: 'c' });
    const slug = generateUniqueSlug(db, 'my-doc');
    assert.equal(slug, 'my-doc-2');
  });
});
```

- [ ] **Step 8.2: Run to confirm failures**

```bash
node --test scripts/wiki-import.test.js 2>&1 | grep -E "FAIL|cannot find" | head -5
```

- [ ] **Step 8.3: Create `scripts/wiki-import.js`**

```js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { extractText, slugFromFilename, sha256 } = require('./wiki-extract');
const { buildConnectedComponents, getDocEmbeddings, membershipHash } = require('./wiki-cluster');
const { buildDocWikiPage, buildTopicClusterPage } = require('./wiki-reflect-build');
const {
  upsertDocSource, getDocSourceByPath, listStaleDocSources,
  markDocSourcesMissing, getClusterMemberIds, replaceClusterMembers,
  listClusterPages, upsertWikiPage,
} = require('./core/wiki-db');

const SUPPORTED_EXTS = new Set(['.md', '.txt', '.pdf']);
const DRAIN_POLL_MS = 5000;
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Scan a path (file or directory) and return array of realpath-normalized supported files.
 */
function scanFiles(inputPath) {
  const real = fs.realpathSync(inputPath);
  const stat = fs.statSync(real);
  if (stat.isFile()) {
    return SUPPORTED_EXTS.has(path.extname(real).toLowerCase()) ? [real] : [];
  }
  return fs.readdirSync(real)
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => fs.realpathSync(path.join(real, f)));
}

/**
 * Generate unique slug for a doc page (no conflict with existing wiki_pages).
 */
function generateUniqueSlug(db, base) {
  let candidate = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM wiki_pages WHERE slug=?').get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

/**
 * Wait for embedding_queue to drain for the given chunk IDs.
 */
async function waitForEmbeddingDrain(db, chunkIds, log = () => {}) {
  if (chunkIds.length === 0) return true;
  const placeholders = chunkIds.map(() => '?').join(',');
  // NOTE: actual embedding_queue uses item_type='chunk' (not 'content_chunk' as written in spec Section 5.4)
  // Confirmed from scripts/wiki-reflect-build.js line ~83 and daemon-embedding.js
  const query = db.prepare(
    `SELECT COUNT(*) as cnt FROM embedding_queue WHERE item_type='chunk' AND item_id IN (${placeholders})`
  );
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { cnt } = query.get(...chunkIds);
    if (cnt === 0) return true;
    log(`[wiki-import] waiting for ${cnt} embeddings to drain...`);
    await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
  }
  log('[wiki-import] WARNING: embedding drain timed out, skipping clustering');
  return false;
}

/**
 * Main import orchestrator.
 * @param {object} db
 * @param {string} inputPath — file or directory
 * @param {{ providers, allowedSlugs?: string[], noCluster?: boolean, log?: Function }} opts
 * @returns {{ imported: number, skipped: number, failed: number, clusters: number }}
 */
async function runWikiImport(db, inputPath, { providers, noCluster = false, log = () => {} } = {}) {
  log(`[wiki-import] scanning: ${inputPath}`);
  const files = scanFiles(inputPath);
  log(`[wiki-import] found ${files.length} supported files`);

  const seenPaths = [];
  const stats = { imported: 0, skipped: 0, failed: 0, clusters: 0 };

  // Phase 0: Extract + hash check + upsert doc_sources
  for (const filePath of files) {
    seenPaths.push(filePath);
    const stat = fs.statSync(filePath);
    const existing = getDocSourceByPath(db, filePath);

    // Pre-check: mtime + size match → skip hash
    if (existing && existing.mtime_ms === stat.mtimeMs && existing.size_bytes === stat.size) {
      if (!existing.content_stale) { stats.skipped++; continue; }
    }

    const { text, title, extractor, extractStatus, errorMessage } = await extractText(filePath);
    const fileHash = sha256(fs.readFileSync(filePath)); // readFileSync returns Buffer — sha256 accepts Buffer via crypto.update()
    const extractedTextHash = text ? sha256(text) : null;
    const baseSlug = slugFromFilename(filePath);
    const slug = existing ? existing.slug : generateUniqueSlug(db, baseSlug);

    upsertDocSource(db, {
      filePath, fileHash,
      mtimeMs: stat.mtimeMs, sizeBytes: stat.size,
      extractedTextHash, fileType: path.extname(filePath).slice(1).toLowerCase(),
      extractor, extractStatus, title, slug,
    });

    if (extractStatus !== 'ok') {
      log(`[wiki-import] SKIP ${path.basename(filePath)}: ${errorMessage || extractStatus}`);
    }
  }

  // Mark unseen active docs as missing
  markDocSourcesMissing(db, seenPaths);

  // Phase 1: Build Tier 1 pages for stale docs
  const stale = listStaleDocSources(db);
  const builtSlugs = [];
  const allChunkIds = [];

  for (const docSrc of stale) {
    if (docSrc.extract_status !== 'ok') {
      db.prepare("UPDATE doc_sources SET content_stale=0 WHERE id=?").run(docSrc.id);
      continue;
    }
    try {
      const { text } = await extractText(docSrc.file_path);
      const allowedSlugs = files.map(f => slugFromFilename(f));
      const result = await buildDocWikiPage(db, docSrc, text, { allowedSlugs, providers });
      if (result) {
        db.prepare("UPDATE doc_sources SET content_stale=0, built_at=? WHERE id=?")
          .run(new Date().toISOString(), docSrc.id);
        builtSlugs.push(docSrc.slug);
        // Collect chunk IDs for drain detection
        const chunks = db.prepare("SELECT id FROM content_chunks WHERE page_slug=?").all(docSrc.slug);
        allChunkIds.push(...chunks.map(c => c.id));
        stats.imported++;
        log(`[wiki-import] built: ${docSrc.slug}`);
      }
    } catch (err) {
      db.prepare("UPDATE doc_sources SET error_message=? WHERE id=?").run(err.message, docSrc.id);
      stats.failed++;
      log(`[wiki-import] FAILED ${docSrc.slug}: ${err.message}`);
    }
  }

  // Phase 2: Cascade stale cluster pages
  if (builtSlugs.length > 0) {
    const affected = db.prepare(`
      SELECT DISTINCT page_slug FROM wiki_page_doc_sources
      WHERE role='cluster_member'
      AND doc_source_id IN (SELECT id FROM doc_sources WHERE slug IN (${builtSlugs.map(() => '?').join(',')}))
    `).all(...builtSlugs).map(r => r.page_slug);
    if (affected.length > 0) {
      const ph = affected.map(() => '?').join(',');
      db.prepare(`UPDATE wiki_pages SET staleness=1 WHERE slug IN (${ph})`).run(...affected);
    }
  }

  // Phase 3: Clustering (Tier 2)
  if (!noCluster && files.length >= 3) {
    const drained = await waitForEmbeddingDrain(db, allChunkIds, log);
    if (drained) {
      const allDocSlugs = db.prepare("SELECT slug, id FROM doc_sources WHERE status='active' AND extract_status='ok'").all();
      const slugList = allDocSlugs.map(r => r.slug);
      const embeddings = getDocEmbeddings(db, slugList);

      if (Object.keys(embeddings).length >= 3) {
        const clusters = buildConnectedComponents(embeddings, { threshold: 0.75, minSize: 3 });
        const existingClusters = listClusterPages(db).map(cp => ({
          slug: cp.slug,
          memberIds: getClusterMemberIds(db, cp.slug),
        }));

        for (const memberSlugs of clusters) {
          const docRows = memberSlugs.map(s => db.prepare("SELECT * FROM doc_sources WHERE slug=?").get(s)).filter(Boolean);
          try {
            const clusterSlug = await buildTopicClusterPage(db, docRows, {
              allowedSlugs: slugList, providers, existingClusters,
            });
            if (clusterSlug) { stats.clusters++; log(`[wiki-import] cluster: ${clusterSlug}`); }
          } catch (err) {
            log(`[wiki-import] cluster FAILED: ${err.message}`);
          }
        }
      } else {
        log('[wiki-import] not enough embedded docs for clustering yet');
      }
    }
  }

  log(`[wiki-import] done — imported: ${stats.imported}, skipped: ${stats.skipped}, failed: ${stats.failed}, clusters: ${stats.clusters}`);
  return stats;
}

module.exports = { runWikiImport, scanFiles, generateUniqueSlug };
```

- [ ] **Step 8.4: Run tests**

```bash
node --test scripts/wiki-import.test.js 2>&1 | grep -E "FAIL|PASS|✓|✗"
```

- [ ] **Step 8.5: Commit**

```bash
git add scripts/wiki-import.js scripts/wiki-import.test.js
git commit -m "feat: add wiki-import.js orchestrator — scan/extract/hash/Tier1/drain/Tier2"
```

---

## Task 9: `daemon-wiki.js` — `/wiki import` Command + Extended Sync

**Files:**
- Modify: `scripts/daemon-wiki.js`

- [ ] **Step 9.1: Add `/wiki import` routing**

In `handleWikiCommand()`, add before the unknown subcommand fallback:

```js
if (trimmed === '/wiki import' || trimmed.startsWith('/wiki import ')) {
  const args = trimmed.slice(12).trim();
  await _handleImport(bot, chatId, args);
  return true;
}
```

- [ ] **Step 9.2: Implement `_handleImport`**

```js
async function _handleImport(bot, chatId, args) {
  const noCluster = args.includes('--no-cluster');
  const inputPath = args.replace('--no-cluster', '').trim();

  if (!inputPath) {
    await bot.sendMessage(chatId, '用法: `/wiki import <路径或文件>` [--no-cluster]\n\n示例:\n`/wiki import ~/Documents/notes`\n`/wiki import ~/report.pdf`');
    return;
  }

  const resolvedPath = inputPath.replace(/^~/, require('node:os').homedir());

  let stat;
  try { stat = require('node:fs').statSync(resolvedPath); }
  catch { await bot.sendMessage(chatId, `❌ 路径不存在: ${resolvedPath}`); return; }

  const isDir = stat.isDirectory();
  await bot.sendMessage(chatId, `⏳ 开始导入 ${isDir ? '目录' : '文件'}: \`${resolvedPath}\`\n${noCluster ? '（跳过聚类）' : '（含自动聚类）'}`);

  const { runWikiImport } = require('./wiki-import');
  const db = getDb();
  const logLines = [];
  const logFn = (msg) => { log('INFO', msg); logLines.push(msg); };

  try {
    const stats = await runWikiImport(db, resolvedPath, {
      providers, noCluster, log: logFn,
    });
    await bot.sendMessage(chatId,
      `✅ 导入完成\n\n` +
      `- 新建/更新页面: ${stats.imported}\n` +
      `- 跳过 (未变更): ${stats.skipped}\n` +
      `- 失败: ${stats.failed}\n` +
      `- 聚类页面: ${stats.clusters}\n\n` +
      `使用 \`/wiki\` 查看全部页面`
    );
  } catch (err) {
    log('ERROR', `[wiki-import] ${err.message}`);
    await bot.sendMessage(chatId, `❌ 导入失败: ${err.message}`);
  }
}
```

- [ ] **Step 9.3: Extend `_handleSync` for phased doc + cluster rebuild**

In the existing `_handleSync` function, after the existing memory-page rebuild loop, add:

```js
// Phase 1: rebuild stale doc pages
const { listStaleDocSources } = require('./core/wiki-db');
const { buildDocWikiPage } = require('./wiki-reflect-build');
const { extractText } = require('./wiki-extract');
const staleDocSources = listStaleDocSources(db);
const builtDocSlugs = [];
for (const docSrc of staleDocSources) {
  try {
    const { text } = await extractText(docSrc.file_path);
    const result = await buildDocWikiPage(db, docSrc, text, { allowedSlugs, providers });
    if (result) {
      db.prepare("UPDATE doc_sources SET content_stale=0, built_at=? WHERE id=?")
        .run(new Date().toISOString(), docSrc.id);
      builtDocSlugs.push(docSrc.slug);
      log('INFO', `[wiki-sync] rebuilt doc page: ${docSrc.slug}`);
    }
  } catch (err) {
    db.prepare("UPDATE doc_sources SET error_message=? WHERE id=?").run(err.message, docSrc.id);
    log('WARN', `[wiki-sync] doc rebuild failed ${docSrc.slug}: ${err.message}`);
  }
}
// Phase 2: cascade stale cluster pages
if (builtDocSlugs.length > 0) {
  const ph = builtDocSlugs.map(() => '?').join(',');
  const affected = db.prepare(`SELECT DISTINCT page_slug FROM wiki_page_doc_sources
    WHERE role='cluster_member' AND doc_source_id IN
    (SELECT id FROM doc_sources WHERE slug IN (${ph}))`).all(...builtDocSlugs).map(r => r.page_slug);
  if (affected.length) {
    db.prepare(`UPDATE wiki_pages SET staleness=1 WHERE slug IN (${affected.map(() => '?').join(',')})`).run(...affected);
  }
}
// Phase 3: rebuild stale cluster pages (after embedding drain for Phase 1 chunks)
const { waitForEmbeddingDrain } = require('./wiki-import');
const phase1ChunkIds = builtDocSlugs.flatMap(slug =>
  db.prepare("SELECT id FROM content_chunks WHERE page_slug=?").all(slug).map(c => c.id)
);
const drained = await waitForEmbeddingDrain(db, phase1ChunkIds, (msg) => log('INFO', msg));
if (!drained) {
  log('WARN', '[wiki-sync] embedding drain timed out — skipping cluster rebuild');
} else {
const { buildTopicClusterPage } = require('./wiki-reflect-build');
const { getClusterMemberIds, listClusterPages } = require('./core/wiki-db');
const staleClusterPages = db.prepare("SELECT * FROM wiki_pages WHERE source_type='topic_cluster' AND staleness=1").all();
for (const cp of staleClusterPages) {
  const memberIds = getClusterMemberIds(db, cp.slug);
  const docRows = memberIds.map(id => db.prepare("SELECT * FROM doc_sources WHERE id=?").get(id)).filter(Boolean);
  try {
    await buildTopicClusterPage(db, docRows, { allowedSlugs, providers, existingClusters: [] });
    log('INFO', `[wiki-sync] rebuilt cluster: ${cp.slug}`);
  } catch (err) {
    log('WARN', `[wiki-sync] cluster rebuild failed ${cp.slug}: ${err.message}`);
  }
}
} // end drained block
```

- [ ] **Step 9.4: Run ESLint**

```bash
npx eslint scripts/daemon-wiki.js 2>&1 | head -20
```
Expected: 0 errors.

- [ ] **Step 9.5: Run full test suite**

```bash
node --test scripts/core/wiki-db.test.js scripts/wiki-extract.test.js \
  scripts/wiki-cluster.test.js scripts/wiki-import.test.js \
  scripts/wiki-reflect-build.test.js 2>&1 | tail -10
```
Expected: 0 failures.

- [ ] **Step 9.6: Deploy and smoke test**

```bash
node index.js
```

Then in Feishu/your chat client, send:
```
/wiki import ~/Documents/some-notes-dir
```
Expected response: `⏳ 开始导入...` followed by `✅ 导入完成` summary.

- [ ] **Step 9.7: Commit**

```bash
git add scripts/daemon-wiki.js
git commit -m "feat: add /wiki import command and phased doc+cluster sync extension"
```

---

## Task 10: Final Integration — Deploy + Verify

- [ ] **Step 10.1: Run full test suite one final time**

```bash
node --test scripts/core/wiki-db.test.js scripts/wiki-extract.test.js \
  scripts/wiki-cluster.test.js scripts/wiki-import.test.js \
  scripts/wiki-reflect-build.test.js 2>&1
```
Expected: 0 failures across all suites.

- [ ] **Step 10.2: ESLint all new/modified daemon files**

```bash
npx eslint scripts/daemon-wiki.js scripts/wiki-import.js scripts/wiki-extract.js scripts/wiki-cluster.js scripts/wiki-reflect-build.js 2>&1
```
Expected: 0 errors.

- [ ] **Step 10.3: Deploy**

```bash
node index.js
```

- [ ] **Step 10.4: End-to-end test with a real directory**

Send in Feishu:
1. `/wiki import ~/AGI/MetaMe/docs` — should import md files
2. `/wiki` — list should now show pages with `source_type=doc`
3. `/wiki page <one-of-the-imported-slugs>` — should show content
4. `/wiki sync` — should run phased rebuild without errors

- [ ] **Step 10.5: Final commit**

```bash
git add -f docs/superpowers/plans/2026-04-15-wiki-import.md
git commit -m "docs: add wiki-import implementation plan"
```
