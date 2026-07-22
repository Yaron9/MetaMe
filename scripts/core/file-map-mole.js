'use strict';

const path = require('path');

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') return null;
  return {
    name: typeof entry.name === 'string' ? entry.name : path.basename(entry.path),
    path: entry.path,
    size: Number.isFinite(Number(entry.size)) ? Number(entry.size) : null,
    is_dir: !!entry.is_dir,
    insight: !!entry.insight,
  };
}

function parseAnalyzeJson(stdout, { limit = 100 } = {}) {
  let raw;
  try { raw = JSON.parse(String(stdout || '')); } catch { return { ok: false, error: 'invalid Mole analyze JSON' }; }
  if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !Array.isArray(raw.entries)) {
    return { ok: false, error: 'unsupported Mole analyze JSON shape' };
  }
  const cap = Math.max(1, Math.floor(Number(limit) || 100));
  const normalizeList = list => list.slice(0, cap + 1).map(normalizeEntry).filter(Boolean);
  const entries = normalizeList(raw.entries);
  const rawLargeFiles = Array.isArray(raw.large_files) ? raw.large_files : [];
  const largeFiles = normalizeList(rawLargeFiles);
  return {
    ok: true,
    path: raw.path,
    overview: !!raw.overview,
    total_size: Number.isFinite(Number(raw.total_size)) ? Number(raw.total_size) : null,
    total_files: Number.isFinite(Number(raw.total_files)) ? Number(raw.total_files) : null,
    entries: entries.slice(0, cap),
    large_files: largeFiles.slice(0, cap),
    truncated: raw.entries.length > cap || rawLargeFiles.length > cap || undefined,
  };
}

function parseCleanList(text, { limit = Infinity } = {}) {
  const cap = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : Infinity;
  const seen = new Set();
  const paths = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || !path.isAbsolute(value) || seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
    if (paths.length >= cap) break;
  }
  return paths;
}

function isPreviewFresh(mtimeMs, nowMs, ttlMs) {
  const age = nowMs - Number(mtimeMs);
  return Number.isFinite(age) && age >= 0 && age <= ttlMs;
}

module.exports = { parseAnalyzeJson, parseCleanList, isPreviewFresh, _internal: { normalizeEntry } };
