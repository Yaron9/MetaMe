'use strict';

/**
 * Doc Router Intent Module
 *
 * Detects documentation-oriented intents and routes the model
 * to the right handbook/index with a unified hint format.
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const { createDocRoute } = require('./doc-router');

const routes = [
  createDocRoute({
    patterns: [
      /(?:创建|新建|添加|注册|绑定|配置|管理).{0,8}(?:agent|机器人|bot|智能体)/i,
      /(?:agent|bot|智能体).{0,8}(?:创建|新建|添加|注册|绑定|配置|管理)/i,
      /\b(?:create|add|register|bind|manage|setup|configure)\s+(?:an?\s+)?agent\b/i,
    ],
    title: 'Agent 管理提示',
    docPath: '~/.metame/docs/agent-guide.md',
    summary: '创建/管理/绑定 Agent',
  }),
  createDocRoute({
    patterns: [
      /(?:代码结构|脚本入口|升级进度|模块关系|文件结构)/,
      /(?:pointer.?map|架构图|入口文件)/i,
    ],
    title: '代码结构提示',
    docPath: '~/.metame/docs/pointer-map.md',
    summary: '代码结构/脚本入口/升级进度',
  }),
  createDocRoute({
    patterns: [
      /(?:hook|intent|意图).{0,10}(?:配置|设置|开关|新增|添加|修改|怎么配|怎么设置|怎么改)/i,
      /(?:配置|设置|开关|新增|添加|修改).{0,10}(?:hook|intent|意图)/i,
      /intent.?engine/i,
      /意图引擎|意图模块/,
    ],
    title: 'Intent Engine 配置提示',
    docPath: '~/.metame/docs/hook-config.md',
    summary: 'Hook/Intent 配置操作',
  }),
];

module.exports = function detectDocRouter(prompt) {
  const hints = routes
    .map((detect) => detect(prompt))
    .filter(Boolean);

  return hints.length ? hints.join('\n') : null;
};
