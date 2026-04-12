#!/usr/bin/env node
/**
 * memory-search.js — Cross-session memory recall CLI
 *
 * Usage:
 *   node memory-search.js "<query>"                # hybrid search (FTS5 + vector + RRF)
 *   node memory-search.js "<q1>" "<q2>" "<q3>"     # multi-keyword parallel search
 *   node memory-search.js --facts "<query>"         # search facts only
 *   node memory-search.js --sessions "<query>"      # search sessions only
 *   node memory-search.js --fts-only "<query>"      # force pure FTS5 (no vector)
 *   node memory-search.js --recent                  # show recent sessions
 *
 * Multi-keyword: results are deduplicated by fact ID, best rank wins.
 * Hybrid: uses FTS5 + vector embeddings + RRF fusion when available, falls back to FTS5.
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
// Parse flags: allow multiple -- flags before queries
const flags = new Set();
let firstQueryIdx = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { flags.add(args[i]); firstQueryIdx = i + 1; }
  else break;
}
const mode = flags.has('--facts') ? '--facts'
  : flags.has('--sessions') ? '--sessions'
  : flags.has('--recent') ? '--recent'
  : flags.has('--fts-only') ? '--fts-only'
  : null;
const ftsOnly = flags.has('--fts-only');
const queries = args.slice(firstQueryIdx);

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

    // Wiki pages — hybrid search (FTS5 + vector + RRF) when available
    let wikiResults = [];
    const useHybrid = typeof memory.hybridSearchWiki === 'function';
    try {
      const allWiki = [];
      const seen = new Set();
      for (const q of queries) {
        const { wikiPages } = useHybrid
          ? await memory.hybridSearchWiki(q, { ftsOnly, trackSearch: true })
          : (typeof memory.searchWikiAndFacts === 'function'
            ? memory.searchWikiAndFacts(q, { trackSearch: true })
            : { wikiPages: [] });
        for (const p of (wikiPages || [])) {
          if (!seen.has(p.slug)) {
            seen.add(p.slug);
            allWiki.push({
              type: 'wiki',
              slug: p.slug,
              title: p.title,
              excerpt: p.excerpt,
              score: p.score,
              stale: p.stale,
              source: p.source,
            });
          }
        }
      }
      wikiResults = allWiki.slice(0, 5);
    } catch { /* wiki not available */ }

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
