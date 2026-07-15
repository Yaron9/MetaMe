#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const { DatabaseSync } = require('node:sqlite');
const { applyWikiSchema } = require('./memory-wiki-schema');
const { projectMarkdown } = require('./core/openwiki-projection');
const { writeWikiPageWithChunks } = require('./wiki-reflect-build');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const CONFIG_PATH = path.join(METAME_DIR, 'daemon.yaml');
const DB_PATH = path.join(METAME_DIR, 'memory.db');
const OPENWIKI_HOME = path.join(HOME, '.openwiki');
const OPENWIKI_LINK = path.join(OPENWIKI_HOME, 'wiki');
const LOCK_PATH = path.join(METAME_DIR, 'openwiki-sync.lock');
const LOG_PATH = path.join(METAME_DIR, 'openwiki-sync.jsonl');
const LAST_GOOD_PATH = path.join(METAME_DIR, 'openwiki-last-good');
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'COHERE_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_CHATGPT_ACCESS_TOKEN',
  'OPENAI_CHATGPT_ACCOUNT_ID',
  'OPENAI_CHATGPT_EXPIRES_AT',
  'OPENAI_CHATGPT_REFRESH_TOKEN',
  'OPENROUTER_API_KEY',
  'OPENWIKI_MODEL_ID',
  'OPENWIKI_PROVIDER',
  'TOGETHER_API_KEY',
  'XAI_API_KEY',
];

function expandHome(input) {
  return path.resolve(String(input || '').replace(/^~(?=$|\/)/, HOME));
}

function selectProviderEnvironment(env = process.env) {
  return Object.fromEntries(PROVIDER_ENV_KEYS
    .filter(key => typeof env[key] === 'string' && env[key].length > 0)
    .map(key => [key, env[key]]));
}

function shouldUseSandbox(sandboxMode, platform = process.platform, exists = fs.existsSync) {
  if (sandboxMode !== 'required') return false;
  if (platform !== 'darwin') {
    throw new Error(`OpenWiki sandbox=required is unsupported on ${platform}; configure an equivalent sandbox or explicitly set sandbox: disabled`);
  }
  if (!exists('/usr/bin/sandbox-exec')) throw new Error('OpenWiki sandbox=required but /usr/bin/sandbox-exec is unavailable');
  return true;
}

function loadOpenWikiConfig(configPath = CONFIG_PATH) {
  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  const openwiki = config.wiki?.external?.openwiki || {};
  const wikiRoot = expandHome(config.daemon?.wiki_output_dir || path.join(METAME_DIR, 'wiki'));
  const gitConnectors = Array.isArray(openwiki.connectors?.git)
    ? openwiki.connectors.git.filter(item => item && item.path)
    : [];
  const webConnectors = Array.isArray(openwiki.connectors?.web)
    ? openwiki.connectors.web.filter(item => item && item.enabled === true)
    : [];
  return {
    ...openwiki,
    enabled: openwiki.enabled === true,
    recall_mode: ['off', 'shadow', 'on'].includes(openwiki.recall_mode)
      ? openwiki.recall_mode : 'off',
    outputRoot: path.join(wikiRoot, openwiki.output_subdir || 'external/openwiki'),
    scopeTags: Array.isArray(openwiki.scope_tags) && openwiki.scope_tags.length > 0
      ? openwiki.scope_tags : ['metame'],
    binary: expandHome(openwiki.binary || path.join(METAME_DIR, 'tools/openwiki/node_modules/.bin/openwiki')),
    repoPaths: gitConnectors
      .map(item => item && item.path)
      .filter(Boolean)
      .map(expandHome),
    connectorTargets: [
      ...(gitConnectors.length > 0 ? ['git-repo'] : []),
      ...(webConnectors.length > 0 ? ['web-search'] : []),
    ],
    sandbox: openwiki.sandbox || 'required',
  };
}

