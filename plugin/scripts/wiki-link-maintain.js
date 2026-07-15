#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('./resolve-yaml');
const { auditDocuments, replaceMissingWorkspaceFiles, stripBrokenLinks } = require('./core/wiki-link-integrity');
const { resolveConfiguredWikiOutputDir } = require('./core/wiki-paths');

function listMarkdown(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules'
        || entry.name === '_review' || entry.name === '_archive' || entry.name === '_revisions') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) files.push(full);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return files.sort();
}

function auditVault(root) {
  const documents = {};
  for (const file of listMarkdown(root)) {
    documents[path.relative(root, file).replace(/\\/g, '/')] = fs.readFileSync(file, 'utf8');
  }
  return auditDocuments(documents);
}

function repairWorkspace(root, fallback = 'capsules/_index.md') {
  const workspacePath = path.join(root, '.obsidian', 'workspace.json');
  if (!fs.existsSync(workspacePath) || !fs.existsSync(path.join(root, fallback))) return { replaced: 0 };
  const existingFiles = new Set(listMarkdown(root)
    .map(file => path.relative(root, file).replace(/\\/g, '/').toLowerCase()));
  let workspace;
  try { workspace = JSON.parse(fs.readFileSync(workspacePath, 'utf8')); }
  catch { return { replaced: 0, error: 'invalid workspace.json' }; }
  const result = replaceMissingWorkspaceFiles(workspace, existingFiles, fallback);
  if (result.replaced === 0) return { replaced: 0 };
  const backupPath = `${workspacePath}.metame.bak`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(workspacePath, backupPath);
  const tmpPath = `${workspacePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(result.workspace, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, workspacePath);
  return { replaced: result.replaced, backupPath };
}

function sanitizeAuthoredProjectionLinks(root, brokenLinks) {
  const grouped = new Map();
  for (const link of brokenLinks) {
    if (!grouped.has(link.source)) grouped.set(link.source, []);
    grouped.get(link.source).push(link);
  }
  const changed = [];
  let stripped = 0;
  for (const [relative, links] of grouped) {
    const filePath = path.join(root, relative);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, 'utf8');
    const result = stripBrokenLinks(source, links);
    if (result.stripped === 0) continue;
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, result.content, 'utf8');
    fs.renameSync(tmpPath, filePath);
    stripped += result.stripped;
    changed.push(relative);
  }
  return { stripped, changed };
}

function maintainWikiLinks(root, { repair = true, reportPath } = {}) {
  const workspace = repair ? repairWorkspace(root) : { replaced: 0 };
  const before = auditVault(root);
  const sanitized = repair
    ? sanitizeAuthoredProjectionLinks(root, before.softBroken)
    : { stripped: 0, changed: [] };
  const audit = sanitized.stripped > 0 ? auditVault(root) : before;
  const report = {
    generated_at: new Date().toISOString(), root, workspace, sanitized,
    softBrokenBefore: before.softBroken.length,
    ...audit,
  };
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    const tmpPath = `${reportPath}.tmp`;
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
  const root = configuredRoot();
  const report = maintainWikiLinks(root, {
    repair: process.argv.includes('--repair'),
    reportPath: path.join(os.homedir(), '.metame', 'wiki-link-health.json'),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.hardBroken.length > 0 ? 2 : (report.softBroken.length > 0 ? 1 : 0);
}

module.exports = {
  auditVault,
  maintainWikiLinks,
  repairWorkspace,
  sanitizeAuthoredProjectionLinks,
  configuredRoot,
};
