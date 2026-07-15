'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { backfillFactEntityLinks } = require('./wiki-facts');
const { queryTopicEvidence } = require('./wiki-reflect-query');
const { runWikiReflect } = require('./wiki-reflect');
const { resolveWikiPageRelativePath } = require('./core/wiki-layout');
const {
  buildDossierSlug,
  groupTopicEvidence,
  planCanonicalTopics,
  sourceMembershipHash,
} = require('./core/wiki-topic-model');

const MANIFEST_VERSION = 1;
const DEFAULT_DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

function hashFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inspectProjectionFile(filePath, slug, dbContent = null) {
  if (!filePath || !fs.existsSync(filePath)) return { fileHash: null, manualConflict: false };
  const content = fs.readFileSync(filePath, 'utf8');
  const slugMatch = content.match(/^slug:\s*["']?([^\n"']+)/m);
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const managed = slugMatch?.[1]?.trim() === slug
    && dbContent !== null
    && body === String(dbContent).trim();
  return { fileHash: crypto.createHash('sha256').update(content).digest('hex'), manualConflict: !managed };
}

function buildMigrationManifest(db, { vaultRoot = null } = {}) {
  const topics = planCanonicalTopics(db.prepare('SELECT * FROM wiki_topics').all());
  const existingPages = new Map(db.prepare('SELECT slug, content FROM wiki_pages').all().map(page => [page.slug, page.content]));
  const entries = topics.map(topic => {
    const evidence = queryTopicEvidence(db, topic.aliases);
    const grouped = groupTopicEvidence(evidence);
    const dossiers = grouped.dossiers.map(item => ({
      projectKey: item.projectKey,
      slug: buildDossierSlug(topic.slug, item.projectKey),
      factCount: item.facts.length,
    }));
    const pages = [
      { slug: topic.slug, page_kind: 'topic_hub' },
      ...dossiers.map(item => ({ slug: item.slug, page_kind: 'project_dossier' })),
      ...topic.legacySlugs.map(slug => ({ slug, page_kind: 'managed_redirect' })),
    ].map(page => {
      const relativePath = resolveWikiPageRelativePath({ slug: page.slug, source_type: 'memory' });
      const absolutePath = vaultRoot ? path.join(vaultRoot, relativePath) : null;
      return { ...page, relativePath, ...inspectProjectionFile(absolutePath, page.slug, existingPages.get(page.slug) ?? null) };
    });
    const sourceHash = sourceMembershipHash(evidence.map(item => ({ ...item, evidence_type: 'memory_item', evidence_id: item.id })));
    return {
      slug: topic.slug,
      normalizedKey: topic.normalizedKey,
      aliases: topic.aliases,
      legacySlugs: topic.legacySlugs,
      sourceHash,
      evidenceCount: evidence.length,
      sparseCount: grouped.sparse.length,
      dossiers,
      pages,
    };
  });
  const keys = new Set(entries.map(entry => entry.normalizedKey));
  const semanticReview = [...keys].filter(key => !key.endsWith('s') && keys.has(`${key}s`))
    .map(key => ({ left: key, right: `${key}s`, action: 'review_only' }));
  return {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: {
      registeredTopics: db.prepare('SELECT COUNT(*) AS n FROM wiki_topics').get().n,
      canonicalTopics: entries.length,
      aliasesMerged: entries.reduce((sum, entry) => sum + entry.legacySlugs.length, 0),
      expectedDossiers: entries.reduce((sum, entry) => sum + entry.dossiers.length, 0),
    },
    semanticReview,
    topics: entries,
  };
}

function writeManifest(manifest, manifestPath) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, manifestPath);
}

function cloneDatabase(dbPath, clonePath) {
  fs.mkdirSync(path.dirname(clonePath), { recursive: true });
  fs.rmSync(clonePath, { force: true });
  const db = new DatabaseSync(dbPath);
  try { db.prepare('VACUUM INTO ?').run(clonePath); } finally { db.close(); }
}

function embeddingMetrics(db) {
  return {
    queue: db.prepare(`SELECT COUNT(*) AS n FROM embedding_queue WHERE attempts < 3`).get().n,
    missing: db.prepare(`SELECT COUNT(*) AS n FROM content_chunks WHERE embedding IS NULL`).get().n,
  };
}

function drainEmbeddings(db, { dbPath, workRoot, maxBatches = 20 } = {}) {
  let metrics = embeddingMetrics(db);
  for (let batch = 0; batch < maxBatches && metrics.queue > 0; batch++) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'daemon-embedding.js')], {
      env: {
        ...process.env,
        METAME_MEMORY_DB_PATH: dbPath,
        METAME_EMBEDDING_LOCK_PATH: path.join(workRoot, 'embedding.lock'),
        METAME_EMBEDDING_LOG_PATH: path.join(workRoot, 'embedding.jsonl'),
      },
      encoding: 'utf8',
      timeout: 180000,
    });
    if (result.status !== 0) break;
    metrics = embeddingMetrics(db);
  }
  return metrics;
}