function acquireLock(lockPath = LOCK_PATH) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    fs.closeSync(fd);
    return () => { try { fs.unlinkSync(lockPath); } catch { } };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (age < 60 * 60 * 1000) throw new Error('OpenWiki sync already running');
    fs.unlinkSync(lockPath);
    return acquireLock(lockPath);
  }
}

function listMarkdownFiles(root) {
  const rootReal = fs.realpathSync(root);
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`OpenWiki output contains symlink: ${absolute}`);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) walk(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const stat = fs.statSync(absolute);
      if (stat.size > MAX_MARKDOWN_BYTES) throw new Error(`OpenWiki page exceeds 1 MiB: ${absolute}`);
      const relativePath = path.relative(rootReal, absolute).split(path.sep).join('/');
      files.push({ relativePath, markdown: fs.readFileSync(absolute, 'utf8') });
    }
  }
  walk(rootReal);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function removeInternalArtifacts(root) {
  const planPath = path.join(root, '_plan.md');
  if (!fs.existsSync(planPath)) return 0;
  const stat = fs.lstatSync(planPath);
  if (!stat.isFile()) throw new Error('OpenWiki _plan.md must be a regular file');
  fs.unlinkSync(planPath);
  return 1;
}

function ensureExternalFrontmatter(root, scopeTags, now = new Date().toISOString()) {
  let changed = 0;
  for (const { relativePath, markdown } of listMarkdownFiles(root)) {
    if (/^---\r?\n/.test(markdown)) continue;
    const filePath = path.join(root, ...relativePath.split('/'));
    const projected = projectMarkdown({ relativePath, markdown, scopeTags });
    const frontmatter = yaml.dump({
      title: projected.pageSpec.title,
      source: 'openwiki',
      source_type: 'external',
      tags: projected.pageSpec.topic_tags,
      updated: now,
    }, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(filePath, `---\n${frontmatter}---\n\n${markdown.trim()}\n`, 'utf8');
    changed += 1;
  }
  return changed;
}

function preparePages(root, scopeTags) {
  const pages = listMarkdownFiles(root).map(file => projectMarkdown({ ...file, scopeTags }));
  const slugs = new Set();
  for (const page of pages) {
    if (slugs.has(page.pageSpec.slug)) throw new Error(`OpenWiki slug collision: ${page.pageSpec.slug}`);
    slugs.add(page.pageSpec.slug);
  }
  return pages;
}

function deleteExternalPage(db, pageSlug) {
  const ids = db.prepare('SELECT id FROM content_chunks WHERE page_slug = ?').all(pageSlug).map(row => row.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM embedding_queue WHERE item_type = 'chunk' AND item_id IN (${placeholders})`).run(...ids);
  }
  db.prepare('DELETE FROM content_chunks WHERE page_slug = ?').run(pageSlug);
  db.prepare('DELETE FROM wiki_external_sources WHERE page_slug = ?').run(pageSlug);
  db.prepare("DELETE FROM wiki_pages WHERE slug = ? AND source_type = 'openwiki'").run(pageSlug);
}

function applyProjection(db, pages, runId, { dryRun = false } = {}) {
  if (!dryRun) applyWikiSchema(db);
  const existing = db.prepare(`
    SELECT wes.*, wp.slug AS existing_page
    FROM wiki_external_sources wes
    LEFT JOIN wiki_pages wp ON wp.slug = wes.page_slug
  `).all();
  const byKey = new Map(existing.map(row => [row.source_key, row]));
  const bySlug = new Map(existing.map(row => [row.page_slug, row]));
  const seen = new Set(pages.map(page => page.sourceKey));
  const reboundKeys = new Set();
  for (const page of pages) {
    const owner = bySlug.get(page.pageSpec.slug);
    if (owner && owner.source_key !== page.sourceKey) reboundKeys.add(owner.source_key);
  }
  const stats = { scanned: pages.length, changed: 0, unchanged: 0, missing: 0, deleted: 0 };

  for (const page of pages) {
    const previous = byKey.get(page.sourceKey);
    if (previous && previous.content_hash === page.contentHash && previous.existing_page) stats.unchanged++;
    else stats.changed++;
  }
  for (const previous of existing) {
    if (!seen.has(previous.source_key) && !reboundKeys.has(previous.source_key)) {
      stats.missing++;
      if (previous.missing_count + 1 >= 2) stats.deleted++;
    }
  }
  if (dryRun) return stats;

  db.prepare('BEGIN').run();
  try {
    const deleteSource = db.prepare('DELETE FROM wiki_external_sources WHERE source_key = ?');
    for (const sourceKey of reboundKeys) deleteSource.run(sourceKey);
    const upsertSource = db.prepare(`
      INSERT INTO wiki_external_sources
        (source_key, page_slug, relative_path, content_hash, last_seen_run, missing_count, imported_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT(source_key) DO UPDATE SET
        page_slug = excluded.page_slug,
        relative_path = excluded.relative_path,
        content_hash = excluded.content_hash,
        last_seen_run = excluded.last_seen_run,
        missing_count = 0,
        updated_at = datetime('now')
    `);
    for (const page of pages) {
      const previous = byKey.get(page.sourceKey);
      const changed = !previous || previous.content_hash !== page.contentHash || !previous.existing_page;
      if (previous && previous.page_slug !== page.pageSpec.slug) {
        deleteExternalPage(db, previous.page_slug);
      }
      if (changed) {
        writeWikiPageWithChunks(db, page.pageSpec, page.content, {
          transaction: false,
          scopes: page.pageSpec.scope_keys,
        });
      }
      if (!changed) {
        db.prepare('DELETE FROM wiki_page_scopes WHERE page_slug = ?').run(page.pageSpec.slug);
        const insertScope = db.prepare('INSERT INTO wiki_page_scopes (page_slug, scope_key) VALUES (?, ?)');
        for (const scopeKey of page.pageSpec.scope_keys) insertScope.run(page.pageSpec.slug, scopeKey);
      }
      upsertSource.run(
        page.sourceKey,
        page.pageSpec.slug,
        page.relativePath,
        page.contentHash,
        runId,
      );
    }
    for (const previous of existing) {
      if (seen.has(previous.source_key) || reboundKeys.has(previous.source_key)) continue;
      const missingCount = previous.missing_count + 1;
      if (missingCount >= 2) deleteExternalPage(db, previous.page_slug);
      else db.prepare(`
        UPDATE wiki_external_sources SET missing_count = ?, updated_at = datetime('now')
        WHERE source_key = ?
      `).run(missingCount, previous.source_key);
    }
    db.prepare('COMMIT').run();
    return stats;
  } catch (err) {
    try { db.prepare('ROLLBACK').run(); } catch { }
    throw err;
  }
}

function quoteSandbox(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function resolveDeveloperDir() {
  const commandLineTools = '/Library/Developer/CommandLineTools';
  if (fs.existsSync(path.join(commandLineTools, 'usr', 'bin', 'git'))) return commandLineTools;
  const result = spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const selected = String(result.stdout || '').trim();
  if (!path.isAbsolute(selected)) return null;
  if (!selected.startsWith('/Applications/') && !selected.startsWith('/Library/Developer/')) return null;
  return selected;
}

function buildSandboxProfile({ openwikiHome, outputRoot, binary, repoPaths, developerDir = null }) {
  const home = path.dirname(openwikiHome);
  const homeParent = path.dirname(home);
  const developerReadRoot = developerDir && developerDir.startsWith('/Applications/')
    ? path.dirname(developerDir)
    : developerDir;
  const readable = [
    openwikiHome,
    path.dirname(path.dirname(binary)),
    outputRoot,
    ...repoPaths,
    ...(developerReadRoot ? [developerReadRoot] : []),
  ];
  const readRules = readable.map(item => `(subpath ${quoteSandbox(item)})`).join(' ');
  const metadataPaths = new Set(['/', homeParent, home]);
  for (const item of readable) {
    let current = path.resolve(item);
    while (current.startsWith(`${home}${path.sep}`)) {
      current = path.dirname(current);
      metadataPaths.add(current);
      if (current === home) break;
    }
  }
  const metadataRules = [...metadataPaths].map(item => `(literal ${quoteSandbox(item)})`).join(' ');
  return `(version 1)
(import "system.sb")
(deny file-read* (subpath ${quoteSandbox(home)}))
(allow file-read-metadata ${metadataRules})
(allow file-read* ${readRules})
(deny file-write*)
(allow file-write* (subpath ${quoteSandbox(openwikiHome)}) (subpath ${quoteSandbox(outputRoot)}) (subpath "/private/tmp"))
(allow network-outbound)
(allow process*)
`;
}

function replaceSymlink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o700 });
  const temp = `${linkPath}.tmp-${process.pid}`;
  try { fs.unlinkSync(temp); } catch { }
  fs.symlinkSync(targetPath, temp);
  try {
    fs.renameSync(temp, linkPath);
  } catch (err) {
    try { fs.unlinkSync(linkPath); } catch { }
    fs.renameSync(temp, linkPath);
  }
}

function runChild(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => (current + chunk.toString('utf8')).slice(-MAX_OUTPUT_BYTES);
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function invokeOpenWiki(config, outputRoot) {
  if (!fs.existsSync(config.binary)) throw new Error(`OpenWiki binary not installed: ${config.binary}`);
  if (config.connectorTargets.length === 0) throw new Error('No enabled OpenWiki connectors');
  replaceSymlink(OPENWIKI_LINK, outputRoot);
  const useSandbox = shouldUseSandbox(config.sandbox);
  const developerDir = process.platform === 'darwin' ? resolveDeveloperDir() : null;
  const env = {
    HOME,
    PATH: [
      developerDir ? path.join(developerDir, 'usr', 'bin') : null,
      process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    ].filter(Boolean).join(':'),
    LANG: process.env.LANG || 'en_US.UTF-8',
    TMPDIR: '/private/tmp',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}),
    ...selectProviderEnvironment(process.env),
  };
  let profilePath = null;
  if (useSandbox) {
    profilePath = path.join(os.tmpdir(), `metame-openwiki-${process.pid}.sb`);
    fs.writeFileSync(profilePath, buildSandboxProfile({
      openwikiHome: OPENWIKI_HOME,
      outputRoot,
      binary: config.binary,
      repoPaths: config.repoPaths,
      developerDir,
    }), { mode: 0o600 });
  }
  try {
    const results = [];
    for (const target of config.connectorTargets) {
      const openwikiArgs = ['ingest', target, '--print'];
      const command = profilePath ? '/usr/bin/sandbox-exec' : config.binary;
      const args = profilePath
        ? ['-f', profilePath, config.binary, ...openwikiArgs]
        : openwikiArgs;
      const result = await runChild(command, args, { env, cwd: OPENWIKI_HOME });
      if (result.code !== 0 || /["']?status["']?\s*[:=]\s*["']error/i.test(`${result.stdout}\n${result.stderr}`)) {
        throw new Error(`OpenWiki ${target} ingest failed (${result.code}): ${(result.stderr || result.stdout).slice(-1000)}`);
      }
      results.push({ target, ...result });
    }
    return results;
  } finally {
    if (profilePath) try { fs.unlinkSync(profilePath); } catch { }
  }
}

function openProjectionDatabase({ dbPath = DB_PATH, readOnly = false, Database = DatabaseSync } = {}) {
  const db = new Database(dbPath, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
    return db;
  } catch (err) {
    try { db.close(); } catch { }
    throw err;
  }
}

function stageOutput(outputRoot, runId) {
  const parent = path.dirname(outputRoot);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.openwiki-staging-${runId}`);
  const backup = path.join(parent, '.openwiki-last-good');
  fs.rmSync(staging, { recursive: true, force: true });
  if (fs.existsSync(outputRoot)) fs.cpSync(outputRoot, staging, { recursive: true });
  else fs.mkdirSync(staging, { recursive: true });
  return { staging, backup };
}

function publishStaging(outputRoot, staging, backup) {
  fs.rmSync(backup, { recursive: true, force: true });
  if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, backup);
  try {
    fs.renameSync(staging, outputRoot);
  } catch (err) {
    if (fs.existsSync(backup)) fs.renameSync(backup, outputRoot);
    throw err;
  }
}

function rollbackPublish(outputRoot, backup, linkPath = OPENWIKI_LINK) {
  const failed = `${outputRoot}.failed-${Date.now()}`;
  if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, failed);
  if (fs.existsSync(backup)) fs.renameSync(backup, outputRoot);
  if (fs.existsSync(outputRoot)) replaceSymlink(linkPath, outputRoot);
  else fs.rmSync(linkPath, { force: true });
  return failed;
}

