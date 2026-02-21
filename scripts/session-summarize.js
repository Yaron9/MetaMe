#!/usr/bin/env node
/**
 * session-summarize.js <chatId> <sessionId>
 * Reads last N messages from a session .jsonl, generates a 3-5 sentence
 * summary via Haiku, and stores it in daemon_state.json.
 * Spawned by daemon during sleep mode for idle sessions.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const [,, chatId, sessionId] = process.argv;
if (!chatId || !sessionId) {
  console.error('Usage: session-summarize.js <chatId> <sessionId>');
  process.exit(1);
}

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const STATE_FILE = path.join(METAME_DIR, 'daemon_state.json');
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

function findSessionFile(sessionId) {
  try {
    const dirs = fs.readdirSync(CLAUDE_PROJECTS);
    for (const dir of dirs) {
      const p = path.join(CLAUDE_PROJECTS, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
}

function readLastMessages(filePath, maxMessages = 60) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
    const messages = [];
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'user' || ev.type === 'assistant') {
          const role = ev.type;
          const content = ev.message && ev.message.content;
          let text = '';
          if (typeof content === 'string') text = content;
          else if (Array.isArray(content)) {
            text = content.filter(c => c.type === 'text').map(c => c.text).join(' ');
          }
          if (text.trim()) messages.push({ role, text: text.slice(0, 500) });
        }
      } catch { /* skip malformed lines */ }
    }
    return messages.slice(-maxMessages);
  } catch { return []; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* ignore */ }
}

async function main() {
  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) {
    console.log(`[session-summarize] Session file not found for ${sessionId.slice(0, 8)}`);
    return;
  }

  const messages = readLastMessages(sessionFile, 60);
  if (messages.length < 3) {
    console.log(`[session-summarize] Too few messages (${messages.length}), skipping`);
    return;
  }

  let callHaiku;
  try {
    const providers = require('./providers');
    callHaiku = providers.callHaiku;
  } catch (e) {
    console.log(`[session-summarize] providers not available: ${e.message}`);
    return;
  }

  const skeleton = messages.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.text}`).join('\n').slice(0, 4000);
  const prompt = `请用3-5句话简洁地总结以下对话的核心内容和关键决策。重点突出：做了什么决定、解决了什么问题、达成了什么结论。不要列举过程，只说结果。用中文。\n\n${skeleton}`;

  let summary;
  try {
    summary = await Promise.race([
      callHaiku(prompt, {}, 30000),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 35000)),
    ]);
    summary = summary.trim().slice(0, 500);
  } catch (e) {
    console.log(`[session-summarize] Haiku call failed: ${e.message}`);
    return;
  }

  if (!summary) return;

  const state = loadState();
  if (!state.sessions) state.sessions = {};
  if (!state.sessions[chatId]) state.sessions[chatId] = {};
  state.sessions[chatId].last_summary = summary;
  state.sessions[chatId].last_summary_at = Date.now();
  state.sessions[chatId].last_summary_session_id = sessionId;
  saveState(state);

  console.log(`[session-summarize] Summary saved for ${chatId} (${sessionId.slice(0, 8)}): ${summary.slice(0, 80)}...`);
}

main().catch(e => console.error(`[session-summarize] Fatal: ${e.message}`));