function auditDossierProjection(db, { vaultRoot = null, expectedSlugs = [] } = {}) {
  const active = db.prepare(`
    SELECT slug, content, raw_source_count FROM wiki_pages
    WHERE page_kind='project_dossier' AND source_type='memory' AND build_profile='local-dossier-v1'
  `).all();
  const actual = new Set(active.map(page => page.slug));
  const expected = new Set(expectedSlugs);
  const orphanEvidence = db.prepare(`
    SELECT COUNT(*) AS n FROM wiki_page_evidence wpe
    LEFT JOIN memory_items mi ON wpe.evidence_type='memory_item' AND mi.id=wpe.evidence_id
    LEFT JOIN paper_facts pf ON wpe.evidence_type='paper_fact' AND pf.id=wpe.evidence_id
    WHERE (wpe.evidence_type='memory_item' AND mi.id IS NULL)
       OR (wpe.evidence_type='paper_fact' AND pf.id IS NULL)
  `).get().n;
  const missingScopes = db.prepare(`
    SELECT COUNT(*) AS n FROM wiki_pages wp
    WHERE wp.page_kind='project_dossier' AND wp.source_type='memory'
      AND NOT EXISTS (SELECT 1 FROM wiki_page_scopes wps WHERE wps.page_slug=wp.slug)
  `).get().n;
  const evidenceMismatch = db.prepare(`
    SELECT COUNT(*) AS n FROM wiki_pages wp
    WHERE wp.page_kind='project_dossier' AND wp.source_type='memory'
      AND wp.raw_source_count != (SELECT COUNT(*) FROM wiki_page_evidence wpe
        WHERE wpe.page_slug=wp.slug AND wpe.evidence_type='memory_item')
  `).get().n;
  let invalidFootnotes = 0;
  for (const page of active) {
    const definitions = new Set();
    const uses = new Set();
    for (const line of String(page.content).split(/\r?\n/)) {
      const definition = line.match(/^\[\^([^\]]+)\]:/);
      if (definition) definitions.add(definition[1]);
      else for (const match of line.matchAll(/\[\^([^\]]+)\]/g)) uses.add(match[1]);
    }
    if ([...uses].some(ref => !definitions.has(ref))) invalidFootnotes++;
  }
  const missingFiles = vaultRoot ? active.filter(page => !fs.existsSync(path.join(vaultRoot,
    resolveWikiPageRelativePath({ slug: page.slug, source_type: 'memory' })))).map(page => page.slug) : [];
  return {
    activeDossiers: active.length,
    topicHubs: countRowsSafe(db, "page_kind='topic_hub' AND source_type='memory' AND build_profile='local-hub-v1'"),
    aliases: db.prepare('SELECT COUNT(*) AS n FROM wiki_topic_aliases').get().n,
    graphLinks: db.prepare('SELECT COUNT(*) AS n FROM fact_entity_links').get().n,
    orphanEvidence,
    missingScopes,
    evidenceMismatch,
    invalidFootnotes,
    extra: expected.size ? active.filter(page => !expected.has(page.slug)).map(page => page.slug) : [],
    missing: expected.size ? [...expected].filter(slug => !actual.has(slug)) : [],
    missingFiles,
    embeddings: embeddingMetrics(db),
  };
}

function countRowsSafe(db, where) {
  return db.prepare(`SELECT COUNT(*) AS n FROM wiki_pages WHERE ${where}`).get().n;
}

async function stageMigration({ dbPath, vaultRoot, stageRoot, providers }) {
  const root = stageRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'metame-wiki-stage-'));
  const clonePath = path.join(root, 'memory.db');
  const stagedVault = path.join(root, 'vault');
  cloneDatabase(dbPath, clonePath);
  fs.mkdirSync(stagedVault, { recursive: true });
  if (vaultRoot && fs.existsSync(vaultRoot)) fs.cpSync(vaultRoot, stagedVault, { recursive: true, force: false, errorOnExist: false });
  const db = new DatabaseSync(clonePath);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    applyWikiSchema(db);
    const graph = backfillFactEntityLinks(db);
    const before = buildMigrationManifest(db, { vaultRoot: stagedVault });
    const result = await runWikiReflect(db, {
      outputDir: stagedVault, providers, dossierMode: true, threshold: 0,
      lockFile: path.join(root, 'wiki-reflect.lock'),
      dossierConcurrency: 8,
    });
    const embeddings = drainEmbeddings(db, { dbPath: clonePath, workRoot: root });
    const after = buildMigrationManifest(db, { vaultRoot: stagedVault });
    const expectedSlugs = after.topics.flatMap(topic => topic.dossiers.map(dossier => dossier.slug));
    const audit = auditDossierProjection(db, { vaultRoot: stagedVault, expectedSlugs });
    writeManifest({ ...after, stage: { root, clonePath, stagedVault, graph, result, embeddings, audit, before: before.summary } }, path.join(root, 'manifest.json'));
    return { root, clonePath, stagedVault, graph, result, embeddings, audit, manifest: after };
  } finally {
    db.close();
  }
}

