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
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add timeline column for Compiled Truth + Timeline model (existing DBs)
  try { db.exec("ALTER TABLE wiki_pages ADD COLUMN timeline TEXT DEFAULT ''"); } catch { /* column already exists */ }

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS recall_audit (
      id              TEXT PRIMARY KEY,
      ts              TEXT DEFAULT (datetime('now')),
      phase           TEXT NOT NULL DEFAULT 'observe',
      chat_id         TEXT,
      project         TEXT,
      scope           TEXT,
      agent_key       TEXT,
      engine          TEXT,
      session_started INTEGER DEFAULT 0,
      should_recall   INTEGER DEFAULT 0,
      router_reason   TEXT,
      query_hashes    TEXT DEFAULT '[]',
      anchor_labels   TEXT DEFAULT '[]',
      modes           TEXT DEFAULT '[]',
      source_refs     TEXT DEFAULT '[]',
      injected_chars  INTEGER DEFAULT 0,
      truncated       INTEGER DEFAULT 0,
      wiki_dropped    INTEGER DEFAULT 0,
      outcome         TEXT DEFAULT 'unknown'
                      CHECK (outcome IN ('unknown','planned','injected','used','ignored','corrected','harmful')),
      error_message  TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_recall_audit_ts      ON recall_audit(ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recall_audit_phase   ON recall_audit(phase, ts)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_recall_audit_project ON recall_audit(project, scope, ts)');

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
}

module.exports = { applyWikiSchema };
