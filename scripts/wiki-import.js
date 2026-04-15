'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { extractText, slugFromFilename, sha256 } = require('./wiki-extract');
const { buildConnectedComponents, getDocEmbeddings } = require('./wiki-cluster');
const { buildDocWikiPage, buildTopicClusterPage } = require('./wiki-reflect-build');
const {
  upsertDocSource, getDocSourceByPath, listStaleDocSources,
  markDocSourcesMissing, getClusterMemberIds,
  listClusterPages,
} = require('./core/wiki-db');

const SUPPORTED_EXTS = new Set(['.md', '.txt', '.pdf']);
const DRAIN_POLL_MS = 5000;
const DRAIN_TIMEOUT_MS = 5 * 60 * 1000;

function scanFiles(inputPath) {
  const real = fs.realpathSync(inputPath);
  const stat = fs.statSync(real);
  if (stat.isFile()) {
    return SUPPORTED_EXTS.has(path.extname(real).toLowerCase()) ? [real] : [];
  }
  return fs.readdirSync(real)
    .filter(f => SUPPORTED_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => fs.realpathSync(path.join(real, f)));
}

function generateUniqueSlug(db, base) {
  let candidate = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM wiki_pages WHERE slug=?').get(candidate)) {
    candidate = `${base}-${n++}`;
  }
  return candidate;
}

async function waitForEmbeddingDrain(db, chunkIds, log = () => {}) {
  if (chunkIds.length === 0) return true;
  const placeholders = chunkIds.map(() => '?').join(',');
  const query = db.prepare(
    `SELECT COUNT(*) as cnt FROM embedding_queue WHERE item_type='chunk' AND item_id IN (${placeholders})`
  );
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { cnt } = query.get(...chunkIds);
    if (cnt === 0) return true;
    log(`[wiki-import] waiting for ${cnt} embeddings to drain...`);
    await new Promise(r => setTimeout(r, DRAIN_POLL_MS));
  }
  log('[wiki-import] WARNING: embedding drain timed out, skipping clustering');
  return false;
}

