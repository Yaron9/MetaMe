'use strict';

/**
 * scripts/memory-recall.js — assembleRecallContext facade (v4.1 PR1 Step 10).
 *
 * Edge module: orchestrates pure logic from scripts/core/recall-* helpers
 * + memory.js search APIs (Step 6 trackSearch=false). Side effects are
 * limited to read-only DB queries, all going through the existing
 * memory.js handle so we do not open a second connection here.
 *
 * Contract per v4.1 §4 PR1:
 *   await assembleRecallContext({ plan, scope, budget, search })
 *     plan:   from core/recall-plan.js (must have shouldRecall=true to do work)
 *     scope:  { project, workspaceScope, agentKey }
 *     budget: { totalChars=4000, perItem? }
 *     search: { ftsOnly=false, trackSearch=false (forced), preferState='active' }
 *   returns:
 *     {
 *       text,        // recallHint string ('' or '\n\n[Recall context: ...]')
 *       sources,     // flat list [{tier, ...source}]
 *       truncated,   // boolean
 *       breakdown,   // { facts, wiki, working, sessions } char usage
 *       recallMeta,  // for audit / marker — never enters prompt body
 *       wikiDropped, // true if wiki tag-overlap filter dropped the tier
 *     }
 */

const memory = require('./memory');
const { consumeTiers } = require('./core/recall-budget');
const { formatRecallBlock } = require('./core/recall-format');

const DEFAULT_TOTAL_CHARS = 4000;
const MAX_QUERY_ANCHORS = 4;
const FACTS_LIMIT = 12;
const SESSIONS_LIMIT = 8;
const WORKING_MAX_LINES = 6;

function _emptyResult() {
  return {
    text: '',
    sources: [],
    truncated: false,
    breakdown: { facts: 0, wiki: 0, working: 0, sessions: 0 },
    recallMeta: null,
    wikiDropped: false,
  };
}

// Anchor labels are tier-prefixed (e.g. "file:scripts/memory.js" / "fn:saveFacts").
// For search we want only the meaningful tail, joined with spaces.
function _anchorsToQuery(anchors) {
  if (!Array.isArray(anchors)) return '';
  const tails = [];
  for (const a of anchors) {
    if (typeof a !== 'string' || !a) continue;
    const idx = a.indexOf(':');
    const tail = idx >= 0 ? a.slice(idx + 1) : a;
    if (tail) tails.push(tail);
    if (tails.length >= MAX_QUERY_ANCHORS) break;
  }
  return tails.join(' ').trim();
}

function _searchFacts(query, scope) {
  if (!query) return [];
  try {
    const rows = memory.searchFacts(query, {
      limit: FACTS_LIMIT,
      project: scope.project || null,
      scope: scope.workspaceScope || null,
      trackSearch: false,
    });
    return rows.map(r => ({
      text: [r.entity, r.relation, r.value].filter(Boolean).join(' · '),
      source: { kind: 'fact', id: r.id },
    }));
  } catch { return []; }
}

function _searchSessions(query, scope) {
  if (!query) return [];
  try {
    const rows = memory.searchSessions(query, {
      limit: SESSIONS_LIMIT,
      project: scope.project || null,
      scope: scope.workspaceScope || null,
      trackSearch: false,
    });
    return rows.map(r => ({
      text: r.summary || r.keywords || '',
      source: { kind: 'episode', sessionId: r.id },
    }));
  } catch { return []; }
}

function _searchWorking(scope) {
  try {
    const raw = memory.readWorkingMemory(scope.agentKey || null);
    if (!raw) return [];
    return raw.split(/\n{2,}/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, WORKING_MAX_LINES)
      .map(text => ({ text, source: { kind: 'working' } }));
  } catch { return []; }
}

// Wiki has no project/scope columns; filter by topic_tags overlap with
// [project, scope, agentKey] per v4.1 §P1.10. If overlap is empty, the
// caller drops the wiki tier and records wikiDropped:true.
async function _searchWiki(query, scope, search) {
  if (!query) return { items: [], dropped: false };

  let wikiPages = [];
  try {
    const result = await memory.hybridSearchWiki(query, {
      ftsOnly: !!search.ftsOnly,
      trackSearch: false,
    });
    wikiPages = (result && Array.isArray(result.wikiPages)) ? result.wikiPages : [];
  } catch { return { items: [], dropped: false }; }

  if (wikiPages.length === 0) return { items: [], dropped: false };

  const desired = new Set([scope.project, scope.workspaceScope, scope.agentKey].filter(Boolean));

  // No scope to filter by — surface wiki ungated.
  if (desired.size === 0) {
    return {
      items: wikiPages.map(p => ({ text: p.excerpt || p.title, source: { kind: 'wiki', slug: p.slug } })),
      dropped: false,
    };
  }

  const slugs = wikiPages.map(p => p.slug).filter(Boolean);
  const tagsBySlug = memory.getWikiTopicTags(slugs);
  const kept = [];
  for (const page of wikiPages) {
    const tags = tagsBySlug.get(page.slug) || [];
    const overlap = tags.some(t => desired.has(t));
    if (overlap) {
      kept.push({ text: page.excerpt || page.title, source: { kind: 'wiki', slug: page.slug } });
    }
  }
  return { items: kept, dropped: kept.length === 0 };
}

async function assembleRecallContext({ plan, scope = {}, budget = {}, search = {} } = {}) {
  if (!plan || !plan.shouldRecall) return _emptyResult();

  const safeScope = {
    project: scope.project || null,
    workspaceScope: scope.workspaceScope || null,
    agentKey: scope.agentKey || null,
  };
  const totalChars = Number.isFinite(budget.totalChars) ? budget.totalChars : DEFAULT_TOTAL_CHARS;
  const perItem = budget.perItem || undefined;
  // searchFacts/searchSessions internally hard-pin state='active' so we don't
  // expose preferState here. trackSearch is forced false for prompt-bound recall.
  const searchOpts = { ftsOnly: !!search.ftsOnly };

  const query = _anchorsToQuery(plan.anchors);
  const modes = Array.isArray(plan.modes) ? plan.modes : [];

  const items = { facts: [], wiki: [], working: [], sessions: [] };
  let wikiDropped = false;

  if (modes.includes('facts'))    items.facts    = _searchFacts(query, safeScope);
  if (modes.includes('sessions')) items.sessions = _searchSessions(query, safeScope);
  if (modes.includes('working'))  items.working  = _searchWorking(safeScope);
  if (modes.includes('wiki')) {
    const wikiResult = await _searchWiki(query, safeScope, searchOpts);
    items.wiki = wikiResult.items;
    wikiDropped = wikiResult.dropped;
  }

  const allEmpty = Object.values(items).every(arr => arr.length === 0);
  if (allEmpty) {
    return { ..._emptyResult(), wikiDropped };
  }

  const allocated = consumeTiers({ items, totalChars, perItem });
  const formatted = formatRecallBlock(allocated.taken);

  return {
    text: formatted.text,
    sources: formatted.sources,
    truncated: !!allocated.truncated,
    breakdown: {
      facts:    allocated.used.facts || 0,
      wiki:     allocated.used.wiki || 0,
      working:  allocated.used.working || 0,
      sessions: allocated.used.sessions || 0,
    },
    recallMeta: {
      reason: plan.reason,
      anchors: plan.anchors,
      modes,
      hintBudget: plan.hintBudget,
      totalUsed: allocated.totalUsed,
      sources: formatted.sources,
      chars: formatted.chars || 0,
    },
    wikiDropped,
  };
}

module.exports = { assembleRecallContext };
