#!/usr/bin/env node

'use strict';

/**
 * Explicit Human Annotation import boundary.
 *
 * This command reads a bounded notes file and stores it separately from the
 * generated Wiki projection.  It never reads an edited generated page back
 * into wiki_pages.  A --claim-key import uses Claim Contract v1 to append a
 * project-scoped Candidate Claim (or an explicit conflict) with annotation
 * provenance.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { normalizeSlug } = require('./core/wiki-layout');
const {
  mapClaimStorage,
  reconcileClaim,
  validateCanonicalKey,
} = require('./core/claim-contract');
const { deriveProvenanceRootId } = require('./core/knowledge-eligibility');
const { recordKnowledgeLineage } = require('./core/memory-mutate');
const { normalizeProjectionText, projectionHash } = require('./core/wiki-projection');

const MAX_ANNOTATION_BYTES = 64 * 1024;
const DEFAULT_DB_PATH = path.join(os.homedir(), '.metame', 'memory.db');

function validateSlug(rawSlug) {
  const raw = String(rawSlug ?? '').trim().replaceAll('\\', '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/')
    || raw.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`invalid wiki slug: ${JSON.stringify(rawSlug)}`);
  }
  return normalizeSlug(raw);
}

function resolveInputFile(rawPath) {
  const value = String(rawPath ?? '').trim();
  if (!value || value.includes('\0') || value.split(/[\\/]/u).includes('..')) {
    throw new Error('annotation source path is invalid');
  }
  const expanded = value.replace(/^~(?=$|[\\/])/, os.homedir());
  const absolute = path.resolve(expanded);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('annotation source must be a regular file');
  if (stat.size > MAX_ANNOTATION_BYTES) throw new Error(`annotation exceeds ${MAX_ANNOTATION_BYTES} bytes`);
  return absolute;
}

function readAnnotationFile(rawPath) {
  const filePath = resolveInputFile(rawPath);
  const content = normalizeProjectionText(fs.readFileSync(filePath, 'utf8'));
  if (!content.trim()) throw new Error('annotation source is empty');
  if (Buffer.byteLength(content, 'utf8') > MAX_ANNOTATION_BYTES) {
    throw new Error(`annotation exceeds ${MAX_ANNOTATION_BYTES} bytes`);
  }
  return { filePath, content };
}

function annotationId(content, filePath, baseHash) {
  const digest = crypto.createHash('sha256')
    .update(`${filePath}\0${baseHash}\0${projectionHash(content)}`, 'utf8')
    .digest('hex');
  return `wa_${digest.slice(0, 24)}`;
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function insertAnnotation(db, annotation) {
  db.prepare(`
    INSERT INTO wiki_annotations
      (id, page_slug, base_projection_hash, content, content_hash, claim_key,
       state, status, source_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, datetime('now'), datetime('now'))
  `).run(
    annotation.id,
    annotation.pageSlug,
    annotation.baseProjectionHash,
    annotation.content,
    annotation.contentHash,
    annotation.claimKey,
    annotation.sourcePath,
  );
}

function updateAnnotation(db, id, { state, claimId = null, claimOutcome = null }) {
  db.prepare(`
    UPDATE wiki_annotations
       SET state=?, status=?, claim_id=?, claim_outcome=?, updated_at=datetime('now')
     WHERE id=?
  `).run(state, state, claimId, claimOutcome, id);
}

function insertMemoryClaim(db, candidate) {
  const columns = tableColumns(db, 'memory_items');
  const required = ['id', 'kind', 'state', 'content', 'project', 'canonical_key', 'source_type', 'source_id'];
  const missing = required.filter(column => !columns.has(column));
  if (missing.length > 0) throw new Error(`memory claim schema missing: ${missing.join(', ')}`);

  const values = {
    id: candidate.id,
    kind: candidate.kind,
    state: candidate.state,
    title: candidate.title,
    content: candidate.content,
    summary: null,
    confidence: 1,
    project: candidate.project,
    scope: candidate.scope,
    task_key: null,
    session_id: null,
    agent_key: null,
    canonical_key: candidate.canonical_key,
    supersedes_id: null,
    source_type: candidate.source_type,
    source_id: candidate.source_id,
    origin_class: 'primary',
    provenance_root_id: deriveProvenanceRootId(candidate),
    relation: 'human_annotation',
    search_count: 0,
    last_searched_at: null,
    tags: JSON.stringify([`wiki:${candidate.page_slug}`]),
  };
  const insertable = Object.keys(values).filter(column => columns.has(column));
  const placeholders = insertable.map(() => '?').join(',');
  db.prepare(`INSERT INTO memory_items (${insertable.join(',')}) VALUES (${placeholders})`)
    .run(...insertable.map(column => values[column]));
}

function admitAnnotationClaim(db, annotation, page) {
  const columns = tableColumns(db, 'memory_items');
  if (!columns.has('canonical_key') || !columns.has('project') || !columns.has('scope')) {
    throw new Error('memory claim schema cannot enforce canonical identity');
  }
  const candidate = mapClaimStorage({
    id: `mi_ha_${annotation.id.slice(3)}`,
    kind: 'insight',
    title: `Human annotation · ${annotation.pageSlug}`,
    content: annotation.content.trim(),
    confidence: 1,
    lifecycle: 'project',
    canonical_key: annotation.claimKey,
    project: page.project_key || '*',
    scope: page.project_key || null,
    source_type: 'human_annotation',
    source_id: annotation.id,
    page_slug: annotation.pageSlug,
    provenance_root_id: `wiki_annotation:${annotation.id}`,
  });
  const matches = db.prepare(`
    SELECT * FROM memory_items
     WHERE canonical_key=? AND project IS ? AND scope IS ?
       AND state IN ('candidate','active','conflict')
  `).all(candidate.canonical_key, candidate.project, candidate.scope);
  const decision = reconcileClaim(candidate, matches);
  if (decision.outcome === 'duplicate') {
    recordKnowledgeLineage(db, {
      childKind: 'memory_item',
      childId: decision.existing_id,
      parentKind: 'wiki_annotation',
      parentId: annotation.id,
      transform: 'human-annotation-v1',
      role: 'evidence',
    });
    return { state: 'admitted', claimId: decision.existing_id, outcome: decision.outcome };
  }
  candidate.state = decision.outcome === 'conflict' ? 'conflict' : 'candidate';
  insertMemoryClaim(db, candidate);
  recordKnowledgeLineage(db, {
    childKind: 'memory_item',
    childId: candidate.id,
    parentKind: 'wiki_annotation',
    parentId: annotation.id,
    transform: 'human-annotation-v1',
    role: 'evidence',
  });
  return {
    state: decision.outcome === 'conflict' ? 'conflict' : 'admitted',
    claimId: candidate.id,
    outcome: decision.outcome,
  };
}

function importWikiAnnotation({
  db,
  slug,
  fromFile,
  claimKey = null,
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
  const pageSlug = validateSlug(slug);
  if (!fromFile) throw new Error('--from-file is required');
  const source = readAnnotationFile(fromFile);
  const keyValidation = validateCanonicalKey(claimKey);
  if (!keyValidation.valid) throw new Error(`invalid claim key: ${keyValidation.reason}`);
  const normalizedClaimKey = keyValidation.value;
  if (normalizedClaimKey && (source.content.trim().length < 20 || source.content.trim().length > 300)) {
    throw new Error('claim-key annotations must contain 20-300 characters');
  }

  const page = db.prepare('SELECT * FROM wiki_pages WHERE slug=?').get(pageSlug);
  if (!page) throw new Error(`wiki page not found: ${pageSlug}`);
  const baseProjectionHash = page.projection_hash || null;
  if (!baseProjectionHash) throw new Error('wiki page has no projection baseline; annotation is degraded and blocked');
  const annotation = {
    id: annotationId(source.content, source.filePath, baseProjectionHash),
    pageSlug,
    baseProjectionHash,
    content: source.content,
    contentHash: projectionHash(source.content),
    claimKey: normalizedClaimKey,
    sourcePath: source.filePath,
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT * FROM wiki_annotations WHERE id=?').get(annotation.id);
    if (existing) {
      if (normalizedClaimKey && existing.state === 'pending') {
        const admittedAnnotation = {
          ...annotation,
          pageSlug: existing.page_slug,
          baseProjectionHash: existing.base_projection_hash,
          content: existing.content,
          contentHash: existing.content_hash,
          sourcePath: existing.source_path || annotation.sourcePath,
          claimKey: normalizedClaimKey,
        };
        db.prepare(`
          UPDATE wiki_annotations
             SET claim_key=?, updated_at=datetime('now')
           WHERE id=?
        `).run(normalizedClaimKey, annotation.id);
        const admitted = admitAnnotationClaim(db, admittedAnnotation, page);
        updateAnnotation(db, annotation.id, admitted);
        db.exec('COMMIT');
        return { ...annotation, ...admitted, claimKey: normalizedClaimKey, idempotent: false };
      }
      db.exec('COMMIT');
      return { ...annotation, state: existing.state, claimId: existing.claim_id || null, idempotent: true };
    }
    insertAnnotation(db, annotation);
    const admitted = normalizedClaimKey ? admitAnnotationClaim(db, annotation, page) : {
      state: 'pending', claimId: null, outcome: 'annotation_only',
    };
    updateAnnotation(db, annotation.id, admitted);
    db.exec('COMMIT');
    return { ...annotation, ...admitted, idempotent: false };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { }
    throw error;
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--json') options.json = true;
    else if (value === '--claim-key') options.claimKey = argv[++i];
    else if (value === '--from-file') options.fromFile = argv[++i];
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value.startsWith('--')) throw new Error(`unknown option: ${value}`);
    else positional.push(value);
  }
  return { slug: positional[0], options };
}

function main(argv = process.argv.slice(2), { dbPath = process.env.METAME_DB_PATH || DEFAULT_DB_PATH } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    console.log('Usage: metame wiki annotate <slug> --from-file <path> [--claim-key <canonical_key>] [--json]');
    return 0;
  }
  const db = new DatabaseSync(dbPath);
  try {
    applyWikiSchema(db);
    const result = importWikiAnnotation({
      db,
      slug: parsed.slug,
      fromFile: parsed.options.fromFile,
      claimKey: parsed.options.claimKey,
    });
    console.log(parsed.options.json
      ? JSON.stringify(result, null, 2)
      : `Wiki annotation ${result.state}: ${result.pageSlug}${result.claimId ? ` (claim ${result.claimId})` : ''}`);
    return 0;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[wiki-annotate] ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = {
  MAX_ANNOTATION_BYTES,
  importWikiAnnotation,
  main,
  _internal: {
    admitAnnotationClaim,
    annotationId,
    parseArgs,
    readAnnotationFile,
    resolveInputFile,
    validateSlug,
  },
};
