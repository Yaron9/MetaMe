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
function queryHotFacts(db, windowDays = WINDOW_DAYS) {
  const stmt = db.prepare(`
    SELECT id, title, content, kind, confidence, search_count, source_type, created_at
    FROM memory_items
    WHERE search_count >= ${MIN_SEARCH_COUNT}
      AND created_at >= datetime('now', '-${windowDays} days')
      AND state = 'active'
      AND kind IN ('insight', 'convention')
    ORDER BY search_count DESC, created_at DESC
    LIMIT ${MAX_FACTS}
  `);
  return stmt.all();
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
    const prefix = entityPrefix(fact && fact.title);
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

function writeCapsuleFile(filePath, markdownContent, facts, today, prefix) {
  const frontmatter = `---
date: ${today}
source: nightly-reflect
type: knowledge-capsule
entity_prefix: ${prefix}
facts_analyzed: ${Array.isArray(facts) ? facts.length : 0}
---

`;
  try {
    fs.writeFileSync(filePath, frontmatter + markdownContent, 'utf8');
    return true;
  } catch (e) {
    console.log(`[NIGHTLY-REFLECT] Warning: failed to write capsule ${filePath}: ${e.message}`);
    return false;
  }
}

function appendCapsuleUpdate(filePath, markdownContent, today) {
  // Idempotency: skip if same-day update already appended
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.includes(`## 🔄 增量研判 (${today})`)) return false;
  } catch { /* file may not be readable, proceed */ }
  try {
    const section = `\n\n## 🔄 增量研判 (${today})\n\n${markdownContent}\n`;
    fs.appendFileSync(filePath, section, 'utf8');
    return true;
  } catch (e) {
    console.log(`[NIGHTLY-REFLECT] Warning: failed to append capsule update ${filePath}: ${e.message}`);
    return false;
  }
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
    // Recent facts (last 1 day) used exclusively for incremental capsule appends,
    // preventing the 7-day rolling window from re-distilling the same facts repeatedly.
    const recentFacts = queryHotFacts(db, 1);
    console.log(`[NIGHTLY-REFLECT] Found ${hotFacts.length} hot-zone facts (${recentFacts.length} from last 24h).`);

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
        title: f.title,
        kind: f.kind,
        content: f.content,
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
      releaseLock();
      return;
    }

    // Parse Haiku response
    const parsed = parseJsonFromLlm(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.log('[NIGHTLY-REFLECT] Failed to parse Haiku output.');
      writeReflectLog({ status: 'error', reason: 'parse_failed', facts_found: hotFacts.length });
      releaseLock();
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
      // Cold start uses full hotFacts (7 days); incremental uses recentFacts (1 day)
      // to prevent the same facts from being re-distilled every night.
      const capsuleGroups = collectCapsuleGroups(hotFacts, 3).slice(0, 3);
      for (const group of capsuleGroups) {
        const capsuleSlug = sanitizeSlug(group.prefix.replace(/\./g, '-'), 'capsule');
        const capsuleFile = path.join(CAPSULES_DIR, `${capsuleSlug}-playbook.md`);
        const playbookExists = fs.existsSync(capsuleFile);

        // For incremental appends, only use facts from the last 24 hours
        const factsForGroup = playbookExists
          ? collectCapsuleGroups(recentFacts, 1).find(g => g.prefix === group.prefix)
          : group;
        // Skip append if no new facts in the last 24 hours
        if (playbookExists && !factsForGroup) continue;

        const sourceItems = factsForGroup ? factsForGroup.items : group.items;
        const groupFacts = sourceItems.map(f => ({
          title: f.title,
          kind: f.kind,
          content: f.content,
          search_count: f.search_count,
        }));
        const capsulePrompt = playbookExists
          ? `你是知识胶囊维护者。以下是该主题近期新增的原始事实，请提炼成简洁的增量段落（不超过300字），直接追加到现有手册。不要重复旧内容，不要输出大标题。

entity_prefix: ${group.prefix}
新增 facts(json): ${JSON.stringify(groupFacts, null, 2).slice(0, 3000)}

输出格式（仅段落内容，Markdown 列表）：
- **[具体要点/报错/红线]**：[原因与解法，含变量名/路径/报错原文]`
          : `你是首席布道师与底层架构师。请将以下零散的开发者流水账，升维提炼成一本《硬核架构与避坑手册》(Playbook)。

entity_prefix: ${group.prefix}
输入事实(JSON): ${JSON.stringify(groupFacts, null, 2).slice(0, 5000)}

【输出信仰与戒律】
1. 绝对的业务原子性：必须写具体的变量名、报错信息、文件路径，不要写"遇到了问题解决问题"。
2. 倒金字塔结构：致命错误、架构红线必须写在最前面的 🩸 血泪避坑指南 中。
3. 如果输入事实中包含报错原文（如 Exception 栈），必须保留在 🔍 历史报错指纹 中。
4. 必须使用 Markdown 格式输出，不要有任何 JSON 包装。
5. 去除一切废话：不要用"总而言之"、"这体现了"等水文词汇，全本必须干货。

请按以下 Markdown 模板输出：
# 📕 Playbook: [你提炼的主题名称]

> **胶囊摘要**：[一句话核心]
> **覆盖实体**：${group.prefix}
> **核心标签**：[tag1, tag2, tag3]

---

## 1. 🩸 血泪避坑指南 (Critical Red Lines)
- **[问题名]**：[具体诱因与解法]

## 2. 🏗️ 架构决议 (Architecture Decisions)
- **[为什么选X不选Y]**：[理由]

## 3. 🔍 历史报错指纹 (Error Fingerprints)
- \`[报错原文]\`
  - **诱因**：...
  - **解法**：...

## 4. 🔗 图谱扩展 (Related Concepts)
- [相关主题或文件引用]`;

        let capsuleMarkdown = null;
        try {
          const rawCapsule = await Promise.race([
            callHaiku(capsulePrompt, distillEnv, 60000),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 65000)),
          ]);
          capsuleMarkdown = typeof rawCapsule === 'string' ? rawCapsule.trim() : null;
        } catch { /* non-fatal */ }
        // Strip markdown code fences that Haiku may wrap around output
        if (capsuleMarkdown) {
          capsuleMarkdown = capsuleMarkdown
            .replace(/^```(markdown)?\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
        }
        if (!capsuleMarkdown || capsuleMarkdown.length < 50) continue;

        if (playbookExists) {
          appendCapsuleUpdate(capsuleFile, capsuleMarkdown, today);
        } else {
          writeCapsuleFile(capsuleFile, capsuleMarkdown, sourceItems, today, group.prefix);
        }
        capsulesWritten++;

        if (memory && typeof memory.saveFacts === 'function') {
          const titleMatch = capsuleMarkdown.match(/^# 📕 Playbook:\s*(.+)$/m)
            || capsuleMarkdown.match(/^## (.+)$/m);
          const capsuleTitle = (titleMatch ? titleMatch[1].trim() : group.prefix).slice(0, 80);
          const summaryMatch = capsuleMarkdown.match(/\*\*胶囊摘要\*\*[：:]\s*(.+)/);
          const capsuleSummary = summaryMatch
            ? summaryMatch[1].trim()
            : stripMd(capsuleMarkdown.slice(0, 120));
          const capsuleValue = `${capsuleTitle}: ${capsuleSummary}`.slice(0, 280);
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

    // ── Conflict Resolution ──────────────────────────────────────────────
    // Query CONFLICT items grouped by title+kind, ask Haiku to pick winner.
    // Loser is marked state='superseded'; winner restored to 'active'.
    let conflictsResolved = 0;
    try {
      const conflictGroups = db.prepare(`
        SELECT title, kind, COUNT(*) as cnt
        FROM memory_items
        WHERE state = 'conflict'
        GROUP BY title, kind
        HAVING cnt >= 2
        ORDER BY cnt DESC
        LIMIT 10
      `).all();

      if (conflictGroups.length > 0) {
        console.log(`[NIGHTLY-REFLECT] Found ${conflictGroups.length} conflict group(s) to resolve.`);

        // Collect all conflicting facts for these groups (batch to reduce queries)
        const allConflicts = [];
        for (const g of conflictGroups) {
          const rows = db.prepare(`
            SELECT id, title, kind, content, confidence, created_at
            FROM memory_items
            WHERE title = ? AND kind = ? AND state = 'conflict'
            ORDER BY created_at DESC
          `).all(g.title, g.kind);
          if (rows.length >= 2) allConflicts.push({ title: g.title, kind: g.kind, facts: rows });
        }

        if (allConflicts.length > 0) {
          // Limit to 5 groups to avoid truncating serialized JSON
          const conflictInput = allConflicts.slice(0, 5).map(g => ({
            title: g.title,
            kind: g.kind,
            candidates: g.facts.slice(0, 5).map(f => ({ id: f.id, content: f.content.slice(0, 150), confidence: f.confidence, created_at: f.created_at })),
          }));

          const resolvePrompt = `你是知识库冲突调解员。以下是同一 title+kind 下的冲突记忆条目，请选出每组最准确的一条保留。

冲突组(JSON):
${JSON.stringify(conflictInput, null, 2)}

输出 JSON 数组，每个元素对应一组冲突的裁决：
[
  {
    "title": "...",
    "kind": "...",
    "winner_id": "保留的item id",
    "reason": "一句话理由"
  }
]

规则：
- 优先选最新（created_at）且 confidence 高的
- 如果旧条目更准确具体，选旧的
- 只输出 JSON 数组`;

          try {
            const resolveRaw = await Promise.race([
              callHaiku(resolvePrompt, distillEnv, 60000),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 65000)),
            ]);
            const verdicts = parseJsonFromLlm(resolveRaw);
            if (Array.isArray(verdicts)) {
              for (const v of verdicts) {
                if (!v || !v.winner_id || !v.title || !v.kind) continue;
                // Validate winner exists in our conflict set
                const group = allConflicts.find(g => g.title === v.title && g.kind === v.kind);
                if (!group) continue;
                const winnerExists = group.facts.some(f => f.id === v.winner_id);
                if (!winnerExists) continue;

                const loserIds = group.facts.filter(f => f.id !== v.winner_id).map(f => f.id);
                if (loserIds.length === 0) continue;

                // Mark losers as superseded
                const placeholders = loserIds.map(() => '?').join(',');
                db.prepare(
                  `UPDATE memory_items SET state = 'superseded', updated_at = datetime('now')
                   WHERE id IN (${placeholders})`
                ).run(...loserIds);

                // Restore winner
                db.prepare(
                  `UPDATE memory_items SET state = 'active', updated_at = datetime('now') WHERE id = ?`
                ).run(v.winner_id);

                conflictsResolved += loserIds.length;
              }
              if (conflictsResolved > 0) {
                console.log(`[NIGHTLY-REFLECT] Resolved ${conflictsResolved} conflicting fact(s).`);
              }
            }
          } catch (e) {
            console.log(`[NIGHTLY-REFLECT] Conflict resolution failed (non-fatal): ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.log(`[NIGHTLY-REFLECT] Conflict query failed (non-fatal): ${e.message}`);
    }

    // Write audit log
    writeReflectLog({
      status: 'success',
      facts_analyzed: hotFacts.length,
      decisions_written: decisions.length,
      lessons_written: lessons.length,
      synthesized_insights_saved: synthesizedSaved,
      conflicts_resolved: conflictsResolved,
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
    // Report estimated token usage for daemon budget tracking
    // ~5k tokens per reflection + capsule generation
    console.log('__TOKENS__:5000');
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
