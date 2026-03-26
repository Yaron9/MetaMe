'use strict';

/**
 * thread-chat-id.js — Pure utilities for Feishu topic-based session isolation.
 *
 * Composite ID format: "thread:{chatId}:{threadId}"
 *   chatId   = Feishu group chat ID  (e.g. "oc_xxx")
 *   threadId = topic root message ID (e.g. "om_yyy")
 *
 * Zero dependencies. Zero side effects.
 */

const PREFIX = 'thread:';

function buildThreadChatId(chatId, threadId) {
  const c = String(chatId || '').trim();
  const t = String(threadId || '').trim();
  if (!c || !t) return c || '';
  return `${PREFIX}${c}:${t}`;
}

function parseThreadChatId(compositeId) {
  const id = String(compositeId || '');
  if (!id.startsWith(PREFIX)) return null;
  const firstColon = PREFIX.length;
  const secondColon = id.indexOf(':', firstColon);
  if (secondColon === -1) return null;
  const chatId = id.slice(firstColon, secondColon);
  const threadId = id.slice(secondColon + 1);
  if (!chatId || !threadId) return null;
  return { chatId, threadId };
}

function isThreadChatId(id) {
  return typeof id === 'string' && id.startsWith(PREFIX) && parseThreadChatId(id) !== null;
}

/**
 * Extract the raw Feishu chat ID regardless of whether the input
 * is a composite thread ID or a plain chat ID.
 */
function rawChatId(id) {
  const parsed = parseThreadChatId(id);
  return parsed ? parsed.chatId : String(id || '');
}

module.exports = {
  buildThreadChatId,
  parseThreadChatId,
  isThreadChatId,
  rawChatId,
};
