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

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS wiki_pages_fts_update
      AFTER UPDATE ON wiki_pages BEGIN
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
}

module.exports = { applyWikiSchema };
