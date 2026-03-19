#!/usr/bin/env node

/**
 * memory-extract.js — Independent Memory Extraction
 *
 * Scans unanalyzed Claude Code sessions and extracts atomic facts
 * into memory.db. Runs independently of raw_signals.jsonl so that
 * pure technical sessions (no preference signals) are still captured.
 *
 * Designed to run as a standalone heartbeat task (default interval: 4h).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { callHaiku, buildDistillEnv } = require('./providers');

const HOME = os.homedir();
const LOCK_FILE = path.join(HOME, '.metame', 'memory-extract.lock');

// Atomic fact extraction prompt (local copy — distill.js no longer exports this)
const FACT_EXTRACTION_PROMPT = `你是精准的知识提取引擎。从以下会话材料中提取「值得长期记住的原子事实」。

提取类型（必须是以下之一）：
- tech_decision（技术决策：为什么选A不选B）
- bug_lesson（Bug根因：什么设计/假设导致了问题）
- arch_convention（架构约定：系统组件的行为边界）
- config_fact（配置事实：某个值的真实含义，尤其反直觉的）
- config_change（配置变更：用户选择/确认了某个具体配置值，如”字体选了x-large”、”间隔改为2h”）
- workflow_rule（工作流戒律/用户红线：如”不要在某情况下做某事”的反常识流、用户明确表达的项目级红线）
- project_milestone（项目里程碑：主要架构重构、版本发布等跨会话级成果）

绝对不提取：
- 过程性描述（"用户问了X"、"我们讨论了Y"）
- 临时状态（"当前正在..."、"这次会话..."）
- 未经验证的猜测（"可能是因为..."、"也许..."）
- 显而易见的常识
- 泛化偏好（沟通风格、代码风格、语言偏好等）——这些由认知Profile自动采集，memory不重复记录

输出 JSON 对象，包含会话名称和提取的事实：
{
  "session_name": "用3-5个词极其精简地概括这起会话的主题（例如：优化微信登录架构、排查Redis连接泄漏、配置Nginx反向代理）",
  "facts": [
    {
      "entity":"主体(点号层级如MetaMe.daemon.askClaude)",
      "relation":"类型",
      "value":"脱离上下文可独立理解的一句话",
      "confidence":"high或medium",
      "tags":["最多3个标签"],
      "concepts":["最多3个抽象概念标签，如流量控制/背压/解耦"],
      "domain":"可选领域标签，如backend/frontend/devops"
    }
  ]
}

规则：
- 宁缺毋滥：0条比10条废话好
- value必须包含足够上下文，不能写"这个问题"、"上面说的"
- value长度20-200字
- entity用英文点号路径，value可用中文
- medium confidence必须有非空tags
- concepts 可为空；若存在，最多3个，必须是抽象概念词而非文件名
- 优先引用证据里的具体锚点（文件名、命令、报错关键词）；没有锚点时不要硬编
- 没有值得提取的事实时 facts 返回 []

只输出JSON对象，不要解释。

会话材料（包含骨架 + 证据）：
{{SESSION_INPUT}}`.trim();

const SESSION_TAGS_FILE = path.join(os.homedir(), '.metame', 'session_tags.json');

/**
 * Persist session name and derived tags to ~/.metame/session_tags.json.
 * Consumed by /sessions and /resume commands for friendly display titles.
 * Merges into existing file — never overwrites existing entries.
 */
function saveSessionTag(sessionId, sessionName, facts) {
  // Derive tags from facts' tags arrays (deduplicated, max 8)
  const tagSet = new Set();
  for (const f of facts) {
    if (Array.isArray(f.tags)) f.tags.forEach(t => tagSet.add(t));
  }
  const tags = [...tagSet].slice(0, 8);

  let existing = {};
  try {
    if (fs.existsSync(SESSION_TAGS_FILE)) {
      existing = JSON.parse(fs.readFileSync(SESSION_TAGS_FILE, 'utf8'));
    }
  } catch { existing = {}; }

  // Only update if not already present (never overwrite)
  if (!existing[sessionId]) {
    existing[sessionId] = {
      name: sessionName,
      tags,
      extracted_at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(SESSION_TAGS_FILE), { recursive: true });
      fs.writeFileSync(SESSION_TAGS_FILE, JSON.stringify(existing, null, 2), 'utf8');
    } catch (e) {
      console.log(`[memory-extract] Failed to save session tag: ${e.message}`);
    }
  }
}

