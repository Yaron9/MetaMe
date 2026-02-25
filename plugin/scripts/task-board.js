'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.metame', 'task_board.db');

function parseJsonSafe(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function toJson(value, fallback) {
  try { return JSON.stringify(value); } catch { return JSON.stringify(fallback); }
}

function sanitizeText(input, maxLen = 1000) {
  return String(input || '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, maxLen);
}

function sanitizeStringArray(values, maxItems = 40, maxItemLen = 500) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const item of values) {
    const v = sanitizeText(item, maxItemLen);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

function createTaskBoard(opts = {}) {
  const dbPath = opts.dbPath || DEFAULT_DB_PATH;
  const logger = typeof opts.logger === 'function' ? opts.logger : null;
  let db = null;

  function logWarn(msg) {
    if (logger) logger(msg);
  }

  function getDb() {
    if (db) return db;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');

    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        task_id             TEXT PRIMARY KEY,
        scope_id            TEXT NOT NULL DEFAULT '',
        parent_task_id      TEXT,
        from_agent          TEXT NOT NULL,
        to_agent            TEXT NOT NULL,
        goal                TEXT NOT NULL,
        task_kind           TEXT NOT NULL DEFAULT 'team',
        participants        TEXT NOT NULL DEFAULT '[]',
        definition_of_done  TEXT NOT NULL DEFAULT '[]',
        inputs              TEXT NOT NULL DEFAULT '{}',
        artifacts           TEXT NOT NULL DEFAULT '[]',
        owned_paths         TEXT NOT NULL DEFAULT '[]',
        status              TEXT NOT NULL DEFAULT 'queued',
        priority            TEXT NOT NULL DEFAULT 'normal',
        summary             TEXT NOT NULL DEFAULT '',
        last_error          TEXT NOT NULL DEFAULT '',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      )
    `);
    try { db.exec("ALTER TABLE tasks ADD COLUMN scope_id TEXT NOT NULL DEFAULT ''"); } catch {}
    try { db.exec("ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'team'"); } catch {}
    try { db.exec("ALTER TABLE tasks ADD COLUMN participants TEXT NOT NULL DEFAULT '[]'"); } catch {}

    db.exec(`
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id          TEXT PRIMARY KEY,
        task_id             TEXT NOT NULL,
        from_agent          TEXT NOT NULL,
        to_agent            TEXT NOT NULL,
        payload             TEXT NOT NULL DEFAULT '{}',
        status              TEXT NOT NULL DEFAULT 'sent',
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS task_events (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id             TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        actor               TEXT NOT NULL,
        body                TEXT NOT NULL DEFAULT '{}',
        created_at          TEXT NOT NULL
      )
    `);

    try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_scope_id ON tasks(scope_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id)'); } catch {}
    try { db.exec('CREATE INDEX IF NOT EXISTS idx_handoffs_task_id ON handoffs(task_id)'); } catch {}
    return db;
  }

  function upsertTask(task) {
    if (!task || !task.task_id) return { ok: false, error: 'task_id_required' };
    const nowIso = new Date().toISOString();
    const safe = {
      task_id: sanitizeText(task.task_id, 80),
      scope_id: sanitizeText(task.scope_id, 120) || sanitizeText(task.task_id, 80),
      parent_task_id: sanitizeText(task.parent_task_id, 80) || null,
      from_agent: sanitizeText(task.from_agent, 80) || 'unknown',
      to_agent: sanitizeText(task.to_agent, 80),
      goal: sanitizeText(task.goal, 500),
      task_kind: sanitizeText(task.task_kind, 20) || 'team',
      participants: sanitizeStringArray(task.participants, 40, 80),
      definition_of_done: sanitizeStringArray(task.definition_of_done, 20, 300),
      inputs: task.inputs && typeof task.inputs === 'object' ? task.inputs : {},
      artifacts: sanitizeStringArray(task.artifacts, 40, 500),
      owned_paths: sanitizeStringArray(task.owned_paths, 40, 500),
      status: sanitizeText(task.status, 20) || 'queued',
      priority: sanitizeText(task.priority, 20) || 'normal',
      summary: sanitizeText(task.summary, 2000),
      last_error: sanitizeText(task.last_error, 2000),
      created_at: sanitizeText(task.created_at, 64) || nowIso,
      updated_at: sanitizeText(task.updated_at, 64) || nowIso,
    };
    if (!safe.task_id || !safe.to_agent || !safe.goal) {
      return { ok: false, error: 'task_fields_missing' };
    }

    const sql = `
      INSERT INTO tasks (
        task_id, scope_id, parent_task_id, from_agent, to_agent, goal, task_kind, participants,
        definition_of_done, inputs, artifacts, owned_paths, status, priority, summary, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        parent_task_id = excluded.parent_task_id,
        from_agent = excluded.from_agent,
        to_agent = excluded.to_agent,
        goal = excluded.goal,
        task_kind = excluded.task_kind,
        participants = excluded.participants,
        definition_of_done = excluded.definition_of_done,
        inputs = excluded.inputs,
        artifacts = excluded.artifacts,
        owned_paths = excluded.owned_paths,
        status = excluded.status,
        priority = excluded.priority,
        summary = excluded.summary,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `;
    try {
      getDb().prepare(sql).run(
        safe.task_id,
        safe.scope_id,
        safe.parent_task_id,
        safe.from_agent,
        safe.to_agent,
        safe.goal,
        safe.task_kind,
        toJson(safe.participants, []),
        toJson(safe.definition_of_done, []),
        toJson(safe.inputs, {}),
        toJson(safe.artifacts, []),
        toJson(safe.owned_paths, []),
        safe.status,
        safe.priority,
        safe.summary,
        safe.last_error,
        safe.created_at,
        safe.updated_at
      );
      return { ok: true, task_id: safe.task_id };
    } catch (e) {
      logWarn(`TaskBoard upsertTask failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  function appendTaskEvent(taskId, eventType, actor, body = {}) {
    const safeTaskId = sanitizeText(taskId, 80);
    if (!safeTaskId) return { ok: false, error: 'task_id_required' };
    const safeEvent = sanitizeText(eventType, 60) || 'event';
    const safeActor = sanitizeText(actor, 80) || 'system';
    const nowIso = new Date().toISOString();
    try {
      getDb().prepare(`
        INSERT INTO task_events (task_id, event_type, actor, body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(safeTaskId, safeEvent, safeActor, toJson(body, {}), nowIso);
      return { ok: true };
    } catch (e) {
      logWarn(`TaskBoard appendTaskEvent failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  function recordHandoff(handoff) {
    const nowIso = new Date().toISOString();
    const safe = {
      handoff_id: sanitizeText(handoff && handoff.handoff_id, 90),
      task_id: sanitizeText(handoff && handoff.task_id, 80),
      from_agent: sanitizeText(handoff && handoff.from_agent, 80) || 'unknown',
      to_agent: sanitizeText(handoff && handoff.to_agent, 80),
      payload: handoff && typeof handoff.payload === 'object' ? handoff.payload : {},
      status: sanitizeText(handoff && handoff.status, 30) || 'sent',
      created_at: sanitizeText(handoff && handoff.created_at, 64) || nowIso,
      updated_at: sanitizeText(handoff && handoff.updated_at, 64) || nowIso,
    };
    if (!safe.handoff_id || !safe.task_id || !safe.to_agent) return { ok: false, error: 'handoff_fields_missing' };
    try {
      getDb().prepare(`
        INSERT INTO handoffs (handoff_id, task_id, from_agent, to_agent, payload, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(handoff_id) DO UPDATE SET
          payload = excluded.payload,
          status = excluded.status,
          updated_at = excluded.updated_at
      `).run(
        safe.handoff_id,
        safe.task_id,
        safe.from_agent,
        safe.to_agent,
        toJson(safe.payload, {}),
        safe.status,
        safe.created_at,
        safe.updated_at
      );
      return { ok: true };
    } catch (e) {
      logWarn(`TaskBoard recordHandoff failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  function getTask(taskId) {
    const safeTaskId = sanitizeText(taskId, 80);
    if (!safeTaskId) return null;
    try {
      const row = getDb().prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId);
      if (!row) return null;
      return {
        ...row,
        participants: parseJsonSafe(row.participants, []),
        definition_of_done: parseJsonSafe(row.definition_of_done, []),
        inputs: parseJsonSafe(row.inputs, {}),
        artifacts: parseJsonSafe(row.artifacts, []),
        owned_paths: parseJsonSafe(row.owned_paths, []),
      };
    } catch (e) {
      logWarn(`TaskBoard getTask failed: ${e.message}`);
      return null;
    }
  }

  function listRecentTasks(limit = 10, status = null, taskKind = null) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 10));
    const statusVal = sanitizeText(status, 30);
    const kindVal = sanitizeText(taskKind, 20);
    try {
      let sql = 'SELECT * FROM tasks';
      const params = [];
      const where = [];
      if (statusVal) { where.push('status = ?'); params.push(statusVal); }
      if (kindVal) { where.push('task_kind = ?'); params.push(kindVal); }
      if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY updated_at DESC LIMIT ?';
      params.push(lim);
      const rows = getDb().prepare(sql).all(...params);
      return rows.map(r => ({
        ...r,
        participants: parseJsonSafe(r.participants, []),
        definition_of_done: parseJsonSafe(r.definition_of_done, []),
        inputs: parseJsonSafe(r.inputs, {}),
        artifacts: parseJsonSafe(r.artifacts, []),
        owned_paths: parseJsonSafe(r.owned_paths, []),
      }));
    } catch (e) {
      logWarn(`TaskBoard listRecentTasks failed: ${e.message}`);
      return [];
    }
  }

  function listTaskEvents(taskId, limit = 20) {
    const safeTaskId = sanitizeText(taskId, 80);
    if (!safeTaskId) return [];
    const lim = Math.max(1, Math.min(200, Number(limit) || 20));
    try {
      const rows = getDb()
        .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
        .all(safeTaskId, lim);
      return rows.map(r => ({ ...r, body: parseJsonSafe(r.body, {}) }));
    } catch (e) {
      logWarn(`TaskBoard listTaskEvents failed: ${e.message}`);
      return [];
    }
  }

  function listScopeTasks(scopeId, limit = 30) {
    const safeScopeId = sanitizeText(scopeId, 120);
    if (!safeScopeId) return [];
    const lim = Math.max(1, Math.min(200, Number(limit) || 30));
    try {
      const rows = getDb()
        .prepare('SELECT * FROM tasks WHERE scope_id = ? ORDER BY updated_at DESC LIMIT ?')
        .all(safeScopeId, lim);
      return rows.map(r => ({
        ...r,
        participants: parseJsonSafe(r.participants, []),
        definition_of_done: parseJsonSafe(r.definition_of_done, []),
        inputs: parseJsonSafe(r.inputs, {}),
        artifacts: parseJsonSafe(r.artifacts, []),
        owned_paths: parseJsonSafe(r.owned_paths, []),
      }));
    } catch (e) {
      logWarn(`TaskBoard listScopeTasks failed: ${e.message}`);
      return [];
    }
  }

  function listScopeParticipants(scopeId) {
    const tasks = listScopeTasks(scopeId, 200);
    const set = new Set();
    for (const t of tasks) {
      const arr = Array.isArray(t.participants) ? t.participants : [];
      for (const p of arr) {
        const v = sanitizeText(p, 80);
        if (v) set.add(v);
      }
      const from = sanitizeText(t.from_agent, 80);
      const to = sanitizeText(t.to_agent, 80);
      if (from) set.add(from);
      if (to) set.add(to);
    }
    return [...set];
  }

  function markTaskStatus(taskId, status, opts = {}) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const mergedArtifacts = sanitizeStringArray([...(task.artifacts || []), ...sanitizeStringArray(opts.artifacts || [])], 80, 500);
    const mergedOwned = sanitizeStringArray([...(task.owned_paths || []), ...sanitizeStringArray(opts.owned_paths || [])], 80, 500);
    const next = {
      ...task,
      status: sanitizeText(status, 20) || task.status,
      summary: sanitizeText(opts.summary, 2000) || task.summary || '',
      last_error: sanitizeText(opts.last_error, 2000) || '',
      artifacts: mergedArtifacts,
      owned_paths: mergedOwned,
      updated_at: new Date().toISOString(),
    };
    return upsertTask(next);
  }

  function addArtifacts(taskId, artifacts) {
    const task = getTask(taskId);
    if (!task) return { ok: false, error: 'task_not_found' };
    const merged = sanitizeStringArray([...(task.artifacts || []), ...sanitizeStringArray(artifacts || [])], 80, 500);
    return upsertTask({ ...task, artifacts: merged, updated_at: new Date().toISOString() });
  }

  function close() {
    if (!db) return;
    try { db.close(); } catch {}
    db = null;
  }

  return {
    dbPath,
    upsertTask,
    appendTaskEvent,
    recordHandoff,
    getTask,
    listRecentTasks,
    listScopeTasks,
    listScopeParticipants,
    listTaskEvents,
    markTaskStatus,
    addArtifacts,
    close,
  };
}

module.exports = {
  createTaskBoard,
  DEFAULT_DB_PATH,
};
