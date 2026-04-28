'use strict';

function extractPathFromText(input) {
  const text = String(input || '');
  const unixMatch = text.match(/(?:~\/|\/|\.\/|\.\.\/)[^\s，。；;!！?？"“”'‘’`]+/);
  if (unixMatch) return unixMatch[0].replace(/[，。；;!！?？]+$/, '');

  const windowsMatch = text.match(/[A-Za-z]:[\\/][^\s，。；;!！?？"“”'‘’`]+/);
  if (windowsMatch) return windowsMatch[0].replace(/[，。；;!！?？]+$/, '');

  return '';
}

function detectCloneIntent(text) {
  if (!text || text.startsWith('/') || text.length < 3) return false;
  const cloneKeywords = ['分身', '再造', '克隆', '副本', '另一个自己', '另一个我'];
  const hasCloneKeyword = cloneKeywords.some(k => text.includes(k));
  if (hasCloneKeyword) {
    const excludePatterns = [/已经/, /存在/, /有了/, /好了/, /完成/, /搞定/, /配置好/, /怎么建/, /如何建/, /方法/, /步骤/];
    if (excludePatterns.some(p => p.test(text))) return false;
    return true;
  }
  const actionKeywords = ['新建', '创建', '造', '做一个', '加一个', '增加', '添加'];
  const hasAction = actionKeywords.some(k => text.includes(k));
  if (hasAction && /分身|数字/.test(text)) return true;
  if (/让.*做分身|叫.*做分身|甲.*做分身/.test(text)) return true;
  return false;
}

function detectTeamIntent(text) {
  if (!text || text.startsWith('/') || text.length < 4) return false;
  if (/走team|用team|通过team|team里|team中|团队里|团队中|走团队|用团队|在team|在团队|team.*已经|团队.*已经|team.*讨论|团队.*讨论/.test(text)) return false;
  if ((text.includes('团队') || text.includes('工作组'))) {
    if (/(新建|创建|造一个|加一个|组建|设置|建|搞)/.test(text)) {
      if (/怎么|如何|方法|步骤/.test(text)) return false;
      return true;
    }
  }
  if (/^(新建|创建|建|搞).*团队/.test(text)) return true;
  return false;
}

function isLikelyDirectAgentAction(input) {
  const text = String(input || '').trim();
  return /^(?:请|帮我|麻烦|给我|给这个群|给当前群|在这个群|把这个群|把当前群|将这个群|这个群|当前群|本群|群里|我想|我要|我需要|创建|新建|新增|搞一个|加一个|create|bind|绑定|列出|查看|显示|有哪些|解绑|取消绑定|断开绑定|修改|调整)/i.test(text);
}

function looksLikeAgentIssueReport(input) {
  const text = String(input || '').trim();
  const hasIssueWords = /(用户反馈|反馈|报错|bug|问题|故障|异常|修复|改一下|修一下|任务|工单|代码)/i.test(text);
  const hasAgentWords = /(agent|智能体|session|会话|目录|工作区|绑定|切换)/i.test(text);
  return hasIssueWords && hasAgentWords;
}

function classifyAgentIntent(input) {
  const text = String(input || '').trim();
  if (!text || text.startsWith('/')) return null;

  const workspaceDir = extractPathFromText(text);
  const hasWorkspacePath = !!workspaceDir;
  const directAction = isLikelyDirectAgentAction(text);
  const issueReport = looksLikeAgentIssueReport(text);
  if (issueReport && !directAction) return null;

  const hasThirdPartyName = /(阿里|百度|腾讯|字节|谷歌|google|openai|微软|microsoft|deepseek|豆包|通义|文心|kimi)/i.test(text);
  const hasAgentWord = /(智能体|agent|助手|机器人)/i.test(text);
  const isAboutOurAgents = /(我的|我们的|当前|这个群|这里的|metame)/i.test(text);
  if (hasThirdPartyName && hasAgentWord && !isAboutOurAgents) return null;

  const hasAgentContext = /(agent|智能体|工作区|人设|绑定|当前群|这个群|chat|workspace)/i.test(text);
  // Question-form prefixes ("如何/怎么/能不能/可以吗") indicate the user is
  // asking ABOUT creating an agent, not requesting one — exclude from create intent.
  const isQuestion = /^(如何|怎么|怎样|能不能|可不可以|可以吗|是否)/i.test(text) || /(吗\?|吗？|\?$|？$)/.test(text);
  const wantsList = /(列出|查看|显示|有哪些|list|show)/i.test(text) && /(agent|智能体|工作区|绑定)/i.test(text);
  const wantsUnbind = /(解绑|取消绑定|断开绑定|unbind|unassign)/i.test(text) && hasAgentContext;
  const wantsEditRole =
    ((/(角色|职责|人设)/i.test(text) && /(改|修改|调整|更新|变成|改成|改为)/i.test(text)) ||
    /(把这个agent|把当前agent|当前群.*角色|当前群.*职责)/i.test(text));
  // Relaxed: a bare "新建 agent" with no path is enough — daemon will derive
  // a default workspace at ~/AGI/<name>/ if no path is given.
  const wantsCreate =
    /(创建|新建|新增|搞一个|加一个|create)/i.test(text)
    && /(agent|智能体|人设|工作区)/i.test(text)
    && !isQuestion;
  const wantsBind =
    !wantsCreate &&
    (/(绑定|bind)/i.test(text) && hasAgentContext && (directAction || hasWorkspacePath));
  const wantsActivate = /(?:在新群|新群里|新群中|目标群|另一个群).{0,12}(激活|activate)|(?:激活|activate).{0,12}(agent|智能体|绑定)|\/activate/i.test(text);
  const wantsReset =
    /(重置|清空|删除).{0,24}(agent|智能体|助手|角色|职责|人设).{0,12}(角色|职责|人设)?/i.test(text) ||
    /(?:角色|职责|人设).{0,12}(重置|清空|删除)/i.test(text) ||
    /\/agent reset/i.test(text);
  const wantsSoul = /(soul|灵魂|身份设定|人格设定)/i.test(text) && /(查看|修复|编辑|修改|更新|repair|edit|show|看)/i.test(text);
  const wantsAgentDoc =
    /(?:agent|智能体|机器人|bot).{0,12}(文档|手册|说明|guide)/i.test(text) ||
    /(?:怎么|如何|手册|文档|说明).{0,12}(配置|管理|使用).{0,12}(agent|智能体|机器人|bot)/i.test(text) ||
    /(?:agent|智能体|机器人|bot).{0,12}(怎么|如何).{0,12}(配置|管理|使用)/i.test(text);

  // wantsCreate is checked BEFORE wantsList so that "新建 agent 用于查看 X"
  // (which contains both 新建 and 查看) is correctly routed to create.
  if (wantsCreate) return { action: 'create', workspaceDir };
  if (wantsList) return { action: 'list', workspaceDir };
  if (wantsUnbind) return { action: 'unbind', workspaceDir };
  if (wantsEditRole) return { action: 'edit_role', workspaceDir };
  if (wantsBind) return { action: 'bind', workspaceDir };
  if (wantsAgentDoc) return { action: 'agent_doc', workspaceDir };
  if (wantsActivate) return { action: 'activate', workspaceDir };
  if (wantsReset) return { action: 'reset', workspaceDir };
  if (wantsSoul) return { action: 'soul', workspaceDir };
  if (detectCloneIntent(text)) return { action: 'wizard_clone', workspaceDir };
  if (detectTeamIntent(text)) return { action: 'wizard_team', workspaceDir };
  return null;
}

module.exports = {
  classifyAgentIntent,
  detectCloneIntent,
  detectTeamIntent,
  extractPathFromText,
};