function normalizeConceptList(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    const v = String(raw || '').trim();
    if (!v || v.length > 40) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeDomain(input) {
  const v = String(input || '').trim();
  if (!v) return null;
  return v.length > 40 ? v.slice(0, 40) : v;
}

function factFingerprint(fact) {
  if (!fact || typeof fact !== 'object') return '';
  const entity = String(fact.entity || '').trim();
  const relation = String(fact.relation || '').trim();
  const value = String(fact.value || '').trim().slice(0, 100);
  if (!entity || !relation || !value) return '';
  return `${entity}||${relation}||${value}`;
}

function buildFactLabelRows(extractedFacts, savedFacts) {
  const source = Array.isArray(extractedFacts) ? extractedFacts : [];
  const saved = Array.isArray(savedFacts) ? savedFacts : [];
  if (source.length === 0 || saved.length === 0) return [];

  const byFp = new Map();
  for (const fact of source) {
    const fp = factFingerprint(fact);
    if (!fp) continue;
    if (!byFp.has(fp)) byFp.set(fp, fact);
  }

  const rows = [];
  const dedup = new Set();
  for (const sf of saved) {
    const fp = factFingerprint(sf);
    if (!fp) continue;
    const src = byFp.get(fp);
    if (!src) continue;
    const concepts = normalizeConceptList(src.concepts);
    if (concepts.length === 0) continue;
    const domain = normalizeDomain(src.domain);
    for (const label of concepts) {
      const rowKey = `${sf.id}::${label}`;
      if (dedup.has(rowKey)) continue;
      dedup.add(rowKey);
      rows.push({ fact_id: sf.id, label, domain });
    }
  }
  return rows;
}

const VAGUE_PATTERNS = [
  /^用户(问|提|说|提到)/, /^我们(讨论|分析|查看)/,
  /这个问题/, /上面(提到|说的|的)/, /可能是因为/,
  /也许|或许|大概/, /当前正在|目前在/, /这次会话/,
];
const ALLOWED_FLAT = new Set(['王总', 'system', 'user']);

/**
 * Extract atomic facts from session skeleton + evidence via Haiku.
 * Returns filtered fact array (may be empty).
 */
async function extractFacts(skeleton, evidence, distillEnv) {
  const sessionInput = JSON.stringify({ skeleton, evidence }, null, 2).slice(0, 4500);
  const prompt = FACT_EXTRACTION_PROMPT.replace('{{SESSION_INPUT}}', sessionInput);

  let raw;
  try {
    raw = await Promise.race([
      callHaiku(prompt, distillEnv, 60000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 65000)),
    ]);
  } catch (e) {
    console.log(`[memory-extract] Haiku call failed: ${e.message} | code:${e.code} killed:${e.killed} stdout:${String(e.stdout || '').slice(0, 100)} stderr:${String(e.stderr || '').slice(0, 100)}`);
    return { ok: false, facts: [], session_name: "未命名会话" };
  }

  let parsed;
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, facts: [], session_name: "未命名会话" };
  }

  let facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  const session_name = parsed.session_name || "未命名会话";

  const filteredFacts = facts.filter(f => {
    if (!f.entity || !f.relation || !f.value) return false;
    if (f.value.length < 20 || f.value.length > 300) return false;
    if (VAGUE_PATTERNS.some(re => re.test(f.value))) return false;
    if (!f.entity.includes('.') && !ALLOWED_FLAT.has(f.entity)) return false;
    if (f.confidence === 'medium' && (!f.tags || f.tags.length === 0)) return false;
    return true;
  });

  const normalizedFacts = filteredFacts.map(f => ({
    ...f,
    concepts: normalizeConceptList(f.concepts),
    domain: normalizeDomain(f.domain),
  }));

  return { ok: true, facts: normalizedFacts, session_name };
}

/**
 * Main entry: scan all unanalyzed sessions and extract facts.
 * Returns { sessionsProcessed, factsSaved, factsSkipped }
 */
