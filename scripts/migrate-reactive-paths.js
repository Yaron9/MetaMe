'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveReactivePaths, resolveLegacyPaths } = require('./core/reactive-paths');

/**
 * Discover all project keys that have legacy reactive files.
 * Scans memory/now/ for *_memory.md, *.md (state), and events/ for *.jsonl.
 *
 * @param {string} metameDir
 * @returns {string[]} unique project keys
 */
function discoverLegacyKeys(metameDir) {
  const keys = new Set();

  // Scan memory/now/ for <key>_memory.md and <key>.md (state files)
  const nowDir = path.join(metameDir, 'memory', 'now');
  if (fs.existsSync(nowDir)) {
    for (const file of fs.readdirSync(nowDir)) {
      if (file === 'shared.md') continue; // skip shared.md
      const memMatch = file.match(/^(.+)_memory\.md$/);
      if (memMatch) { keys.add(memMatch[1]); continue; }
      const l2Match = file.match(/^(.+)_l2cache\.md$/);
      if (l2Match) { keys.add(l2Match[1]); continue; }
      // State files: <key>.md (but not <key>_memory.md or <key>_l2cache.md)
      if (file.endsWith('.md') && !file.endsWith('_memory.md') && !file.endsWith('_l2cache.md')) {
        keys.add(file.replace(/\.md$/, ''));
      }
    }
  }

  // Scan events/ for <key>.jsonl
  const evDir = path.join(metameDir, 'events');
  if (fs.existsSync(evDir)) {
    for (const file of fs.readdirSync(evDir)) {
      if (file.endsWith('.jsonl')) {
        keys.add(file.replace(/\.jsonl$/, ''));
      }
    }
  }

  // Scan memory/agents/ for <key>_latest.md
  const agentsDir = path.join(metameDir, 'memory', 'agents');
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      const latestMatch = file.match(/^(.+)_latest\.md$/);
      if (latestMatch) keys.add(latestMatch[1]);
    }
  }

  return [...keys];
}

/**
 * Migrate legacy flat reactive files to per-project directory structure.
 * Idempotent: skips files that already exist at the destination.
 *
 * @param {string} [metameDir] - defaults to ~/.metame
 * @returns {{ migrated: string[], skipped: string[], errors: string[] }}
 */
function migrate(metameDir) {
  metameDir = metameDir || path.join(os.homedir(), '.metame');
  const report = { migrated: [], skipped: [], errors: [] };

  const keys = discoverLegacyKeys(metameDir);
  if (keys.length === 0) return report;

  for (const key of keys) {
    const legacy = resolveLegacyPaths(key, metameDir);
    const target = resolveReactivePaths(key, metameDir);

    // Create target directory
    fs.mkdirSync(target.dir, { recursive: true });

    const fileMap = [
      { src: legacy.memory, dst: target.memory, label: 'memory' },
      { src: legacy.l2cache, dst: target.l2cache, label: 'l2cache' },
      { src: legacy.state, dst: target.state, label: 'state' },
      { src: legacy.events, dst: target.events, label: 'events' },
      { src: legacy.latest, dst: target.latest, label: 'latest' },
    ];

    for (const { src, dst, label } of fileMap) {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) {
        report.skipped.push(`${key}/${label} (target exists)`);
        continue;
      }
      try {
        fs.copyFileSync(src, dst);
        fs.unlinkSync(src);
        report.migrated.push(`${key}/${label}`);
      } catch (e) {
        report.errors.push(`${key}/${label}: ${e.message}`);
      }
    }
  }

  return report;
}

// CLI mode
if (require.main === module) {
  const metameDir = process.argv[2] || path.join(os.homedir(), '.metame');
  console.log(`Migrating reactive paths in ${metameDir}...`);
  const report = migrate(metameDir);
  console.log(`Migrated: ${report.migrated.length}`);
  for (const m of report.migrated) console.log(`  + ${m}`);
  if (report.skipped.length) {
    console.log(`Skipped: ${report.skipped.length}`);
    for (const s of report.skipped) console.log(`  ~ ${s}`);
  }
  if (report.errors.length) {
    console.log(`Errors: ${report.errors.length}`);
    for (const e of report.errors) console.log(`  ! ${e}`);
    process.exitCode = 1;
  }
}

module.exports = { migrate, discoverLegacyKeys };
