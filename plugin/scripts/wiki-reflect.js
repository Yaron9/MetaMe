'use strict';

/**
 * wiki-reflect.js — Wiki page rebuild orchestrator
 *
 * Process flow:
 *   1. Acquire process lock (O_EXCL file flag, 10-min staleness detection)
 *   2. Read all wiki_topics from DB
 *   3. Per topic: query → build → export (failure per page does not stop others)
 *   4. Rebuild _index.md
 *   5. Release lock
 *   6. Append audit log entry to wiki_reflect_log.jsonl
 *
 * Exports:
 *   runWikiReflect(db, { outputDir, capsulesDir, logPath, providers, staleness }) → { built, failed, exportFailed }
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { listWikiTopics, getWikiPageBySlug, listWikiPages, listRecentSessionSummaries } = require('./core/wiki-db');
const { queryRawFacts } = require('./wiki-reflect-query');
const { buildWikiPage } = require('./wiki-reflect-build');
const {
  exportWikiPage,
  rebuildIndex,
  exportSessionSummary,
  rebuildSessionsIndex,
  exportCapsuleFile,
  rebuildCapsulesIndex,
} = require('./wiki-reflect-export');

const DEFAULT_WIKI_DIR = path.join(os.homedir(), '.metame', 'wiki');
const DEFAULT_CAPSULES_DIR = path.join(os.homedir(), '.metame', 'memory', 'capsules');
const DEFAULT_LOG_PATH = path.join(os.homedir(), '.metame', 'wiki_reflect_log.jsonl');
const LOCK_FILE = path.join(os.homedir(), '.metame', 'wiki-reflect.lock');
const LOCK_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const STALENESS_THRESHOLD = 0.4;
const MAX_RETRIES = 3;

/**
 * Run wiki reflect pipeline.
 *
 * @param {object} db - DatabaseSync instance
 * @param {{
 *   outputDir?: string,
 *   capsulesDir?: string,
 *   logPath?: string,
 *   providers: { callHaiku: Function, buildDistillEnv: Function },
 *   threshold?: number,
 * }} opts
 * @returns {{ built: string[], failed: object[], exportFailed: string[] }}
 */
async function runWikiReflect(db, {
  outputDir = DEFAULT_WIKI_DIR,
  capsulesDir = DEFAULT_CAPSULES_DIR,
  logPath = DEFAULT_LOG_PATH,
  providers,
  threshold = STALENESS_THRESHOLD,
} = {}) {
  const startMs = Date.now();

  // 1. Acquire lock
  if (!_acquireLock(LOCK_FILE)) {
    throw new Error('wiki-reflect: another instance is running (lock file exists and is recent)');
  }

  const built = [];
  const failed = [];
  const exportFailed = [];
  const strippedLinksMap = {};

  try {
    // 2. Load previous failed_slugs for retry logic
    const failedSlugsMap = _loadFailedSlugs(logPath);

    // 3. Get all registered topics and their allowed slugs (for wikilink whitelist)
    const topics = listWikiTopics(db);
    const allowedSlugs = topics.map(t => t.slug);

    // 4. Process each topic
    for (const topic of topics) {
      const slug = topic.slug;

      // Determine if this page should be rebuilt
      const existingPage = getWikiPageBySlug(db, slug);
      const staleness = existingPage ? existingPage.staleness : 1.0;
      const failedEntry = failedSlugsMap.get(slug);

      const needsBuild = _shouldBuild(staleness, failedEntry, threshold);
      if (!needsBuild) continue;

      try {
        // Query raw facts
        const queryResult = queryRawFacts(db, topic.tag, { capsulesDir });

        if (queryResult.totalCount === 0) {
          // No facts for this topic yet — skip without marking as failed
          continue;
        }

        // Build (LLM + DB write)
        const buildResult = await buildWikiPage(db, topic, queryResult, {
          allowedSlugs,
          providers,
        });

        if (buildResult === null) {
          // LLM failure
          const retries = failedEntry ? failedEntry.retries + 1 : 1;
          failed.push({
            slug,
            retries,
            next_retry: retries >= MAX_RETRIES ? null : _nextRetryISO(retries),
            permanent_error: retries >= MAX_RETRIES,
          });
          continue;
        }

        // Track stripped links for audit log
        if (buildResult.strippedLinks.length > 0) {
          strippedLinksMap[slug] = buildResult.strippedLinks;
        }

        // Export (file write)
        const updatedPage = getWikiPageBySlug(db, slug);
        const frontmatter = {
          title: updatedPage.title,
          slug,
          tags: _parseTags(updatedPage.topic_tags),
          created: (updatedPage.created_at || '').slice(0, 10),
          last_built: (updatedPage.last_built_at || '').slice(0, 10),
          raw_sources: updatedPage.raw_source_count,
          staleness: updatedPage.staleness,
        };

        try {
          exportWikiPage(slug, frontmatter, buildResult.content, outputDir);
          built.push(slug);
        } catch (exportErr) {
          // DB write succeeded, file write failed — log separately.
          // Do NOT push to built: callers must not assume the file exists.
          exportFailed.push(slug);
        }

      } catch (err) {
        // Unexpected error (DB failure from buildWikiPage throws)
        const retries = failedEntry ? failedEntry.retries + 1 : 1;
        failed.push({
          slug,
          retries,
          next_retry: retries >= MAX_RETRIES ? null : _nextRetryISO(retries),
          permanent_error: retries >= MAX_RETRIES,
        });
      }
    }

    // 5. Rebuild index — per-operation try/catch so one failure doesn't suppress the rest
    let allPages = [];
    let sessions = [];
    try { allPages = listWikiPages(db, { limit: 1000, orderBy: 'title' }); } catch { /* non-fatal */ }
    try { sessions = listRecentSessionSummaries(db, { limit: 200 }); } catch { /* non-fatal */ }
    const capsuleFiles = _listCapsuleFiles(capsulesDir);

    try {
      rebuildIndex(allPages, outputDir, { sessionCount: sessions.length, capsuleCount: capsuleFiles.length });
    } catch { /* non-fatal — _index.md not updated */ }

    for (const entry of sessions) {
      try { exportSessionSummary(entry, outputDir, { wikiPages: allPages, capsuleFiles }); }
      catch { /* non-fatal — skip this session */ }
    }
    try { rebuildSessionsIndex(sessions, outputDir); } catch { /* non-fatal */ }

    for (const capsuleFile of capsuleFiles) {
      try { exportCapsuleFile(capsuleFile, outputDir); }
      catch { /* non-fatal — skip this capsule */ }
    }
    try { rebuildCapsulesIndex(capsuleFiles, outputDir); } catch { /* non-fatal */ }

  } finally {
    // 6. Release lock
    _releaseLock(LOCK_FILE);

    // 7. Write audit log
    const entry = {
      ts: new Date().toISOString(),
      slugs_built: built,
      export_failed_slugs: exportFailed,
      failed_slugs: failed,
      stripped_links: strippedLinksMap,
      duration_ms: Date.now() - startMs,
    };
    try {
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* non-fatal */ }
  }

  return { built, failed, exportFailed };
}

