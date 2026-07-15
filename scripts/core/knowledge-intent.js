'use strict';

const WHY = /(?:为什么|为何|原因|权衡|决策|架构选择|why|rationale|trade[ -]?off|decision|history)/i;
const HOW = /(?:怎么|如何|步骤|流程|操作|排查|调试|修复|回滚|手册|红线|how|sop|debug|troubleshoot|playbook|rollback)/i;

function classifyKnowledgeIntent(query) {
  const text = String(query || '').trim();
  if (!text) return { kind: 'state', artifactKinds: [] };
  if (WHY.test(text)) return { kind: 'why', artifactKinds: ['decision'] };
  if (HOW.test(text)) return { kind: 'how', artifactKinds: ['playbook'] };
  return { kind: 'state', artifactKinds: [] };
}

module.exports = { classifyKnowledgeIntent };
