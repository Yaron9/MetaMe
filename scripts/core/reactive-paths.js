'use strict';

const path = require('path');

/**
 * Resolve new per-project reactive file paths.
 *
 * Structure: ~/.metame/reactive/<key>/{memory,l2cache,state,events,latest}.{md,jsonl}
 *
 * @param {string} projectKey
 * @param {string} metameDir - e.g. ~/.metame
 * @returns {{ dir: string, memory: string, l2cache: string, state: string, events: string, latest: string }}
 */
function resolveReactivePaths(projectKey, metameDir) {
  const dir = path.join(metameDir, 'reactive', projectKey);
  return {
    dir,
    memory: path.join(dir, 'memory.md'),
    l2cache: path.join(dir, 'l2cache.md'),
    state: path.join(dir, 'state.md'),
    events: path.join(dir, 'events.jsonl'),
    latest: path.join(dir, 'latest.md'),
  };
}

/**
 * Resolve legacy (pre-migration) flat paths for a project.
 * Used by the migration script to locate old files.
 *
 * @param {string} projectKey
 * @param {string} metameDir
 * @returns {{ memory: string, l2cache: string, state: string, events: string, latest: string }}
 */
function resolveLegacyPaths(projectKey, metameDir) {
  return {
    memory: path.join(metameDir, 'memory', 'now', `${projectKey}_memory.md`),
    l2cache: path.join(metameDir, 'memory', 'now', `${projectKey}_l2cache.md`),
    state: path.join(metameDir, 'memory', 'now', `${projectKey}.md`),
    events: path.join(metameDir, 'events', `${projectKey}.jsonl`),
    latest: path.join(metameDir, 'memory', 'agents', `${projectKey}_latest.md`),
  };
}

module.exports = { resolveReactivePaths, resolveLegacyPaths };
