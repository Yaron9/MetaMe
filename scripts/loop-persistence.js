'use strict';

function encodeJson(value) {
  return JSON.stringify(value === undefined ? {} : value);
}

function parseJson(raw, fallback = {}) {
  try { return JSON.parse(raw); } catch { return fallback; }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function appendLoopEvent(db, event) {
  db.prepare(`
    INSERT INTO loop_events (goal_id, run_id, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    event.goalId,
    event.runId || null,
    event.type,
    encodeJson(event.payload),
    event.createdAt
  );
}

function appendOutbox(db, item, nowIso) {
  if (!item) return;
  const topic = String(item.topic || '').trim();
  const dedupeKey = String(item.dedupeKey || '').trim();
  if (!topic || !dedupeKey) throw new Error('outbox_identity_required');
  db.prepare(`
    INSERT INTO outbox (goal_id, run_id, topic, dedupe_key, payload, available_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    item.goalId || null,
    item.runId || null,
    topic,
    dedupeKey,
    encodeJson(item.payload),
    item.availableAt || nowIso
  );
}

module.exports = { encodeJson, parseJson, canonicalJson, appendLoopEvent, appendOutbox };
