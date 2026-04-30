'use strict';

/**
 * scripts/core/recall-plan.js — pure recall trigger planner (v4.1 §P1.5).
 *
 * Decides whether the current user turn warrants memory recall, and if so
 * derives short anchor labels (NOT raw user text) for downstream search.
 *
 * Pure: no IO, no DB, no daemon imports. Caller passes {text, runtime, scope},
 * gets back a plan object. Step 10 facade consumes the plan; Step 12 daemon
 * audit observe-only writes the plan to recall_audit. The legacy CLI hint in
 * scripts/hooks/intent-memory-recall.js is independent of this module — it
 * remains a string-only shim (Step 11).
 */

const { redactSecretsAndPii } = require('./recall-redact');

// Trigger phrases. Each entry has a reason tag for audit attribution.
const TRIGGER_PATTERNS = [
  { reason: 'explicit-history', re: /(?:上次|前几天|上周|前阵子).{0,6}(?:说|讨论|聊|提到|做|改|写|搞|弄|处理|商量|决定)/ },
  { reason: 'explicit-history', re: /之前.{0,4}(?:说过|讨论过|聊过|提到过|商量过|做过|做的|的决定|的方案)/ },
  { reason: 'explicit-history', re: /(?:还记得|记不记得|记得吗)/ },
  { reason: 'explicit-history', re: /\b(?:last time|previously|remember when|do you remember|earlier we)\b/i },
  { reason: 'decision-recall',  re: /(?:为什么这么(?:定|做|选)|当时怎么(?:决定|定的|想的)|以前怎么处理)/ },
  { reason: 'recurrence',       re: /(?:又(?:出|遇)|再次出|同样的\s*(?:问题|bug|错误)|之前的\s*bug|之前那个\s*bug)/i },
  { reason: 'procedural',       re: /(?:怎么做|流程是|步骤是|以后遇到|复用一下|按之前的)/ },
];

const NON_TRIGGER_PREFIXES = ['/status', '/tasks', '/agent', '/wiki', '/engine', '/help', '/clear'];
const MIN_LENGTH = 4;
const MAX_TEXT_FOR_SCAN = 4000;
const MAX_ANCHORS = 8;

const ANCHOR_PATTERNS = [
  { kind: 'file',    re: /(?:^|[\s,'"`(])([./]?[\w-]+\/[\w./-]+\.(?:js|ts|tsx|jsx|py|md|json|yaml|yml|toml|sql|sh|css|html))(?=$|[\s,'"`)\]:.;])/g },
  { kind: 'fn',      re: /\b((?:[a-z][a-zA-Z0-9]*(?:Item|Memory|Search|Audit|Hint|Recall|Session|Schema|Embed|Wiki))|(?:[a-z][a-zA-Z0-9_]*[A-Z][a-zA-Z0-9]+))\s*\(/g },
  { kind: 'errcode', re: /\b(E[A-Z][A-Z0-9_]{3,}|HTTP\s*\d{3}|SQLITE_[A-Z]+)\b/g },
  { kind: 'config',  re: /\b([a-z][a-zA-Z0-9_]*\.(?:yaml|yml|json|toml|env))\b/g },
];

function _detectTriggers(text) {
  const reasons = [];
  for (const { reason, re } of TRIGGER_PATTERNS) {
    if (re.test(text)) reasons.push(reason);
  }
  return reasons;
}

function _extractAnchors(text) {
  const seen = new Set();
  const labels = [];
  for (const { kind, re } of ANCHOR_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = (m[1] || '').trim();
      if (!raw) continue;
      const redacted = redactSecretsAndPii(`${kind}:${raw}`);
      if (!redacted || seen.has(redacted)) continue;
      seen.add(redacted);
      labels.push(redacted);
      if (labels.length >= MAX_ANCHORS) return labels;
    }
  }
  return labels;
}

function _emptyPlan() {
  return { shouldRecall: false, reason: '', anchors: [], modes: [], hintBudget: 0 };
}

function planRecall({ text, runtime, scope } = {}) {
  if (typeof text !== 'string') return _emptyPlan();
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) return _emptyPlan();
  if (NON_TRIGGER_PREFIXES.some(p => trimmed.startsWith(p))) return _emptyPlan();

  const scanText = trimmed.length > MAX_TEXT_FOR_SCAN ? trimmed.slice(0, MAX_TEXT_FOR_SCAN) : trimmed;

  const reasons = _detectTriggers(scanText);
  const anchors = _extractAnchors(scanText);

  // Recall fires if either an explicit phrase fired, OR multiple anchors were found
  // (anchor-only mode handles "查 daemon-claude-engine.js 的 archiveItem" style asks).
  const shouldRecall = reasons.length > 0 || anchors.length >= 2;
  if (!shouldRecall) return _emptyPlan();

  const reason = reasons[0] || 'anchor-match';

  // Modes: facts always; sessions for explicit history; wiki for procedural;
  // working for any explicit-history or decision-recall.
  const modes = ['facts'];
  if (reasons.includes('explicit-history') || reasons.includes('recurrence')) modes.push('sessions');
  if (reasons.includes('procedural') || reasons.includes('decision-recall')) modes.push('wiki');
  if (reasons.includes('explicit-history') || reasons.includes('decision-recall')) modes.push('working');

  // Soft hint to facade — actual budget enforced by recall-budget.js.
  const hintBudget = Math.min(4000, 800 + 200 * anchors.length);

  return {
    shouldRecall: true,
    reason,
    anchors,
    modes: Array.from(new Set(modes)),
    hintBudget,
    // runtime / scope are informational (daemon may attach to audit row),
    // recall-plan does not enforce them itself.
    _runtime: runtime || null,
    _scope: scope || null,
  };
}

module.exports = { planRecall };
