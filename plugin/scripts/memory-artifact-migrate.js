'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const {
  normalizeCanonicalKey,
  parseArtifactMarkdown,
  serializeArtifact,
  stableArtifactId,
} = require('./core/knowledge-artifact');
const { primarySqlForDb } = require('./core/knowledge-eligibility');
const { projectArtifacts, scanArtifacts } = require('./memory-artifact-projector');
const { resolveConfiguredWikiOutputDir } = require('./core/wiki-paths');

const MANIFEST_VERSION = 1;
const GENERATOR_VERSION = 'artifact-migration-v1';
const PROCUREMENT_FILES = new Set([
  'metame-procurement-tender-radar-playbook.md',
  'metame-procurement_radar-playbook.md',
  'metame-skill-playbook.md',
  'user-procurementradar-playbook.md',
]);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fileInventory(root) {
  const rows = [];
  if (!fs.existsSync(root)) return rows;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else rows.push({ path: path.relative(root, full).split(path.sep).join('/'), hash: sha256File(full), size: fs.statSync(full).size });
    }
  }
  walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

function inventoryHash(root) {
  return crypto.createHash('sha256').update(JSON.stringify(fileInventory(root))).digest('hex');
}

function countReflectEntries(dir) {
  let files = 0;
  let entries = 0;
  if (!fs.existsSync(dir)) return { files, entries };
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.md'))) {
    files++;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map(match => match[1].trim());
    entries += headings.filter(title => !['背景', '结论', '问题', '操作手册'].includes(title)).length;
  }
  return { files, entries };
}

function parseLegacyCapsule(file) {
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const header = match ? require('./resolve-yaml').load(match[1]) || {} : {};
  const body = match ? source.slice(match[0].length).trim() : source.trim();
  const title = (body.match(/^#\s+📕\s*Playbook:\s*(.+)$/m) || [])[1] || path.basename(file, '.md');
  return { file, name: path.basename(file), header, body, title: title.trim() };
}

function canonicalCapsuleIdentity(capsule) {
  if (PROCUREMENT_FILES.has(capsule.name)) return { projectKey: 'metame', capabilityKey: 'procurement-radar' };
  const prefix = String(capsule.header.entity_prefix || path.basename(capsule.name, '-playbook.md'));
  const [project = 'global', capability = 'general'] = prefix.split('.');
  return {
    projectKey: normalizeCanonicalKey(project) || 'global',
    capabilityKey: normalizeCanonicalKey(capability) || 'general',
  };
}

function knownDerivedMetrics(db) {
  const hasOrigin = db.prepare('PRAGMA table_info(memory_items)').all().some(row => row.name === 'origin_class');
  const derived = `relation IN ('synthesized_insight','knowledge_capsule')
    OR lower(COALESCE(source_id,'')) LIKE 'nightly-reflect-%'
    OR lower(COALESCE(source_id,'')) LIKE 'capsule-%'`;
  const count = where => db.prepare(`SELECT COUNT(*) n FROM memory_items WHERE ${where}`).get().n;
  return {
    classified: count(`(${derived})`),
    legacyNull: count(`lower(COALESCE(source_id,'')) LIKE 'nightly-reflect-%' AND COALESCE(relation,'')=''`),
    activeLegacyNull: count(`state='active' AND lower(COALESCE(source_id,'')) LIKE 'nightly-reflect-%' AND COALESCE(relation,'')=''`),
    activeDerivedEligible: hasOrigin ? count(`state='active' AND origin_class!='derived' AND (${derived})`) : null,
  };
}

function buildManifest(db, { memoryRoot, vaultRoot }) {
  const decisionsDir = path.join(memoryRoot, 'decisions');
  const lessonsDir = path.join(memoryRoot, 'lessons');
  const capsulesDir = path.join(memoryRoot, 'capsules');
  const capsules = fs.existsSync(capsulesDir)
    ? fs.readdirSync(capsulesDir).filter(name => name.endsWith('-playbook.md')).sort().map(name => {
      const capsule = parseLegacyCapsule(path.join(capsulesDir, name));
      const identity = canonicalCapsuleIdentity(capsule);
      return {
        name,
        hash: sha256File(capsule.file),
        entityPrefix: capsule.header.entity_prefix || null,
        projectKey: identity.projectKey,
        capabilityKey: identity.capabilityKey,
        action: name === 'nightly-reflect-playbook.md' ? 'archive' : PROCUREMENT_FILES.has(name) ? 'merge-procurement' : 'canonicalize',
      };
    }) : [];
  return {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    memoryRoot,
    vaultRoot,
    derived: knownDerivedMetrics(db),
    decisions: countReflectEntries(decisionsDir),
    lessons: countReflectEntries(lessonsDir),
    capsules,
    sourceInventory: fileInventory(memoryRoot),
    vaultInventoryHash: fs.existsSync(vaultRoot)
      ? crypto.createHash('sha256').update(JSON.stringify(fileInventory(vaultRoot))).digest('hex') : null,
    expected: { activePlaybooks: 12, archivedPlaybooks: 4, retiredPlaybooks: 1 },
  };
}

function writeManifest(manifest, file) {
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}

function cloneDatabase(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try { db.exec(`VACUUM INTO '${String(target).replaceAll("'", "''")}'`); } finally { db.close(); }
}

function copyTree(source, target) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
}

function evidenceForPrefix(db, prefix, date) {
  const eligibility = primarySqlForDb(db, 'mi');
  const hasCreated = db.prepare('PRAGMA table_info(memory_items)').all().some(row => row.name === 'created_at');
  const dateClause = hasCreated && /^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))
    ? "AND mi.created_at >= datetime(?, '-7 days') AND mi.created_at < datetime(?, '+2 days')" : '';
  const args = [`${String(prefix || '').toLowerCase()}%`];
  if (dateClause) args.push(date, date);
  return db.prepare(`
    SELECT mi.id FROM memory_items mi
    WHERE lower(COALESCE(mi.title,'')) LIKE ?
      AND mi.state IN ('active','candidate') AND ${eligibility.sql} ${dateClause}
    ORDER BY mi.created_at, mi.id LIMIT 40
  `).all(...args).map(row => row.id);
}

