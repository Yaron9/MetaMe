#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { DatabaseSync } = require('node:sqlite');
const embedding = require('./core/embedding');
const { loadOpenWikiConfig, preparePages } = require('./openwiki-sync')._internal;

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const CONFIG_PATH = path.join(METAME_DIR, 'daemon.yaml');
const DB_PATH = path.join(METAME_DIR, 'memory.db');

function lastJsonLine(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { }
  }
  return null;
}

function ageHours(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? (Date.now() - timestamp) / 3600000 : null;
}

function addCheck(report, name, level, message, data = undefined) {
  report.checks.push({ name, level, message, ...(data === undefined ? {} : { data }) });
  if (level === 'error') report.status = 'error';
  else if (level === 'degraded' && report.status === 'ok') report.status = 'degraded';
}

function tableExists(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function tableColumns(db, table) {
  if (!/^[a-z_]+$/i.test(table) || !tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function countRows(db, table, where = '') {
  if (!/^[a-z_]+$/i.test(table) || !tableExists(db, table)) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`).get().count;
}

function inspectDatabase(report, config, { dbPath = DB_PATH, Database = DatabaseSync } = {}) {
  if (!fs.existsSync(dbPath)) {
    addCheck(report, 'database', 'error', `memory.db missing: ${dbPath}`);
    return;
  }
  const db = new Database(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA quick_check').get().quick_check;
    addCheck(report, 'database', integrity === 'ok' ? 'ok' : 'error', `quick_check=${integrity}`);
    const wikiColumns = tableColumns(db, 'wiki_pages');
    const chunkColumns = tableColumns(db, 'content_chunks');
    const queueColumns = tableColumns(db, 'embedding_queue');
    const externalSchemaReady = wikiColumns.has('source_type') && tableExists(db, 'wiki_external_sources');
    const dossierSchemaReady = wikiColumns.has('page_kind')
      && tableExists(db, 'wiki_topic_aliases')
      && tableExists(db, 'wiki_page_scopes')
      && tableExists(db, 'wiki_page_evidence');
    const metrics = {
      memory_items: countRows(db, 'memory_items'),
      wiki_pages: countRows(db, 'wiki_pages'),
      openwiki_pages: externalSchemaReady
        ? countRows(db, 'wiki_pages', "source_type='openwiki'") : 0,
      chunks: countRows(db, 'content_chunks'),
      missing_embeddings: chunkColumns.has('embedding')
        ? countRows(db, 'content_chunks', 'embedding IS NULL') : 0,
      queue_pending: queueColumns.has('attempts')
        ? countRows(db, 'embedding_queue', 'attempts < 3') : 0,
      queue_dead: queueColumns.has('attempts')
        ? countRows(db, 'embedding_queue', 'attempts >= 3') : 0,
      topic_hubs: dossierSchemaReady ? countRows(db, 'wiki_pages', "page_kind='topic_hub' AND source_type='memory'") : 0,
      project_dossiers: dossierSchemaReady ? countRows(db, 'wiki_pages', "page_kind='project_dossier' AND source_type='memory'") : 0,
    };
    report.metrics = { ...report.metrics, ...metrics };
    const models = chunkColumns.has('embedding_model') && chunkColumns.has('embedding_dim')
      ? db.prepare(`
      SELECT COALESCE(embedding_model, 'NULL') AS model, COALESCE(embedding_dim, 0) AS dimensions,
             COUNT(*) AS count
      FROM content_chunks GROUP BY embedding_model, embedding_dim ORDER BY count DESC
    `).all().map(row => ({ ...row })) : [];
    report.metrics.embedding_models = models;
    if (metrics.queue_dead > 0) addCheck(report, 'embedding-queue', 'error', `${metrics.queue_dead} dead embedding jobs`);
    else if (metrics.queue_pending > 0) addCheck(report, 'embedding-queue', 'degraded', `${metrics.queue_pending} embedding jobs pending`);
    else addCheck(report, 'embedding-queue', 'ok', 'embedding queue empty');

    if (!dossierSchemaReady) {
      addCheck(report, 'dossier-schema', 'degraded', 'schema upgrade required before dossier diagnostics');
    } else {
      const orphanEvidence = db.prepare(`
        SELECT COUNT(*) AS n FROM wiki_page_evidence wpe
        LEFT JOIN memory_items mi ON wpe.evidence_type='memory_item' AND mi.id=wpe.evidence_id
        LEFT JOIN paper_facts pf ON wpe.evidence_type='paper_fact' AND pf.id=wpe.evidence_id
        WHERE (wpe.evidence_type='memory_item' AND mi.id IS NULL)
           OR (wpe.evidence_type='paper_fact' AND pf.id IS NULL)
      `).get().n;
      const orphanAliases = db.prepare(`
        SELECT COUNT(*) AS n FROM wiki_topic_aliases wta
        LEFT JOIN wiki_pages wp ON wp.slug=wta.topic_slug WHERE wp.slug IS NULL
      `).get().n;
      report.metrics.orphan_wiki_evidence = orphanEvidence;
      report.metrics.orphan_topic_aliases = orphanAliases;
      addCheck(report, 'dossier-evidence', orphanEvidence + orphanAliases === 0 ? 'ok' : 'error',
        orphanEvidence + orphanAliases === 0
          ? 'evidence and aliases are referentially complete'
          : `${orphanEvidence} orphan evidence, ${orphanAliases} orphan aliases`);
    }

    if (!externalSchemaReady) {
      addCheck(report, 'openwiki-schema', 'degraded', 'schema upgrade required before projection diagnostics');
    } else if (fs.existsSync(config.outputRoot)) {
      const pages = preparePages(config.outputRoot, config.scopeTags);
      const projected = new Map(db.prepare('SELECT source_key, content_hash, missing_count FROM wiki_external_sources').all()
        .map(row => [row.source_key, row]));
      let drift = 0;
      for (const page of pages) {
        const row = projected.get(page.sourceKey);
        if (!row || row.content_hash !== page.contentHash || row.missing_count > 0) drift++;
        projected.delete(page.sourceKey);
      }
      drift += projected.size;
      report.metrics.openwiki_drift = drift;
      const level = drift === 0 ? 'ok' : (config.recall_mode === 'on' ? 'error' : 'degraded');
      addCheck(report, 'openwiki-projection', level, drift === 0 ? 'file and DB projection match' : `${drift} projection differences`);
    } else if (config.enabled) {
      addCheck(report, 'openwiki-output', 'error', `output missing: ${config.outputRoot}`);
    }
  } finally {
    db.close();
  }
}

function inspectOpenWiki(report, config) {
  if (!config.enabled) {
    addCheck(report, 'openwiki', 'degraded', 'integration disabled');
    return;
  }
  if (!fs.existsSync(config.binary)) {
    addCheck(report, 'openwiki-binary', 'error', `binary missing: ${config.binary}`);
  } else {
    const packagePath = path.join(path.dirname(path.dirname(config.binary)), 'openwiki', 'package.json');
    let text = '';
    try { text = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version || ''; } catch { }
    const expected = String(config.version || '0.1.2');
    addCheck(
      report,
      'openwiki-version',
      text === expected ? 'ok' : 'error',
      text || 'unable to read installed package version',
    );
  }
  const last = lastJsonLine(path.join(METAME_DIR, 'openwiki-sync.jsonl'));
  if (!last) addCheck(report, 'openwiki-sync', 'degraded', 'no completed sync recorded');
  else {
    const hours = ageHours(last.ts);
    const level = last.mode === 'error' || (hours !== null && hours > 72)
      ? 'error' : (hours !== null && hours > 36 ? 'degraded' : 'ok');
    addCheck(report, 'openwiki-sync', level, `last=${last.mode || 'unknown'}, age=${hours?.toFixed(1) ?? '?'}h`, last);
  }
  addCheck(
    report,
    'openwiki-recall',
    config.recall_mode === 'on' ? 'ok' : 'degraded',
    `mode=${config.recall_mode}`,
  );
}

function inspectReflection(report, logPath = path.join(METAME_DIR, 'memory_reflect_log.jsonl')) {
  const last = lastJsonLine(logPath);
  if (!last) return addCheck(report, 'nightly-reflect', 'degraded', 'no reflection log');
  const failed = last.status === 'error'
    || last.reason === 'parse_failed'
    || last.parse_failed === true
    || last.status === 'parse_failed'
    || !!last.error;
  addCheck(report, 'nightly-reflect', failed ? 'degraded' : 'ok', failed ? 'latest reflection failed' : 'latest reflection healthy');
}

function runDoctor() {
  const report = { status: 'ok', generated_at: new Date().toISOString(), checks: [], metrics: {} };
  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  const backend = raw.daemon?.embedding?.backend;
  if (backend) process.env.METAME_EMBEDDING_BACKEND = backend;
  const backendInfo = embedding.getBackendInfo();
  addCheck(
    report,
    'embedding-backend',
    backendInfo ? 'ok' : 'error',
    backendInfo ? `${backendInfo.backend}:${backendInfo.model}/${backendInfo.dimensions}` : `unavailable:${backend || 'auto'}`,
  );
  const config = loadOpenWikiConfig();
  inspectOpenWiki(report, config);
  inspectDatabase(report, config);
  inspectReflection(report);
  return report;
}

function renderHuman(report) {
  const icon = { ok: '✓', degraded: '△', error: '✗' };
  const lines = [`Wiki doctor: ${report.status}`];
  for (const check of report.checks) lines.push(`${icon[check.level]} ${check.name}: ${check.message}`);
  return lines.join('\n');
}

if (require.main === module) {
  try {
    const report = runDoctor();
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderHuman(report));
    process.exitCode = report.status === 'error' ? 2 : (report.status === 'degraded' ? 1 : 0);
  } catch (err) {
    console.error(`[wiki-doctor] ${err.message}`);
    process.exitCode = 2;
  }
}

module.exports = {
  runDoctor,
  _internal: {
    addCheck,
    ageHours,
    inspectDatabase,
    inspectReflection,
    lastJsonLine,
    renderHuman,
    tableColumns,
    tableExists,
  },
};
