'use strict';

/**
 * Memory Recall Intent Module — string-only shim (v4.1 §P1.14).
 *
 * Surfaces a CLI hint string for the legacy memory-search.js workflow when
 * the user references past conversations. This is INDEPENDENT of the
 * recall channel:
 *
 *   - This shim:           returns a CLI guidance string (or null) for the
 *                          intent-registry pipeline. Prompt-only.
 *   - core/recall-plan.js: produces a structured plan for the daemon to
 *                          assemble actual recall context. Async, audited.
 *
 * The shim MUST NOT require core/recall-plan.js. Phrase patterns may
 * overlap with planRecall by design — they serve different surfaces and
 * evolve independently. PR2 wiring will suppress this shim's output when
 * recall injection actually fires (v4.1 §P1.6 suppressKeys).
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const RECALL_PATTERNS = [
  // "上次/之前/前几天" — referencing past conversations (tight window to avoid current-session refs)
  /(?:上次|前几天|上周|前阵子).{0,6}(?:说|讨论|聊|提到|做|改|写|搞|弄|处理|商量)/,
  // "之前" needs tighter pairing — "之前写了个函数" is current-session, not recall
  /之前.{0,4}(?:说过|讨论过|聊过|提到过|商量过|做过的)/,
  // "还记得/记不记得" — asking if AI remembers (exclude "你记得" which is often imperative)
  /(?:还记得|记不记得|记得吗)/,
  // English recall patterns
  /\b(?:last time|previously|remember when|do you remember|earlier we)\b/i,
];

module.exports = function detectMemoryRecall(prompt) {
  if (!RECALL_PATTERNS.some(re => re.test(prompt))) return null;

  return [
    '[跨会话记忆提示]',
    '- 搜索记忆: `node ~/.metame/memory-search.js "关键词1" "keyword2"`',
    '- 一次传 3-4 个关键词（中文+英文+函数名）',
    '- `--facts` 只搜事实，`--sessions` 只搜会话',
    '- 不要假设工作区里存在 `./memory` 模块；优先走 `memory-search.js` CLI 做召回',
  ].join('\n');
};
