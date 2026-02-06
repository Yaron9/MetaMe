'use strict';

/**
 * utils.js — Pure utility functions extracted for testability.
 */

// ---------------------------------------------------------
// INTERVAL PARSING
// ---------------------------------------------------------
function parseInterval(str) {
  const match = String(str).match(/^(\d+)(s|m|h|d)$/);
  if (!match) return 3600; // default 1h
  const val = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return val;
    case 'm': return val * 60;
    case 'h': return val * 3600;
    case 'd': return val * 86400;
    default: return 3600;
  }
}

// ---------------------------------------------------------
// RELATIVE TIME FORMATTING
// ---------------------------------------------------------
function formatRelativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHour = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  if (diffHour < 24) return `${diffHour}小时前`;
  if (diffDay === 1) return '昨天';
  if (diffDay < 7) return `${diffDay}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

// ---------------------------------------------------------
// PATH SHORTENER (Telegram callback_data 64-byte limit)
// ---------------------------------------------------------
function createPathMap() {
  const map = new Map();
  let counter = 0;

  function shortenPath(fullPath) {
    for (const [k, v] of map) {
      if (v === fullPath) return k;
    }
    const id = 'p' + (++counter);
    map.set(id, fullPath);
    return id;
  }

  function expandPath(idOrPath) {
    return map.get(idOrPath) || idOrPath;
  }

  return { shortenPath, expandPath };
}

module.exports = {
  parseInterval,
  formatRelativeTime,
  createPathMap,
};
