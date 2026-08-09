#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildEffectivenessReport } = require('./core/cognitive-effectiveness');

function safeGet(db, sql, ...args) {
  try { return db.prepare(sql).get(...args) || {}; } catch { return {}; }
}

function safeAll(db, sql, ...args) {
  try { return db.prepare(sql).all(...args); } catch { return []; }
}

function collectReport({ dbPath, skillsDir, days = 30 }) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const since = `-${Math.max(1, Math.floor(days))} days`;
    const facts = safeGet(db, `SELECT COUNT(*) AS n FROM memory_items WHERE state='active' AND kind!='profile'`).n || 0;
    const wiki = safeGet(db, `SELECT COUNT(*) AS n FROM wiki_pages WHERE source_type!='managed_redirect' AND COALESCE(artifact_status,'active')='active'`).n || 0;
    let skills = 0;
    try {
      skills = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter(entry => !entry.name.startsWith('.') && !entry.name.startsWith('_') && (entry.isDirectory() || entry.isSymbolicLink())).length;
    } catch { /* unavailable skill directory */ }
    const opportunities = safeGet(db, `SELECT COUNT(*) AS n FROM recall_audit WHERE ts >= datetime('now', ?) AND should_recall=1`, since).n || 0;
    const consumption = safeAll(db, `
      SELECT consumer_stage, COALESCE(engine, consumer_type, 'unknown') AS host, COUNT(*) AS n
        FROM recall_audit
       WHERE ts >= datetime('now', ?) AND phase='consume' AND consumer_stage IS NOT NULL
       GROUP BY consumer_stage, COALESCE(engine, consumer_type, 'unknown')
    `, since);
    return buildEffectivenessReport({ inventory: { facts, wiki, skills }, consumption, opportunities, days });
  } finally {
    db.close();
  }
}

function render(report) {
  const lines = [
    `MetaMe cognitive effectiveness (${report.days}d): ${report.status}`,
    `assets facts=${report.inventory.facts} wiki=${report.inventory.wiki} skills=${report.inventory.skills}`,
    `funnel delivered=${report.stages.delivered} opened=${report.stages.opened} applied=${report.stages.applied} validated=${report.stages.validated}`,
    `opportunities=${report.opportunities}`,
  ];
  if (report.broken_stage) lines.push(`broken_stage=${report.broken_stage}`);
  if (report.pause_candidates.length > 0) lines.push(`backpressure: pause candidates=${report.pause_candidates.join(',')}`);
  return lines.join('\n');
}

function main(argv = process.argv.slice(2), options = {}) {
  const daysArg = argv.find(arg => /^--days=\d+$/.test(arg));
  const days = daysArg ? Number(daysArg.split('=')[1]) : 30;
  const home = options.home || os.homedir();
  const report = collectReport({
    dbPath: options.dbPath || path.join(home, '.metame', 'memory.db'),
    skillsDir: options.skillsDir || path.join(home, '.claude', 'skills'),
    days,
  });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : render(report));
  process.exitCode = report.status === 'healthy' || report.status === 'empty' ? 0 : 2;
  return report;
}

if (require.main === module) main();

module.exports = { collectReport, main, render };
