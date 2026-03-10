'use strict';

/**
 * Ops Assist Intent Module
 *
 * Detects operational context and injects relevant command hints.
 * Uses specific patterns to avoid noise — only fires when the user
 * is clearly asking about operational topics.
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const OPS_INTENTS = [
  {
    // User explicitly wants to revert/undo code changes.
    // Removed "上一步" (too generic: "上一步的逻辑是什么" is not undo).
    // \b only used around ASCII keywords; Chinese patterns need no word boundary.
    pattern: /(回退|撤销|恢复上一版|回到上一版|回滚)|\b(undo|git reset)\b/i,
    hint: '`/undo` 撤销最近改动 | `/undo <hash>` 回到指定 checkpoint',
  },
  {
    // Save a progress checkpoint — requires explicit "save/create" intent.
    // Removed bare \bcheckpoint\b: fires on any technical mention of the word.
    pattern: /保存.{0,5}(进度|checkpoint|快照|存档)|存个档|打个checkpoint/i,
    hint: '`/checkpoint` 保存当前进度快照',
  },
  {
    // Daemon restart
    pattern: /(重启|restart).{0,10}(daemon|服务|后台)|daemon.{0,10}(挂了|不响应|崩了|没反应|失联)/i,
    hint: '`/restart` 重启 MetaMe daemon',
  },
  {
    // Explicitly asking to view logs
    pattern: /(查看|看看|看下|打开).{0,10}(日志|logs?)|(日志|logs?).{0,10}(在哪|怎么看|如何查)|\b(show|view|check)\s+logs?\b/i,
    hint: '`/logs` 查看最近运行日志',
  },
  {
    // Memory/session cleanup
    pattern: /\bgc\b|垃圾回收|清理.{0,5}(缓存|session|内存)|内存.{0,5}(清理|释放|满了|不够)/i,
    hint: '`/gc` 清理过期 session / 释放内存',
  },
  {
    // System status check
    pattern: /(系统|daemon|服务|agent).{0,5}(状态|运行情况|是否正常|健康状况)|\b(status|health)\b.{0,10}(check|查看)/i,
    hint: '`/status` 查看当前系统状态',
  },
];

module.exports = function detectOpsAssist(prompt) {
  const hits = OPS_INTENTS.filter(({ pattern }) => pattern.test(prompt));
  if (hits.length === 0) return null;
  return ['[运维提示]', ...hits.map(h => `- ${h.hint}`)].join('\n');
};
