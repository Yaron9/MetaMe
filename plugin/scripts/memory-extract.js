#!/usr/bin/env node

/**
 * memory-extract.js — Independent Memory Extraction
 *
 * Scans unanalyzed Claude Code sessions and extracts atomic facts
 * into memory.db. Runs independently of raw_signals.jsonl so that
 * pure technical sessions (no preference signals) are still captured.
 *
 * Designed to run as a standalone heartbeat task every 30 minutes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { callHaiku, buildDistillEnv } = require('./providers');

const HOME = os.homedir();
const LOCK_FILE = path.join(HOME, '.metame', 'memory-extract.lock');

// Atomic fact extraction prompt (local copy — distill.js no longer exports this)
const FACT_EXTRACTION_PROMPT = `你是精准的知识提取引擎。从以下会话骨架中提取「值得长期记住的原子事实」。

提取类型（必须是以下之一）：
- tech_decision（技术决策：为什么选A不选B）
- bug_lesson（Bug根因：什么设计/假设导致了问题）
- arch_convention（架构约定：系统组件的行为边界）
- config_fact（配置事实：某个值的真实含义，尤其反直觉的）
- config_change（配置变更：用户选择/确认了某个具体配置值，如”字体选了x-large”、”间隔改为2h”）
- user_pref（用户明确表达的偏好/红线）
- workflow_rule（工作流戒律：如”不要在某情况下做某事”的反常识流）
- project_milestone（项目里程碑：主要架构重构、版本发布等跨会话级成果）

绝对不提取：
- 过程性描述（"用户问了X"、"我们讨论了Y"）
- 临时状态（"当前正在..."、"这次会话..."）
- 未经验证的猜测（"可能是因为..."、"也许..."）
- 显而易见的常识

输出 JSON 对象，包含会话名称和提取的事实：
{
  "session_name": "用3-5个词极其精简地概括这起会话的主题（例如：优化微信登录架构、排查Redis连接泄漏、配置Nginx反向代理）",
  "facts": [
    {"entity":"主体(点号层级如MetaMe.daemon.askClaude)","relation":"类型","value":"脱离上下文可独立理解的一句话","confidence":"high或medium","tags":["最多3个标签"]}
  ]
}

规则：
- 宁缺毋滥：0条比10条废话好
- value必须包含足够上下文，不能写"这个问题"、"上面说的"
- value长度20-200字
- entity用英文点号路径，value可用中文
- medium confidence必须有非空tags
- 没有值得提取的事实时 facts 返回 []

只输出JSON对象，不要解释。

会话骨架：
{{SKELETON}}`.trim();

const SESSION_TAGS_FILE = path.join(os.homedir(), '.metame', 'session_tags.json');

/**
 * Persist session name and derived tags to ~/.metame/session_tags.json.
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

const VAGUE_PATTERNS = [
  /^用户(问|提|说|提到)/, /^我们(讨论|分析|查看)/,
  /这个问题/, /上面(提到|说的|的)/, /可能是因为/,
  /也许|或许|大概/, /当前正在|目前在/, /这次会话/,
];
const ALLOWED_FLAT = new Set(['王总', 'system', 'user']);

/**
 * Extract atomic facts from a session skeleton via Haiku.
 * Returns filtered fact array (may be empty).
 */
async function extractFacts(skeleton, sessionSummary, distillEnv) {
  const skeletonText = JSON.stringify({ skeleton, sessionSummary }, null, 2).slice(0, 3000);
  const prompt = FACT_EXTRACTION_PROMPT.replace('{{SKELETON}}', skeletonText);

  let raw;
  try {
    raw = await Promise.race([
      callHaiku(prompt, distillEnv, 60000),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 65000)),
    ]);
  } catch (e) {
    console.log(`[memory-extract] Haiku call failed: ${e.message} | code:${e.code} killed:${e.killed} stdout:${String(e.stdout || '').slice(0, 100)} stderr:${String(e.stderr || '').slice(0, 100)}`);
    return [];
  }

  let parsed;
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { facts: [], session_name: "未命名会话" };
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

  return { facts: filteredFacts, session_name };
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
  } catch {
    console.log('[memory-extract] session-analytics not available, exiting.');
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

    const sessions = sessionAnalytics.findAllUnextractedSessions(8);
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

        const { facts, session_name } = await extractFacts(skeleton, null, distillEnv);

        if (facts.length > 0) {
          const { saved, skipped } = memory.saveFacts(
            skeleton.session_id,
            skeleton.project || 'unknown',
            facts
          );
          totalSaved += saved;
          totalSkipped += skipped;
          console.log(`[memory-extract] Session ${skeleton.session_id.slice(0, 8)}: ${saved} facts saved, ${skipped} skipped`);
        } else {
          console.log(`[memory-extract] Session ${skeleton.session_id.slice(0, 8)} (${session_name}): no facts extracted`);
        }

        sessionAnalytics.markFactsExtracted(skeleton.session_id);

        // P2-A: persist session name + tags to session_tags.json
        saveSessionTag(skeleton.session_id, session_name, facts);

        processed++;
      } catch (e) {
        console.log(`[memory-extract] Session error: ${e.message}`);
      }
    }

    memory.close();
    return { sessionsProcessed: processed, factsSaved: totalSaved, factsSkipped: totalSkipped };
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch { }
  }
}

if (require.main === module) {
  run().then(({ sessionsProcessed, factsSaved, factsSkipped }) => {
    console.log(`✅ memory-extract: ${sessionsProcessed} session(s), ${factsSaved} facts saved, ${factsSkipped} skipped`);
  }).catch(e => {
    console.error(`[memory-extract] Fatal: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { run, extractFacts };
