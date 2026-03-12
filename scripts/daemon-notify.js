'use strict';

function resolveAdminChatId(adapterConfig = {}) {
  const explicitId = String(adapterConfig.admin_chat_id || '').trim();
  if (explicitId) return explicitId;
  const ids = Array.isArray(adapterConfig.allowed_chat_ids) ? adapterConfig.allowed_chat_ids : [];
  return ids[0] || null;
}

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
    const { feishuBridge, telegramBridge } = getBridges();
    if (feishuBridge && feishuBridge.bot) {
      const adminId = resolveAdminChatId(config.feishu || {});
      if (adminId) {
        try { await feishuBridge.bot.sendMessage(adminId, message); } catch (e) {
          log('ERROR', `Feishu admin notify failed ${adminId}: ${e.message}`);
        }
      }
    }
    if (telegramBridge && telegramBridge.bot) {
      const adminId = resolveAdminChatId(config.telegram || {});
      if (adminId) {
        try { await telegramBridge.bot.sendMarkdown(adminId, message); } catch (e) {
          log('ERROR', `Telegram admin notify failed ${adminId}: ${e.message}`);
        }
      }
    }
  }

  /**
   * Send only to personal (non-agent-bound) chat IDs.
   * Agent-bound group chats (those in chat_agent_map) are excluded.
   * Falls back to fsIds[0] if no personal chats are found.
   * Used for system notifications that should not spam every agent group.
   */
  async function notifyPersonal(message) {
    const config = getConfig();
    const { telegramBridge, feishuBridge } = getBridges();

    if (feishuBridge && feishuBridge.bot) {
      const chatAgentMap = (config.feishu && config.feishu.chat_agent_map) || {};
      const fsIds = (config.feishu && config.feishu.allowed_chat_ids) || [];
      // Personal chats = allowed IDs not bound to any agent
      const personalIds = fsIds.filter(id => !chatAgentMap[id]);
      const targetIds = personalIds.length > 0 ? personalIds : fsIds.slice(0, 1);
      for (const chatId of targetIds) {
        try { await feishuBridge.bot.sendMessage(chatId, message); } catch (e) {
          log('ERROR', `Feishu personal notify failed ${chatId}: ${e.message}`);
        }
      }
    }

    if (telegramBridge && telegramBridge.bot) {
      const tgAgentMap = (config.telegram && config.telegram.chat_agent_map) || {};
      const tgIds = (config.telegram && config.telegram.allowed_chat_ids) || [];
      const personalIds = tgIds.filter(id => !tgAgentMap[id]);
      const targetIds = personalIds.length > 0 ? personalIds : tgIds.slice(0, 1);
      for (const chatId of targetIds) {
        try { await telegramBridge.bot.sendMarkdown(chatId, message); } catch (e) {
          log('ERROR', `Telegram personal notify failed ${chatId}: ${e.message}`);
        }
      }
    }
  }

  return { notify, notifyAdmin, notifyPersonal };
}

module.exports = { createNotifier, resolveAdminChatId };
