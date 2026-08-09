'use strict';

const DEFAULT_MAX_CHARS = 4000;
const DEFAULT_ITEM_CHARS = 700;

function cleanText(value) {
  return String(value || '')
    .replace(/<\/?b>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function boundedText(value, maxChars = DEFAULT_ITEM_CHARS) {
  const text = cleanText(value);
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeKey(value) {
  return cleanText(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function factResult(row) {
  return {
    type: 'fact',
    id: String(row.id),
    canonical_id: row.provenance_root_id || String(row.id),
    title: cleanText(row.title) || String(row.id),
    summary: boundedText(row.summary || row.excerpt || row.content),
    project: row.project || '*',
    scope: row.scope || null,
    confidence: Number.isFinite(row.confidence) ? row.confidence : null,
    freshness: 'current',
    provenance: [row.provenance_root_id || row.source_id].filter(Boolean),
    score: Number.isFinite(row.score) ? row.score : null,
    updated_at: row.updated_at || null,
  };
}

function factIdentity(row) {
  return [row.title, row.project || '*', row.scope || '', row.relation || '']
    .map(normalizeKey)
    .join('|');
}

function coherentFacts(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = factIdentity(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const kept = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    const values = new Set(group.map(row => normalizeKey(row.content || row.summary || row.excerpt)));
    if (values.size === 1) {
      kept.push(group.slice().sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0]);
    }
    // Different active values for one identity are unresolved. Fail closed:
    // none is safe to inject until the existing conflict resolver archives one.
  }
  return kept;
}

function wikiResult(row) {
  const stale = row.stale === true || Number(row.staleness || 0) >= 0.3;
  return {
    type: 'wiki',
    id: String(row.slug),
    canonical_id: String(row.slug),
    title: cleanText(row.title) || String(row.slug),
    summary: boundedText(row.excerpt),
    project: row.project_key || '*',
    scope: row.project_key || null,
    confidence: null,
    freshness: stale ? 'stale' : 'current',
    provenance: Array.isArray(row.provenance) ? row.provenance.slice(0, 10) : [],
    score: Number.isFinite(row.score) ? row.score : null,
    updated_at: row.updated_at || null,
    page_kind: row.page_kind || 'topic_hub',
  };
}

function dedupeResults(results) {
  const seenIds = new Set();
  const seenContent = new Set();
  const kept = [];
  for (const result of results) {
    const idKey = `${result.type}:${result.id}`;
    const contentKey = normalizeKey(`${result.title} ${result.summary}`);
    if (seenIds.has(idKey) || (contentKey && seenContent.has(contentKey))) continue;
    seenIds.add(idKey);
    if (contentKey) seenContent.add(contentKey);
    kept.push(result);
  }
  return kept;
}

function allocateResults(results, { limit = 5, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), 20);
  const safeBudget = Math.min(Math.max(Number(maxChars) || DEFAULT_MAX_CHARS, 256), 12000);
  const selected = [];
  let usedChars = 0;
  for (const result of results) {
    if (selected.length >= safeLimit) break;
    const serializedChars = JSON.stringify(result).length;
    if (selected.length > 0 && usedChars + serializedChars > safeBudget) break;
    if (selected.length === 0 && serializedChars > safeBudget) {
      const room = Math.max(40, safeBudget - (serializedChars - result.summary.length));
      selected.push({ ...result, summary: boundedText(result.summary, room) });
      usedChars = JSON.stringify(selected[0]).length;
      break;
    }
    selected.push(result);
    usedChars += serializedChars;
  }
  return { results: selected, usedChars, truncated: selected.length < results.length };
}

function assembleSearchResults(searchResult = {}, options = {}) {
  const factRows = Array.isArray(searchResult.facts) ? coherentFacts(searchResult.facts) : [];
  const facts = factRows.map(factResult);
  const wiki = Array.isArray(searchResult.wikiPages)
    ? searchResult.wikiPages.filter(page => !page.stale).map(wikiResult)
    : [];
  const candidates = dedupeResults([...facts, ...wiki]);
  const allocated = allocateResults(candidates, options);
  return { ...allocated, total_candidates: candidates.length };
}

function scopeKeys(project) {
  const key = String(project || '').normalize('NFKC').trim().toLowerCase();
  return key ? [key] : [];
}

module.exports = {
  assembleSearchResults,
  scopeKeys,
  _internal: { allocateResults, boundedText, cleanText, coherentFacts, dedupeResults, factIdentity, factResult, normalizeKey, wikiResult },
};
