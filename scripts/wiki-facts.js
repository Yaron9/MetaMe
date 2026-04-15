'use strict';

/**
 * wiki-facts.js — Paper fact extraction, persistence, and entity registration
 *
 * Single responsibility: turn structured paper sections into atomic facts
 * stored in paper_facts + research_entities tables.
 *
 * Exports:
 *   extractPaperFacts(db, docSource, sections, providers, opts)
 *     → Promise<fact[]>   all facts written to DB for this doc
 *
 *   writeFacts(db, docSourceId, facts)
 *     → void   idempotent batch INSERT (conflict ignore by id)
 *
 *   registerEntities(db, facts)
 *     → void   INSERT OR IGNORE entities inferred from subject/object fields
 *
 *   buildTier1Prompt(title, facts)
 *     → string   LLM prompt for Tier 1 wiki page generation
 */

const crypto = require('node:crypto');

// ── Concurrency helper ────────────────────────────────────────────────────────
// Hand-written semaphore — no external dependencies.
async function withConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++;
      try {
        results[idx] = await tasks[idx]();
      } catch (err) {
        results[idx] = { error: err.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── Section → LLM prompt ──────────────────────────────────────────────────────
const FACT_TYPES = [
  'problem', 'method', 'claim', 'assumption',
  'dataset', 'metric', 'result', 'baseline',
  'limitation', 'future_work', 'contradiction_note',
];

function buildSectionFactPrompt(sectionName, sectionText, paperTitle) {
  const truncated = sectionText.length > 4000
    ? sectionText.slice(0, 4000) + '\n[...truncated]'
    : sectionText;

  return `You are extracting structured facts from a section of an academic paper.

Paper title: ${paperTitle}
Section: ${sectionName}

Section text:
${truncated}

Extract all atomic, verifiable facts from this section. For each fact output a JSON object with these fields:
- fact_type: one of ${FACT_TYPES.join(', ')}
- subject: the primary entity (model name, method name, system name, etc.)
- predicate: a short verb phrase (achieves, outperforms, requires, assumes, proposes, uses, ...)
- object: what the subject does/has/achieves (metric value, baseline name, dataset name, ...)
- value: numeric value if any (e.g. "0.87")
- unit: unit if any (e.g. "%", "ms", "F1")
- context: conditions under which this holds (e.g. "on FORCE 2020 dataset", "with 5-fold CV")
- evidence_text: exact quote from the section (≤400 characters) that supports this fact
- confidence: 0.0–1.0 reflecting how clearly stated this fact is

Return ONLY a valid JSON array of fact objects. No explanation, no markdown. Empty array [] if no facts found.`;
}

// ── LLM response parser ───────────────────────────────────────────────────────
function parseFacts(raw, sectionName) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  // Strip possible markdown code fences
  const jsonStr = trimmed.startsWith('```')
    ? trimmed.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '')
    : trimmed;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(f => f && typeof f === 'object' && f.fact_type && f.evidence_text)
      .map(f => ({
        fact_type:         String(f.fact_type || 'claim'),
        subject:           f.subject   ? String(f.subject).slice(0, 200)   : null,
        predicate:         f.predicate ? String(f.predicate).slice(0, 100) : null,
        object:            f.object    ? String(f.object).slice(0, 300)    : null,
        value:             f.value     ? String(f.value).slice(0, 50)      : null,
        unit:              f.unit      ? String(f.unit).slice(0, 20)       : null,
        context:           f.context   ? String(f.context).slice(0, 300)   : null,
        evidence_text:     String(f.evidence_text || '').slice(0, 400),
        section:           sectionName,
        confidence:        typeof f.confidence === 'number'
                             ? Math.min(1, Math.max(0, f.confidence))
                             : 0.7,
      }));
  } catch {
    return [];
  }
}

// ── DB write helpers ──────────────────────────────────────────────────────────

// Valid fact_type values matching the paper_facts CHECK constraint
const VALID_FACT_TYPES = new Set([
  'problem','method','claim','assumption',
  'dataset','metric','result','baseline',
  'limitation','future_work','contradiction_note',
]);