function finalizePublish(outputRoot, backup, lastGoodPath = LAST_GOOD_PATH) {
  const temp = `${lastGoodPath}.tmp-${process.pid}`;
  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(outputRoot, temp, { recursive: true });
  fs.rmSync(lastGoodPath, { recursive: true, force: true });
  fs.renameSync(temp, lastGoodPath);
  fs.rmSync(backup, { recursive: true, force: true });
  return lastGoodPath;
}

function projectPublishedOutput({
  pages,
  runId,
  outputRoot,
  backup,
  linkPath = OPENWIKI_LINK,
  openDatabase = openProjectionDatabase,
  apply = applyProjection,
} = {}) {
  let db;
  try {
    replaceSymlink(linkPath, outputRoot);
    db = openDatabase();
    return apply(db, pages, runId);
  } catch (err) {
    try { rollbackPublish(outputRoot, backup, linkPath); } catch { }
    throw err;
  } finally {
    if (db) try { db.close(); } catch { }
  }
}

function runPostCommitHousekeeping(result, {
  gc,
  finalize,
  log,
} = {}) {
  let gcResult;
  try {
    gcResult = { status: 'ok', ...(gc ? gc() : {}) };
  } catch (err) {
    gcResult = { status: 'degraded', error: err.message };
  }
  let recovery;
  try {
    recovery = { status: 'ok', path: finalize ? finalize() : null };
  } catch (err) {
    recovery = { status: 'degraded', error: err.message };
  }
  const completed = { ...result, gc: gcResult, recovery, logging: { status: 'ok' } };
  try {
    if (log) log(completed);
  } catch (err) {
    completed.logging = { status: 'degraded', error: err.message };
  }
  return completed;
}

