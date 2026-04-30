'use strict';

/**
 * scripts/core/recall-format.js — pure formatter from consumeTiers result
 * to the recall-block string + sources metadata.
 *
 * Output convention matches intentHint (scripts/daemon-prompt-context.js:95):
 *   - Empty input → empty string ('')
 *   - Non-empty → leading `\n\n` so callers can concatenate without separator
 *     management.
 *
 * Pure: no IO, no DB, no daemon imports. Step 10 facade calls
 * consumeTiers (recall-budget.js), then formatRecallBlock to produce the
 * recallHint string + sources entries for askState.recallMeta.
 */

const TIER_LABELS = {
  facts:    'Facts',
  wiki:     'Wiki',
  working:  'Working memory',
  sessions: 'Past sessions',
};
const TIER_ORDER = ['facts', 'wiki', 'working', 'sessions'];

// Inline newlines in bullet text break the single-line bullet visual.
// Replace with `\n` literal (4 chars) so the bullet stays one line in
// the prompt block. Closing brackets are escaped to keep the outer
// `[Recall context: ... ]` structure parseable by readers.
function _sanitizeText(text) {
  return text.replace(/\r?\n+/g, ' \\n ').replace(/]/g, '\\]');
}

function _renderItem(item) {
  // item: { text, source: { kind?, id?, slug?, sessionId? } | null }
  const text = (typeof item === 'object' && item && typeof item.text === 'string') ? item.text : '';
  if (!text) return '';
  const safe = _sanitizeText(text);
  const src = item.source;
  let label = '';
  if (src && typeof src === 'object') {
    if (src.id)        label = `[ref:${src.id}]`;
    else if (src.slug) label = `[wiki:${src.slug}]`;
    else if (src.sessionId) label = `[session:${src.sessionId}]`;
    else if (src.kind) label = `[${src.kind}]`;
  }
  const bullet = `- ${safe}`;
  return label ? `${bullet} ${label}` : bullet;
}

/**
 * formatRecallBlock(taken)
 *   taken: { facts: [{text,source}...], wiki: [...], working: [...], sessions: [...] }
 *   returns:
 *     {
 *       text:  '' | '\n\n[Recall context:...]'
 *       sources: [{tier, ...source}]    // flat source list for audit / marker
 *       isEmpty: boolean
 *     }
 */
function formatRecallBlock(taken = {}) {
  const sections = [];
  const sources = [];
  for (const tier of TIER_ORDER) {
    const items = Array.isArray(taken[tier]) ? taken[tier] : [];
    if (items.length === 0) continue;
    const lines = [];
    for (const it of items) {
      const rendered = _renderItem(it);
      if (!rendered) continue;
      lines.push(rendered);
      if (it && it.source) sources.push({ tier, ...it.source });
    }
    if (lines.length > 0) {
      sections.push(`${TIER_LABELS[tier]}:\n${lines.join('\n')}`);
    }
  }
  if (sections.length === 0) {
    return { text: '', sources: [], isEmpty: true, chars: 0 };
  }
  const body = sections.join('\n\n');
  const text = `\n\n[Recall context:\n${body}\n]`;
  return {
    text,
    sources,
    isEmpty: false,
    chars: text.length,
  };
}

module.exports = { formatRecallBlock, TIER_LABELS, TIER_ORDER };
