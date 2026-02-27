#!/usr/bin/env node

/**
 * memory-index.js — Auto-generate INDEX.md for ~/.metame/memory/
 *
 * Lists all .md files under ~/.metame/memory/ recursively and writes
 * a structured INDEX.md at the root of that directory.
 * Serves as an L1 pointer document for context injection.
 *
 * Designed to run nightly at 01:30 via daemon.yaml scheduler.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MEMORY_DIR = path.join(os.homedir(), '.metame', 'memory');
const INDEX_FILE = path.join(MEMORY_DIR, 'INDEX.md');

/**
 * Recursively list all .md files under dir, excluding INDEX.md itself.
 * Returns relative paths (relative to MEMORY_DIR), sorted alphabetically.
 *
 * @param {string} dir - absolute directory to scan
 * @param {string} base - relative prefix to prepend (used in recursion)
 * @returns {string[]} sorted relative paths
 */
function listFiles(dir, base = '') {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results = results.concat(listFiles(path.join(dir, entry.name), relPath));
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
      results.push(relPath);
    }
  }

  return results.sort();
}

/**
 * Group files by their top-level subdirectory (or root).
 * @param {string[]} files - relative paths
 * @returns {Map<string, string[]>}
 */
function groupByDir(files) {
  const groups = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const dir = parts.length > 1 ? parts[0] : '(root)';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return groups;
}

/**
 * Main: scan memory dir and write INDEX.md.
 */
function run() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });

  const files = listFiles(MEMORY_DIR);
  const groups = groupByDir(files);

  const lines = [
    '# Memory Index',
    '',
    `_Updated: ${new Date().toISOString()}_`,
    `_Total files: ${files.length}_`,
    '',
  ];

  if (files.length === 0) {
    lines.push('_(no memory files yet)_');
  } else {
    for (const [dir, dirFiles] of groups) {
      lines.push(`## ${dir}`);
      lines.push('');
      for (const f of dirFiles) {
        lines.push(`- [${path.basename(f, '.md')}](./${f})`);
      }
      lines.push('');
    }
  }

  fs.writeFileSync(INDEX_FILE, lines.join('\n') + '\n', 'utf8');
  console.log(`[MEMORY-INDEX] Updated INDEX.md (${files.length} file(s)) → ${INDEX_FILE}`);
}

if (require.main === module) {
  run();
}
