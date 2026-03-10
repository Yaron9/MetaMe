'use strict';

/**
 * Hook Config Intent Module
 *
 * Detects when the user asks about hook/intent engine configuration.
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const HOOK_PATTERNS = [
  // Hook / intent configuration
  /(?:hook|intent|意图).{0,10}(?:配置|设置|开关|新增|添加|修改|怎么配|怎么设置|怎么改)/i,
  /(?:配置|设置|开关|新增|添加|修改).{0,10}(?:hook|intent|意图)/i,
  // Specific intent engine topics
  /intent.?engine/i,
  /意图引擎|意图模块/,
];

module.exports = function detectHookConfig(prompt) {
  if (!HOOK_PATTERNS.some(re => re.test(prompt))) return null;

  return [
    '[Intent Engine 配置提示]',
    '- Hook/Intent 配置操作 → 先 `cat ~/.metame/docs/hook-config.md` 获取完整手册',
  ].join('\n');
};
