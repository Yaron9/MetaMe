'use strict';

const crypto = require('node:crypto');

const HIGH_RISK = /(?:credential|secret|token|password|permission|sudo|shell|exec|network|delete|remove|publish|release|daemon|system|policy|self[-_ ]?modif|凭证|权限|删除|发布|系统|自修改)/i;
const LOW_RISK = /(?:docs?|documentation|example|metadata|description|typo|readme|注释|文档|示例|描述|错别字)/i;

function normalizeSignal(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/\bskills?\b/g, 'skill')
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function evolutionFingerprint(entry) {
  const material = [entry.type, entry.skill_name, entry.search_hint, entry.workflow_sketch_id]
    .map(normalizeSignal).join('|');
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 20);
}

function classifyEvolutionTier(entry) {
  const text = [entry.type, entry.category, entry.reason, entry.insight, entry.search_hint].join(' ');
  if (HIGH_RISK.test(text) || entry.type === 'policy_change') return 3;
  if (LOW_RISK.test(text) || entry.category === 'context') return 1;
  return 2;
}

function initialEvolutionStage(tier) {
  return tier === 1 ? 'auto' : 'proposal';
}

// A pending item that never reached the evidence bar stops being actionable;
// aging it out keeps the queue from accumulating one-off complaints forever.
function isStalePending(item, minEvidence, staleDays, now = Date.now()) {
  if (!item || item.status !== 'pending') return false;
  if ((item.evidence_count || 1) >= minEvidence) return false;
  const seen = new Date(item.last_seen || item.detected || 0).getTime();
  return Number.isFinite(seen) && seen > 0 && now - seen > staleDays * 86400000;
}

module.exports = {
  classifyEvolutionTier, evolutionFingerprint, initialEvolutionStage, isStalePending, normalizeSignal,
};
