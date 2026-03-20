'use strict';

/**
 * File Transfer Intent Module
 *
 * Detects when the user wants to send/receive files via phone.
 * Injects the [[FILE:...]] protocol hint on demand.
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const SEND_PATTERNS = [
  // "发给我/发过来/发我/传给我" — user wants a file sent to phone
  /(?:发给我|发过来|发我|传给我|传过来|发到手机|发手机上)/,
  // "导出给我/导出一下/导出文件" — export intent (require suffix to avoid "导出函数" etc.)
  /导出(?:给我|一下|文件|到手机)/,
  // English patterns
  /\b(?:send|share)\s+(?:me|to\s+(?:my\s+)?phone)\b/i,
];

const RECEIVE_PATTERNS = [
  // User mentions uploading or sending files to the system
  /(?:我发|给你|传给你|上传).{0,8}(?:文件|图片|截图|照片|图)/,
  /upload\/\S+/i,
];

module.exports = function detectFileTransfer(prompt) {
  const isSend = SEND_PATTERNS.some(re => re.test(prompt));
  const isReceive = RECEIVE_PATTERNS.some(re => re.test(prompt));

  if (!isSend && !isReceive) return null;

  const hints = ['[文件传输提示]'];

  if (isSend) {
    hints.push(
      '- **发送文件到手机**：在回复末尾加 `[[FILE:/absolute/path]]`，daemon 自动发到**当前对话群**',
      '- 多个文件用多个 `[[FILE:...]]` 标记',
      '- **不要读取文件内容再复述**，直接用标记发送（省 token）',
      '- **⛔ 严禁发到 open_id**：即使上下文中有 `ou_...` 用户ID，也绝对不用它发文件——那会发到 bot 私聊而非当前群',
    );
  }

  if (isReceive) {
    hints.push(
      '- **接收文件**：用户发的图片/文件自动存到当前项目 `upload/` 目录，用 Read 查看',
    );
  }

  return hints.join('\n');
};