function appendLog(entry) {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function directorySize(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += directorySize(absolute);
    else if (entry.isFile()) total += fs.statSync(absolute).size;
  }
  return total;
}

function gcRawConnectorData(openwikiHome, retention = {}, now = Date.now()) {
  const days = Number(retention.raw_days || 90);
  const keep = Number(retention.successful_runs || 3);
  const maxBytes = Number(retention.raw_max_gb || 2) * 1024 * 1024 * 1024;
  const connectorsRoot = path.join(openwikiHome, 'connectors');
  if (!fs.existsSync(connectorsRoot)) return { removed: 0, bytesFreed: 0, bytesRemaining: 0 };
  const runs = [];
  for (const connector of fs.readdirSync(connectorsRoot, { withFileTypes: true })) {
    if (!connector.isDirectory() || connector.isSymbolicLink()) continue;
    const rawRoot = path.join(connectorsRoot, connector.name, 'raw');
    if (!fs.existsSync(rawRoot)) continue;
    const connectorRuns = fs.readdirSync(rawRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => {
        const absolute = path.join(rawRoot, entry.name);
        return {
          absolute,
          connector: connector.name,
          mtimeMs: fs.statSync(absolute).mtimeMs,
          bytes: directorySize(absolute),
          protected: false,
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    connectorRuns.slice(0, keep).forEach(run => { run.protected = true; });
    runs.push(...connectorRuns);
  }
  let total = runs.reduce((sum, run) => sum + run.bytes, 0);
  let removed = 0;
  let bytesFreed = 0;
  const cutoff = now - days * 86400000;
  for (const run of runs.filter(item => !item.protected).sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (run.mtimeMs >= cutoff && total <= maxBytes) continue;
    fs.rmSync(run.absolute, { recursive: true, force: true });
    total -= run.bytes;
    bytesFreed += run.bytes;
    removed++;
  }
  return { removed, bytesFreed, bytesRemaining: total };
}

async function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const projectOnly = argv.includes('--project-only') || dryRun;
  const config = loadOpenWikiConfig();
  if (!config.enabled && !projectOnly) throw new Error('OpenWiki integration is disabled');
  const releaseLock = dryRun ? () => {} : acquireLock();
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  let db;
  try {
    if (projectOnly) {
      if (!fs.existsSync(config.outputRoot)) throw new Error(`OpenWiki output missing: ${config.outputRoot}`);
      const pages = preparePages(config.outputRoot, config.scopeTags);
      db = openProjectionDatabase({ readOnly: dryRun });
      const result = applyProjection(db, pages, runId, { dryRun });
      if (!dryRun) appendLog({ ts: new Date().toISOString(), mode: 'project-only', ...result });
      return result;
    }

    const { staging, backup } = stageOutput(config.outputRoot, runId);
    try {
      await invokeOpenWiki(config, staging);
      removeInternalArtifacts(staging);
      ensureExternalFrontmatter(staging, config.scopeTags);
      const pages = preparePages(staging, config.scopeTags);
      if (pages.length === 0) throw new Error('OpenWiki produced no Markdown pages');
      publishStaging(config.outputRoot, staging, backup);
      const result = projectPublishedOutput({
        pages,
        runId,
        outputRoot: config.outputRoot,
        backup,
      });
      const completed = runPostCommitHousekeeping(result, {
        gc: () => gcRawConnectorData(OPENWIKI_HOME, config.retention),
        finalize: () => finalizePublish(config.outputRoot, backup),
        log: value => appendLog({ ts: new Date().toISOString(), mode: 'sync', ...value }),
      });
      return completed;
    } catch (err) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { }
      if (fs.existsSync(config.outputRoot)) replaceSymlink(OPENWIKI_LINK, config.outputRoot);
      else fs.rmSync(OPENWIKI_LINK, { force: true });
      throw err;
    }
  } catch (err) {
    if (!dryRun) try { appendLog({ ts: new Date().toISOString(), mode: 'error', error: err.message }); } catch { }
    throw err;
  } finally {
    if (db) try { db.close(); } catch { }
    releaseLock();
  }
}

if (require.main === module) {
  main()
    .then(result => console.log(JSON.stringify(result)))
    .catch(err => {
      console.error(`[openwiki-sync] ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  main,
  _internal: {
    applyProjection,
    buildSandboxProfile,
    gcRawConnectorData,
    ensureExternalFrontmatter,
    finalizePublish,
    listMarkdownFiles,
    loadOpenWikiConfig,
    invokeOpenWiki,
    openProjectionDatabase,
    preparePages,
    projectPublishedOutput,
    publishStaging,
    removeInternalArtifacts,
    replaceSymlink,
    resolveDeveloperDir,
    selectProviderEnvironment,
    shouldUseSandbox,
    rollbackPublish,
    runPostCommitHousekeeping,
    stageOutput,
  },
};
