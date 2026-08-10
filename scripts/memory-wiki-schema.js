'use strict';

/**
 * memory-wiki-schema.js — Wiki DB schema initializer
 *
 * Exports:
 *   applyWikiSchema(db) — accepts a DatabaseSync instance, applies all DDL
 *                         (IF NOT EXISTS, idempotent — safe to call multiple times)
 *
 * Tables:
 *   wiki_pages       — topic knowledge pages
 *   wiki_topics      — controlled topic registry
 *   wiki_pages_fts   — FTS5 virtual table (content table, trigram tokenizer)
 *   content_chunks   — chunked page content with optional vector embeddings
 *   embedding_queue  — durable async queue for embedding generation
 *   wiki_external_sources — rebuildable file-to-page projection state
 *
 * Triggers:
 *   wiki_pages_fts_insert / wiki_pages_fts_update / wiki_pages_fts_delete
 */

/**
 * Apply wiki schema to a DatabaseSync instance.
 * @param {import('node:sqlite').DatabaseSync} db
 */
function applyWikiSchema(db) {
  // ── wiki_pages ──────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id                    TEXT PRIMARY KEY,
      slug                  TEXT UNIQUE NOT NULL,
      title                 TEXT NOT NULL,
      content               TEXT NOT NULL,
      primary_topic         TEXT NOT NULL,
      topic_tags            TEXT DEFAULT '[]',
      raw_source_ids        TEXT DEFAULT '[]',
      capsule_refs          TEXT DEFAULT '[]',
      staleness             REAL DEFAULT 0.0,
      raw_source_count      INTEGER DEFAULT 0,
      new_facts_since_build INTEGER DEFAULT 0,
      word_count            INTEGER DEFAULT 0,
      last_built_at         TEXT,
      projection_hash      TEXT,
      projection_at        TEXT,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add timeline column for Compiled Truth + Timeline model (existing DBs)
  try { db.exec("ALTER TABLE wiki_pages ADD COLUMN timeline TEXT DEFAULT ''"); } catch { /* column already exists */ }
  try { db.exec("ALTER TABLE wiki_pages ADD COLUMN page_kind TEXT DEFAULT 'topic_hub'"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN project_key TEXT'); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE wiki_pages ADD COLUMN build_profile TEXT DEFAULT 'legacy-v1'"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE wiki_pages ADD COLUMN source_membership_hash TEXT DEFAULT ''"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN eligibility_miss_count INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN projection_hash TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN projection_at TEXT'); } catch { /* already exists */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_pages_kind_project ON wiki_pages(page_kind, project_key)');

  // ── wiki_topics ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_topics (
      tag        TEXT PRIMARY KEY,
      slug       TEXT UNIQUE NOT NULL,
      label      TEXT NOT NULL,
      pinned     INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Canonical topic identity. Raw tags remain unchanged on memory_items; aliases
  // are the deterministic boundary between source vocabulary and generated pages.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_topic_aliases (
      normalized_alias TEXT PRIMARY KEY,
      raw_alias        TEXT NOT NULL,
      topic_slug       TEXT NOT NULL,
      created_at       TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (topic_slug) REFERENCES wiki_pages(slug) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_topic_aliases_slug ON wiki_topic_aliases(topic_slug)');

  // Scope is a recall relevance gate, not an authorization boundary.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_page_scopes (
      page_slug TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      PRIMARY KEY (page_slug, scope_key),
      FOREIGN KEY (page_slug) REFERENCES wiki_pages(slug) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_page_scopes_scope ON wiki_page_scopes(scope_key, page_slug)');

  // Minimal polymorphic evidence relation. Metadata stays in the source tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_page_evidence (
      page_slug    TEXT NOT NULL,
      evidence_type TEXT NOT NULL CHECK (evidence_type IN ('memory_item','paper_fact')),
      evidence_id  TEXT NOT NULL,
      PRIMARY KEY (page_slug, evidence_type, evidence_id),
      FOREIGN KEY (page_slug) REFERENCES wiki_pages(slug) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_page_evidence_source ON wiki_page_evidence(evidence_type, evidence_id)');

  // Human corrections are revision-bound annotations, never a second source
  // of truth for wiki_pages.  `status` mirrors `state` for older callers that
  // use status terminology; both are kept in sync by the annotation writer.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_annotations (
      id                    TEXT PRIMARY KEY,
      page_slug             TEXT NOT NULL,
      base_projection_hash  TEXT,
      content               TEXT NOT NULL,
      content_hash          TEXT NOT NULL,
      claim_key             TEXT,
      claim_id              TEXT,
      claim_outcome         TEXT,
      state                 TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending','admitted','conflict','archived')),
      status                TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','admitted','conflict','archived')),
      source_path           TEXT,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (page_slug) REFERENCES wiki_pages(slug) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_annotations_page ON wiki_annotations(page_slug, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_annotations_status ON wiki_annotations(status, state)');

  // ── wiki_pages_fts (FTS5 content table) ─────────────────────────────────────
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS wiki_pages_fts USING fts5(
        slug, title, content, topic_tags,
        content='wiki_pages',
        content_rowid='rowid',
        tokenize='trigram'
      )
    `);
  } catch { /* already exists */ }

  // ── FTS5 sync triggers ───────────────────────────────────────────────────────
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_insert
      AFTER INSERT ON wiki_pages BEGIN
      INSERT INTO wiki_pages_fts(rowid, slug, title, content, topic_tags)
        VALUES (new.rowid, new.slug, new.title, new.content, new.topic_tags);
    END
  `);

  // DROP+CREATE to upgrade existing unguarded trigger on deployed DBs
  db.exec('DROP TRIGGER IF EXISTS wiki_pages_fts_update');
  db.exec(`
    CREATE TRIGGER wiki_pages_fts_update
      AFTER UPDATE ON wiki_pages
      WHEN old.slug IS NOT new.slug OR old.title IS NOT new.title
        OR old.content IS NOT new.content OR old.topic_tags IS NOT new.topic_tags
    BEGIN
      INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, slug, title, content, topic_tags)
        VALUES ('delete', old.rowid, old.slug, old.title, old.content, old.topic_tags);
      INSERT INTO wiki_pages_fts(rowid, slug, title, content, topic_tags)
        VALUES (new.rowid, new.slug, new.title, new.content, new.topic_tags);
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_delete
      AFTER DELETE ON wiki_pages BEGIN
      INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, slug, title, content, topic_tags)
        VALUES ('delete', old.rowid, old.slug, old.title, old.content, old.topic_tags);
    END
  `);

  // ── content_chunks (vector embedding storage for wiki pages) ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_chunks (
      id              TEXT PRIMARY KEY,
      page_slug       TEXT NOT NULL,
      chunk_text      TEXT NOT NULL,
      chunk_idx       INTEGER NOT NULL,
      embedding       BLOB,
      embedding_model TEXT,
      embedding_dim   INTEGER,
      created_at      TEXT DEFAULT (datetime('now'))
    )
  `);
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_slug ON content_chunks(page_slug)'); } catch { }

  // ── embedding_queue (durable async queue for embedding generation) ──────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_queue (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_type   TEXT NOT NULL,
      item_id     TEXT NOT NULL,
      model       TEXT DEFAULT 'text-embedding-3-small',
      attempts    INTEGER DEFAULT 0,
      last_error  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── session_sources (raw transcript provenance, L0) ───────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_sources (
      id               TEXT PRIMARY KEY,
      engine           TEXT NOT NULL DEFAULT 'unknown'
                       CHECK (engine IN ('claude','codex','unknown')),
      session_id       TEXT NOT NULL,
      project          TEXT DEFAULT '*',
      scope            TEXT,
      agent_key        TEXT,
      cwd              TEXT,
      source_path      TEXT,
      source_hash      TEXT NOT NULL,
      source_size      INTEGER DEFAULT 0,
      first_ts         TEXT,
      last_ts          TEXT,
      message_count    INTEGER DEFAULT 0,
      tool_call_count  INTEGER DEFAULT 0,
      tool_error_count INTEGER DEFAULT 0,
      status           TEXT DEFAULT 'indexed'
                       CHECK (status IN ('indexed','summarized','extracted','error','archived')),
      error_message    TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(engine, session_id, source_hash)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_session ON session_sources(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_project ON session_sources(project, scope, last_ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_sources_agent   ON session_sources(agent_key, last_ts)');

  // Universal Session Source/extraction state is an additive migration owned
  // by the core source boundary. It is deliberately idempotent and does not
  // consume the shared SQLite user_version value.
  try {
    const { ensureSessionSourceSchema } = require('./core/session-source-db');
    const { ensureExtractionRunSchema } = require('./core/extraction-run-db');
    ensureSessionSourceSchema(db);
    ensureExtractionRunSchema(db);
  } catch (error) {
    // Keep the historical wiki schema initialization behavior for callers
    // that open a partial legacy database; source-aware callers retry the
    // migration through session-source-db before using the public seam.
    if (error && error.code === 'session_source_database_required') throw error;
  }

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

  // ── wiki_external_sources ─────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS wiki_external_sources (
      source_key      TEXT PRIMARY KEY,
      page_slug       TEXT UNIQUE NOT NULL,
      relative_path   TEXT UNIQUE NOT NULL,
      content_hash    TEXT NOT NULL,
      last_seen_run   TEXT NOT NULL,
      missing_count   INTEGER NOT NULL DEFAULT 0,
      imported_at     TEXT DEFAULT (datetime('now')),
      updated_at      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (page_slug) REFERENCES wiki_pages(slug) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wiki_external_missing ON wiki_external_sources(missing_count)`);

  // ── wiki_pages additions (idempotent ALTER) ───────────────────────────────
  for (const [col, def] of [
    ['source_type',    "TEXT DEFAULT 'memory'"],
    ['membership_hash','TEXT'],
    ['cluster_size',   'INTEGER'],
  ]) {
    try { db.exec(`ALTER TABLE wiki_pages ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  }
  db.exec("UPDATE wiki_pages SET source_type = 'memory' WHERE source_type IS NULL");

  // ── doc_sources additions (idempotent ALTER) ──────────────────────────────
  for (const [col, def] of [
    ['doi',            'TEXT'],
    ['year',           'INTEGER'],
    ['venue',          'TEXT'],
    ['zotero_key',     'TEXT'],
    ['citation_count', 'INTEGER'],
  ]) {
    try { db.exec(`ALTER TABLE doc_sources ADD COLUMN ${col} ${def}`); } catch { /* already exists */ }
  }

  // ── paper_facts ───────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_facts (
      id                TEXT PRIMARY KEY,
      doc_source_id     INTEGER NOT NULL,
      fact_type         TEXT NOT NULL CHECK (fact_type IN (
                          'problem','method','claim','assumption',
                          'dataset','metric','result','baseline',
                          'limitation','future_work','contradiction_note'
                        )),
      subject           TEXT,
      predicate         TEXT,
      object            TEXT,
      value             TEXT,
      unit              TEXT,
      context           TEXT,
      evidence_text     TEXT NOT NULL,
      section           TEXT,
      extraction_source TEXT DEFAULT 'pdf_llm_section'
                        CHECK (extraction_source IN (
                          'pdf_llm_section',
                          'zotero_deep_read',
                          'manual'
                        )),
      confidence        REAL DEFAULT 0.7,
      created_at        TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (doc_source_id) REFERENCES doc_sources(id) ON DELETE CASCADE
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_paper_facts_doc     ON paper_facts(doc_source_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_paper_facts_type    ON paper_facts(fact_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_paper_facts_subject ON paper_facts(subject)');

  // ── research_entities ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_entities (
      id          TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN (
                    'problem','concept','method_family','dataset','metric','application'
                  )),
      name        TEXT NOT NULL UNIQUE,
      aliases     TEXT DEFAULT '[]',
      description TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── fact_entity_links ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_entity_links (
      fact_id   TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      role      TEXT,
      PRIMARY KEY (fact_id, entity_id),
      FOREIGN KEY (fact_id)   REFERENCES paper_facts(id)       ON DELETE CASCADE,
      FOREIGN KEY (entity_id) REFERENCES research_entities(id) ON DELETE CASCADE
    )
  `);

  // ── recall_audit (v4.1 §P1.17): observe + inject phase telemetry ──────────
  // DDL is shared with core/recall-audit-db.js via core/recall-audit-ddl.js
  // (single source of truth, §0.5 no-redundancy).
  const { RECALL_AUDIT_DDL, RECALL_AUDIT_INDEXES, RECALL_AUDIT_STATE_DDL } = require('./core/recall-audit-ddl');
  db.exec(RECALL_AUDIT_DDL);
  try { db.exec('ALTER TABLE recall_audit ADD COLUMN external_shadow_hits INTEGER DEFAULT 0'); } catch { }
  for (const [name, type] of [
      ['consumer_stage', 'TEXT'], ['consumer_type', 'TEXT'], ['trace_id', 'TEXT'],
      ['latency_ms', 'INTEGER DEFAULT 0'], ['token_count', 'INTEGER DEFAULT 0'],
      ['evidence_class', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE recall_audit ADD COLUMN ${name} ${type}`); } catch { }
  }
  for (const idx of RECALL_AUDIT_INDEXES) db.exec(idx);
  db.exec(RECALL_AUDIT_STATE_DDL);

  // ── memory_review_decisions (v4.1 §P1.7): Phase-3 candidate review idempotency ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_review_decisions (
      content_hash TEXT PRIMARY KEY,
      item_id      TEXT NOT NULL,
      decision     TEXT NOT NULL CHECK (decision IN ('promoted','merged','rejected','aged_out')),
      reason       TEXT,
      reviewed_at  TEXT DEFAULT (datetime('now')),
      reviewer     TEXT DEFAULT 'nightly'
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_review_decisions_item ON memory_review_decisions(item_id)');

  // ── memory_items.archive_reason (v4.1 §P1.9): tracks why item was archived ─
  // NULL = legacy archive (reason unknown); positive-match queries only.
  try { db.exec('ALTER TABLE memory_items ADD COLUMN archive_reason TEXT'); } catch { /* already exists */ }

  // Explicit provenance contract. Backfill is deterministic and deliberately
  // recognizes only known generator fingerprints; relation=NULL alone is never
  // treated as derived. applyWikiSchema is also used by projection-only test DBs,
  // so the memory migration remains conditional on the source table existing.
  const hasMemoryItems = !!db.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='memory_items'"
  ).get();
  if (hasMemoryItems) {
    // Claim Contract v1 identity is additive. Legacy rows stay NULL and are
    // intentionally never re-keyed from title, tags, or popularity.
    try { db.exec('ALTER TABLE memory_items ADD COLUMN canonical_key TEXT'); } catch { /* already exists */ }
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_mi_canonical_identity ON memory_items(canonical_key, project, scope)'); } catch { /* partial legacy fixture */ }
    try { db.exec('ALTER TABLE memory_items ADD COLUMN relation TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE memory_items ADD COLUMN source_id TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE memory_items ADD COLUMN session_id TEXT'); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE memory_items ADD COLUMN task_key TEXT'); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE memory_items ADD COLUMN origin_class TEXT DEFAULT 'primary'"); } catch { /* already exists */ }
    try { db.exec('ALTER TABLE memory_items ADD COLUMN provenance_root_id TEXT'); } catch { /* already exists */ }
    db.exec(`
      UPDATE memory_items
         SET origin_class = CASE
           WHEN relation IN ('synthesized_insight','knowledge_capsule')
             OR lower(COALESCE(source_id, '')) LIKE 'nightly-reflect-%'
             OR lower(COALESCE(source_id, '')) LIKE 'capsule-%'
           THEN 'derived' ELSE 'primary' END
       WHERE origin_class IS NULL
          OR origin_class NOT IN ('primary','derived')
          OR (origin_class='primary' AND (
            relation IN ('synthesized_insight','knowledge_capsule')
            OR lower(COALESCE(source_id, '')) LIKE 'nightly-reflect-%'
            OR lower(COALESCE(source_id, '')) LIKE 'capsule-%'))
    `);
    db.exec(`
      UPDATE memory_items
         SET provenance_root_id = CASE
           WHEN COALESCE(source_id, '') != '' THEN 'source:' || source_id
           WHEN COALESCE(session_id, '') != '' THEN 'session:' || session_id
           WHEN COALESCE(task_key, '') != '' THEN 'task:' || task_key
           ELSE NULL END
       WHERE provenance_root_id IS NULL OR provenance_root_id = ''
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mi_origin_state ON memory_items(origin_class, state)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mi_provenance_root ON memory_items(provenance_root_id)');
  }

  // Markdown-authoritative knowledge artifacts. This registry is a disposable
  // projection and must always be rebuildable from canonical files.
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_artifact_registry (
      artifact_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('decision','playbook')),
      canonical_key TEXT NOT NULL UNIQUE,
      project_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','active','stale','superseded','retired')),
      revision INTEGER NOT NULL,
      source_path TEXT NOT NULL UNIQUE,
      page_slug TEXT,
      content_hash TEXT NOT NULL,
      evidence_membership_hash TEXT NOT NULL,
      previous_hash TEXT,
      generator_version TEXT NOT NULL,
      projected_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_artifact_kind_scope_status ON knowledge_artifact_registry(kind, project_key, status)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_lineage (
      child_kind TEXT NOT NULL,
      child_id TEXT NOT NULL,
      parent_kind TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      run_id TEXT,
      transform TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'evidence',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (child_kind, child_id, parent_kind, parent_id, role)
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_lineage_parent ON knowledge_lineage(parent_kind, parent_id)');
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN artifact_id TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN artifact_status TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN artifact_revision INTEGER'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN canonical_key TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE wiki_pages ADD COLUMN source_path TEXT'); } catch { /* already exists */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_wiki_artifact_lookup ON wiki_pages(page_kind, artifact_status, project_key)');
}

module.exports = { applyWikiSchema };