// ── Lock helpers ──────────────────────────────────────────────────────────────

function _acquireLock(lockFile) {
  // Check if lock file exists and is recent
  try {
    const stat = fs.statSync(lockFile);
    const age = Date.now() - stat.mtimeMs;
    if (age < LOCK_MAX_AGE_MS) return false; // Lock is held
    // Stale lock — remove it
    fs.unlinkSync(lockFile);
  } catch {
    // Lock file doesn't exist — proceed
  }

  try {
    // O_EXCL ensures atomic creation (no race condition)
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false; // Another process created the lock between our check and write
  }
}

function _releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
}

function _listCapsuleFiles(capsulesDir) {
  try {
    if (!fs.existsSync(capsulesDir)) return [];
    return fs.readdirSync(capsulesDir)
      .filter(name => name.endsWith('.md'))
      .map(name => path.join(capsulesDir, name));
  } catch {
    return [];
  }
}

// ── failed_slugs helpers ──────────────────────────────────────────────────────

/**
 * Load the most recent failed_slugs from the audit log.
 * @param {string} logPath
 * @returns {Map<string, { retries: number, next_retry: string|null, permanent_error?: boolean }>}
 */
function _loadFailedSlugs(logPath) {
  const map = new Map();
  if (!fs.existsSync(logPath)) return map;

  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return map;

    // Use the most recent log entry
    const last = JSON.parse(lines[lines.length - 1]);
    for (const entry of (last.failed_slugs || [])) {
      map.set(entry.slug, {
        retries: entry.retries || 0,
        next_retry: entry.next_retry || null,
        permanent_error: entry.permanent_error || false,
      });
    }
  } catch { /* corrupted log — start fresh */ }

  return map;
}

/**
 * Determine if a page should be rebuilt this round.
 */
function _shouldBuild(staleness, failedEntry, threshold) {
  // Permanent error → skip
  if (failedEntry && failedEntry.permanent_error) return false;

  // Retry queue: retries < MAX_RETRIES AND next_retry has passed
  if (failedEntry && failedEntry.retries < MAX_RETRIES && failedEntry.next_retry) {
    if (Date.now() >= Date.parse(failedEntry.next_retry)) return true;
    return false; // Not yet time to retry
  }

  // Normal staleness gate
  return staleness >= threshold;
}

/**
 * Calculate next retry time using exponential backoff (2^retries days).
 */
function _nextRetryISO(retries) {
  const daysMs = Math.pow(2, retries) * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + daysMs).toISOString();
}

// ── Tag helpers ────────────────────────────────────────────────────────────────

function _parseTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

module.exports = { runWikiReflect };
