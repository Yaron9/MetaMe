/**
 * telegram-adapter.js — Zero-dependency Telegram Bot API client
 * Uses only Node built-in https module.
 * Designed as a replaceable interface (future: feishu-adapter.js with same API).
 */

'use strict';

const https = require('https');

const API_BASE = 'https://api.telegram.org';

/**
 * Make an HTTPS request to Telegram Bot API
 */
function apiRequest(token, method, params = {}, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}/bot${token}/${method}`;
    const body = JSON.stringify(params);

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed.result);
          } else {
            reject(new Error(`Telegram API error: ${parsed.description || 'unknown'}`));
          }
        } catch (e) {
          reject(new Error(`Failed to parse Telegram response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram API request timed out'));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Create a Telegram bot instance
 * @param {string} token - Bot token from @BotFather
 * @returns {object} Bot instance with getUpdates, sendMessage, sendMarkdown
 */
function createBot(token) {
  if (!token) throw new Error('Bot token is required');

  return {
    /**
     * Long-poll for updates
     * @param {number} offset - Update offset for acknowledgment
     * @param {number} timeout - Long-poll timeout in seconds (default 30)
     * @returns {Promise<Array>} Array of update objects
     */
    async getUpdates(offset = 0, timeout = 30) {
      try {
        const result = await apiRequest(token, 'getUpdates', {
          offset,
          timeout,
          allowed_updates: ['message', 'callback_query'],
        }, (timeout + 5) * 1000); // HTTP timeout > long-poll timeout
        return result || [];
      } catch (e) {
        // On timeout or network error, return empty — caller retries
        if (e.message.includes('timed out')) return [];
        throw e;
      }
    },

    /**
     * Send a plain text message
     * @param {number|string} chatId - Target chat ID
     * @param {string} text - Message text
     */
    async sendMessage(chatId, text) {
      // Telegram max message length is 4096
      const chunks = splitMessage(text, 4096);
      for (const chunk of chunks) {
        await apiRequest(token, 'sendMessage', {
          chat_id: chatId,
          text: chunk,
        });
      }
    },

    /**
     * Send a markdown-formatted message
     * @param {number|string} chatId - Target chat ID
     * @param {string} markdown - Markdown text
     */
    async sendMarkdown(chatId, markdown) {
      const chunks = splitMessage(markdown, 4096);
      for (const chunk of chunks) {
        try {
          await apiRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: chunk,
            parse_mode: 'Markdown',
          });
        } catch {
          // Fallback to plain text if markdown parsing fails
          await apiRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: chunk,
          });
        }
      }
    },

    /**
     * Get bot info (useful for verifying token)
     */
    async getMe() {
      return apiRequest(token, 'getMe');
    },

    /**
     * Show "typing..." status in chat
     * @param {number|string} chatId - Target chat ID
     */
    async sendTyping(chatId) {
      await apiRequest(token, 'sendChatAction', {
        chat_id: chatId,
        action: 'typing',
      });
    },

    /**
     * Send a message with inline keyboard buttons
     * @param {number|string} chatId
     * @param {string} text
     * @param {Array<Array<{text: string, callback_data: string}>>} buttons - rows of buttons
     */
    async sendButtons(chatId, text, buttons) {
      await apiRequest(token, 'sendMessage', {
        chat_id: chatId,
        text,
        reply_markup: JSON.stringify({ inline_keyboard: buttons }),
      });
    },

    /**
     * Answer a callback query (dismiss the loading indicator on button press)
     */
    async answerCallback(callbackQueryId) {
      await apiRequest(token, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
      });
    },

};
}

/**
 * Split a message into chunks that fit Telegram's limit
 */
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.5) splitIdx = maxLen; // no good newline, hard split
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

module.exports = { createBot };
