'use strict';

/**
 * Perpetual Task Intent Module
 *
 * Detects when the user wants to interact with perpetual/reactive projects
 * (start research, check progress, manage missions, dispatch to agents).
 *
 * HIGH PRECISION: Only fires on explicit perpetual task verbs + target patterns.
 * Will NOT fire on casual mentions of "研究" in conversational context.
 *
 * @param {string} prompt
 * @param {object} config - daemon.yaml config
 * @param {string} projectKey - current project key
 * @returns {string|null}
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Intent patterns ──
// Each pattern requires BOTH a verb AND a target/context to fire.
// Single words like "研究" alone will NOT trigger — must be paired with action.

const PERPETUAL_INTENTS = [
  {
    // Direct "永续任务" / "perpetual task" / "长期任务" — highest confidence, no verb needed
    pattern: /永续任务|永续.{0,5}(研究|课题|项目)|perpetual.{0,5}task|长期任务|long.?term.{0,5}(task|mission)/i,
    hint: (config) => {
      const bin = path.join(os.homedir(), '.metame', 'bin', 'dispatch_to');
      const reactive = getReactiveProjects(config);
      if (reactive.length === 0) return '[永续任务] 暂无 reactive 项目。在 daemon.yaml 中添加 `reactive: true` 配置。';
      const targets = reactive.map(r => `  ${r.icon} **${r.name}** → \`${bin} ${r.key} "你的任务描述"\``).join('\n');
      return [
        '[永续任务系统]',
        `可用项目:\n${targets}`,
        '命令: `/status perpetual` 查看进度 | `dispatch_to <key> "任务"` 启动',
        'Agent 内部用 NEXT_DISPATCH 派发子任务，MISSION_COMPLETE 结束任务。',
      ].join('\n');
    },
  },
  {
    // User wants to start/launch a perpetual research mission
    // Requires action verb + research/mission target
    pattern: /(开始|启动|开启|launch|start|kick off).{0,15}(研究|课题|实验|mission|research|调研)/i,
    hint: (config) => {
      const bin = path.join(os.homedir(), '.metame', 'bin', 'dispatch_to');
      const reactive = getReactiveProjects(config);
      if (reactive.length === 0) return null;
      const targets = reactive.map(r => `  \`${bin} ${r.key} "开始任务"\``).join('\n');
      return `[永续任务] 启动命令:\n${targets}\n或在 agent 内部用 NEXT_DISPATCH 指令派发子任务。`;
    },
  },
  {
    // User wants to check perpetual project progress
    pattern: /(查看|看看|检查|check).{0,10}(进度|进展|状态|progress|status).{0,10}(研究|课题|永续|perpetual|reactive)?/i,
    hint: () => '[永续任务] `/status perpetual` 查看所有永续项目进度',
  },
  {
    // User wants to see the topic/mission pool
    pattern: /(课题|任务|mission|topic).{0,8}(池|pool|列表|list|队列|queue)/i,
    hint: () => '[永续任务] 查看任务队列: `cat workspace/topics.md`\n管理: `node scripts/topic-pool.js list`',
  },
  {
    // User wants to pause/stop a perpetual project
    pattern: /(暂停|停止|pause|stop).{0,15}(研究|科研|课题|永续|perpetual|reactive)/i,
    hint: () => '[永续任务] 暂停方式:\n- Budget/depth 超限自动暂停\n- 或手动设置 `daemon_state.json` 中 `reactive.<key>.status = "paused"`',
  },
  {
    // User asks about event log or progress history
    pattern: /(事件|event).{0,5}(日志|log)|progress\.tsv|进度日志/i,
    hint: () => '[永续任务] 事件日志: `tail ~/.metame/reactive/<project>/events.jsonl`\n进度表: `cat workspace/progress.tsv`',
  },
];

function getReactiveProjects(config) {
  if (!config || !config.projects) return [];
  return Object.entries(config.projects)
    .filter(([, proj]) => proj && proj.reactive)
    .map(([key, proj]) => ({ key, name: proj.name || key, icon: proj.icon || '' }));
}

// Negative patterns: these look like perpetual intent but are actually
// one-shot skills (deep-research, casual mention, etc.)
const NEGATIVE_PATTERNS = [
  /深度研究|深度调研|deep.?research|调研.{0,5}(一下|下|看看)/i,  // deep-research skill
  /研究.{0,5}(一下|下|看看|这个|那个|怎么)/i,                     // casual "look into this" (Chinese)
  /\bresearch\b.{0,5}\b(this|it|that|the|how|what|why)\b/i,    // casual "research this/how" (English)
  /搜索|搜一下|查一下|google/i,                                  // web search (not English "search" alone)
];

module.exports = function detectPerpetual(prompt, config) {
  const text = String(prompt || '').trim();
  if (!text) return null;

  // Bail early if text matches a negative pattern (one-shot, not perpetual)
  if (NEGATIVE_PATTERNS.some(re => re.test(text))) return null;

  const hints = [];
  for (const intent of PERPETUAL_INTENTS) {
    if (intent.pattern.test(text)) {
      const h = typeof intent.hint === 'function' ? intent.hint(config) : intent.hint;
      if (h) hints.push(h);
    }
  }

  return hints.length > 0 ? hints.join('\n') : null;
};
