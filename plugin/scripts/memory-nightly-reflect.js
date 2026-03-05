#!/usr/bin/env node

/**
 * memory-nightly-reflect.js — Nightly Hot-Fact Distillation
 *
 * Reads "hot zone" facts from memory.db (search_count >= 3, last 7 days),
 * calls Haiku to distill high-level patterns, and writes results to:
 *   - ~/.metame/memory/decisions/YYYY-MM-DD-nightly-reflect.md  (strategic/architectural)
 *   - ~/.metame/memory/lessons/YYYY-MM-DD-nightly-reflect.md    (operational SOPs)
 *
 * Designed to run nightly at 01:00 via daemon.yaml scheduler (require_idle).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const DB_PATH = path.join(METAME_DIR, 'memory.db');
const LOCK_FILE = path.join(METAME_DIR, 'memory-nightly-reflect.lock');
const REFLECT_LOG_FILE = path.join(METAME_DIR, 'memory_reflect_log.jsonl');

const MEMORY_DIR = path.join(HOME, '.metame', 'memory');
const DECISIONS_DIR = path.join(MEMORY_DIR, 'decisions');
const LESSONS_DIR = path.join(MEMORY_DIR, 'lessons');
const CAPSULES_DIR = path.join(MEMORY_DIR, 'capsules');

// Hot zone thresholds
const MIN_SEARCH_COUNT = 3;
const WINDOW_DAYS = 7;
const MAX_FACTS = 20;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const EXCLUDED_RELATIONS = ['project_milestone', 'synthesized_insight', 'knowledge_capsule', 'bug_lesson'];

// Ensure output directories exist at startup
[MEMORY_DIR, DECISIONS_DIR, LESSONS_DIR, CAPSULES_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

/**
 * Load callHaiku + buildDistillEnv from deployed path, fallback to scripts dir.
 */
function loadHelper(name) {
  const candidates = [
    path.join(HOME, '.metame', name),
    path.join(__dirname, name),
  ];
  for (const p of candidates) {
    try { return require(p); } catch {}
  }
  throw new Error(`Cannot load ${name}`);
}

/**
 * Acquire atomic lock using O_EXCL — prevents concurrent runs.
 */
function acquireLock() {
  try {
    const fd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(fd, process.pid.toString());
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (lockAge < LOCK_TIMEOUT_MS) {
          console.log('[NIGHTLY-REFLECT] Already running (lock held), skipping.');
          return false;
        }
        // Stale lock — remove and re-acquire
        fs.unlinkSync(LOCK_FILE);
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(fd, process.pid.toString());
        fs.closeSync(fd);
        return true;
      } catch {
        console.log('[NIGHTLY-REFLECT] Could not acquire lock, skipping.');
        return false;
      }
    }
    throw e;
  }
}

/**
 * Release the atomic lock.
 */
function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* non-fatal */ }
}

/**
 * Append a run record to the audit log.
 */
function writeReflectLog(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
  try {
    fs.mkdirSync(path.dirname(REFLECT_LOG_FILE), { recursive: true });
    fs.appendFileSync(REFLECT_LOG_FILE, line, 'utf8');
  } catch (e) {
    console.log(`[NIGHTLY-REFLECT] Warning: could not write reflect log: ${e.message}`);
  }
}

/**
 * Query hot zone facts from memory.db.
 * Returns array of plain objects.
 */
function queryHotFacts(db) {
  const relationPlaceholders = EXCLUDED_RELATIONS.map(() => '?').join(', ');
  const stmt = db.prepare(`
    SELECT id, entity, relation, value, confidence, search_count, created_at
    FROM facts
    WHERE search_count >= ${MIN_SEARCH_COUNT}
      AND created_at >= datetime('now', '-${WINDOW_DAYS} days')
      AND superseded_by IS NULL
      AND (conflict_status IS NULL OR conflict_status = 'OK')
      AND relation NOT IN (${relationPlaceholders})
    ORDER BY search_count DESC, created_at DESC
    LIMIT ${MAX_FACTS}
  `);
  return stmt.all(...EXCLUDED_RELATIONS);
}

