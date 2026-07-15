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
const { queryRawFacts, queryRelatedTopics, queryTopicEvidence, queryTopicResearch } = require('./wiki-reflect-query');
const { buildWikiPage, buildProjectDossier, buildTopicHubPage, writeWikiPageWithChunks } = require('./wiki-reflect-build');
const {
  buildDossierSlug,
  groupTopicEvidence,
  isAtomicMemoryFact,
  normalizeTopicKey,
  planCanonicalTopics,
  sourceMembershipHash,
} = require('./core/wiki-topic-model');
const {
  exportWikiPage,
  rebuildIndex,
  exportSessionSummary,
  rebuildSessionsIndex,
  exportCapsuleFile,
  rebuildCapsulesIndex,
  exportReflectDir,
  rebuildReflectDirIndex,
  exportDocPages,
  organizeWikiProjection,
} = require('./wiki-reflect-export');
const {
  defaultWikiOutputDir,
  resolveConfiguredWikiOutputDir,
} = require('./core/wiki-paths');

const DEFAULT_CAPSULES_DIR = path.join(os.homedir(), '.metame', 'memory', 'capsules');
const DEFAULT_LOG_PATH = path.join(os.homedir(), '.metame', 'wiki_reflect_log.jsonl');
const DEFAULT_DECISIONS_DIR = path.join(os.homedir(), '.metame', 'memory', 'decisions');
const DEFAULT_LESSONS_DIR   = path.join(os.homedir(), '.metame', 'memory', 'lessons');
const LOCK_FILE = path.join(os.homedir(), '.metame', 'wiki-reflect.lock');
const LOCK_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const STALENESS_THRESHOLD = 0.4;
const MAX_RETRIES = 3;