function managedRedirect(title, target) {
  return `---\ntype: managed_redirect\nstatus: archived\ntarget: ${target}\n---\n# 已归档：${title}\n\n此手册已迁移到 [[${target}]]。\n`;
}

function markReflectArchive(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (/^---\r?\n/.test(source)) {
    if (/^archive:\s*true\s*$/m.test(source)) return;
    fs.writeFileSync(file, source.replace(/^---\r?\n/, '---\narchive: true\nstatus: archived\n'));
  }
}

function wrapManagedBody(body) {
  return `<!-- METAME:MANAGED START -->\n${String(body).trim()}\n<!-- METAME:MANAGED END -->\n\n## Manual Notes\n`;
}

function evidenceRootCount(db, evidenceIds) {
  if (evidenceIds.length === 0) return 0;
  const placeholders = evidenceIds.map(() => '?').join(',');
  return db.prepare(`SELECT COUNT(DISTINCT COALESCE(provenance_root_id,id)) AS n
    FROM memory_items WHERE id IN (${placeholders})`).get(...evidenceIds).n;
}

function mergeLegacyBodies(group) {
  const seen = new Set();
  const sections = [];
  for (const item of group) {
    const body = item.body.replace(/^#\s+.*$/m, '').trim();
    const paragraphs = body.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
    const unique = paragraphs.filter(part => {
      const key = part.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (unique.length > 0) sections.push(`## 来源：${item.title}\n\n${unique.join('\n\n')}`);
  }
  return sections.join('\n\n');
}

function canonicalizeDecisions(db, decisionsDir, now = new Date().toISOString()) {
  const columns = new Set(db.prepare('PRAGMA table_info(memory_items)').all().map(row => row.name));
  if (!columns.has('relation')) return [];
  const eligibility = primarySqlForDb(db, 'mi');
  const select = name => columns.has(name) ? `mi.${name}` : `NULL AS ${name}`;
  const rows = db.prepare(`SELECT mi.id,mi.title,mi.content,mi.created_at,mi.provenance_root_id,
      ${select('project')},${select('scope')}
    FROM memory_items mi WHERE mi.state IN ('active','candidate')
      AND mi.relation='tech_decision' AND ${eligibility.sql}
    ORDER BY mi.created_at,mi.id`).all();
  const groups = new Map();
  for (const row of rows) {
    const entity = String(row.title || 'decision').split(' · ')[0];
    const projectKey = (normalizeCanonicalKey(row.project || row.scope || entity.split('.')[0] || 'global')
      .replace(/^[._-]+/, '')) || 'global';
    const capability = normalizeCanonicalKey(entity.split('.').slice(0, 2).join('-')) || 'decision';
    const canonicalKey = `${projectKey}/decisions/${capability}`;
    if (!groups.has(canonicalKey)) groups.set(canonicalKey, { projectKey, capability, rows: [] });
    groups.get(canonicalKey).rows.push(row);
  }
  const written = [];
  for (const [canonicalKey, group] of groups) {
    const evidenceIds = group.rows.map(row => row.id);
    const status = evidenceRootCount(db, evidenceIds) >= 2 ? 'active' : 'draft';
    const id = stableArtifactId('decision', canonicalKey);
    const target = path.join(decisionsDir, group.projectKey, `${group.capability}.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const body = group.rows.map(row => `## ${String(row.title || '').split(' · ')[0]}\n\n${row.content}`).join('\n\n');
    const markdown = serializeArtifact({
      id, kind: 'decision', title: group.rows[0].title.split(' · ')[0], canonical_key: canonicalKey,
      project_key: group.projectKey, status, revision: 1, evidence_ids: evidenceIds,
      created_at: group.rows[0].created_at || now, updated_at: now,
      generator_version: GENERATOR_VERSION, change_reason: 'primary tech_decision canonicalization',
    }, wrapManagedBody(body));
    fs.writeFileSync(target, markdown, { flag: 'wx' });
    written.push({ id, canonicalKey, target, status, evidenceCount: evidenceIds.length });
  }
  return written;
}

function canonicalizeCapsules(db, capsulesDir, now = new Date().toISOString()) {
  const legacy = fs.readdirSync(capsulesDir).filter(name => name.endsWith('-playbook.md')).sort()
    .map(name => parseLegacyCapsule(path.join(capsulesDir, name)));
  const archiveDir = path.join(capsulesDir, '_archive');
  const revisionDir = path.join(capsulesDir, '_revisions');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(revisionDir, { recursive: true });
  const groups = new Map();
  for (const capsule of legacy) {
    const identity = canonicalCapsuleIdentity(capsule);
    const key = `${identity.projectKey}/${identity.capabilityKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...capsule, ...identity });
  }
  const written = [];
  for (const [key, group] of groups) {
    for (const capsule of group) fs.copyFileSync(capsule.file, path.join(archiveDir, capsule.name), fs.constants.COPYFILE_EXCL);
    if (group.some(item => item.name === 'nightly-reflect-playbook.md')) {
      const capsule = group.find(item => item.name === 'nightly-reflect-playbook.md');
      fs.writeFileSync(capsule.file, managedRedirect(capsule.title, `capsules/_archive/${capsule.name.replace(/\.md$/, '')}`));
      continue;
    }
    const chosen = group.find(item => item.name === 'metame-skill-playbook.md') || group[0];
    const prefixes = [...new Set(group.map(item => item.header.entity_prefix).filter(Boolean))];
    const evidenceIds = [...new Set(prefixes.flatMap(prefix => evidenceForPrefix(db, prefix, chosen.header.date)))].sort();
    const canonicalKey = normalizeCanonicalKey(key);
    const id = stableArtifactId('playbook', canonicalKey);
    const relative = path.join(chosen.projectKey, `${chosen.capabilityKey}.md`);
    const target = path.join(capsulesDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const status = evidenceRootCount(db, evidenceIds) >= 2 ? 'active' : 'draft';
    const markdown = serializeArtifact({
      id, kind: 'playbook', title: chosen.title, canonical_key: canonicalKey,
      project_key: chosen.projectKey, status, revision: 1,
      evidence_ids: evidenceIds, legacy_refs: group.map(item => `capsules/_archive/${item.name}`),
      created_at: `${chosen.header.date || now.slice(0, 10)}T00:00:00.000Z`, updated_at: now,
      generator_version: GENERATOR_VERSION, change_reason: 'legacy capsule canonicalization',
    }, wrapManagedBody(group.length > 1 ? mergeLegacyBodies(group) : chosen.body));
    fs.writeFileSync(target, markdown, { flag: 'wx' });
    const revisionPath = path.join(revisionDir, id, '0001.md');
    fs.mkdirSync(path.dirname(revisionPath), { recursive: true });
    fs.writeFileSync(revisionPath, markdown, { flag: 'wx' });
    const targetLink = `capsules/${relative.slice(0, -3).split(path.sep).join('/')}`;
    for (const capsule of group) fs.writeFileSync(capsule.file, managedRedirect(capsule.title, targetLink));
    written.push({ id, canonicalKey, target, status, evidenceCount: evidenceIds.length });
  }
  return written;
}

function archiveReflectDirectories(memoryRoot) {
  for (const name of ['decisions', 'lessons']) {
    const dir = path.join(memoryRoot, name);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter(item => item.endsWith('.md'))) markReflectArchive(path.join(dir, file));
  }
}

function removeDerivedEvidence(db) {
  const before = db.prepare(`SELECT COUNT(*) n FROM wiki_page_evidence wpe JOIN memory_items mi
    ON wpe.evidence_type='memory_item' AND wpe.evidence_id=mi.id WHERE mi.origin_class='derived'`).get().n;
  db.prepare(`DELETE FROM wiki_page_evidence WHERE evidence_type='memory_item' AND evidence_id IN
    (SELECT id FROM memory_items WHERE origin_class='derived')`).run();
  const retired = [];
  for (const slug of ['nightly', 'reflection']) {
    const primary = db.prepare(`SELECT COUNT(*) n FROM wiki_page_evidence wpe JOIN memory_items mi
      ON wpe.evidence_type='memory_item' AND wpe.evidence_id=mi.id
      WHERE wpe.page_slug=? AND mi.origin_class='primary'`).get(slug).n;
    if (primary > 0) continue;
    db.prepare('DELETE FROM content_chunks WHERE page_slug=?').run(slug);
    db.prepare("DELETE FROM embedding_queue WHERE item_type='wiki_page' AND item_id=?").run(slug);
    db.prepare('DELETE FROM wiki_pages WHERE slug=?').run(slug);
    retired.push(slug);
  }
  return { removed: before, retired };
}

function drainStageEmbeddings(stagedDb, stageRoot) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'daemon-embedding.js')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      METAME_MEMORY_DB_PATH: stagedDb,
      METAME_EMBEDDING_LOCK_PATH: path.join(stageRoot, 'embedding.lock'),
      METAME_EMBEDDING_LOG_PATH: path.join(stageRoot, 'embedding.jsonl'),
    },
  });
  if (result.status !== 0) throw new Error(`embedding drain failed: ${(result.stderr || result.stdout || '').trim()}`);
  const db = new DatabaseSync(stagedDb, { readOnly: true });
  try {
    const pending = db.prepare('SELECT COUNT(*) AS n FROM embedding_queue WHERE attempts < 3').get().n;
    const dead = db.prepare('SELECT COUNT(*) AS n FROM embedding_queue WHERE attempts >= 3').get().n;
    const missing = db.prepare('SELECT COUNT(*) AS n FROM content_chunks WHERE embedding IS NULL').get().n;
    if (pending || dead || missing) throw new Error(`embedding gate failed: pending=${pending}, dead=${dead}, missing=${missing}`);
    return { pending, dead, missing };
  } finally { db.close(); }
}

function stageArtifactVault(scan, stageRoot) {
  const stagedVault = path.join(stageRoot, 'vault');
  for (const name of ['decisions', 'lessons', 'capsules']) fs.mkdirSync(path.join(stagedVault, name), { recursive: true });
  for (const artifact of scan.artifacts) {
    const target = path.join(stagedVault, artifact.sourcePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(artifact.file, target);
  }
  return stagedVault;
}

function stageMigration({ dbPath, memoryRoot, vaultRoot, stageRoot, drainEmbeddings = false }) {
  if (fs.existsSync(stageRoot)) throw new Error(`stage root exists: ${stageRoot}`);
  fs.mkdirSync(stageRoot, { recursive: true });
  const stagedDb = path.join(stageRoot, 'memory.db');
  const stagedMemory = path.join(stageRoot, 'memory');
  cloneDatabase(dbPath, stagedDb);
  copyTree(memoryRoot, stagedMemory);
  let db = new DatabaseSync(stagedDb);
  try {
    applyWikiSchema(db);
    archiveReflectDirectories(stagedMemory);
    const decisions = canonicalizeDecisions(db, path.join(stagedMemory, 'decisions'));
    const playbooks = canonicalizeCapsules(db, path.join(stagedMemory, 'capsules'));
    const derived = removeDerivedEvidence(db);
    const scan = scanArtifacts({ decisionsDir: path.join(stagedMemory, 'decisions'), capsulesDir: path.join(stagedMemory, 'capsules') });
    const projection = projectArtifacts(db, scan);
    if (!projection.ok) throw new Error(`artifact projection failed: ${JSON.stringify(projection.errors)}`);
    const stagedVault = stageArtifactVault(scan, stageRoot);
    const metrics = knownDerivedMetrics(db);
    db.close();
    db = null;
    const embeddings = drainEmbeddings ? drainStageEmbeddings(stagedDb, stageRoot) : null;
    return { stageRoot, stagedDb, stagedMemory, stagedVault, decisions, playbooks, derived, projection, metrics, embeddings, vaultRoot };
  } finally { if (db) db.close(); }
}

function publishDirectory(staged, live, backup) {
  if (fs.existsSync(backup)) throw new Error(`backup path exists: ${backup}`);
  fs.renameSync(live, backup);
  try { fs.renameSync(staged, live); }
  catch (error) { fs.renameSync(backup, live); throw error; }
}

function assertDaemonStopped(metameDir) {
  const pidFile = path.join(metameDir, 'daemon.pid');
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); } catch { return; }
  throw new Error(`daemon is running (pid ${pid}); stop it before applying migration`);
}

function acquireMaintenanceLock(metameDir) {
  const file = path.join(metameDir, 'memory-maintenance.lock');
  fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`, { flag: 'wx' });
  return () => { try { fs.unlinkSync(file); } catch { /* already released */ } };
}

function writePublishJournal(backupRoot, phase, extra = {}) {
  const file = path.join(backupRoot, 'publish-journal.json');
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, phase, updated_at: new Date().toISOString(), ...extra }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function rollbackPublishedState({ dbPath, memoryRoot, vaultRoot, backupRoot }) {
  const previousDb = path.join(backupRoot, 'previous-memory.db');
  if (fs.existsSync(previousDb)) {
    fs.rmSync(dbPath, { force: true });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.renameSync(previousDb, dbPath);
  }
  for (const name of ['decisions', 'lessons', 'capsules']) {
    for (const [root, prefix] of [[memoryRoot, 'previous-'], [vaultRoot, 'previous-vault-']]) {
      const backup = path.join(backupRoot, `${prefix}${name}`);
      if (!fs.existsSync(backup)) continue;
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      fs.renameSync(backup, path.join(root, name));
    }
  }
}

function recoverMigration({ dbPath, memoryRoot, vaultRoot, backupRoot }) {
  const metameDir = path.dirname(dbPath);
  assertDaemonStopped(metameDir);
  if (!fs.existsSync(backupRoot)) throw new Error(`backup root not found: ${backupRoot}`);
  rollbackPublishedState({ dbPath, memoryRoot, vaultRoot, backupRoot });
  try { fs.unlinkSync(path.join(metameDir, 'memory-maintenance.lock')); } catch { /* already clear */ }
  writePublishJournal(backupRoot, 'rolled_back');
  return { recovered: true, backupRoot };
}

function applyMigration({ dbPath, memoryRoot, vaultRoot, backupRoot, _stageMigration = stageMigration }) {
  const metameDir = path.dirname(dbPath);
  assertDaemonStopped(metameDir);
  fs.mkdirSync(path.dirname(backupRoot), { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: false });
  const releaseMaintenance = acquireMaintenanceLock(metameDir);
  const stageRoot = path.join(backupRoot, 'stage');
  let guardDb = null;
  try {
    const sourceHash = inventoryHash(memoryRoot);
    guardDb = new DatabaseSync(dbPath);
    guardDb.exec('PRAGMA busy_timeout=10000');
    guardDb.exec('BEGIN IMMEDIATE');
    const staged = _stageMigration({ dbPath, memoryRoot, vaultRoot, stageRoot, drainEmbeddings: true });
    writePublishJournal(backupRoot, 'staged', { dbPath, memoryRoot, vaultRoot });
    if (inventoryHash(memoryRoot) !== sourceHash) throw new Error('source inventory drifted during migration');
    guardDb.exec('COMMIT');
    const checkpoint = guardDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (checkpoint.busy) throw new Error('database still has active readers or writers');
    guardDb.close();
    guardDb = null;
    writePublishJournal(backupRoot, 'publishing_memory');
    for (const name of ['decisions', 'lessons', 'capsules']) {
      publishDirectory(path.join(staged.stagedMemory, name), path.join(memoryRoot, name), path.join(backupRoot, `previous-${name}`));
    }
    writePublishJournal(backupRoot, 'publishing_vault');
    for (const name of ['decisions', 'lessons', 'capsules']) {
      const live = path.join(vaultRoot, name);
      fs.mkdirSync(live, { recursive: true });
      publishDirectory(path.join(staged.stagedVault, name), live, path.join(backupRoot, `previous-vault-${name}`));
    }
    writePublishJournal(backupRoot, 'publishing_database');
    fs.renameSync(dbPath, path.join(backupRoot, 'previous-memory.db'));
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true });
    fs.renameSync(staged.stagedDb, dbPath);
    writePublishJournal(backupRoot, 'complete');
    return { backupRoot, decisions: staged.decisions, playbooks: staged.playbooks,
      derived: staged.derived, projection: staged.projection, metrics: staged.metrics };
  } catch (error) {
    if (guardDb) {
      try { guardDb.exec('ROLLBACK'); } catch { /* no active transaction */ }
      try { guardDb.close(); } catch { /* preserve original */ }
      guardDb = null;
    }
    try { rollbackPublishedState({ dbPath, memoryRoot, vaultRoot, backupRoot }); } catch { /* report original error */ }
    try { writePublishJournal(backupRoot, 'rolled_back', { error: error.message }); } catch { /* preserve original */ }
    throw error;
  } finally {
    if (guardDb) try { guardDb.close(); } catch { /* preserve result */ }
    releaseMaintenance();
  }
}

function parseArgs(argv) {
  const args = { mode: null };
  for (let i = 0; i < argv.length; i++) {
    if (['--dry-run', '--stage', '--apply', '--recover'].includes(argv[i])) {
      const mode = argv[i].slice(2);
      if (args.mode && args.mode !== mode) throw new Error('choose exactly one migration mode');
      args.mode = mode;
    }
    else if (['--manifest', '--db', '--memory-root', '--vault', '--stage-root', '--backup-root'].includes(argv[i])) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argv[i - 1]}`);
      args[argv[i - 1].slice(2).replaceAll('-', '_')] = value;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const dbPath = path.resolve(args.db || path.join(os.homedir(), '.metame', 'memory.db'));
  const memoryRoot = path.resolve(args.memory_root || path.join(os.homedir(), '.metame', 'memory'));
  let configuredVault = null;
  try {
    const config = require('./resolve-yaml').load(fs.readFileSync(path.join(os.homedir(), '.metame', 'daemon.yaml'), 'utf8'));
    configuredVault = resolveConfiguredWikiOutputDir(config, { home: os.homedir() });
  } catch { /* use runtime default */ }
  const vaultRoot = path.resolve(args.vault || configuredVault || path.join(os.homedir(), '.metame', 'wiki'));
  if (args.mode === 'dry-run') {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const manifest = buildManifest(db, { memoryRoot, vaultRoot });
      if (args.manifest) writeManifest(manifest, path.resolve(args.manifest));
      return manifest;
    } finally { db.close(); }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (args.mode === 'stage') return stageMigration({
    dbPath, memoryRoot, vaultRoot,
    stageRoot: path.resolve(args.stage_root || path.join(os.tmpdir(), `metame-artifacts-${stamp}`)),
    drainEmbeddings: true,
  });
  if (args.mode === 'apply') return applyMigration({
    dbPath, memoryRoot, vaultRoot,
    backupRoot: path.resolve(args.backup_root || path.join(os.homedir(), '.metame', 'backups', `knowledge-artifacts-${stamp}`)),
  });
  if (args.mode === 'recover') {
    if (!args.backup_root) throw new Error('--recover requires --backup-root');
    return recoverMigration({ dbPath, memoryRoot, vaultRoot, backupRoot: path.resolve(args.backup_root) });
  }
  throw new Error('usage: memory-artifact-migrate --dry-run|--stage|--apply|--recover');
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main(), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = {
  MANIFEST_VERSION,
  applyMigration,
  archiveReflectDirectories,
  buildManifest,
  canonicalCapsuleIdentity,
  canonicalizeDecisions,
  canonicalizeCapsules,
  knownDerivedMetrics,
  main,
  parseArgs,
  removeDerivedEvidence,
  recoverMigration,
  stageMigration,
};
