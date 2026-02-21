#!/usr/bin/env node
/**
 * memory-search.js — Cross-session memory recall CLI
 *
 * Usage:
 *   node memory-search.js "<query>"           # search both sessions and facts
 *   node memory-search.js --facts "<query>"   # search facts only
 *   node memory-search.js --sessions "<query>" # search sessions only
 *   node memory-search.js --recent            # show recent sessions
 *
 * Called by Claude via Bash tool when it needs to recall past knowledge.
 */

'use strict';

const path = require('path');
const os = require('os');

// Support both local dev and installed (~/.metame/) paths
const memoryPath = [
  path.join(os.homedir(), '.metame', 'memory.js'),
  path.join(__dirname, 'memory.js'),
].find(p => { try { require.resolve(p); return true; } catch { return false; } });

if (!memoryPath) {
  console.log('[]');
  process.exit(0);
}

const memory = require(memoryPath);

const args = process.argv.slice(2);
const mode = args[0] && args[0].startsWith('--') ? args[0] : null;
const query = mode ? args[1] : args[0];

try {
  if (mode === '--recent') {
    const rows = memory.recentSessions({ limit: 5 });
    console.log(JSON.stringify(rows.map(r => ({
      type: 'session',
      project: r.project,
      date: r.created_at,
      summary: r.summary,
    })), null, 2));

  } else if (mode === '--facts') {
    if (!query) { console.log('[]'); process.exit(0); }
    const facts = memory.searchFacts(query, { limit: 5 });
    console.log(JSON.stringify(facts.map(f => ({
      type: 'fact',
      entity: f.entity,
      relation: f.relation,
      value: f.value,
      confidence: f.confidence,
      date: f.created_at,
    })), null, 2));

  } else if (mode === '--sessions') {
    if (!query) { console.log('[]'); process.exit(0); }
    const sessions = memory.searchSessions(query, { limit: 5 });
    console.log(JSON.stringify(sessions.map(s => ({
      type: 'session',
      project: s.project,
      date: s.created_at,
      summary: s.summary,
    })), null, 2));

  } else {
    // Default: search both facts and sessions
    if (!query) { console.log('[]'); process.exit(0); }
    const facts = (typeof memory.searchFacts === 'function')
      ? memory.searchFacts(query, { limit: 3 })
      : [];
    const sessions = memory.searchSessions(query, { limit: 3 });

    const results = [
      ...facts.map(f => ({
        type: 'fact',
        entity: f.entity,
        relation: f.relation,
        value: f.value,
        confidence: f.confidence,
        date: f.created_at,
      })),
      ...sessions.map(s => ({
        type: 'session',
        project: s.project,
        date: s.created_at,
        summary: s.summary,
      })),
    ];

    console.log(JSON.stringify(results, null, 2));
  }
} catch (e) {
  console.log('[]');
} finally {
  try { memory.close(); } catch {}
}