function resolveConfiguredOutputDir(config, home = os.homedir()) {
  return resolveConfiguredWikiOutputDir(config, { home });
}

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
  outputDir = defaultWikiOutputDir(),
  capsulesDir = DEFAULT_CAPSULES_DIR,
  decisionsDir = DEFAULT_DECISIONS_DIR,
  lessonsDir   = DEFAULT_LESSONS_DIR,
  logPath = DEFAULT_LOG_PATH,
  providers,
  threshold = STALENESS_THRESHOLD,
  dossierMode = false,
  topicSlugs = null,
  lockFile = LOCK_FILE,
  dossierConcurrency = 4,
} = {}) {
  const startMs = Date.now();

  // 1. Acquire lock
  if (!_acquireLock(lockFile)) {
    throw new Error('wiki-reflect: another instance is running (lock file exists and is recent)');
  }

  const built = [];
  const failed = [];
  const exportFailed = [];
  const strippedLinksMap = {};
  let docsExported = 0;
  let reflectExported = 0;

  try {
    // 2. Load previous failed_slugs for retry logic
    const failedSlugsMap = _loadFailedSlugs(logPath);

    // 3. Get all registered topics and their allowed slugs (for wikilink whitelist)
    const registeredTopics = listWikiTopics(db);
    const plannedTopics = dossierMode ? planCanonicalTopics(registeredTopics) : registeredTopics;
    const selectedSlugs = Array.isArray(topicSlugs) ? new Set(topicSlugs) : null;
    const topics = selectedSlugs ? plannedTopics.filter(topic => selectedSlugs.has(topic.slug)) : plannedTopics;
    const allowedSlugs = topics.map(t => t.slug);

    if (dossierMode) {
      const results = await _mapWithConcurrency(topics, dossierConcurrency,
        topic => _reflectDossierTopic(db, topic, { outputDir, providers, threshold }));
      for (const result of results) {
        built.push(...result.built);
        failed.push(...result.failed);
        exportFailed.push(...result.exportFailed);
      }
    }

    // 4. Process each legacy topic. Dossier mode is handled concurrently above;
    // DB writes remain synchronous and each page writer owns its transaction.
    for (const topic of dossierMode ? [] : topics) {
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
          source_type: updatedPage.source_type || 'memory',
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

    // Export rebuildable document projections before indexes, then reconcile
    // legacy flat files into their stable collection directories.
    try {
      const { exported } = exportDocPages(db, outputDir);
      docsExported = exported.length;
    } catch { /* non-fatal */ }
    try { organizeWikiProjection(allPages, outputDir); } catch { /* non-fatal */ }

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

    // Step 6: Mirror decisions and lessons to vault
    try {
      const decWritten = exportReflectDir(decisionsDir, 'decisions', outputDir);
      const lesWritten = exportReflectDir(lessonsDir, 'lessons', outputDir);
      reflectExported = decWritten.length + lesWritten.length;

      const decFiles = fs.existsSync(decisionsDir) && fs.statSync(decisionsDir).isDirectory()
        ? fs.readdirSync(decisionsDir).filter(f => f.endsWith('.md'))
        : [];
      const lesFiles = fs.existsSync(lessonsDir) && fs.statSync(lessonsDir).isDirectory()
        ? fs.readdirSync(lessonsDir).filter(f => f.endsWith('.md'))
        : [];
      if (decFiles.length > 0) rebuildReflectDirIndex(decFiles, 'decisions', outputDir);
      if (lesFiles.length > 0) rebuildReflectDirIndex(lesFiles, 'lessons', outputDir);
    } catch { /* non-fatal */ }

  } finally {
    // 6. Release lock
    _releaseLock(lockFile);

    // 7. Write audit log
    const entry = {
      ts: new Date().toISOString(),
      slugs_built: built,
      export_failed_slugs: exportFailed,
      failed_slugs: failed,
      stripped_links: strippedLinksMap,
      docs_exported: docsExported,
      reflect_exported: reflectExported,
      duration_ms: Date.now() - startMs,
    };
    try {
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* non-fatal */ }
  }

  return { built, failed, exportFailed, docsExported, reflectExported };
}

async function _mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  }
  const count = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function _reflectDossierTopic(db, topic, { outputDir, providers, threshold }) {
  const built = [];
  const failed = [];
  const exportFailed = [];
  const evidenceRows = queryTopicEvidence(db, topic.aliases || [topic.tag]);
  const grouped = groupTopicEvidence(evidenceRows);
  const research = queryTopicResearch(db, topic.aliases || [topic.tag]);
  const related = queryRelatedTopics(db, topic.aliases || [topic.tag]);
  let dossierChanged = false;
  const dossierLinks = [];
  const plannedDossierSlugs = new Map(grouped.dossiers.map(item => [
    item.projectKey,
    buildDossierSlug(topic.slug, item.projectKey),
  ]));

  for (const dossier of grouped.dossiers) {
    const slug = buildDossierSlug(topic.slug, dossier.projectKey);
    const evidence = dossier.facts.map(fact => ({ evidence_type: 'memory_item', evidence_id: fact.id }));
    const membership = sourceMembershipHash(dossier.facts.map(fact => ({ ...fact, evidence_type: 'memory_item', evidence_id: fact.id })));
    const existing = getWikiPageBySlug(db, slug);
    const needsBuild = !existing
      || existing.build_profile !== 'local-dossier-v1'
      || existing.source_membership_hash !== membership
      || Number(existing.staleness || 0) >= threshold;
    if (needsBuild) {
      const result = await buildProjectDossier(db, topic, dossier.projectKey, dossier.facts, { providers });
      if (!result) {
        failed.push(_failedBuild(slug));
        if (existing) dossierLinks.push({ slug, projectKey: dossier.projectKey, factCount: dossier.facts.length });
        continue;
      }
      dossierChanged = true;
      _recordExport(db, slug, result.content, outputDir, built, exportFailed);
    }
    dossierLinks.push({ slug, projectKey: dossier.projectKey, factCount: dossier.facts.length });
  }

  const desiredSlugs = new Set(dossierLinks.map(item => item.slug));
  const existingDossiers = db.prepare(`
    SELECT * FROM wiki_pages
    WHERE page_kind='project_dossier' AND build_profile!='managed-redirect-v1' AND slug LIKE ?
  `).all(`${topic.slug}/projects/%`);
  for (const existing of existingDossiers) {
    if (desiredSlugs.has(existing.slug)) continue;
    const count = evidenceRows.filter(fact => isAtomicMemoryFact(fact)
      && normalizeTopicKey(fact.project || fact.scope) === normalizeTopicKey(existing.project_key)).length;
    const desiredReplacement = plannedDossierSlugs.get(existing.project_key);
    const replacement = desiredReplacement && desiredReplacement !== existing.slug
      ? getWikiPageBySlug(db, desiredReplacement) : null;
    if (count >= 3 && (!replacement || replacement.build_profile !== 'local-dossier-v1')) {
      dossierLinks.push({ slug: existing.slug, projectKey: existing.project_key, factCount: count });
      continue;
    }
    const misses = count === 0 || count >= 3 ? 2 : Number(existing.eligibility_miss_count || 0) + 1;
    if (misses < 2) {
      db.prepare('UPDATE wiki_pages SET eligibility_miss_count=? WHERE slug=?').run(misses, existing.slug);
      dossierLinks.push({ slug: existing.slug, projectKey: existing.project_key, factCount: count });
      continue;
    }
    const redirect = `# ${existing.title}\n\n项目证据已低于维护门槛，请返回 [[topics/${topic.slug}|${topic.label || topic.tag}]]。\n`;
    writeWikiPageWithChunks(db, {
      slug: existing.slug, title: existing.title, primary_topic: topic.tag,
      source_type: 'managed_redirect', page_kind: 'project_dossier', project_key: existing.project_key,
      build_profile: 'managed-redirect-v1', eligibility_miss_count: misses,
      source_membership_hash: '', raw_source_ids: '[]', raw_source_count: 0, topic_tags: '[]',
    }, redirect, { evidence: [], scopes: [] });
    dossierChanged = true;
    _recordExport(db, existing.slug, redirect, outputDir, built, exportFailed);
  }

  const hubEvidence = grouped.sparse.map(fact => ({ ...fact, evidence_type: 'memory_item', evidence_id: fact.id }));
  const hubMembership = sourceMembershipHash([
    ...hubEvidence,
    ...research.flatMap(item => item.factIds.map(id => ({ evidence_type: 'paper_fact', evidence_id: id }))),
    ...related.map(item => ({ evidence_type: 'related_topic', evidence_id: `${item.slug}:${item.shared}` })),
    ...dossierLinks.map(item => ({ evidence_type: 'dossier', evidence_id: `${item.slug}:${item.factCount}` })),
  ]);
  const existingHub = getWikiPageBySlug(db, topic.slug);
  const needsHub = dossierChanged || !existingHub
    || existingHub.build_profile !== 'local-hub-v1'
    || existingHub.source_membership_hash !== hubMembership
    || Number(existingHub.staleness || 0) >= threshold;
  if (needsHub) {
    const hub = buildTopicHubPage(db, topic, { dossiers: dossierLinks, sparse: grouped.sparse, research, related });
    db.prepare('UPDATE wiki_pages SET source_membership_hash=? WHERE slug=?').run(hubMembership, topic.slug);
    _recordExport(db, topic.slug, hub.content, outputDir, built, exportFailed);
  }

  db.prepare(`
    INSERT INTO wiki_topic_aliases (normalized_alias, raw_alias, topic_slug)
    VALUES (?, ?, ?)
    ON CONFLICT(normalized_alias) DO UPDATE SET raw_alias=excluded.raw_alias, topic_slug=excluded.topic_slug
  `).run(topic.normalizedKey || normalizeTopicKey(topic.tag), (topic.aliases || [topic.tag])[0], topic.slug);

  for (const legacySlug of topic.legacySlugs || []) {
    const content = `# 已合并：${topic.label || topic.tag}\n\n此主题已规范化合并到 [[topics/${topic.slug}|${topic.label || topic.tag}]]。\n`;
    const legacy = getWikiPageBySlug(db, legacySlug);
    if (!legacy || legacy.build_profile !== 'managed-redirect-v1') {
      writeWikiPageWithChunks(db, {
        slug: legacySlug, title: `${topic.label || topic.tag}（已合并）`, primary_topic: topic.tag,
        source_type: 'managed_redirect', page_kind: 'managed_redirect', build_profile: 'managed-redirect-v1',
        source_membership_hash: '', raw_source_ids: '[]', raw_source_count: 0, topic_tags: '[]',
      }, content, { evidence: [], scopes: [] });
      _recordExport(db, legacySlug, content, outputDir, built, exportFailed);
    }
  }
  return { built, failed, exportFailed };
}