function unchangedTopics(previous, current, vaultRoot) {
  const currentBySlug = new Map(current.topics.map(topic => [topic.slug, topic]));
  const eligible = [];
  const skipped = [];
  for (const topic of previous.topics || []) {
    const now = currentBySlug.get(topic.slug);
    if (!now || now.sourceHash !== topic.sourceHash) {
      skipped.push({ slug: topic.slug, reason: 'source_drift' });
      continue;
    }
    const manual = (topic.pages || []).find(page => page.manualConflict);
    if (manual) {
      skipped.push({ slug: topic.slug, reason: 'manual_conflict', path: manual.relativePath });
      continue;
    }
    const conflict = (topic.pages || []).find(page => {
      if (!page.fileHash) return false;
      return hashFile(path.join(vaultRoot, page.relativePath)) !== page.fileHash;
    });
    if (conflict) skipped.push({ slug: topic.slug, reason: 'file_drift', path: conflict.relativePath });
    else eligible.push(topic.slug);
  }
  return { eligible, skipped };
}

async function applyMigration({ dbPath, vaultRoot, manifestPath, providers, backupRoot }) {
  const previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (previous.version !== MANIFEST_VERSION) throw new Error(`unsupported manifest version: ${previous.version}`);
  const readDb = new DatabaseSync(dbPath, { readOnly: true });
  let current;
  try { current = buildMigrationManifest(readDb, { vaultRoot }); } finally { readDb.close(); }
  const selection = unchangedTopics(previous, current, vaultRoot);
  const canaryOrder = new Map(['step3', 'skill', 'lithology'].map((slug, index) => [slug, index]));
  selection.eligible.sort((a, b) => (canaryOrder.get(a) ?? 99) - (canaryOrder.get(b) ?? 99) || a.localeCompare(b));
  const backup = backupRoot || path.join(path.dirname(manifestPath), `backup-${Date.now()}`);
  for (const topic of previous.topics.filter(item => selection.eligible.includes(item.slug))) {
    for (const page of topic.pages || []) {
      const source = path.join(vaultRoot, page.relativePath);
      if (!fs.existsSync(source)) continue;
      const target = path.join(backup, page.relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
  const db = new DatabaseSync(dbPath);
  const batches = [];
  try {
    db.exec('PRAGMA busy_timeout=5000');
    applyWikiSchema(db);
    db.exec('BEGIN IMMEDIATE; COMMIT');
    const graph = backfillFactEntityLinks(db);
    const canaries = selection.eligible.filter(slug => canaryOrder.has(slug));
    const remaining = selection.eligible.filter(slug => !canaryOrder.has(slug));
    const groups = canaries.length > 0 ? [canaries] : [];
    for (let i = 0; i < remaining.length; i += 10) groups.push(remaining.slice(i, i + 10));
    for (const slugs of groups) {
      const result = await runWikiReflect(db, {
        outputDir: vaultRoot, providers, dossierMode: true, threshold: 0, topicSlugs: slugs,
      });
      const embeddings = drainEmbeddings(db, { dbPath, workRoot: backup });
      batches.push({ slugs, result, embeddings });
      if (embeddings.queue > 0 || embeddings.missing > 0) {
        throw new Error(`embedding gate failed after batch: queue=${embeddings.queue}, missing=${embeddings.missing}`);
      }
    }
    return { applied: selection.eligible, skipped: selection.skipped, backup, graph, batches };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const args = { mode: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.mode = 'dry-run';
    else if (arg === '--stage') args.mode = 'stage';
    else if (arg === '--apply') args.mode = 'apply';
    else if (['--manifest', '--db', '--vault', '--stage-root', '--backup-root'].includes(arg)) {
      args[arg.slice(2).replaceAll('-', '_')] = argv[++i];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dbPath = path.resolve(args.db || DEFAULT_DB_PATH);
  const vaultRoot = path.resolve(args.vault || path.join(os.homedir(), 'Documents', 'MetaMe'));
  if (args.mode === 'dry-run') {
    if (!args.manifest) throw new Error('--dry-run requires --manifest');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const manifest = buildMigrationManifest(db, { vaultRoot });
      writeManifest(manifest, path.resolve(args.manifest));
      return manifest;
    } finally { db.close(); }
  }
  const providers = require('./providers');
  if (args.mode === 'stage') return stageMigration({ dbPath, vaultRoot, stageRoot: args.stage_root && path.resolve(args.stage_root), providers });
  if (args.mode === 'apply') {
    if (!args.manifest) throw new Error('--apply requires --manifest');
    return applyMigration({ dbPath, vaultRoot, manifestPath: path.resolve(args.manifest), providers, backupRoot: args.backup_root && path.resolve(args.backup_root) });
  }
  throw new Error('usage: wiki-dossier-migrate --dry-run|--stage|--apply [options]');
}

if (require.main === module) {
  main().then(result => process.stdout.write(`${JSON.stringify(result.summary || result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = {
  MANIFEST_VERSION,
  applyMigration,
  auditDossierProjection,
  buildMigrationManifest,
  cloneDatabase,
  drainEmbeddings,
  main,
  parseArgs,
  stageMigration,
  unchangedTopics,
  writeManifest,
};