/**
 * Idempotent batch insert of facts into paper_facts.
 *
 * Deduplication: ID is a deterministic sha256 of (doc_source_id, evidence_text, section)
 * so INSERT OR IGNORE correctly skips duplicates on re-run.
 *
 * fact_type is validated against the schema CHECK enum before insert;
 * invalid values fall back to 'claim' to avoid crashing the batch transaction.
 */
function writeFacts(db, docSourceId, facts) {
  if (facts.length === 0) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO paper_facts
      (id, doc_source_id, fact_type, subject, predicate, object,
       value, unit, context, evidence_text, section,
       extraction_source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pdf_llm_section', ?)
  `);
  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  tx.run();
  try {
    for (const f of facts) {
      // FLAG-7 fix: validate fact_type against enum, fallback to 'claim'
      const factType = VALID_FACT_TYPES.has(f.fact_type) ? f.fact_type : 'claim';
      // FLAG-8 fix: deterministic ID — sha256 of (docSourceId, section, evidence_text)
      const idSeed = `${docSourceId}:${f.section || ''}:${f.evidence_text || ''}`;
      const id = 'pf_' + crypto.createHash('sha256').update(idSeed).digest('hex').slice(0, 16);
      insert.run(
        id, docSourceId, factType,
        f.subject, f.predicate, f.object,
        f.value, f.unit, f.context,
        f.evidence_text, f.section, f.confidence,
      );
    }
    commit.run();
  } catch (err) {
    try { rollback.run(); } catch { /* ignore */ }
    throw err;
  }
}

// Simple entity_type inference from fact fields
const ENTITY_HINTS = {
  dataset:     /\b(dataset|corpus|benchmark|collection)\b/i,
  metric:      /\b(accuracy|f1|precision|recall|auc|mse|rmse|bleu|rouge|map|ndcg)\b/i,
  method_family: /\b(transformer|cnn|rnn|lstm|gru|bert|gpt|attention|svm|xgboost|random.?forest)\b/i,
  problem:     /\b(classification|regression|detection|segmentation|prediction|recognition)\b/i,
};

function inferEntityType(text) {
  if (!text) return 'concept';
  for (const [type, re] of Object.entries(ENTITY_HINTS)) {
    if (re.test(text)) return type;
  }
  return 'concept';
}

/**
 * Register unique entities inferred from subject/object fields.
 * INSERT OR IGNORE — safe to call multiple times.
 */
function registerEntities(db, facts) {
  const seen = new Set();
  const candidates = [];
  for (const f of facts) {
    for (const field of [f.subject, f.object]) {
      if (field && field.length >= 2 && field.length <= 100 && !seen.has(field)) {
        seen.add(field);
        candidates.push(field);
      }
    }
  }
  if (candidates.length === 0) return;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO research_entities (id, entity_type, name)
    VALUES (?, ?, ?)
  `);
  const tx = db.prepare('BEGIN');
  const commit = db.prepare('COMMIT');
  const rollback = db.prepare('ROLLBACK');
  tx.run();
  try {
    for (const name of candidates) {
      const id = 'ent_' + crypto.randomBytes(6).toString('hex');
      const entity_type = inferEntityType(name);
      insert.run(id, entity_type, name);
    }
    commit.run();
  } catch (err) {
    try { rollback.run(); } catch { /* ignore */ }
    throw err;
  }
}

// ── Main extraction entry point ───────────────────────────────────────────────

/**
 * Extract structured facts from paper sections using per-section LLM calls.
 * Writes results to paper_facts and research_entities tables.
 *
 * @param {object} db - DatabaseSync instance
 * @param {{ id: number, title: string, slug: string }} docSource
 * @param {{ abstract, introduction, method, experiments, results,
 *           discussion, conclusion, _fallback: boolean }} sections
 * @param {{ callHaiku: Function, buildDistillEnv: Function }} providers
 * @param {{ concurrency?: number }} opts
 * @returns {Promise<object[]>} all facts written to DB
 */
