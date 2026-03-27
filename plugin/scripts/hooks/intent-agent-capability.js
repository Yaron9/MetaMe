'use strict';

const { classifyAgentIntent } = require('../agent-intent-shared');

function buildLines(action) {
  switch (action) {
    case 'create':
      return [
        '- 创建并绑定当前群：直接用自然语言说“给这个群创建一个 Agent，目录是 ~/repo”',
        '- 创建待激活 Agent：说“创建一个 codex agent，目录是 ~/repo”，再去目标群发 `/activate`',
      ];
    case 'bind':
      return [
        '- 绑定现有 Agent：`/agent bind <名称> <目录>`',
        '- 也可直接说“给这个群绑定一个 Agent，目录是 ~/repo”',
      ];
    case 'list':
      return ['- 查看已配置 Agent：`/agent list`'];
    case 'unbind':
      return ['- 解绑当前群：`/agent unbind`'];
    case 'edit_role':
      return ['- 修改当前 Agent 角色：`/agent edit <描述>`，或直接用自然语言说“把当前 agent 角色改成 ...”'];
    case 'reset':
      return ['- 清空当前 Agent 的角色定义：`/agent reset`'];
    case 'soul':
      return [
        '- 查看当前 Soul：`/agent soul`',
        '- 修复 Soul 文件：`/agent soul repair`',
        '- 覆盖编辑 Soul：`/agent soul edit <内容>`',
      ];
    case 'activate':
      return ['- 在新群完成绑定：进入目标群发送 `/activate`'];
    case 'wizard_clone':
      return ['- 创建当前 Agent 的分身：`/agent new clone`'];
    case 'wizard_team':
      return ['- 创建团队工作区：`/agent new team`'];
    case 'agent_doc':
      return ['- Agent 配置/管理文档：先看 `~/.metame/docs/agent-guide.md`'];
    default:
      return [];
  }
}

module.exports = function detectAgentCapability(prompt) {
  const intent = classifyAgentIntent(prompt);
  if (!intent) return null;

  const lines = buildLines(intent.action);
  if (lines.length === 0) return null;
  return ['[Agent 能力提示]', ...lines].join('\n');
};
