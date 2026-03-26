'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

function log(msg) { process.stderr.write(`[migrate-v2] ${msg}\n`); }

function die(msg) {
  log(`FATAL: ${msg}`);
  process.exit(1);
}

// ── Mapping helpers ──

const KIND_MAP_CONVENTION = new Set([
  'bug_lesson', 'arch_convention', 'workflow_rule', 'config_fact', 'config_change',
]);
const KIND_MAP_INSIGHT = new Set([
  'tech_decision', 'project_milestone',
]);

function mapKind(relation) {
  if (KIND_MAP_CONVENTION.has(relation)) return 'convention';
  if (KIND_MAP_INSIGHT.has(relation)) return 'insight';
  return 'insight';
}

function mapState(conflictStatus) {
  if (conflictStatus === 'OK') return 'active';
  if (conflictStatus === 'ARCHIVED') return 'archived';
  if (conflictStatus === 'CONFLICT') return 'candidate';
  return 'active';
}

function mapConfidence(text) {
  if (text === 'high') return 0.9;
  if (text === 'medium') return 0.7;
  if (text === 'low') return 0.4;
  return 0.7;
}

// ── Main ──

function main() {
  if (!fs.existsSync(DB_PATH)) die(`DB not found: ${DB_PATH}`);

  // Backup
  const ts = Date.now();
  const backupPath = `${DB_PATH}.backup-v2-${ts}`;
  fs.copyFileSync(DB_PATH, backupPath);
  log(`Backup created: ${backupPath}`);

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = OFF');

  // Safety check
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM memory_items').get();
    if (row.n > 0) die('Already migrated — memory_items has rows');
  } catch {
    // table doesn't exist yet, good
  }

  db.exec('BEGIN');

  try {
    // ── Step 1: Create new table ──
    log('Step 1: Creating memory_items table...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_items (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        state           TEXT NOT NULL DEFAULT 'candidate',
        title           TEXT,
        content         TEXT NOT NULL,
        summary         TEXT,
        confidence      REAL DEFAULT 0.5,
        project         TEXT DEFAULT '*',
        scope           TEXT,
        task_key        TEXT,
        session_id      TEXT,
        agent_key       TEXT,
        supersedes_id   TEXT,
        source_type     TEXT,
        source_id       TEXT,
        search_count    INTEGER DEFAULT 0,
        last_searched_at TEXT,
        tags            TEXT DEFAULT '[]',
        created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
          title, content, tags,
          content='memory_items',
          content_rowid='rowid',
          tokenize='trigram'
        )
      `);
    } catch { /* already exists */ }

    db.exec('CREATE INDEX IF NOT EXISTS idx_mi_kind_state ON memory_items(kind, state)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mi_project ON memory_items(project)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mi_scope ON memory_items(scope)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mi_supersedes ON memory_items(supersedes_id)');

    const ftsTriggers = [
      `CREATE TRIGGER IF NOT EXISTS mi_ai AFTER INSERT ON memory_items BEGIN
         INSERT INTO memory_items_fts(rowid, title, content, tags)
         VALUES (new.rowid, new.title, new.content, new.tags);
       END`,
      `CREATE TRIGGER IF NOT EXISTS mi_ad AFTER DELETE ON memory_items BEGIN
         INSERT INTO memory_items_fts(memory_items_fts, rowid, title, content, tags)
         VALUES ('delete', old.rowid, old.title, old.content, old.tags);
       END`,
      `CREATE TRIGGER IF NOT EXISTS mi_au AFTER UPDATE ON memory_items BEGIN
         INSERT INTO memory_items_fts(memory_items_fts, rowid, title, content, tags)
         VALUES ('delete', old.rowid, old.title, old.content, old.tags);
         INSERT INTO memory_items_fts(rowid, title, content, tags)
         VALUES (new.rowid, new.title, new.content, new.tags);
       END`,
    ];
    for (const t of ftsTriggers) {
      try { db.exec(t); } catch { /* already exists */ }
    }

    // ── Step 2: Migrate facts ──
    log('Step 2: Migrating facts...');

    const insertMi = db.prepare(`
      INSERT INTO memory_items
        (id, kind, state, title, content, confidence, project, scope,
         source_type, source_id, search_count, last_searched_at, tags,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const facts = db.prepare('SELECT * FROM facts').all();
    let factsMigrated = 0;

    for (const f of facts) {
      const newId = 'mi_' + f.id;
      insertMi.run(
        newId,
        mapKind(f.relation),
        mapState(f.conflict_status || 'OK'),
        (f.entity || '') + ' \u00b7 ' + (f.relation || ''),
        f.value,
        mapConfidence(f.confidence),
        f.project || '*',
        f.scope || null,
        f.source_type || null,
        f.source_id || null,
        f.search_count || 0,
        f.last_searched_at || null,
        f.tags || '[]',
        f.created_at,
        f.updated_at || f.created_at
      );
      factsMigrated++;
    }

    // Second pass: supersedes_id (reverse pointer)
    const updateSupersedes = db.prepare(
      'UPDATE memory_items SET supersedes_id = ? WHERE id = ?'
    );
    for (const f of facts) {
      if (f.superseded_by) {
        const newNewId = 'mi_' + f.superseded_by;
        const oldNewId = 'mi_' + f.id;
        updateSupersedes.run(oldNewId, newNewId);
      }
    }

    // ── Step 3: Migrate sessions ──
    log('Step 3: Migrating sessions...');

    const sessions = db.prepare('SELECT * FROM sessions').all();
    let sessionsMigrated = 0;

    const insertEpisode = db.prepare(`
      INSERT INTO memory_items
        (id, kind, state, title, content, confidence, project, scope,
         session_id, source_type, source_id, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of sessions) {
      const newId = 'mi_ses_' + s.id;
      const title = (s.summary || '').slice(0, 80);
      const kw = (s.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
      const tags = JSON.stringify(kw);

      insertEpisode.run(
        newId,
        'episode',
        'active',
        title,
        s.summary || '',
        0.7,
        s.project || '*',
        s.scope || null,
        s.id,
        'session',
        s.id,
        tags,
        s.created_at,
        s.created_at
      );
      sessionsMigrated++;
    }

    // ── Step 4: Merge fact_labels into tags ──
    log('Step 4: Merging fact_labels into tags...');

    let labelsTable = false;
    try {
      db.prepare("SELECT 1 FROM fact_labels LIMIT 1").get();
      labelsTable = true;
    } catch { /* table doesn't exist */ }

    if (labelsTable) {
      const labels = db.prepare('SELECT fact_id, label FROM fact_labels').all();
      const labelMap = new Map();
      for (const row of labels) {
        if (!labelMap.has(row.fact_id)) labelMap.set(row.fact_id, []);
        labelMap.get(row.fact_id).push(row.label);
      }

      const readTags = db.prepare('SELECT tags FROM memory_items WHERE id = ?');
      const writeTags = db.prepare('UPDATE memory_items SET tags = ? WHERE id = ?');

      for (const [factId, lbls] of labelMap) {
        const miId = 'mi_' + factId;
        const existing = readTags.get(miId);
        if (!existing) continue;

        let arr = [];
        try { arr = JSON.parse(existing.tags || '[]'); } catch { arr = []; }
        const merged = [...new Set([...arr, ...lbls])];
        writeTags.run(JSON.stringify(merged), miId);
      }
      log(`  Merged labels for ${labelMap.size} facts`);
    }

    // ── Step 5: Verify counts ──
    log('Step 5: Verifying counts...');

    const miFactCount = db.prepare(
      "SELECT COUNT(*) AS n FROM memory_items WHERE kind IN ('insight','convention')"
    ).get().n;
    const miEpisodeCount = db.prepare(
      "SELECT COUNT(*) AS n FROM memory_items WHERE kind = 'episode'"
    ).get().n;

    log(`  Migrated ${facts.length} facts -> ${miFactCount} memory_items (insight/convention)`);
    log(`  Migrated ${sessions.length} sessions -> ${miEpisodeCount} memory_items (episode)`);

    if (miFactCount !== factsMigrated) die(`Fact count mismatch: expected ${factsMigrated}, got ${miFactCount}`);
    if (miEpisodeCount !== sessionsMigrated) die(`Session count mismatch: expected ${sessionsMigrated}, got ${miEpisodeCount}`);

    // ── Step 6: Rename old tables ──
    log('Step 6: Renaming old tables...');

    db.exec('DROP TRIGGER IF EXISTS facts_ai');
    db.exec('DROP TRIGGER IF EXISTS facts_ad');
    db.exec('DROP TRIGGER IF EXISTS facts_au');
    db.exec('DROP TRIGGER IF EXISTS sessions_ai');
    db.exec('DROP TRIGGER IF EXISTS sessions_ad');
    db.exec('DROP TRIGGER IF EXISTS sessions_au');

    db.exec('DROP TABLE IF EXISTS facts_fts');
    db.exec('DROP TABLE IF EXISTS sessions_fts');

    db.exec('ALTER TABLE facts RENAME TO facts_v1');
    db.exec('ALTER TABLE sessions RENAME TO sessions_v1');
    if (labelsTable) db.exec('ALTER TABLE fact_labels RENAME TO fact_labels_v1');

    // ── Step 7: Rebuild FTS5 ──
    log('Step 7: Rebuilding FTS5 index...');
    db.exec("INSERT INTO memory_items_fts(memory_items_fts) VALUES('rebuild')");

    db.exec('COMMIT');
    log('Migration complete.');
    db.close();
    process.exit(0);

  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    die(err.stack || err.message);
  }
}

main();