async function runWikiImport(db, inputPath, { providers, noCluster = false, log = () => {} } = {}) {
  if (!fs.existsSync(inputPath)) {
    log(`[wiki-import] ERROR: path does not exist: ${inputPath}`);
    return { imported: 0, skipped: 0, failed: 0, clusters: 0 };
  }

  log(`[wiki-import] scanning: ${inputPath}`);
  const files = scanFiles(inputPath);
  log(`[wiki-import] found ${files.length} supported files`);

  const seenPaths = [];
  const stats = { imported: 0, skipped: 0, failed: 0, clusters: 0 };
  const extractedTexts = new Map();

  // Phase 0: Extract + hash check + upsert doc_sources
  for (const filePath of files) {
    seenPaths.push(filePath);
    try {
      const stat = fs.statSync(filePath);
      const existing = getDocSourceByPath(db, filePath);

      if (existing && existing.mtime_ms === stat.mtimeMs && existing.size_bytes === stat.size) {
        if (!existing.content_stale) { stats.skipped++; continue; }
      }

      const { text, title, extractor, extractStatus, errorMessage } = await extractText(filePath);
      if (text) extractedTexts.set(filePath, text);
      const fileHash = sha256(fs.readFileSync(filePath));
      const extractedTextHash = text ? sha256(text) : null;
      const baseSlug = slugFromFilename(filePath);
      const slug = existing ? existing.slug : generateUniqueSlug(db, baseSlug);

      upsertDocSource(db, {
        filePath, fileHash,
        mtimeMs: stat.mtimeMs, sizeBytes: stat.size,
        extractedTextHash, fileType: path.extname(filePath).slice(1).toLowerCase(),
        extractor, extractStatus, title, slug,
      });

      if (extractStatus !== 'ok') {
        log(`[wiki-import] SKIP ${path.basename(filePath)}: ${errorMessage || extractStatus}`);
      }
    } catch (err) {
      log(`[wiki-import] Phase 0 error for ${path.basename(filePath)}: ${err.message}`);
    }
  }

  markDocSourcesMissing(db, seenPaths);

  // Phase 1: Build Tier 1 pages for stale docs
  const stale = listStaleDocSources(db);
  const builtSlugs = [];
  const allChunkIds = [];

  for (const docSrc of stale) {
    if (docSrc.extract_status !== 'ok') {
      db.prepare("UPDATE doc_sources SET content_stale=0 WHERE id=?").run(docSrc.id);
      continue;
    }
    try {
      const text = extractedTexts.get(docSrc.file_path) || '';
      const allowedSlugs = files.map(f => slugFromFilename(f));
      const result = await buildDocWikiPage(db, docSrc, text, { allowedSlugs, providers });
      if (result) {
        db.prepare("UPDATE doc_sources SET content_stale=0, built_at=? WHERE id=?")
          .run(new Date().toISOString(), docSrc.id);
        builtSlugs.push(docSrc.slug);
        const chunks = db.prepare("SELECT id FROM content_chunks WHERE page_slug=?").all(docSrc.slug);
        allChunkIds.push(...chunks.map(c => c.id));
        stats.imported++;
        log(`[wiki-import] built: ${docSrc.slug}`);
      }
    } catch (err) {
      db.prepare("UPDATE doc_sources SET error_message=? WHERE id=?").run(err.message, docSrc.id);
      stats.failed++;
      log(`[wiki-import] FAILED ${docSrc.slug}: ${err.message}`);
    }
  }

  // Phase 2: Cascade stale cluster pages
  if (builtSlugs.length > 0) {
    const affected = db.prepare(`
      SELECT DISTINCT page_slug FROM wiki_page_doc_sources
      WHERE role='cluster_member'
      AND doc_source_id IN (SELECT id FROM doc_sources WHERE slug IN (${builtSlugs.map(() => '?').join(',')}))
    `).all(...builtSlugs).map(r => r.page_slug);
    if (affected.length > 0) {
      const ph = affected.map(() => '?').join(',');
      db.prepare(`UPDATE wiki_pages SET staleness=1 WHERE slug IN (${ph})`).run(...affected);
    }
  }

  // Phase 3: Clustering (Tier 2)
  if (!noCluster) {
    const drained = await waitForEmbeddingDrain(db, allChunkIds, log);
    if (drained) {
      const allDocSlugs = db.prepare("SELECT slug FROM doc_sources WHERE status='active' AND extract_status='ok'").all().map(r => r.slug);
      const embeddings = getDocEmbeddings(db, allDocSlugs);

      // embeddings is Array<{ slug, vector: Float32Array }>, use .length
      if (embeddings.length >= 3) {
        const clusters = buildConnectedComponents(embeddings, { threshold: 0.75, minSize: 3 });
        const existingClusters = listClusterPages(db).map(cp => ({
          slug: cp.slug,
          memberIds: getClusterMemberIds(db, cp.slug),
        }));

        const getDocBySlug = db.prepare("SELECT * FROM doc_sources WHERE slug=?");
        for (const memberSlugs of clusters) {
          const docRows = memberSlugs.map(s => getDocBySlug.get(s)).filter(Boolean);
          try {
            // buildTopicClusterPage returns { slug, strippedLinks } or null
            const clusterResult = await buildTopicClusterPage(db, docRows, {
              allowedSlugs: allDocSlugs, providers, existingClusters,
            });
            if (clusterResult) {
              stats.clusters++;
              log(`[wiki-import] cluster: ${clusterResult.slug}`);
            }
          } catch (err) {
            log(`[wiki-import] cluster FAILED: ${err.message}`);
          }
        }
      } else {
        log('[wiki-import] not enough embedded docs for clustering yet');
      }
    }
  }

  log(`[wiki-import] done — imported: ${stats.imported}, skipped: ${stats.skipped}, failed: ${stats.failed}, clusters: ${stats.clusters}`);
  return stats;
}

module.exports = { runWikiImport, scanFiles, generateUniqueSlug };
