'use strict';

/**
 * Weixin Bridge Intent Module
 *
 * 按需暴露 MetaMe 的微信桥接配置能力，只在用户明确谈到微信接入、
 * 开启桥接、扫码登录、绑定配置或微信 direct bridge 时注入。
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const POSITIVE_PATTERNS = [
  /(?:帮我|请|想|要|需要|如何|怎么).{0,10}(?:配置|绑定|接入|接上|开通|启用).{0,10}(?:微信|wechat)(?:.{0,10}(?:bridge|桥接|bot|通道))?/i,
  /(?:微信|wechat).{0,12}(?:配置|绑定|接入|接上|开通|启用|扫码|二维码|登录|授权|bridge|桥接|bot|通道)/i,
  /(?:开始|发起).{0,8}(?:微信|wechat).{0,10}(?:扫码|二维码|登录|绑定|授权)/i,
  /(?:用|通过).{0,6}(?:微信|wechat).{0,10}(?:聊|对话|发消息|收消息|回复)/i,
];
const NEGATIVE_PATTERNS = [
  /企业微信|wecom/i,
  /微信群|群聊|group/i,
];

module.exports = function detectWeixinBridge(prompt) {
  const text = String(prompt || '').trim();
  if (!text || text.length < 4) return null;
  if (NEGATIVE_PATTERNS.some(re => re.test(text))) return null;
  if (!POSITIVE_PATTERNS.some(re => re.test(text))) return null;

  return [
    '[微信桥接提示]',
    '- 当前已接入 MetaMe 的是 **微信 direct bridge**，不是企业微信。',
    '- 如果用户是在让你代为配置，先确保 `~/.metame/daemon.yaml` 里的 `weixin.enabled=true`，`weixin.bot_type=\"3\"`，其余可先保持默认。',
    '- 开启配置后，执行 `/weixin login start [--bot-type 3] [--session <key>]` 生成二维码/登录链接。',
    '- 用户扫码确认后，再执行 `/weixin login wait --session <key>` 等待绑定完成。',
    '- 查看状态：`/weixin` 或 `/weixin status`。',
    '- 当前最稳的是 **text-only**：收到微信消息后回复文本；媒体、文件、富交互还不是第一优先级。',
    '- 微信出站依赖最近一条入站消息携带的 `context_token`，所以更适合“用户来一句，系统回一句”的对话模式。',
  ].join('\n');
};