/**
 * Write a reflect Markdown file with frontmatter.
 */
function writeReflectFile(filePath, entries, factsCount, sourceType) {
  const today = new Date().toISOString().slice(0, 10);
  const sections = entries
    .map(e => `## ${e.title}\n\n${e.content}`)
    .join('\n\n---\n\n');

  const content = `---
date: ${today}
source: nightly-reflect
type: ${sourceType}
facts_analyzed: ${factsCount}
---

${sections}
`;
  fs.writeFileSync(filePath, content, 'utf8');
}

function sanitizeSlug(input, fallback = 'capsule') {
  const v = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!v) return fallback;
  return v.slice(0, 50);
}

function stripMd(text) {
  return String(text || '').replace(/[#*_`>\[\]\(\)]/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildSynthesizedFacts(today, decisions, lessons) {
  const all = []
    .concat(Array.isArray(decisions) ? decisions : [])
    .concat(Array.isArray(lessons) ? lessons : []);
  const out = [];
  for (const item of all) {
    const title = String(item && item.title ? item.title : '').trim();
    const content = String(item && item.content ? item.content : '').trim();
    if (!title || !content) continue;
    const value = stripMd(`${title}: ${content}`).slice(0, 280);
    if (value.length < 20) continue;
    out.push({
      entity: `nightly.reflect.${today}`,
      relation: 'synthesized_insight',
      value,
      confidence: 'high',
      tags: ['nightly', 'reflection'],
    });
  }
  return out;
}

function entityPrefix(entity) {
  const src = String(entity || '').trim();
  if (!src) return '';
  const parts = src.split('.').map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]}.${parts[1]}`;
}

function collectCapsuleGroups(facts, minGroupSize = 3) {
  const groups = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    const prefix = entityPrefix(fact && fact.entity);
    if (!prefix) continue;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(fact);
  }
  return [...groups.entries()]
    .map(([prefix, items]) => ({ prefix, items }))
    .filter(g => g.items.length >= minGroupSize)
    .sort((a, b) => b.items.length - a.items.length);
}

function parseJsonFromLlm(raw) {
  const text = String(raw || '');
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  if (!cleaned) return null;
  try { return JSON.parse(cleaned); } catch { return null; }
}

function writeCapsuleFile(filePath, capsule, facts, today, prefix) {
  const related = Array.isArray(capsule.related_concepts) ? capsule.related_concepts.slice(0, 8) : [];
  const supporting = Array.isArray(capsule.supporting_facts) ? capsule.supporting_facts.slice(0, 8) : [];
  const content = `---
date: ${today}
source: nightly-reflect
type: knowledge-capsule
entity_prefix: ${prefix}
facts_analyzed: ${Array.isArray(facts) ? facts.length : 0}
---

# ${capsule.title}

## 核心结论
${capsule.core_conclusion}

## 适用场景
${capsule.applicable_scenarios}

## 关联概念
${related.length > 0 ? related.map(x => `- ${x}`).join('\n') : '- (none)'}

## 支撑事实
${supporting.length > 0 ? supporting.map(x => `- ${x}`).join('\n') : '- (none)'}
`;
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Main nightly reflect run.
 */
async function run() {
  console.log('[NIGHTLY-REFLECT] Starting nightly reflect run...');

  if (!fs.existsSync(DB_PATH)) {
    console.log('[NIGHTLY-REFLECT] memory.db not found, skipping.');
    return;
  }

  if (!acquireLock()) return;

  const today = new Date().toISOString().slice(0, 10);
  const decisionFile = path.join(DECISIONS_DIR, `${today}-nightly-reflect.md`);
  const lessonFile = path.join(LESSONS_DIR, `${today}-nightly-reflect.md`);

  // Prevent duplicate runs for the same day
  if (fs.existsSync(decisionFile) || fs.existsSync(lessonFile)) {
    console.log('[NIGHTLY-REFLECT] Already ran today, skipping.');
    releaseLock();
    return;
  }

  let db;
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');

    const hotFacts = queryHotFacts(db);
    console.log(`[NIGHTLY-REFLECT] Found ${hotFacts.length} hot-zone facts.`);

    if (hotFacts.length < 3) {
      console.log('[NIGHTLY-REFLECT] Insufficient hot facts (< 3), skipping distillation.');
      writeReflectLog({ status: 'skipped', reason: 'insufficient_facts', facts_found: hotFacts.length });
      releaseLock();
      return;
    }

    // Load Haiku helper from providers.js (callHaiku lives there)
    let callHaiku, buildDistillEnv;
    try {
      ({ callHaiku, buildDistillEnv } = loadHelper('providers.js'));
    } catch (e) {
      throw new Error(`Cannot load Haiku helper from providers.js: ${e.message}`);
    }

    let distillEnv = {};
    try { distillEnv = buildDistillEnv(); } catch {}

    const factsJson = JSON.stringify(
      hotFacts.map(f => ({
        entity: f.entity,
        relation: f.relation,
        value: f.value,
        confidence: f.confidence,
        search_count: f.search_count,
      })),
      null,
      2
    );

    const prompt = `You are extracting high-level patterns from an AI assistant's recent memory facts.

Recent high-frequency facts (JSON):
${factsJson}

Analyze and output a JSON object:
{
  "decisions": [{"title": "中文标题", "content": "## 背景\\n...\\n## 结论\\n..."}],
  "lessons": [{"title": "中文标题", "content": "## 问题\\n...\\n## 操作手册\\n1. ..."}]
}

Rules:
- decisions: strategic/architectural insights (why we chose X over Y)
- lessons: operational SOPs (how to do X correctly)
- Each array can be empty if no pattern found
- content in 中文, 100-250 chars each
- Output ONLY the JSON object`;

    console.log('[NIGHTLY-REFLECT] Calling Haiku for distillation...');
    let raw;
    try {
      raw = await Promise.race([
        callHaiku(prompt, distillEnv, 90000),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 95000)),
      ]);
    } catch (e) {
      console.log(`[NIGHTLY-REFLECT] Haiku call failed: ${e.message}`);
      writeReflectLog({ status: 'error', reason: 'haiku_failed', error: e.message, facts_found: hotFacts.length });
      return;
    }

    // Parse Haiku response
    const parsed = parseJsonFromLlm(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.log('[NIGHTLY-REFLECT] Failed to parse Haiku output.');
      writeReflectLog({ status: 'error', reason: 'parse_failed', facts_found: hotFacts.length });
      return;
    }

    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions.filter(d => d.title && d.content) : [];
    const lessons = Array.isArray(parsed.lessons) ? parsed.lessons.filter(l => l.title && l.content) : [];

    console.log(`[NIGHTLY-REFLECT] Distilled: ${decisions.length} decision(s), ${lessons.length} lesson(s).`);

    // Write decisions file (even if empty array — record the run)
    if (decisions.length > 0) {
      writeReflectFile(decisionFile, decisions, hotFacts.length, 'decisions');
      console.log(`[NIGHTLY-REFLECT] Decisions written: ${decisionFile}`);
    }

    // Write lessons file
    if (lessons.length > 0) {
      writeReflectFile(lessonFile, lessons, hotFacts.length, 'lessons');
      console.log(`[NIGHTLY-REFLECT] Lessons written: ${lessonFile}`);
    }

    let synthesizedSaved = 0;
    let capsulesWritten = 0;
    let capsuleFactsSaved = 0;
    let memory = null;
    try {
      try { memory = require('./memory'); } catch { /* optional */ }

      // 3B: write distilled insights back into memory.db for closed-loop retrieval.
      if (memory && typeof memory.saveFacts === 'function') {
        const synthesizedFacts = buildSynthesizedFacts(today, decisions, lessons);
        if (synthesizedFacts.length > 0) {
          const writeRes = memory.saveFacts(`nightly-reflect-${today}`, '*', synthesizedFacts, { scope: '*' });
          synthesizedSaved = Number(writeRes && writeRes.saved) || 0;
        }
      }

      // 3C: knowledge capsule aggregation by entity prefix.
      const capsuleGroups = collectCapsuleGroups(hotFacts, 3).slice(0, 3);
      for (const group of capsuleGroups) {
        const groupFacts = group.items.map(f => ({
          entity: f.entity,
          relation: f.relation,
          value: f.value,
          search_count: f.search_count,
        }));
        const capsulePrompt = `你是知识胶囊生成器。请将同一主题下的事实聚合成结构化胶囊。

entity_prefix: ${group.prefix}
facts(json): ${JSON.stringify(groupFacts, null, 2).slice(0, 5000)}

输出 JSON：
{
  "title":"标题",
  "core_conclusion":"一句核心结论",
  "applicable_scenarios":"适用场景（1-2句）",
  "related_concepts":["概念1","概念2"],
  "supporting_facts":["支撑点1","支撑点2"]
}

规则：
- 只基于输入事实，不虚构
- 每个字段简洁具体
- 仅输出 JSON`;

        let capsule = null;
        try {
          const rawCapsule = await Promise.race([
            callHaiku(capsulePrompt, distillEnv, 60000),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 65000)),
          ]);
          capsule = parseJsonFromLlm(rawCapsule);
        } catch { /* non-fatal */ }
        if (!capsule || !capsule.title || !capsule.core_conclusion || !capsule.applicable_scenarios) continue;

        const capsuleSlug = sanitizeSlug(group.prefix.replace(/\./g, '-'), 'capsule');
        const capsuleFile = path.join(CAPSULES_DIR, `${capsuleSlug}-${today}.md`);
        writeCapsuleFile(capsuleFile, capsule, group.items, today, group.prefix);
        capsulesWritten++;

        if (memory && typeof memory.saveFacts === 'function') {
          const capsuleValue = stripMd(`${capsule.title}: ${capsule.core_conclusion}`).slice(0, 280);
          if (capsuleValue.length >= 20) {
            const saveCapsule = memory.saveFacts(`capsule-${today}-${capsuleSlug}`, '*', [{
              entity: `capsule.${group.prefix.replace(/\./g, '_')}`,
              relation: 'knowledge_capsule',
              value: capsuleValue,
              confidence: 'high',
              tags: ['capsule'],
            }], { scope: '*' });
            capsuleFactsSaved += Number(saveCapsule && saveCapsule.saved) || 0;
          }
        }
      }
    } finally {
      try { if (memory && typeof memory.close === 'function') memory.close(); } catch { /* non-fatal */ }
    }

    // Write audit log
    writeReflectLog({
      status: 'success',
      facts_analyzed: hotFacts.length,
      decisions_written: decisions.length,
      lessons_written: lessons.length,
      synthesized_insights_saved: synthesizedSaved,
      capsules_written: capsulesWritten,
      capsule_facts_saved: capsuleFactsSaved,
      decision_file: decisions.length > 0 ? decisionFile : null,
      lesson_file: lessons.length > 0 ? lessonFile : null,
    });

    console.log('[NIGHTLY-REFLECT] Run complete.');

  } catch (e) {
    console.error(`[NIGHTLY-REFLECT] Fatal error: ${e.message}`);
    writeReflectLog({ status: 'error', reason: 'fatal', error: e.message });
    process.exitCode = 1;
  } finally {
    try { if (db) db.close(); } catch { /* non-fatal */ }
    releaseLock();
  }
}

if (require.main === module) {
  run().then(() => {
    console.log('✅ nightly-reflect complete');
  }).catch(e => {
    console.error(`[NIGHTLY-REFLECT] Fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  run,
  _private: {
    queryHotFacts,
    buildSynthesizedFacts,
    collectCapsuleGroups,
    entityPrefix,
    parseJsonFromLlm,
    EXCLUDED_RELATIONS,
  },
};
