'use strict';

const fs = require('fs');
const path = require('path');
const { createLinkOrMirror } = require('./agent-layer');

function resolveCloneParentCwd({ isClone, loadConfig, chatId, normalizeCwd }) {
  if (!isClone) return null;
  const cfg = loadConfig();
  const agentMap = {
    ...(cfg && cfg.telegram ? cfg.telegram.chat_agent_map : {}),
    ...(cfg && cfg.feishu ? cfg.feishu.chat_agent_map : {}),
  };
  const boundKey = agentMap[String(chatId)];
  const boundProj = boundKey && cfg.projects && cfg.projects[boundKey];
  return boundProj && boundProj.cwd ? normalizeCwd(boundProj.cwd) : null;
}

function stampFlow(flow) {
  return { ...flow, __ts: Date.now() };
}

function inheritParentAgentContext({ fs, path, childCwd, parentCwd }) {
  const childClaudeMd = path.join(childCwd, 'CLAUDE.md');
  const childSoulMd = path.join(childCwd, 'SOUL.md');
  const parentClaudeMd = parentCwd ? path.join(parentCwd, 'CLAUDE.md') : '';
  const parentSoulMd = parentCwd ? path.join(parentCwd, 'SOUL.md') : '';

  const result = {
    inheritedClaude: false,
    inheritedSoul: false,
    created: false,
  };

  if (parentClaudeMd && fs.existsSync(parentClaudeMd)) {
    createLinkOrMirror(parentClaudeMd, childClaudeMd);
    result.inheritedClaude = true;
    result.created = true;
  }
  if (parentSoulMd && fs.existsSync(parentSoulMd)) {
    createLinkOrMirror(parentSoulMd, childSoulMd);
    result.inheritedSoul = true;
    result.created = true;
  }
  return result;
}

async function startNewAgentWizard({
  bot,
  chatId,
  secondArg,
  pendingTeamFlows,
  pendingAgentFlows,
  loadConfig,
  normalizeCwd,
  sendBrowse,
  HOME,
}) {
  if (secondArg === 'team') {
    if (!pendingTeamFlows) {
      await bot.sendMessage(chatId, '❌ 团队向导暂不可用');
      return true;
    }
    pendingTeamFlows.set(String(chatId), stampFlow({ step: 'name' }));
    await bot.sendMessage(chatId, `🏗️ **团队创建向导**

请输入团队名称（如：短剧团队、销售团队）：

输入 /cancel 可取消`);
    return true;
  }

  const isClone = secondArg === 'clone';
  const parentCwd = resolveCloneParentCwd({
    isClone,
    loadConfig,
    chatId,
    normalizeCwd,
  });
  pendingAgentFlows.set(String(chatId), stampFlow({ step: 'dir', isClone, parentCwd }));
  const hint = isClone ? `（${parentCwd ? '分身模式：将继承父 Agent 上下文' : '⚠️ 当前群未绑定 Agent'})` : '';
  await sendBrowse(bot, chatId, 'agent-new', HOME, `${isClone ? '步骤1/2' : '步骤1/3'}：选择 Agent 的工作目录${hint}`);
  return true;
}

async function completeAgentCreation({
  bot,
  chatId,
  flow,
  description,
  createWorkspaceAgent,
  doBindAgent,
  mergeAgentRole,
}) {
  const { dir, name, isClone, parentCwd } = flow;
  await bot.sendMessage(chatId, `⏳ 正在配置 Agent「${name}」，稍等...`);
  try {
    let createResult;
    if (typeof createWorkspaceAgent === 'function') {
      createResult = await createWorkspaceAgent({
        chatId,
        agentName: name,
        workspaceDir: dir,
        roleDescription: isClone ? '' : description,
      });
    } else {
      await doBindAgent(bot, chatId, name, dir);
      createResult = { ok: true, data: {} };
    }
    if (!createResult || createResult.ok === false) {
      await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${(createResult && createResult.error) || 'unknown error'}`);
      return true;
    }
    const mergeResult = isClone
      ? inheritParentAgentContext({ fs, path, childCwd: dir, parentCwd })
      : (createResult.data && createResult.data.role
        ? createResult.data.role
        : await mergeAgentRole(dir, description, isClone, parentCwd));
    if (mergeResult && mergeResult.error) {
      await bot.sendMessage(chatId, `⚠️ CLAUDE.md 合并失败: ${mergeResult.error}，其他配置已保存`);
    } else if (isClone) {
      await bot.sendMessage(
        chatId,
        `🧬 已继承父 Agent 上下文${mergeResult && mergeResult.inheritedSoul ? '（含 Soul）' : ''}\n✅ Agent「${name}」创建完成`
      );
    } else if (mergeResult && mergeResult.created) {
      await bot.sendMessage(chatId, `📝 已创建 CLAUDE.md\n✅ Agent「${name}」创建完成`);
    } else {
      await bot.sendMessage(chatId, `📝 已更新 CLAUDE.md\n✅ Agent「${name}」创建完成`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ 创建 Agent 失败: ${e.message}`);
  }
  return true;
}

