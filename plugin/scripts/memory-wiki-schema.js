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
}

module.exports = { applyWikiSchema };
