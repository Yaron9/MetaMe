'use strict';

/**
 * wiki-synthesis.js — Evidence synthesis engines for Tier 2 cluster pages
 *
 * Single responsibility: DB queries + pure computation to produce structured
 * intermediate artifacts. Zero LLM calls. All functions are synchronous and
 * take a DatabaseSync instance + array of doc_source ids.
 *
 * Exports:
 *   buildComparisonMatrix(db, docSourceIds) → string (markdown table)
 *   buildTimeline(db, docSourceIds)         → string (markdown list)
 *   detectContradictions(db, docSourceIds)  → object[]
 *   buildCoverageReport(db, docSourceIds)   → string (markdown list)
 */

const EXPECTED_TYPES = ['problem', 'method', 'result', 'dataset', 'limitation'];
const MAX_COLS = 8;       // max papers in comparison table before truncation
const MAX_ROWS = 20;      // max predicate groups in comparison table
const TRUNCATE_TITLE = 28; // char limit for column headers

// ── helpers ───────────────────────────────────────────────────────────────────

function ph(ids) {
  return ids.map(() => '?').join(',');
}

function shortTitle(t, len = TRUNCATE_TITLE) {
  if (!t) return '?';
  return t.length > len ? t.slice(0, len - 1) + '…' : t;
}

// ── buildComparisonMatrix ─────────────────────────────────────────────────────

/**
 * Build a markdown comparison table of results/metrics across papers.
 * Groups by predicate; columns are papers (up to MAX_COLS).
 *
 * @param {object} db - DatabaseSync
 * @param {number[]} docSourceIds
 * @returns {string} markdown table, or empty string if no result facts
 */
function buildComparisonMatrix(db, docSourceIds) {
  if (docSourceIds.length === 0) return '';

  const rows = db.prepare(`
    SELECT pf.predicate, pf.subject, pf.object, pf.value, pf.unit, pf.context,
           ds.id as doc_id, ds.title
    FROM paper_facts pf
    JOIN doc_sources ds ON ds.id = pf.doc_source_id
    WHERE pf.doc_source_id IN (${ph(docSourceIds)})
      AND pf.fact_type IN ('result','metric','baseline')
      AND pf.predicate IS NOT NULL
    ORDER BY pf.predicate, ds.id
  `).all(...docSourceIds);

  if (rows.length === 0) return '';

  // Collect ordered unique papers (cap at MAX_COLS)
  const paperOrder = [];
  const paperTitles = {};
  for (const r of rows) {
    if (!paperTitles[r.doc_id]) {
      paperOrder.push(r.doc_id);
      paperTitles[r.doc_id] = r.title;
    }
  }
  const papers = paperOrder.slice(0, MAX_COLS);

  // Group by predicate → { docId → cell text }
  const groups = {};
  for (const r of rows) {
    if (!papers.includes(r.doc_id)) continue;
    const key = r.predicate;
    if (!groups[key]) groups[key] = {};
    const parts = [r.subject, r.object].filter(Boolean);
    if (r.value) parts.push(r.value + (r.unit ? ' ' + r.unit : ''));
    if (r.context) parts.push(`*(${r.context})*`);
    // Keep first occurrence per (predicate, docId)
    if (!groups[key][r.doc_id]) groups[key][r.doc_id] = parts.join(' — ');
  }

  const predicates = Object.keys(groups).slice(0, MAX_ROWS);
  if (predicates.length === 0) return '';

  // Build table
  const header = ['Metric / Result', ...papers.map(id => shortTitle(paperTitles[id]))];
  const separator = header.map(() => '---');
  const tableRows = predicates.map(pred => {
    const cells = papers.map(id => groups[pred][id] || '—');
    return [pred, ...cells];
  });

  const fmt = (row) => '| ' + row.join(' | ') + ' |';
  return [fmt(header), fmt(separator), ...tableRows.map(fmt)].join('\n');
}

// ── buildTimeline ─────────────────────────────────────────────────────────────

/**
 * Build a chronological timeline of core method contributions per paper.
 *
 * @param {object} db
 * @param {number[]} docSourceIds
 * @returns {string} markdown list
 */