async function run() {
  // Atomic lock — prevent concurrent extraction (O_EXCL guarantees no race)
  let lockFd;
  try {
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(lockFd, process.pid.toString());
    fs.closeSync(lockFd);
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        if (lockAge < 300000) { // 5 min timeout for extraction
          console.log('[memory-extract] Already running, skipping.');
          return { sessionsProcessed: 0, factsSaved: 0, factsSkipped: 0 };
        }
        fs.unlinkSync(LOCK_FILE);
        lockFd = fs.openSync(LOCK_FILE, 'wx');
        fs.writeSync(lockFd, process.pid.toString());
        fs.closeSync(lockFd);
      } catch {
        console.log('[memory-extract] Already running, skipping.');
        return { sessionsProcessed: 0, factsSaved: 0, factsSkipped: 0 };
      }
    } else {
      throw e;
    }
  }

  let sessionAnalytics;
  try {
    sessionAnalytics = require('./session-analytics');
  } catch (e) {
    console.log(`[memory-extract] session-analytics unavailable: ${e.message} — memory extraction disabled`);
    return { sessionsProcessed: 0, factsSaved: 0, factsSkipped: 0 };
  }

  let memory;
  try {
    memory = require('./memory');
  } catch {
    console.log('[memory-extract] memory module not available, exiting.');
    return { sessionsProcessed: 0, factsSaved: 0, factsSkipped: 0 };
  }

  try {
    let distillEnv = {};
    try { distillEnv = buildDistillEnv(); } catch { }

    const sessions = sessionAnalytics.findAllUnextractedSessions(3);
    if (sessions.length === 0) {
      console.log('[memory-extract] No unanalyzed sessions found.');
      memory.close();
      return { sessionsProcessed: 0, factsSaved: 0, factsSkipped: 0 };
    }

    let totalSaved = 0;
    let totalSkipped = 0;
    let processed = 0;

    for (const session of sessions) {
      try {
        const skeleton = sessionAnalytics.extractSkeleton(session.path);

        // Skip trivial sessions
        if (skeleton.message_count < 2 && skeleton.duration_min < 1) {
          sessionAnalytics.markFactsExtracted(skeleton.session_id);
          continue;
        }

        let evidence = null;
        try {
          evidence = sessionAnalytics.extractEvidence(session.path, 3000);
        } catch { /* non-fatal */ }

        const { ok, facts, session_name } = await extractFacts(skeleton, evidence, distillEnv);
        if (!ok) {
          console.log(`[memory-extract] Session ${skeleton.session_id.slice(0, 8)}: extraction failed, will retry later`);
          continue;
        }

        if (facts.length > 0) {
          const fallbackScope = skeleton.session_id
            ? `sess_${String(skeleton.session_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`
            : null;
          const { saved, skipped, superseded, savedFacts } = memory.saveFacts(
            skeleton.session_id,
            skeleton.project || 'unknown',
            facts,
            { scope: skeleton.project_id || fallbackScope }
          );
          let labelsSaved = 0;
          if (typeof memory.saveFactLabels === 'function' && Array.isArray(savedFacts) && savedFacts.length > 0) {
            const labelRows = buildFactLabelRows(facts, savedFacts);
            if (labelRows.length > 0) {
              const labelResult = memory.saveFactLabels(labelRows);
              labelsSaved = Number(labelResult && labelResult.saved) || 0;
            }
          }
          totalSaved += saved;
          totalSkipped += skipped;
          const superMsg = superseded > 0 ? `, ${superseded} superseded` : '';
          const labelMsg = labelsSaved > 0 ? `, ${labelsSaved} labels` : '';
          console.log(`[memory-extract] Session ${skeleton.session_id.slice(0, 8)}: ${saved} facts saved, ${skipped} skipped${superMsg}${labelMsg}`);
        } else {
          console.log(`[memory-extract] Session ${skeleton.session_id.slice(0, 8)} (${session_name}): no facts extracted`);
        }

        sessionAnalytics.markFactsExtracted(skeleton.session_id);

        // Persist session summary to memory.db sessions table (makes sessions searchable)
        try {
          const keywords = facts.flatMap(f => Array.isArray(f.tags) ? f.tags : [])
            .filter((v, i, a) => a.indexOf(v) === i).slice(0, 10).join(',');
          memory.saveSession({
            sessionId: skeleton.session_id,
            project: skeleton.project || 'unknown',
            scope: skeleton.project_id || null,
            summary: `[${session_name}] ${facts.map(f => f.value).join(' | ').slice(0, 2000)}`,
            keywords,
          });
        } catch { /* non-fatal — facts already saved, session is bonus */ }

        // P2-A: persist session name + tags to session_tags.json
        saveSessionTag(skeleton.session_id, session_name, facts);

        processed++;
      } catch (e) {
        console.log(`[memory-extract] Session error: ${e.message}`);
      }
    }

    // ── Codex sessions ──────────────────────────────────────────────────────
    // Same pipeline, different source: reads ~/.codex/sessions rollout files
    // (first 2KB only) + history.jsonl for user messages.
    const codexSessions = sessionAnalytics.findAllUnextractedCodexSessions(3);
    if (codexSessions.length > 0) {
      // Pass session IDs so loadCodexHistory only parses relevant entries
      // (history.jsonl grows unbounded; no need to load the full file)
      const historyMap = sessionAnalytics.loadCodexHistory(codexSessions.map(cs => cs.session_id));
      for (const cs of codexSessions) {
        try {
          const { skeleton, evidence } = sessionAnalytics.buildCodexInput(cs.path, historyMap);

          // Skip trivial sessions with no user messages
          if (skeleton.message_count < 1) {
            sessionAnalytics.markCodexFactsExtracted(cs.session_id);
            continue;
          }

          const { ok, facts, session_name } = await extractFacts(skeleton, evidence, distillEnv);
          if (!ok) {
            console.log(`[memory-extract] Codex ${cs.session_id.slice(0, 8)}: extraction failed, will retry later`);
            continue;
          }

          if (facts.length > 0) {
            const fallbackScope = `codex_${String(cs.session_id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)}`;
            const { saved, skipped, superseded, savedFacts } = memory.saveFacts(
              cs.session_id,
              skeleton.project || 'unknown',
              facts,
              { scope: skeleton.project_id || fallbackScope, source_type: 'codex' }
            );
            let labelsSaved = 0;
            if (typeof memory.saveFactLabels === 'function' && Array.isArray(savedFacts) && savedFacts.length > 0) {
              const labelRows = buildFactLabelRows(facts, savedFacts);
              if (labelRows.length > 0) {
                const lr = memory.saveFactLabels(labelRows);
                labelsSaved = Number(lr && lr.saved) || 0;
              }
            }
            totalSaved += saved;
            totalSkipped += skipped;
            const superMsg = superseded > 0 ? `, ${superseded} superseded` : '';
            const labelMsg = labelsSaved > 0 ? `, ${labelsSaved} labels` : '';
            console.log(`[memory-extract] Codex ${cs.session_id.slice(0, 8)} (${session_name}): ${saved} facts saved${superMsg}${labelMsg}`);

            // Persist Codex session summary to memory.db sessions table
            try {
              const keywords = facts.flatMap(f => Array.isArray(f.tags) ? f.tags : [])
                .filter((v, i, a) => a.indexOf(v) === i).slice(0, 10).join(',');
              memory.saveSession({
                sessionId: cs.session_id,
                project: skeleton.project || 'unknown',
                scope: skeleton.project_id || null,
                summary: `[${session_name}] ${facts.map(f => f.value).join(' | ').slice(0, 2000)}`,
                keywords,
              });
            } catch { /* non-fatal */ }

            saveSessionTag(cs.session_id, session_name, facts);
          } else {
            console.log(`[memory-extract] Codex ${cs.session_id.slice(0, 8)} (${session_name}): no facts extracted`);
          }

          sessionAnalytics.markCodexFactsExtracted(cs.session_id);
          processed++;
        } catch (e) {
          console.log(`[memory-extract] Codex session error: ${e.message}`);
        }
      }
    }
    // ── end Codex ────────────────────────────────────────────────────────────

    memory.close();
    return { sessionsProcessed: processed, factsSaved: totalSaved, factsSkipped: totalSkipped };
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { }
  }
}

if (require.main === module) {
  run().then(({ sessionsProcessed, factsSaved, factsSkipped }) => {
    console.log(`✅ memory-extract: ${sessionsProcessed} session(s), ${factsSaved} facts saved, ${factsSkipped} skipped`);
    // Report estimated token usage for daemon budget tracking
    // Each session processed ≈ 1 callHaiku invocation ≈ 3k tokens
    const estTokens = sessionsProcessed * 3000;
    if (estTokens > 0) console.log(`__TOKENS__:${estTokens}`);
  }).catch(e => {
    console.error(`[memory-extract] Fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = {
  run,
  extractFacts,
  _private: {
    normalizeConceptList,
    normalizeDomain,
    buildFactLabelRows,
    factFingerprint,
  },
};
