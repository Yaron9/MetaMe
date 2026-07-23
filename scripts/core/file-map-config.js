'use strict';

/**
 * file-map-config.js — load + normalize file-map.yaml (fs/yaml injected).
 *
 * The defaults below are the safety baseline: missing keys fall back to them,
 * so a hand-edited config can extend but not silently erase the protection
 * net. An unreadable user file falls back to the deployed template, then to
 * pure defaults; invalid YAML still yields a safe default config (ok:false so
 * callers can surface the problem without losing read-only tools).
 */

const DEFAULT_CONFIG = {
  roots: ['~'],
  protected: [
    '/System/**', '/Library/**', '/usr/**', '/bin/**', '/sbin/**',
    '/private/**', '/Applications/**',
    '~/Library/**', '~/.metame/**', '~/.claude/**', '~/.ssh/**', '~/.config/**',
    '**/.git', '**/.git/**',
    '~/*',
  ],
  protect_recent_days: 14,
  exclude: ['**/node_modules/**', '**/.git/**', '**/Library/**', '**/.Trash/**', '**/*.photoslibrary/**'],
  cleanup: { method: 'quarantine', proposal_ttl_minutes: 60, quarantine_days: 30, max_batch_files: 500, max_batch_gb: 50 },
  overview: { depth: 3, ttl_hours: 24, du_budget_seconds: 60 },
  storage: { min_report_mb: 500, du_budget_seconds: 45, target_max_categories: 12 },
  maintenance: {
    recent_days: 14,
    max_depth: 6,
    max_entries: 200000,
    budget_seconds: 15,
    snapshot_ttl_minutes: 60,
    max_candidates: 5000,
  },
};

function expandHome(p, home) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return home;
  if (p.startsWith('~/')) return home + p.slice(1);
  return p;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function stringList(value, fallback) {
  const cleaned = Array.isArray(value) ? value.filter(x => typeof x === 'string' && x) : [];
  return cleaned.length ? cleaned : fallback.slice();
}

function normalizeConfig(raw, home) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const cleanup = { ...DEFAULT_CONFIG.cleanup, ...(src.cleanup && typeof src.cleanup === 'object' ? src.cleanup : {}) };
  const overview = { ...DEFAULT_CONFIG.overview, ...(src.overview && typeof src.overview === 'object' ? src.overview : {}) };
  const storage = { ...DEFAULT_CONFIG.storage, ...(src.storage && typeof src.storage === 'object' ? src.storage : {}) };
  const maintenance = { ...DEFAULT_CONFIG.maintenance, ...(src.maintenance && typeof src.maintenance === 'object' ? src.maintenance : {}) };
  return {
    roots: stringList(src.roots, DEFAULT_CONFIG.roots).map(p => expandHome(p, home)),
    protectedPatterns: stringList(src.protected, DEFAULT_CONFIG.protected).map(p => expandHome(p, home)),
    protectRecentDays: clampNumber(src.protect_recent_days, DEFAULT_CONFIG.protect_recent_days, 0, 365),
    excludePatterns: stringList(src.exclude, DEFAULT_CONFIG.exclude).map(p => expandHome(p, home)),
    cleanup: {
      method: cleanup.method === 'trash' ? 'trash' : 'quarantine',
      proposalTtlMinutes: clampNumber(cleanup.proposal_ttl_minutes, 60, 5, 24 * 60),
      quarantineDays: clampNumber(cleanup.quarantine_days, 30, 1, 365),
      maxBatchFiles: clampNumber(cleanup.max_batch_files, 500, 1, 5000),
      maxBatchBytes: clampNumber(cleanup.max_batch_gb, 50, 1, 1000) * 1024 ** 3,
    },
    overview: {
      depth: clampNumber(overview.depth, 3, 1, 4),
      ttlHours: clampNumber(overview.ttl_hours, 24, 1, 24 * 14),
      duBudgetSeconds: clampNumber(overview.du_budget_seconds, 60, 5, 600),
    },
    storage: {
      minReportMb: clampNumber(storage.min_report_mb, 500, 0, 1024 * 1024),
      duBudgetSeconds: clampNumber(storage.du_budget_seconds, 45, 5, 120),
      targetMaxCategories: clampNumber(storage.target_max_categories, 12, 1, 30),
    },
    maintenance: {
      recentDays: clampNumber(maintenance.recent_days, 14, 0, 365),
      maxDepth: clampNumber(maintenance.max_depth, 6, 1, 12),
      maxEntries: clampNumber(maintenance.max_entries, 200000, 100, 1000000),
      budgetMs: clampNumber(maintenance.budget_seconds, 15, 1, 120) * 1000,
      snapshotTtlMs: clampNumber(maintenance.snapshot_ttl_minutes, 60, 5, 24 * 60) * 60 * 1000,
      maxCandidates: clampNumber(maintenance.max_candidates, 5000, 1, 20000),
    },
  };
}

function loadFileMapConfig({ fs, yaml, home, configPath, defaultPath }) {
  const candidates = [[configPath, 'user'], [defaultPath, 'template']];
  for (const [file, source] of candidates) {
    if (!file) continue;
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    try {
      return { ok: true, source, config: normalizeConfig(yaml.load(text), home) };
    } catch (err) {
      return { ok: false, error: `invalid YAML in ${file}: ${err.message}`, config: normalizeConfig(null, home) };
    }
  }
  return { ok: true, source: 'defaults', config: normalizeConfig(null, home) };
}

module.exports = { DEFAULT_CONFIG, expandHome, normalizeConfig, loadFileMapConfig, _internal: { clampNumber, stringList } };
