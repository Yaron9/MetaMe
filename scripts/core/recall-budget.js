'use strict';

/**
 * scripts/core/recall-budget.js — pure single-pass spillover allocator.
 *
 * v4.1 §P1.5 algorithm:
 *   tiers consume in order facts → wiki → working → sessions
 *   each tier has a base reserve (50/30/10/10 of totalBudget)
 *   facts consume from facts.reserve only; the unused remainder enters
 *   spilloverPool which lower tiers may draw from in order
 *   per-item caps are absolute; over-cap items get truncated with a suffix
 *   facts NEVER yield reserve to other tiers (consume runs first)
 *
 * Initial weights are conservative; tune after recall_audit data
 * accumulates over 4 weeks (v4.1 §P1.5 note).
 */

const RESERVE_RATIOS = { facts: 0.50, wiki: 0.30, working: 0.10, sessions: 0.10 };

const PER_ITEM_DEFAULTS = {
  fact:    { maxChars: 300, maxItems: 8 },
  wiki:    { maxChars: 500, maxItems: 3 },
  working: { maxChars: 400, maxItems: 2 },
  session: { maxChars: 200, maxItems: 5 },
};

const TRUNC_SUFFIX = '…[truncated]';

const TIER_TO_PER_ITEM = { facts: 'fact', wiki: 'wiki', working: 'working', sessions: 'session' };

function _truncate(text, maxChars) {
  if (typeof text !== 'string') return '';
  if (text.length <= maxChars) return text;
  // Reserve room for the suffix so the final string fits within maxChars.
  const head = Math.max(0, maxChars - TRUNC_SUFFIX.length);
  return text.slice(0, head) + TRUNC_SUFFIX;
}

/**
 * allocateBudget(totalChars) — returns the static reserve+per-item shape
 * for snapshot inspection / testing. Spillover decisions happen in
 * consumeTiers below.
 */
function allocateBudget(totalChars = 4000) {
  // 0 is a valid "no budget" input; only null/undefined/NaN/negative fall back.
  const t = Number.isFinite(totalChars) && totalChars >= 0 ? Math.floor(totalChars) : 4000;
  return {
    total: t,
    reserves: {
      facts:    Math.floor(t * RESERVE_RATIOS.facts),
      wiki:     Math.floor(t * RESERVE_RATIOS.wiki),
      working:  Math.floor(t * RESERVE_RATIOS.working),
      sessions: Math.floor(t * RESERVE_RATIOS.sessions),
    },
    perItem: { ...PER_ITEM_DEFAULTS },
    truncationSuffix: TRUNC_SUFFIX,
  };
}

/**
 * consumeTier(items, allowance, perItemSpec)
 *   pure — deterministic. Greedily takes items in input order, applying
 *   per-item char cap and per-tier item cap, until the tier's allowance
 *   is exhausted. Returns { taken, used, dropped }.
 *
 *   - taken: array of {text} in original order, possibly truncated
 *   - used: total chars consumed from allowance
 *   - dropped: count of items skipped due to allowance exhaustion (not
 *              counted: items skipped by maxItems)
 */
function consumeTier(items, allowance, perItemSpec) {
  const taken = [];
  let used = 0;
  let dropped = 0;
  if (!Array.isArray(items) || items.length === 0 || allowance <= 0) {
    return { taken, used, dropped };
  }
  const { maxChars, maxItems } = perItemSpec;
  for (const raw of items) {
    if (taken.length >= maxItems) break;
    const text = typeof raw === 'string' ? raw : (raw && typeof raw.text === 'string' ? raw.text : '');
    if (!text) continue;
    const capped = _truncate(text, maxChars);
    if (used + capped.length > allowance) { dropped++; continue; }
    taken.push({ text: capped, source: raw && raw.source != null ? raw.source : null });
    used += capped.length;
  }
  return { taken, used, dropped };
}

/**
 * consumeTiers({ items, totalChars, perItem? })
 *   items: { facts: [], wiki: [], working: [], sessions: [] }
 *   Each entry is either a string or { text, source }.
 *
 *   Returns:
 *     {
 *       taken: { facts, wiki, working, sessions } each an array of {text, source}
 *       used:  { facts, wiki, working, sessions } chars consumed per tier
 *       totalUsed,
 *       dropped: count of items dropped due to budget (not item cap)
 *       truncated: boolean — true if any item or any tier hit its cap
 *     }
 */
function consumeTiers({ items = {}, totalChars = 4000, perItem } = {}) {
  const budget = allocateBudget(totalChars);
  const cap = perItem ? { ...PER_ITEM_DEFAULTS, ...perItem } : PER_ITEM_DEFAULTS;

  const order = ['facts', 'wiki', 'working', 'sessions'];
  let spillover = 0;
  const taken = {};
  const used = {};
  let totalUsed = 0;
  let dropped = 0;
  let truncated = false;

  for (const tier of order) {
    const allowance = (budget.reserves[tier] || 0) + spillover;
    const itemSpec = cap[TIER_TO_PER_ITEM[tier]];
    const tierItems = Array.isArray(items[tier]) ? items[tier] : [];
    const result = consumeTier(tierItems, allowance, itemSpec);
    taken[tier] = result.taken;
    used[tier] = result.used;
    totalUsed += result.used;
    dropped += result.dropped;
    if (result.dropped > 0) truncated = true;
    if (result.taken.some(t => t.text.endsWith(TRUNC_SUFFIX))) truncated = true;
    if (tierItems.length > result.taken.length + result.dropped) truncated = true;
    spillover = allowance - result.used;
  }

  return { taken, used, totalUsed, dropped, truncated, budget };
}

module.exports = {
  allocateBudget,
  consumeTier,
  consumeTiers,
  RESERVE_RATIOS,
  PER_ITEM_DEFAULTS,
  TRUNC_SUFFIX,
};