function readAgentRolePreview({ fs, path, cwd }) {
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  let currentContent = '（CLAUDE.md 不存在）';
  if (fs.existsSync(claudeMdPath)) {
    currentContent = fs.readFileSync(claudeMdPath, 'utf8');
    if (currentContent.length > 500) currentContent = currentContent.slice(0, 500) + '\n...(已截断)';
  }
  return currentContent;
}

function resetAgentRoleSection({ fs, path, cwd }) {
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    return { ok: true, status: 'missing' };
  }

  const before = fs.readFileSync(claudeMdPath, 'utf8');
  const after = before
    .replace(/(?:^|\n)##\s+[^\n]*(?:角色|职责|人设)[^\n]*\n[\s\S]*?(?=\n## |$)/g, '')
    .replace(/(?:^|\n)## Agent 角色\n[\s\S]*?(?=\n## |$)/g, '')
    .trimStart();
  if (after === before.trimStart()) {
    return { ok: true, status: 'unchanged' };
  }

  fs.writeFileSync(claudeMdPath, after, 'utf8');
  return { ok: true, status: 'reset' };
}

async function handleSoulCommand({
  bot,
  chatId,
  soulAction,
  soulText,
  cwd,
  fs,
  path,
  agentTools,
}) {
  const soulPath = path.join(cwd, 'SOUL.md');

  if (soulAction === 'repair') {
    if (!agentTools || typeof agentTools.repairAgentSoul !== 'function') {
      await bot.sendMessage(chatId, '❌ agentTools 不可用');
      return true;
    }
    const res = await agentTools.repairAgentSoul(cwd);
    if (!res.ok) {
      await bot.sendMessage(chatId, '❌ Soul 修复失败: ' + res.error);
      return true;
    }
    const viewModes = res.data.views
      ? Object.entries(res.data.views).map(([k, v]) => k + ':' + v).join(', ')
      : '—';
    await bot.sendMessage(chatId, [
      '✅ Agent Soul 层已就绪',
      'agent_id: ' + res.data.agentId,
      '链接方式: ' + viewModes,
      '',
      '文件位置:',
      '  SOUL.md   → ~/.metame/agents/' + res.data.agentId + '/soul.md',
      '  MEMORY.md → ~/.metame/agents/' + res.data.agentId + '/memory-snapshot.md',
    ].join('\n'));
    return true;
  }

  if (soulAction === 'edit') {
    if (!soulText) {
      await bot.sendMessage(chatId, '用法: /agent soul edit <新内容>\n当前内容: /agent soul');
      return true;
    }
    try {
      fs.writeFileSync(soulPath, soulText, 'utf8');
      await bot.sendMessage(chatId, '✅ SOUL.md 已更新');
    } catch (e) {
      await bot.sendMessage(chatId, '❌ 写入失败: ' + e.message);
    }
    return true;
  }

  if (!fs.existsSync(soulPath)) {
    await bot.sendMessage(chatId, [
      '⚠️ SOUL.md 不存在',
      '',
      '老项目或刚绑定的 Agent 可能尚未建立 Soul 层。',
      '运行 /agent soul repair 自动生成。',
    ].join('\n'));
    return true;
  }

  try {
    const soulContent = fs.readFileSync(soulPath, 'utf8').trim().slice(0, 2000);
    await bot.sendMessage(chatId, '📋 当前 Soul:\n\n' + soulContent);
  } catch (e) {
    await bot.sendMessage(chatId, '❌ 读取 SOUL.md 失败: ' + e.message);
  }
  return true;
}

module.exports = {
  resolveCloneParentCwd,
  startNewAgentWizard,
  completeAgentCreation,
  readAgentRolePreview,
  resetAgentRoleSection,
  handleSoulCommand,
};