async function extractPaperFacts(db, docSource, sections, providers, { concurrency = 3 } = {}) {
  const { callHaiku, buildDistillEnv } = providers;
  const title = docSource.title || docSource.slug;

  // Build one task per non-empty section (skip references, skip tiny sections)
  const SKIP_SECTIONS = new Set(['references', '_fallback']);
  const MIN_SECTION_LEN = 100;

  const tasks = Object.entries(sections)
    .filter(([key, text]) =>
      !SKIP_SECTIONS.has(key) &&
      typeof text === 'string' &&
      text.trim().length >= MIN_SECTION_LEN
    )
    .map(([sectionName, sectionText]) => async () => {
      const prompt = buildSectionFactPrompt(sectionName, sectionText, title);
      let raw;
      try {
        const env = buildDistillEnv();
        raw = await callHaiku(prompt, env, 60000, { model: 'sonnet' });
      } catch {
        return [];
      }
      return parseFacts(raw, sectionName);
    });

  if (tasks.length === 0) return [];

  // Run with concurrency limit — LLM calls are all OUTSIDE any DB transaction
  const sectionResults = await withConcurrency(tasks, concurrency);
  const allFacts = sectionResults.flat().filter(f => f && !f.error);

  if (allFacts.length === 0) return [];

  // Write to DB in one shot (after all LLM calls complete)
  writeFacts(db, docSource.id, allFacts);
  registerEntities(db, allFacts);

  return allFacts;
}

// ── Tier 1 wiki prompt builder ────────────────────────────────────────────────

/**
 * Build a prompt for generating a Tier 1 wiki page from extracted facts.
 * The page uses a fixed 7-section structure for downstream synthesis.
 *
 * @param {string} title
 * @param {object[]} facts - from paper_facts table
 * @returns {string}
 */
function buildTier1Prompt(title, facts) {
  // Group facts by type for structured rendering
  const byType = {};
  for (const f of facts) {
    if (!byType[f.fact_type]) byType[f.fact_type] = [];
    byType[f.fact_type].push(f);
  }

  function renderFacts(types) {
    return types
      .flatMap(t => byType[t] || [])
      .slice(0, 12)
      .map(f => {
        const parts = [f.subject, f.predicate, f.object].filter(Boolean).join(' ');
        const ctx = f.context ? ` (${f.context})` : '';
        const ev = f.evidence_text ? `\n  Evidence: "${f.evidence_text}"` : '';
        return `- ${parts}${ctx}${ev}`;
      })
      .join('\n');
  }

  const problemFacts  = renderFacts(['problem', 'assumption']);
  const methodFacts   = renderFacts(['method', 'claim']);
  const resultFacts   = renderFacts(['result', 'metric', 'baseline']);
  const datasetFacts  = renderFacts(['dataset']);
  const limitFacts    = renderFacts(['limitation', 'future_work']);
  const allFactCount  = facts.length;

  return `You are writing a Tier 1 wiki page for an academic paper knowledge base.

Paper: ${title}
Total extracted facts: ${allFactCount}

Extracted evidence:

## Problems / Assumptions
${problemFacts || '(none extracted)'}

## Methods / Claims
${methodFacts || '(none extracted)'}

## Results / Metrics / Baselines
${resultFacts || '(none extracted)'}

## Datasets
${datasetFacts || '(none extracted)'}

## Limitations
${limitFacts || '(none extracted)'}

Write a wiki page with EXACTLY these seven sections in order:
## Summary
## Problem Addressed
## Method
## Key Results
## Datasets Used
## Limitations
## Relation to This Project

Rules:
- Ground every claim in the extracted evidence above
- Include specific numbers, model names, and dataset names when available
- "Relation to This Project" should note methodological connections and potential challenges — leave placeholder text "[To be filled by paper-reader-lab]" if unknown
- Use [[wikilink]] syntax for concepts that deserve their own pages
- 300–600 words total
- Respond with only the wiki page content`;
}

module.exports = { extractPaperFacts, writeFacts, registerEntities, buildTier1Prompt };