function buildTimeline(db, docSourceIds) {
  if (docSourceIds.length === 0) return '';

  // Get top method/claim fact per paper (by confidence desc)
  const rows = db.prepare(`
    SELECT ds.year, ds.title, ds.slug, ds.id as doc_id,
           pf.subject, pf.predicate, pf.object, pf.evidence_text, pf.confidence
    FROM doc_sources ds
    LEFT JOIN paper_facts pf ON pf.doc_source_id = ds.id
      AND pf.fact_type IN ('method','claim')
    WHERE ds.id IN (${ph(docSourceIds)})
    ORDER BY ds.year ASC NULLS LAST, ds.id ASC, pf.confidence DESC
  `).all(...docSourceIds);

  if (rows.length === 0) return '';

  // Deduplicate: one entry per doc (keep first = highest confidence)
  const seen = new Set();
  const entries = [];
  for (const r of rows) {
    if (seen.has(r.doc_id)) continue;
    seen.add(r.doc_id);
    entries.push(r);
  }

  return entries.map(r => {
    const year = r.year ? `**${r.year}**` : '**year unknown**';
    const slug  = r.slug ? `[[${r.slug}]]` : shortTitle(r.title);
    let claim = '';
    if (r.subject && r.predicate && r.object) {
      claim = ` — ${r.subject} ${r.predicate} ${r.object}`;
    } else if (r.evidence_text) {
      claim = ` — "${r.evidence_text.slice(0, 120)}"`;
    }
    return `- ${year} ${slug}${claim}`;
  }).join('\n');
}

// ── detectContradictions ──────────────────────────────────────────────────────

/**
 * Detect fact pairs where same (subject, predicate) yields different objects
 * across different papers.
 *
 * @param {object} db
 * @param {number[]} docSourceIds
 * @returns {{ slugA, titleA, factA, slugB, titleB, factB }[]}
 */
function detectContradictions(db, docSourceIds) {
  if (docSourceIds.length < 2) return [];

  const rows = db.prepare(`
    SELECT
      a.id as id_a, a.subject, a.predicate, a.object as object_a,
      a.evidence_text as ev_a, a.confidence as conf_a,
      b.id as id_b, b.object as object_b,
      b.evidence_text as ev_b, b.confidence as conf_b,
      ds_a.slug as slug_a, ds_a.title as title_a,
      ds_b.slug as slug_b, ds_b.title as title_b
    FROM paper_facts a
    JOIN paper_facts b ON (
      a.subject IS NOT NULL AND a.subject = b.subject AND
      a.predicate IS NOT NULL AND a.predicate = b.predicate AND
      a.object IS NOT NULL AND b.object IS NOT NULL AND
      a.object != b.object AND
      a.doc_source_id < b.doc_source_id
    )
    JOIN doc_sources ds_a ON ds_a.id = a.doc_source_id
    JOIN doc_sources ds_b ON ds_b.id = b.doc_source_id
    WHERE a.doc_source_id IN (${ph(docSourceIds)})
      AND b.doc_source_id IN (${ph(docSourceIds)})
      AND a.fact_type IN ('result','claim','metric')
      AND b.fact_type IN ('result','claim','metric')
    LIMIT 20
  `).all(...docSourceIds, ...docSourceIds);

  return rows.map(r => ({
    slugA: r.slug_a, titleA: r.title_a,
    factA: { subject: r.subject, predicate: r.predicate, object: r.object_a, evidence: r.ev_a },
    slugB: r.slug_b, titleB: r.title_b,
    factB: { subject: r.subject, predicate: r.predicate, object: r.object_b, evidence: r.ev_b },
  }));
}

// ── buildCoverageReport ───────────────────────────────────────────────────────

/**
 * Report which fact types are covered per paper, highlighting gaps.
 *
 * @param {object} db
 * @param {number[]} docSourceIds
 * @returns {string} markdown list
 */
function buildCoverageReport(db, docSourceIds) {
  if (docSourceIds.length === 0) return '';

  const rows = db.prepare(`
    SELECT ds.id, ds.title, ds.slug,
           GROUP_CONCAT(DISTINCT pf.fact_type) as covered_types
    FROM doc_sources ds
    LEFT JOIN paper_facts pf ON pf.doc_source_id = ds.id
    WHERE ds.id IN (${ph(docSourceIds)})
    GROUP BY ds.id
    ORDER BY ds.id
  `).all(...docSourceIds);

  const lines = rows.map(r => {
    const covered = new Set((r.covered_types || '').split(',').filter(Boolean));
    const missing = EXPECTED_TYPES.filter(t => !covered.has(t));
    const covStr  = EXPECTED_TYPES.map(t => covered.has(t) ? `✓${t}` : `✗${t}`).join(' ');
    const gapNote = missing.length ? ` — **gaps: ${missing.join(', ')}**` : ' — complete';
    return `- [[${r.slug || '?'}]] ${covStr}${gapNote}`;
  });

  return lines.join('\n');
}

module.exports = { buildComparisonMatrix, buildTimeline, detectContradictions, buildCoverageReport };
