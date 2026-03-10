'use strict';

/**
 * Agent Management Intent Module
 *
 * Detects when the user asks about creating, managing, or binding agents,
 * or asks about code structure / upgrade progress.
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const AGENT_MANAGE_PATTERNS = [
  // Creating / binding / managing agents
  /(?:创建|新建|添加|注册|绑定|配置|管理).{0,8}(?:agent|机器人|bot|智能体)/i,
  /(?:agent|bot|智能体).{0,8}(?:创建|新建|添加|注册|绑定|配置|管理)/i,
  // English
  /\b(?:create|add|register|bind|manage|setup|configure)\s+(?:an?\s+)?agent\b/i,
];

const CODE_STRUCTURE_PATTERNS = [
  // Code structure / upgrade / script entry questions
  /(?:代码结构|脚本入口|升级进度|模块关系|文件结构)/,
  /(?:pointer.?map|架构图|入口文件)/i,
];

module.exports = function detectAgentManage(prompt) {
  const isManage = AGENT_MANAGE_PATTERNS.some(re => re.test(prompt));
  const isStructure = CODE_STRUCTURE_PATTERNS.some(re => re.test(prompt));

  if (!isManage && !isStructure) return null;

  const hints = [];

  if (isManage) {
    hints.push(
      '[Agent 管理提示]',
      '- 创建/管理/绑定 Agent → 先 `cat ~/.metame/docs/agent-guide.md` 获取完整流程',
    );
  }

  if (isStructure) {
    hints.push(
      '[代码结构提示]',
      '- 代码结构/脚本入口/升级进度 → 先 `cat ~/.metame/docs/pointer-map.md` 获取索引',
    );
  }

  return hints.join('\n');
};
