'use strict';

/**
 * daemon-skill-routes.js — keyword → /skillname routing for headless Feishu turns.
 *
 * Native skill triggering needs an interactive session; the daemon spawns
 * engines headless, so deterministic pre-routing lives here. Every route MUST
 * point at a skill that ships in this repo's skills/ directory — the
 * daemon-skill-routes.test.js audit pins that invariant.
 */

function isMacLocalOrchestratorIntent(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return false;

  const hasAutomationVerb = /(?:自动化|脚本|控制|操作|执行|设置|调整|打开|关闭|启动|退出|切到|唤起|锁屏|锁定屏幕|睡眠|休眠|静音|取消静音|调(?:高|低|整)?音量|open|launch|quit|activate|lock\s*screen|sleep|mute|unmute|set\s+volume|run\s+(?:an?\s+)?script)/i.test(text);
  const hasMacTool = /\b(?:mac|macos|applescript|osascript|jxa|hammerspoon|aerospace|yabai|skhd|raycast|launchctl|keyboard maestro|shortcuts)\b/i.test(text);
  const hasMacTarget = /(?:微信|WeChat|飞书|Feishu|Finder|Safari|Terminal|iTerm|系统设置|System Settings|辅助功能|隐私|权限|屏幕录制|自动化|电脑|桌面|访达|System Events|LaunchAgent|快捷指令|锁屏|锁定屏幕|睡眠|休眠|静音|音量|mac)/i.test(text);

  // Require an actual automation ask. Mentioning "macOS" or "权限" alone should not route.
  if (hasMacTool && hasAutomationVerb) return true;

  // Natural-language control only triggers when both the action and the macOS target are explicit.
  return hasAutomationVerb && hasMacTarget;
}

const SKILL_ROUTES = [
  { name: 'macos-mail-calendar', pattern: /邮件|邮箱|收件箱|日历|日程|会议|schedule|email|mail|calendar|unread|inbox/i },
  { name: 'macos-local-orchestrator', match: isMacLocalOrchestratorIntent },
  { name: 'heartbeat-task-manager', pattern: /提醒|remind|闹钟|定时|每[天周月]/i },
  { name: 'skill-manager', pattern: /找技能|管理技能|更新技能|安装技能|skill manager|skill scout|(?:find|look for)\s+skills?/i },
  // Evolution/retro asks route to skill-creator, whose skill covers evolve/
  // record-experience flows. (Former target `skill-evolution-manager` never
  // existed as a skill — dead route fixed in plan P3.4.)
  { name: 'skill-creator', pattern: /\/evolve\b|复盘一下|记录一下(这个)?经验|保存到\s*skill|skill evolution/i },
  // (?<!转) excludes "转发" forwarding semantics (e.g. "把这条消息转发给我")
  // which is conversation relay, not file delivery.
  { name: 'send-to-user', pattern: /(?<!转)发(?:到|给|出)?\s*(?:我|手机|飞书)|发(?:个|条|份)?\s*(?:文件|附件|图(?:片)?|日志|压缩包|截图|csv|pdf|zip|excel|表格)|(?<!转)发我|给我(?:下载|发个|发份)|send\s+(?:me|file|attachment|to\s+me)|push\s+(?:to\s+)?(?:me|phone|file)|attach\s+file/i },
];

function routeSkill(prompt) {
  for (const r of SKILL_ROUTES) {
    const matched = typeof r.match === 'function'
      ? r.match(prompt)
      : (r.pattern ? r.pattern.test(prompt) : false);
    if (matched) return r.name;
  }
  return null;
}

/** Return route targets that are not in the given installed-skill name list. */
function findUnknownRouteTargets(skillNames) {
  const installed = new Set(skillNames || []);
  return SKILL_ROUTES.map(r => r.name).filter(name => !installed.has(name));
}

module.exports = { SKILL_ROUTES, routeSkill, isMacLocalOrchestratorIntent, findUnknownRouteTargets };
