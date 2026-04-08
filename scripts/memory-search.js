#!/usr/bin/env node
/**
 * memory-search.js — Cross-session memory recall CLI
 *
 * Usage:
 *   node memory-search.js "<query>"                # hybrid search (QMD + FTS5)
 *   node memory-search.js "<q1>" "<q2>" "<q3>"     # multi-keyword parallel search
 *   node memory-search.js --facts "<query>"         # search facts only
 *   node memory-search.js --sessions "<query>"      # search sessions only
 *   node memory-search.js --recent                  # show recent sessions
 *
 * Multi-keyword: results are deduplicated by fact ID, best rank wins.
 * Async: uses QMD hybrid search (BM25 + vector) when available, falls back to FTS5.
 */

'use strict';

const path = require('path');
const os = require('os');

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
const queries = mode ? args.slice(1) : args;

async function main() {
  try {
    if (mode === '--recent') {
      const rows = memory.recentSessions({ limit: 5 });
      console.log(JSON.stringify(rows.map(r => ({
        type: 'session',
        project: r.project,
        date: r.created_at,
        summary: r.summary,
      })), null, 2));
      return;
    }

    if (!queries.length || !queries[0]) {
      console.log('[]');
      return;
    }

    const useAsync = typeof memory.searchFactsAsync === 'function';

    if (mode === '--facts') {
      const results = await searchMulti(queries, { searchFn: q => useAsync ? memory.searchFactsAsync(q, { limit: 5 }) : memory.searchFacts(q, { limit: 5 }), type: 'fact' });
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (mode === '--sessions') {
      const results = await searchMulti(queries, { searchFn: q => Promise.resolve(memory.searchSessions(q, { limit: 5 })), type: 'session' });
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    // Default: search facts, sessions, and wiki pages in parallel
    const factResults = await searchMulti(queries, {
      searchFn: q => useAsync ? memory.searchFactsAsync(q, { limit: 5 }) : Promise.resolve(memory.searchFacts(q, { limit: 5 })),
      type: 'fact',
      limit: 5,
    });

    const sessionResults = await searchMulti(queries, {
      searchFn: q => Promise.resolve(memory.searchSessions(q, { limit: 3 })),
      type: 'session',
      limit: 3,
    });

    // Wiki pages (if available)
    let wikiResults = [];
    if (typeof memory.searchWikiAndFacts === 'function') {
      try {
        const allWiki = [];
        for (const q of queries) {
          const { wikiPages } = memory.searchWikiAndFacts(q, { trackSearch: true });
          for (const p of (wikiPages || [])) {
            allWiki.push({ type: 'wiki', slug: p.slug, title: p.title, excerpt: p.excerpt, last_built_at: p.last_built_at });
          }
        }
        wikiResults = allWiki.slice(0, 5);
      } catch { /* wiki not available */ }
    }

    console.log(JSON.stringify([...wikiResults, ...factResults, ...sessionResults], null, 2));

  } catch (e) {
    console.log('[]');
  } finally {
    try { memory.close(); } catch {}
  }
}

/**
 * Run multiple queries in parallel, deduplicate and format results.
 */
async function searchMulti(queries, { searchFn, type, limit = 5 }) {
  const allResults = await Promise.all(queries.map(q => searchFn(q).catch(() => [])));

  // Deduplicate by id (facts) or created_at+project (sessions)
  const seen = new Set();
  const merged = [];

  for (const batch of allResults) {
    for (const item of (batch || [])) {
      const key = type === 'fact'
        ? `f:${item.id || item.entity + item.value}`
        : `s:${item.created_at}:${item.project}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(type === 'fact' ? {
          type: 'fact',
          entity: item.entity,
          relation: item.relation,
          value: item.value,
          confidence: item.confidence,
          date: item.created_at,
        } : {
          type: 'session',
          project: item.project,
          date: item.created_at,
          summary: item.summary,
        });
      }
    }
  }

  return merged.slice(0, limit);
}

main();
