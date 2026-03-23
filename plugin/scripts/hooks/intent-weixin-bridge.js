'use strict';

/**
 * Weixin Bridge Intent Module
 *
 * 按需暴露 MetaMe 的微信桥接能力，只在用户明确谈到微信接入、
 * 扫码登录、测试链路或微信侧为何没反应时注入。
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const POSITIVE_PATTERNS = [
  /(?:微信|wechat).{0,12}(?:接入|接上|接通|联通|联调|测试|试试|能不能用|能否使用|可不可用|怎么用|如何用)/i,
  /(?:微信|wechat).{0,12}(?:扫码|二维码|登录|绑定|授权|bot|bridge|桥接|通道)/i,
  /(?:用|通过).{0,6}(?:微信|wechat).{0,10}(?:聊|对话|发消息|收消息|回复)/i,
  /(?:微信|wechat).{0,12}(?:没反应|不回|收不到|发不出|发不出去|回复不了|登不上)/i,
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
    '- 登录链路：先用 `/weixin login start [--bot-type 3] [--session <key>]` 生成二维码/登录链接，再用 `/weixin login wait --session <key>` 等待绑定完成。',
    '- 查看状态：`/weixin` 或 `/weixin status`。',
    '- 当前最稳的是 **text-only**：收到微信消息后回复文本；媒体、文件、富交互还不是第一优先级。',
    '- 微信出站依赖最近一条入站消息携带的 `context_token`，所以更适合“用户来一句，系统回一句”的对话模式。',
  ].join('\n');
};
