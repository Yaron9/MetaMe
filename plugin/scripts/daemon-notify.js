'use strict';

function createNotifier(deps) {
  const { log, getConfig, getBridges } = deps;

  async function notify(message, project = null) {
    const config = getConfig();
    const { telegramBridge, feishuBridge } = getBridges();

    if (feishuBridge && feishuBridge.bot) {
      const chatAgentMap = (config.feishu && config.feishu.chat_agent_map) || {};
      const fsIds = (config.feishu && config.feishu.allowed_chat_ids) || [];
      let targetIds;
      if (project) {
        targetIds = fsIds.filter(id => chatAgentMap[id] === project.key);
        if (targetIds.length === 0) targetIds = fsIds.slice(0, 1);
      } else {
        targetIds = fsIds;
      }
      for (const chatId of targetIds) {
        try {
          if (project && feishuBridge.bot.sendCard) {
            await feishuBridge.bot.sendCard(chatId, {
              title: `${project.icon} ${project.name}`,
              body: message,
              color: project.color,
            });
          } else {
            await feishuBridge.bot.sendMessage(chatId, message);
          }
        } catch (e) {
          log('ERROR', `Feishu notify failed ${chatId}: ${e.message}`);
        }
      }
    }

    if (telegramBridge && telegramBridge.bot) {
      const tgIds = (config.telegram && config.telegram.allowed_chat_ids) || [];
      for (const chatId of tgIds) {
        try { await telegramBridge.bot.sendMarkdown(chatId, message); } catch (e) {
          log('ERROR', `Telegram notify failed ${chatId}: ${e.message}`);
        }
      }
    }
  }

  async function notifyAdmin(message) {
    const config = getConfig();
    const { feishuBridge } = getBridges();
    if (feishuBridge && feishuBridge.bot) {
      const fsIds = (config.feishu && config.feishu.allowed_chat_ids) || [];
      const adminId = fsIds[0];
      if (adminId) {
        try { await feishuBridge.bot.sendMessage(adminId, message); } catch (e) {
          log('ERROR', `Feishu admin notify failed ${adminId}: ${e.message}`);
        }
      }
    }
  }

  return { notify, notifyAdmin };
}

module.exports = { createNotifier };
