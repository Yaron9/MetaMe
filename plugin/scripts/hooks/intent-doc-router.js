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

const AGENT_DOC_PATTERNS = [
  /(?:agent|智能体|机器人|bot).{0,12}(文档|手册|说明|guide)/i,
  /(?:怎么|如何|手册|文档|说明).{0,12}(配置|管理|使用).{0,12}(agent|智能体|机器人|bot)/i,
  /(?:agent|智能体|机器人|bot).{0,12}(怎么|如何).{0,12}(配置|管理|使用)/i,
];

const routes = [
  createDocRoute({
    patterns: AGENT_DOC_PATTERNS,
    title: 'Agent 文档提示',
    docPath: '~/.metame/docs/agent-guide.md',
    summary: 'Agent 配置/管理/使用说明',
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
      /(?:hook|intent|意图).{0,10}(?:配置|设置|开关|新增|添加|修改|怎么配|怎么设置|怎么改|原理)/i,
      /(?:配置|设置|开关|新增|添加|修改|原理).{0,10}(?:hook|intent|意图)/i,
      /intent.?engine/i,
      /意图引擎|意图模块/,
    ],
    title: 'Intent Engine 配置提示',
    docPath: '~/.metame/docs/hook-config.md',
    summary: 'Hook/Intent 配置操作',
  }),
];

function hasExplicitDocIntent(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return false;
  return AGENT_DOC_PATTERNS.some((pattern) => pattern.test(text)) ||
    /(?:文档|手册|说明|guide|readme)/i.test(text);
}

function detectDocRouter(prompt) {
  const hints = routes
    .map((detect) => detect(prompt))
    .filter(Boolean);

  return hints.length ? hints.join('\n') : null;
}

module.exports = detectDocRouter;
module.exports.hasExplicitDocIntent = hasExplicitDocIntent;
