'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArtifactMarkdown, stableArtifactId, validateArtifact } = require('./core/knowledge-artifact');
const { isSynthesisEvidenceEligible } = require('./core/claim-contract');
const { writeWikiPageWithChunks } = require('./wiki-reflect-build');

function listMarkdownFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === '_archive' || entry.name === '_revisions') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md') && entry.name !== '_index.md') files.push(full);
    }
  }
  walk(root);
  return files.sort();
}

function scanArtifacts({ decisionsDir, capsulesDir }) {
  const roots = [
    { root: decisionsDir, collection: 'decisions' },
    { root: capsulesDir, collection: 'capsules' },
  ];
  const artifacts = [];
  const ignored = [];
  const errors = [];
  for (const { root, collection } of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      errors.push({ file: root, error: 'authority root missing' });
      continue;
    }
    for (const file of listMarkdownFiles(root)) {
      const source = fs.readFileSync(file, 'utf8');
      if (!/^---\r?\n[\s\S]*?schema_version:\s*1\b/m.test(source)) {
        if (/^(?:archive:\s*true|status:\s*archived|type:\s*managed_redirect)\s*$/m.test(source)) ignored.push(file);
        else errors.push({ file, error: 'unrecognized file in authority root' });
        continue;
      }
      try {
        const parsed = parseArtifactMarkdown(source);
        const validation = validateArtifact(parsed);
        if (!validation.ok) throw new Error(validation.errors.join('; '));
        if (parsed.meta.id !== stableArtifactId(parsed.meta.kind, parsed.meta.canonical_key)) throw new Error('id does not match stable canonical identity');
        if ((collection === 'decisions' && parsed.meta.kind !== 'decision')
          || (collection === 'capsules' && parsed.meta.kind !== 'playbook')) throw new Error('kind does not match collection');
        artifacts.push({
          ...parsed,
          validation,
          file,
          sourcePath: path.posix.join(collection, path.relative(root, file).split(path.sep).join('/')),
        });
      } catch (error) {
        errors.push({ file, error: error.message });
      }
    }
  }
  const ids = new Set();
  const keys = new Set();
  for (const artifact of artifacts) {
    if (ids.has(artifact.meta.id)) errors.push({ file: artifact.file, error: `duplicate id: ${artifact.meta.id}` });
    if (keys.has(artifact.meta.canonical_key)) errors.push({ file: artifact.file, error: `duplicate canonical_key: ${artifact.meta.canonical_key}` });
    ids.add(artifact.meta.id);
    keys.add(artifact.meta.canonical_key);
  }
  return { artifacts, ignored, errors };
}

function validateEvidence(db, artifacts) {
  const find = db.prepare(`SELECT * FROM memory_items WHERE id=?`);
  const errors = [];
  for (const artifact of artifacts) {
    const roots = new Set();
    for (const evidenceId of artifact.validation.evidenceIds) {
      const row = find.get(evidenceId);
      const draft = artifact.meta.status === 'draft';
      if (!row || !isSynthesisEvidenceEligible(row, { draft })) {
        errors.push({ file: artifact.file, error: `missing, inactive or ineligible evidence: ${evidenceId}` });
      } else {
        roots.add(row.provenance_root_id || row.id);
      }
    }
    if (artifact.meta.status === 'active' && roots.size < 2) errors.push({ file: artifact.file, error: 'active artifact requires two independent provenance roots' });
  }
  return errors;
}

