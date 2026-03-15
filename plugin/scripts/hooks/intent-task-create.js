'use strict';

/**
 * Task Create Intent Module
 *
 * Detects scheduling/reminder intent and injects task creation hints.
 * Requires explicit scheduling language to avoid false positives.
 *
 * @param {string} prompt
 * @returns {string|null}
 */

const TASK_PATTERNS = [
  // Explicit recurring schedule: 每天/每小时/... + action
  /(每天|每小时|每周|每月|每.{1,4}分钟).{0,20}(提醒|通知|运行|执行|做|检查)/,
  // "提醒我" must be paired with time/frequency context to avoid false positives
  // e.g. "提醒我明天九点" ✓ / "提醒我这个要注意" ✗
  /提醒我.{0,15}(每天|每周|每小时|[0-9０-９]|明天|后天|下周|点钟|分钟|小时)|\bremind me\b.{0,20}(every|daily|at \d|\btomorrow\b)|\bset.{0,5}reminder\b/i,
  // Scheduling keywords
  /定时任务|\bheartbeat.{0,5}task\b|\bcron job\b/i,
  // "每天X点提醒" pattern
  /每天.{0,10}[0-9０-９点时].{0,10}(提醒|通知|叫我)/,
  // "下次别忘了 / 帮我记住 + 周期性语境"
  /下次.{0,8}(别忘|记得|提醒)|帮我.{0,5}记住.{0,10}(每|定期|以后)/,
];

module.exports = function detectTaskCreate(prompt) {
  if (!TASK_PATTERNS.some(re => re.test(prompt))) return null;
  return [
    '[任务调度提示]',
    '- 定时任务: `/task-add "描述" --at "09:00" --every day`',
    '- 一次性提醒: `/task-add "描述" --once --in "30m"`',
    '- 查看任务列表: `/tasks`',
  ].join('\n');
};
