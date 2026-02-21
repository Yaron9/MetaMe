#!/usr/bin/env node
/**
 * session-summarize.js <chatId> <sessionId>
 * Generates a 3-5 sentence summary for an idle session via Haiku,
 * stores it in daemon_state.json for injection on next resume.
 *
 * Uses session-analytics.extractSkeleton() for robust JSONL parsing
 * (handles tool_use, artifacts, empty chunks without crashing).
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

function findSessionFile(sid) {
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS)) {
      const p = path.join(CLAUDE_PROJECTS, dir, `${sid}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* ignore */ }
  return null;
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

  // Use extractSkeleton for robust parsing — already battle-tested on 100+ sessions.
  // Handles tool_use blocks, artifacts, empty chunks, malformed lines gracefully.
  let skeleton;
  try {
    const analytics = require('./session-analytics');
    skeleton = analytics.extractSkeleton(sessionFile);
  } catch (e) {
    console.log(`[session-summarize] extractSkeleton failed: ${e.message}`);
    return;
  }

  const snippets = skeleton.user_snippets || [];
  if (snippets.length < 2) {
    console.log(`[session-summarize] Too few user messages (${snippets.length}), skipping`);
    return;
  }

  let callHaiku;
  try {
    callHaiku = require('./providers').callHaiku;
  } catch (e) {
    console.log(`[session-summarize] providers not available: ${e.message}`);
    return;
  }

  // Build compact context from skeleton (safe strings, already sliced to 100 chars each)
  const snippetText = snippets.join('\n- ');
  const meta = [
    skeleton.project ? `项目: ${skeleton.project}` : '',
    skeleton.intent ? `首要意图: ${skeleton.intent}` : '',
    skeleton.duration_min ? `时长: ${skeleton.duration_min}分钟` : '',
    skeleton.total_tool_calls ? `工具调用: ${skeleton.total_tool_calls}次` : '',
  ].filter(Boolean).join('，');

  const prompt = `请用2-4句话简洁总结以下会话的核心内容和关键结论。只说结果和决策，不列举过程。中文输出。

${meta}

用户主要说了什么：
- ${snippetText}`;

  let summary;
  try {
    summary = await Promise.race([
      callHaiku(prompt, {}, 30000),
      new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 35000)),
    ]);
    summary = (summary || '').trim().slice(0, 500);
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

  console.log(`[session-summarize] Saved for ${chatId} (${sessionId.slice(0, 8)}): ${summary.slice(0, 80)}...`);
}

main().catch(e => console.error(`[session-summarize] Fatal: ${e.message}`));
