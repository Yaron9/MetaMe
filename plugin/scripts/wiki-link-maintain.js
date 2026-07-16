#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('./resolve-yaml');
const { auditDocuments, auditWorkspaceState, repairWorkspaceState } = require('./core/wiki-link-integrity');
const { resolveConfiguredWikiOutputDir } = require('./core/wiki-paths');

const IGNORED_DIRS = new Set(['node_modules', '_review', '_archive', '_revisions']);

function listVaultFiles(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`wiki output directory missing: ${root}`);
  }
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  }
  walk(root);
  return files.sort();
}

function readWorkspace(root, { includeDocument = false, availableFiles } = {}) {
  const workspacePath = path.join(root, '.obsidian', 'workspace.json');
  if (!fs.existsSync(workspacePath)) return {
    path: workspacePath, exists: false, refs: [], missing: [], recentFiles: [], missingRecent: [], staleTitles: [],
  };
  const source = fs.readFileSync(workspacePath, 'utf8');
  let workspace;
  try { workspace = JSON.parse(source); }
  catch (error) {
    return {
      path: workspacePath, exists: true, error: `invalid workspace.json: ${error.message}`,
      refs: [], missing: [], recentFiles: [], missingRecent: [], staleTitles: [],
    };
  }
  const existing = availableFiles || listVaultFiles(root)
    .map(file => path.relative(root, file).replace(/\\/g, '/'));
  return {
    path: workspacePath,
    exists: true,
    ...auditWorkspaceState(workspace, existing),
    ...(includeDocument ? { document: workspace, source } : {}),
  };
}

function auditVault(root) {
  const files = listVaultFiles(root);
  const availableFiles = files.map(file => path.relative(root, file).replace(/\\/g, '/'));
  const documents = {};
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    documents[path.relative(root, file).replace(/\\/g, '/')] = fs.readFileSync(file, 'utf8');
  }
  return {
    ...auditDocuments(documents, {
      availableFiles,
    }),
    workspace: readWorkspace(root, { availableFiles }),
  };
}

function publicWorkspaceAudit(audit) {
  const result = { ...audit };
  delete result.document;
  delete result.source;
  return result;
}

function repairWorkspace(root, {
  fallback = 'capsules/_index.md',
  backupDir = path.join(os.homedir(), '.metame', 'backups', 'obsidian-workspace'),
  beforeWrite,
  minStableMs = 2000,
  confirmIdle = false,
} = {}) {
  const audit = readWorkspace(root, { includeDocument: true });
  const repairCount = audit.missing.length + audit.missingRecent.length + audit.staleTitles.length;
  if (!audit.exists || audit.error || repairCount === 0) {
    return { ...publicWorkspaceAudit(audit), replaced: 0 };
  }
  if (!confirmIdle) {
    throw new Error('close Obsidian, then retry workspace repair with --confirm-idle');
  }
  if (!fs.existsSync(path.join(root, fallback))) throw new Error(`workspace fallback missing: ${fallback}`);
  if (minStableMs > 0 && Date.now() - fs.statSync(audit.path).mtimeMs < minStableMs) {
    throw new Error('workspace.json changed recently; wait for Obsidian to become idle and retry');
  }
  const result = repairWorkspaceState(audit.document, {
    missing: audit.missing,
    missingRecent: audit.missingRecent,
    staleTitles: audit.staleTitles,
    fallback,
  });
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `workspace-${stamp}-${process.pid}.json`);
  fs.writeFileSync(backupPath, audit.source, 'utf8');
  const tmpPath = `${audit.path}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(result.workspace, null, 2) + '\n', 'utf8');
  if (beforeWrite) beforeWrite();
  if (fs.readFileSync(audit.path, 'utf8') !== audit.source) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error('workspace.json changed during repair; retry after Obsidian becomes idle');
  }
  fs.renameSync(tmpPath, audit.path);
  return {
    ...publicWorkspaceAudit(audit),
    replaced: result.replaced,
    viewRefsReplaced: result.viewRefsReplaced,
    recentFilesRemoved: result.recentFilesRemoved,
    titlesCleared: result.titlesCleared,
    backupPath,
  };
}

function maintainWikiLinks(root, {
  repairWorkspace: shouldRepair = false,
  confirmWorkspaceIdle = false,
  reportPath,
} = {}) {
  const before = auditVault(root);
  const repaired = shouldRepair ? repairWorkspace(root, { confirmIdle: confirmWorkspaceIdle }) : null;
  const audit = repaired?.replaced ? auditVault(root) : before;
  const report = { generated_at: new Date().toISOString(), root, repaired, ...audit };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const tmpPath = `${reportPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, reportPath);
  }
  return report;
}

function configuredRoot(home = os.homedir()) {
  const configPath = path.join(home, '.metame', 'daemon.yaml');
  let config = {};
  try { config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {}; } catch { }
  return resolveConfiguredWikiOutputDir(config, { home });
}

if (require.main === module) {
  try {
    const report = maintainWikiLinks(configuredRoot(), {
      repairWorkspace: process.argv.includes('--repair'),
      confirmWorkspaceIdle: process.argv.includes('--confirm-idle'),
      reportPath: path.join(os.homedir(), '.metame', 'wiki-link-health.json'),
    });
    console.log(JSON.stringify(report, null, 2));
    const workspaceBroken = report.workspace.error
      || report.workspace.missing.length > 0
      || report.workspace.missingRecent.length > 0
      || report.workspace.staleTitles.length > 0;
    process.exitCode = report.hardBroken.length > 0 || workspaceBroken ? 2 : 0;
  } catch (error) {
    console.error(`[wiki-links] ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { auditVault, configuredRoot, maintainWikiLinks, readWorkspace, repairWorkspace };