function _failedBuild(slug) {
  return { slug, retries: 1, next_retry: _nextRetryISO(1), permanent_error: false };
}

function _recordExport(db, slug, content, outputDir, built, exportFailed) {
  const page = getWikiPageBySlug(db, slug);
  const frontmatter = {
    title: page.title,
    slug,
    tags: _parseTags(page.topic_tags),
    created: (page.created_at || '').slice(0, 10),
    last_built: (page.last_built_at || '').slice(0, 10),
    raw_sources: page.raw_source_count,
    staleness: page.staleness,
    source_type: page.source_type || 'memory',
    page_kind: page.page_kind,
    project_key: page.project_key,
  };
  try {
    exportWikiPage(slug, frontmatter, content, outputDir);
    built.push(slug);
  } catch {
    exportFailed.push(slug);
  }
}

async function runConfiguredWikiReflect({
  home = os.homedir(),
  configPath = path.join(home, '.metame', 'daemon.yaml'),
  dbPath = path.join(home, '.metame', 'memory.db'),
  providers = require('./providers'),
} = {}) {
  const yaml = require('./resolve-yaml');
  const { DatabaseSync } = require('node:sqlite');
  let config = {};
  try { config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {}; } catch { /* use defaults */ }
  const db = new DatabaseSync(dbPath);
  try {
    return await runWikiReflect(db, {
      providers,
      outputDir: resolveConfiguredOutputDir(config, home),
      dossierMode: true,
    });
  } finally {
    db.close();
  }
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

module.exports = {
  runWikiReflect,
  runConfiguredWikiReflect,
  _internal: { resolveConfiguredOutputDir },
};

if (require.main === module) {
  runConfiguredWikiReflect()
    .then(result => console.log('wiki-sync done', JSON.stringify(result)))
    .catch(err => {
      console.error(`[wiki-sync] ${err.message}`);
      process.exitCode = 1;
    });
}
