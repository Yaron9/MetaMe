'use strict';

const KIND_WEIGHTS = { convention: 1.0, insight: 0.8, profile: 0.7, episode: 0.4 };
const DEFAULT_BUDGET = { convention: 8, insight: 8, profile: 6, episode: 3 };
const RECENCY_HALF_LIFE_DAYS = 30;
const LN2 = Math.LN2;
const MS_PER_DAY = 86400000;

/** @param {{ project, scope, task, session, agent }} itemScope */
/** @param {{ project, scope, task, session, agent }} queryScope */
/** @returns {number} 0-1 */
function matchScope(itemScope, queryScope) {
  if (!itemScope || !queryScope) return 0;
  const ip = itemScope.project || '*';
  const qp = queryScope.project || '*';
  if (ip === '*' || qp === '*') return 0.3;
  if (ip !== qp) return 0;
  const sameScope = (itemScope.scope || '') === (queryScope.scope || '');
  const sameAgent = (itemScope.agent || '') === (queryScope.agent || '');
  if (sameScope && sameAgent) return 1.0;
  return 0.6;
}

function recencyScore(createdAt, now) {
  if (!createdAt) return 0;
  const created = typeof createdAt === 'number' ? createdAt : new Date(createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  const ageDays = Math.max(0, (now - created) / MS_PER_DAY);
  return Math.exp(-LN2 * ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** @param {{ kind, state, confidence, created_at, project, scope, agent_key, fts_rank }} item */
/** @param {string} query */
/** @param {{ project, scope, task, session, agent }} scopeContext */
/** @returns {number} */
function scoreMemoryItem(item, query, scopeContext) {
  const scopeMatch = matchScope(
    { project: item.project, scope: item.scope, agent: item.agent_key },
    scopeContext,
  );
  const kindWeight = KIND_WEIGHTS[item.kind] || 0;
  const textRelevance = (typeof item.fts_rank === 'number' && Number.isFinite(item.fts_rank))
    ? Math.max(0, Math.min(1, item.fts_rank))
    : 0;
  const confidence = (typeof item.confidence === 'number' && Number.isFinite(item.confidence))
    ? Math.max(0, Math.min(1, item.confidence))
    : 0;
  const recency = recencyScore(item.created_at, Date.now());

  return scopeMatch * 4 + kindWeight * 3 + textRelevance * 2 + confidence * 1 + recency * 1;
}

/** @param {Array} items */
/** @param {string} query */
/** @param {{ project, scope, task, session, agent }} scopeContext */
/** @returns {Array} sorted descending by score, each item gets .score */
function rankMemoryItems(items, query, scopeContext) {
  const scored = items.map(item => {
    const score = scoreMemoryItem(item, query, scopeContext);
    return Object.assign({}, item, { score });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** @param {Array} rankedItems */
/** @param {{ convention?: number, insight?: number, profile?: number, episode?: number }} [budgetConfig] */
/** @returns {{ convention: Array, insight: Array, profile: Array, episode: Array }} */
function allocateBudget(rankedItems, budgetConfig) {
  const limits = Object.assign({}, DEFAULT_BUDGET, budgetConfig);
  const result = { convention: [], insight: [], profile: [], episode: [] };
  for (const item of rankedItems) {
    if (item.state !== 'active') continue;
    const bucket = result[item.kind];
    if (!bucket) continue;
    const limit = limits[item.kind] || 0;
    if (bucket.length < limit) bucket.push(item);
  }
  return result;
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    try { const parsed = JSON.parse(tags); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}

function isProtected(item) {
  if (item.source_type === 'manual') return true;
  if (parseTags(item.tags).includes('protected')) return true;
  if (item.kind === 'profile' && typeof item.confidence === 'number' && item.confidence >= 0.9) return true;
  return false;
}

function contentEqual(a, b) {
  return a.content === b.content && a.title === b.title;
}

function sameTitleOrEntity(a, b) {
  if (a.title && b.title && a.title === b.title) return true;
  if (a.entity && b.entity && a.entity === b.entity) return true;
  return false;
}

/** @param {object} candidate */
/** @param {Array} existingItems */
/** @returns {{ action: string, targetId?: * }} */
function judgeMerge(candidate, existingItems) {
  for (const existing of existingItems) {
    if (contentEqual(candidate, existing)) return { action: 'noop' };
  }
  for (const existing of existingItems) {
    if (sameTitleOrEntity(candidate, existing)) {
      if (isProtected(existing)) return { action: 'reject' };
      return { action: 'supersede', targetId: existing.id };
    }
  }
  return { action: 'promote' };
}

function truncate(str, max) {
  if (!str || str.length <= max) return str || '';
  return str.slice(0, max - 3) + '...';
}

/** @param {{ convention: Array, insight: Array, profile: Array, episode: Array }} allocated */
/** @returns {{ conventions: string, insights: string, profile: string, episodes: string }} */
function assemblePromptBlocks(allocated) {
  function formatBucket(items) {
    return items.map(item => {
      const title = item.title || '';
      const content = truncate(item.content || '', 200);
      return title ? `- [${title}]: ${content}` : `- ${content}`;
    }).join('\n');
  }
  return {
    conventions: formatBucket(allocated.convention || []),
    insights: formatBucket(allocated.insight || []),
    profile: formatBucket(allocated.profile || []),
    episodes: formatBucket(allocated.episode || []),
  };
}

/** @param {object} item */
/** @returns {boolean} */
function shouldPromote(item) {
  if (typeof item.search_count !== 'number' || item.search_count < 3) return false;
  if (!item.last_searched_at) return false;
  const searched = new Date(item.last_searched_at).getTime();
  if (Number.isNaN(searched)) return false;
  const sevenDaysAgo = Date.now() - 7 * MS_PER_DAY;
  return searched >= sevenDaysAgo;
}

/** @param {object} item */
/** @returns {boolean} */
function shouldArchive(item) {
  if (isProtected(item)) return false;
  const now = Date.now();
  const created = new Date(item.created_at).getTime();
  if (Number.isNaN(created)) return false;
  const ageDays = (now - created) / MS_PER_DAY;
  const neverSearched = !item.search_count || item.search_count === 0;
  const lastSearched = item.last_searched_at ? new Date(item.last_searched_at).getTime() : 0;
  const notSearchedRecently = !lastSearched || (now - lastSearched) / MS_PER_DAY > 30;

  if (item.state === 'candidate' && ageDays >= 30 && neverSearched) return true;
  if (item.state === 'active' && ageDays >= 90
    && typeof item.confidence === 'number' && item.confidence < 0.6
    && notSearchedRecently) return true;
  return false;
}

module.exports = {
  KIND_WEIGHTS,
  DEFAULT_BUDGET,
  RECENCY_HALF_LIFE_DAYS,
  matchScope,
  scoreMemoryItem,
  rankMemoryItems,
  allocateBudget,
  judgeMerge,
  assemblePromptBlocks,
  shouldPromote,
  shouldArchive,
  _internal: { isProtected, recencyScore, truncate },
};