function projectArtifacts(db, scan, { dryRun = false } = {}) {
  const errors = [...scan.errors, ...validateEvidence(db, scan.artifacts)];
  if (errors.length > 0) return { ok: false, errors, projected: [], retired: [] };
  const projected = [];
  const retired = [];
  if (dryRun) return { ok: true, errors: [], projected: scan.artifacts.map(item => item.meta.id), retired };
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT artifact_id, page_slug FROM knowledge_artifact_registry').all();
    const existingMeta = new Map(db.prepare(`SELECT artifact_id,revision,content_hash,evidence_membership_hash,
      status,project_key,canonical_key,kind FROM knowledge_artifact_registry`).all()
      .map(row => [row.artifact_id, row]));
    const desired = new Set(scan.artifacts.map(item => item.meta.id));
    for (const row of existing) {
      if (desired.has(row.artifact_id)) continue;
      if (row.page_slug) db.prepare('DELETE FROM wiki_pages WHERE slug=?').run(row.page_slug);
      db.prepare("DELETE FROM knowledge_lineage WHERE child_kind='knowledge_artifact' AND child_id=?").run(row.artifact_id);
      db.prepare('DELETE FROM knowledge_artifact_registry WHERE artifact_id=?').run(row.artifact_id);
      retired.push(row.artifact_id);
    }
    const upsertRegistry = db.prepare(`
      INSERT INTO knowledge_artifact_registry
        (artifact_id,kind,canonical_key,project_key,status,revision,source_path,page_slug,content_hash,evidence_membership_hash,previous_hash,generator_version,projected_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(artifact_id) DO UPDATE SET kind=excluded.kind,canonical_key=excluded.canonical_key,
        project_key=excluded.project_key,status=excluded.status,revision=excluded.revision,
        source_path=excluded.source_path,page_slug=excluded.page_slug,content_hash=excluded.content_hash,
        evidence_membership_hash=excluded.evidence_membership_hash,previous_hash=excluded.previous_hash,
        generator_version=excluded.generator_version,projected_at=datetime('now')
    `);
    const insertLineage = db.prepare(`
      INSERT OR REPLACE INTO knowledge_lineage
        (child_kind,child_id,parent_kind,parent_id,run_id,transform,role,created_at)
      VALUES ('knowledge_artifact',?,'memory_item',?,?,'markdown-artifact-v1','evidence',datetime('now'))
    `);
    for (const artifact of scan.artifacts) {
      const meta = artifact.meta;
      const prior = existingMeta.get(meta.id);
      const authorityChanged = prior && [
        ['content_hash', meta.content_hash],
        ['evidence_membership_hash', meta.evidence_membership_hash],
        ['status', meta.status],
        ['project_key', meta.project_key],
        ['canonical_key', meta.canonical_key],
        ['kind', meta.kind],
      ].some(([field, value]) => prior[field] !== value);
      if (authorityChanged
        && (meta.revision <= prior.revision || meta.previous_hash !== prior.content_hash || !meta.change_reason)) {
        throw new Error(`invalid revision chain for ${meta.id}`);
      }
      db.prepare("DELETE FROM knowledge_lineage WHERE child_kind='knowledge_artifact' AND child_id=?").run(meta.id);
      for (const evidenceId of artifact.validation.evidenceIds) {
        insertLineage.run(meta.id, evidenceId, meta.generator_version);
      }
      const pageSlug = meta.status === 'active' ? `artifact/${meta.kind}/${meta.id}` : null;
      if (pageSlug) {
        writeWikiPageWithChunks(db, {
          slug: pageSlug,
          title: meta.title || meta.canonical_key,
          primary_topic: meta.canonical_key,
          source_type: 'knowledge_artifact',
          page_kind: meta.kind,
          project_key: meta.project_key,
          build_profile: 'markdown-artifact-v1',
          source_membership_hash: meta.evidence_membership_hash,
          raw_source_ids: JSON.stringify(artifact.validation.evidenceIds),
          raw_source_count: artifact.validation.evidenceIds.length,
          topic_tags: JSON.stringify([meta.canonical_key]),
        }, artifact.body, {
          transaction: false,
          evidence: artifact.validation.evidenceIds.map(id => ({ evidence_type: 'memory_item', evidence_id: id })),
          scopes: [meta.project_key],
        });
        db.prepare(`UPDATE wiki_pages SET artifact_id=?, artifact_status=?, artifact_revision=?, canonical_key=?, source_path=? WHERE slug=?`)
          .run(meta.id, meta.status, meta.revision, meta.canonical_key, artifact.sourcePath, pageSlug);
      } else {
        const old = db.prepare('SELECT page_slug FROM knowledge_artifact_registry WHERE artifact_id=?').get(meta.id);
        if (old?.page_slug) db.prepare('DELETE FROM wiki_pages WHERE slug=?').run(old.page_slug);
      }
      upsertRegistry.run(meta.id, meta.kind, meta.canonical_key, meta.project_key, meta.status,
        Number(meta.revision), artifact.sourcePath, pageSlug, meta.content_hash,
        meta.evidence_membership_hash, meta.previous_hash || null, meta.generator_version);
      projected.push(meta.id);
    }
    db.exec('COMMIT');
    return { ok: true, errors: [], projected, retired };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original error */ }
    return { ok: false, errors: [{ error: error.message }], projected: [], retired: [] };
  }
}

module.exports = { listMarkdownFiles, projectArtifacts, scanArtifacts, validateEvidence };
