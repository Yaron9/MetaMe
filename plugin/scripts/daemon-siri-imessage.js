'use strict';
/**
 * daemon-siri-imessage.js — iMessage I/O layer
 *
 * 底层函数：轮询 chat.db + AppleScript 发送。
 * 上层 Bridge 逻辑在 daemon-bridges.js 的 startImessageBridge()。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const CHAT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

// macOS Ventura+: text may be stored in attributedBody blob, not text field.
// Returns TSV rows:
//   rowid\ttext\tsender\tchat_guid\tchat_identifier\tchat_name
//
// Key filters:
//   1. is_from_me=0 in SQL WHERE clause is the primary echo guard.
//   2. local_guids filter REMOVED: in self-chat (note-to-self), all incoming messages
//      share the Mac's account_guid, so the old filter blocked everything.
//      Echo prevention is now handled by content fingerprint in createImessageBot.
//   3. Drop reactions/system/service messages so tapbacks never become prompts.
const PYTHON_QUERY = `
import sqlite3,os,re,sys
db=os.path.expanduser('~/Library/Messages/chat.db')
con=sqlite3.connect(db)
rows=con.execute("""
  SELECT
    m.rowid,
    m.text,
    m.attributedBody,
    h.id,
    c.guid,
    c.chat_identifier,
    coalesce(c.display_name, c.room_name, c.chat_identifier, c.guid, ''),
    coalesce(m.account_guid, ''),
    coalesce(m.associated_message_guid, ''),
    coalesce(m.associated_message_type, 0),
    coalesce(m.associated_message_emoji, ''),
    coalesce(m.is_system_message, 0),
    coalesce(m.is_service_message, 0),
    coalesce(m.item_type, 0)
  FROM message m
  LEFT JOIN handle h ON m.handle_id=h.rowid
  LEFT JOIN chat_message_join cmj ON cmj.message_id=m.rowid
  LEFT JOIN chat c ON c.rowid=cmj.chat_id
  WHERE m.rowid > ? AND m.is_from_me = 0
  ORDER BY m.rowid ASC LIMIT 20
""",(int(sys.argv[1]),)).fetchall()
seen=set()
for rowid,text,body,sender,chat_guid,chat_identifier,chat_name,account_guid,assoc_guid,assoc_type,assoc_emoji,is_system,is_service,item_type in rows:
    if assoc_guid or assoc_type or assoc_emoji or is_system or is_service or item_type:
        continue
    if not text and body:
        decoded=body.decode('utf-8','ignore')
        m=re.search(r'[\\x20-\\x7e\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef]{2,}',decoded)
        if m: text=m.group(0).strip()
    if text and text.strip():
        key=(rowid, chat_guid or chat_identifier or sender or '')
        if key in seen:
            continue
        seen.add(key)
        print(
            str(rowid)+'\\t'
            +str(text).replace('\\n',' ')+'\\t'
            +(sender or '')+'\\t'
            +(chat_guid or '')+'\\t'
            +(chat_identifier or '')+'\\t'
            +str(chat_name or '').replace('\\n',' ')
        )
`.trim();

function isAvailable() {
  return fs.existsSync(CHAT_DB);
}

function getMaxRowId() {
  try {
    return parseInt(
      execFileSync('sqlite3', [CHAT_DB, 'SELECT MAX(rowid) FROM message;'],
        { encoding: 'utf8', timeout: 5000 }).trim(), 10
    ) || 0;
  } catch { return 0; }
}

function queryNewMessages(lastRowId) {
  try {
    return execFileSync('python3', ['-c', PYTHON_QUERY, String(lastRowId)],
      { encoding: 'utf8', timeout: 8000 }).trim();
  } catch { return ''; }
}

function escapeAppleScriptString(input) {
  return String(input || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

// Send iMessage via AppleScript; targetChatId should be chat.id / chat.guid.
function sendImessage(targetChatId, text) {
  return new Promise((resolve) => {
    const safe = escapeAppleScriptString(text);
    const safeChatId = escapeAppleScriptString(targetChatId);
    const script = [
      'tell application "Messages"',
      `  send "${safe}" to chat id "${safeChatId}"`,
      'end tell',
    ].join('\n');
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err) => resolve(!err));
  });
}

// Create a bot object compatible with handleCommand / daemon-claude-engine.
//
// Design goals for iMessage:
//   1. No intermediate status spam — buffer all sends, flush only the final text.
//   2. Prevent echo loop — track recently-sent content fingerprints.
//   3. editMessage returns true (pretend success) so engine doesn't double-send.
function createImessageBot(targetChatId, log) {
  let flushTimer = null;
  let pendingText = '';
  // onAfterSend: bridge injects this to advance lastRowId after we send
  let _onAfterSend = null;

  // Echo fingerprint ring — stores { text, ts } of recently sent messages.
  // Used by bridge to detect and skip echoed incoming messages.
  const sentFingerprints = [];
  const FINGERPRINT_TTL = 30000; // 30s window

  const addFingerprint = (text) => {
    const now = Date.now();
    sentFingerprints.push({ text: text.trim().toLowerCase().replace(/\s+/g, ' '), ts: now });
    // Prune expired entries
    while (sentFingerprints.length && sentFingerprints[0].ts < now - FINGERPRINT_TTL) {
      sentFingerprints.shift();
    }
  };

  const isEcho = (text) => {
    const now = Date.now();
    const needle = text.trim().toLowerCase().replace(/\s+/g, ' ');
    for (let i = sentFingerprints.length - 1; i >= 0; i--) {
      const fp = sentFingerprints[i];
      if (fp.ts < now - FINGERPRINT_TTL) break;
      // Prefix match: echo may have trailing whitespace or truncation differences
      if (fp.text === needle || needle.startsWith(fp.text.slice(0, 20)) || fp.text.startsWith(needle.slice(0, 20))) return true;
    }
    return false;
  };

  const scheduleFlush = (text) => {
    if (flushTimer) clearTimeout(flushTimer);
    pendingText = text;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      const final = pendingText;
      pendingText = '';
      if (!final) return;
      const tagged = `🤖 ${final}`;
      addFingerprint(tagged);
      const ok = await sendImessage(targetChatId, tagged);
      if (!ok && log) log('WARN', `[IMESSAGE] send failed to ${targetChatId}`);
      // After sending, advance lastRowId so the echo is skipped
      if (_onAfterSend) _onAfterSend();
    }, 3000); // wait 3s for streaming to settle before sending
  };

  // Record fingerprint IMMEDIATELY on send/edit calls — not in flush timer.
  // This ensures the echo is recognized even if poll runs before flush fires.
  const sendAndFingerprint = (text) => {
    if (text) {
      addFingerprint(text);
      scheduleFlush(text);
    }
  };

  const bot = {
    suppressAck: true,
    isEcho,
    sendMessage: (_chatId, text) => {
      const plain = String(text || '').replace(/[*_`~]/g, '').trim();
      sendAndFingerprint(plain);
      return Promise.resolve({ message_id: Date.now() });
    },
    sendMarkdown: (_chatId, text) => {
      const plain = String(text || '').replace(/[*_`~#>]/g, '').trim();
      sendAndFingerprint(plain);
      return Promise.resolve({ message_id: Date.now() });
    },
    // editMessage: update buffered text and extend flush timer — return true so
    // engine doesn't fall through to a redundant sendMessage call.
    editMessage: (_chatId, _msgId, text) => {
      const plain = String(text || '').replace(/[*_`~]/g, '').trim();
      sendAndFingerprint(plain);
      return Promise.resolve(true);
    },
    deleteMessage: async () => false,
    sendTyping:    async () => {},
    // Bridge injects this after bot is created
    setOnAfterSend: (fn) => { _onAfterSend = fn; },
  };
  return bot;
}

module.exports = { isAvailable, getMaxRowId, queryNewMessages, createImessageBot };
