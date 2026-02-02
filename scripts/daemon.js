#!/usr/bin/env node

/**
 * daemon.js — MetaMe Heartbeat Daemon
 *
 * Single-process daemon that runs:
 * - Scheduled heartbeat tasks (via claude -p)
 * - Telegram bot bridge (optional, long-polling)
 * - Budget tracking (daily token counter)
 *
 * Usage: node daemon.js (launched by `metame daemon start`)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const CONFIG_FILE = path.join(METAME_DIR, 'daemon.yaml');
const STATE_FILE = path.join(METAME_DIR, 'daemon_state.json');
const PID_FILE = path.join(METAME_DIR, 'daemon.pid');
const LOG_FILE = path.join(METAME_DIR, 'daemon.log');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');

let yaml;
try {
  yaml = require('js-yaml');
} catch {
  // When deployed to ~/.metame/, resolve js-yaml via METAME_ROOT env
  const metameRoot = process.env.METAME_ROOT;
  if (metameRoot) {
    try { yaml = require(path.join(metameRoot, 'node_modules', 'js-yaml')); } catch { /* fallthrough */ }
  }
  if (!yaml) {
    // Try common paths
    const candidates = [
      path.resolve(__dirname, '..', 'node_modules', 'js-yaml'),
      path.resolve(__dirname, 'node_modules', 'js-yaml'),
    ];
    for (const p of candidates) {
      try { yaml = require(p); break; } catch { /* next */ }
    }
  }
  if (!yaml) {
    console.error('Cannot find js-yaml module. Ensure metame-cli is installed.');
    process.exit(1);
  }
}

// ---------------------------------------------------------
// LOGGING
// ---------------------------------------------------------
function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    // Rotate if over max size
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      const config = loadConfig();
      const maxSize = (config.daemon && config.daemon.log_max_size) || 1048576;
      if (stat.size > maxSize) {
        const bakFile = LOG_FILE + '.bak';
        if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile);
        fs.renameSync(LOG_FILE, bakFile);
      }
    }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch {
    // Last resort
    process.stderr.write(line);
  }
}

// ---------------------------------------------------------
// CONFIG & STATE
// ---------------------------------------------------------
function loadConfig() {
  try {
    return yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {
      pid: null,
      budget: { date: null, tokens_used: 0 },
      tasks: {},
      started_at: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ---------------------------------------------------------
// PROFILE PREAMBLE (lightweight — only core fields for daemon)
// ---------------------------------------------------------
const CORE_PROFILE_KEYS = ['identity', 'preferences', 'communication', 'context', 'cognition'];

function buildProfilePreamble() {
  try {
    if (!fs.existsSync(BRAIN_FILE)) return '';
    const full = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8'));
    if (!full || typeof full !== 'object') return '';

    // Extract only core fields — skip evolution.log, growth.patterns, etc.
    const slim = {};
    for (const key of CORE_PROFILE_KEYS) {
      if (full[key] !== undefined) slim[key] = full[key];
    }

    const slimYaml = yaml.dump(slim, { lineWidth: -1 });
    return `You are an AI assistant. User profile:\n\`\`\`yaml\n${slimYaml}\`\`\`\nAdapt style to match preferences.\n\n`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------
// BUDGET TRACKING
// ---------------------------------------------------------
function checkBudget(config, state) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.budget.date !== today) {
    state.budget.date = today;
    state.budget.tokens_used = 0;
    saveState(state);
  }
  const limit = (config.budget && config.budget.daily_limit) || 50000;
  return state.budget.tokens_used < limit;
}

function recordTokens(state, tokens) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.budget.date !== today) {
    state.budget.date = today;
    state.budget.tokens_used = 0;
  }
  state.budget.tokens_used += tokens;
  saveState(state);
}

function getBudgetWarning(config, state) {
  const limit = (config.budget && config.budget.daily_limit) || 50000;
  const threshold = (config.budget && config.budget.warning_threshold) || 0.8;
  const ratio = state.budget.tokens_used / limit;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= threshold) return 'warning';
  return 'ok';
}

// ---------------------------------------------------------
// TASK EXECUTION (claude -p)
// ---------------------------------------------------------
function checkPrecondition(task) {
  if (!task.precondition) return { pass: true, context: '' };

  try {
    const output = execSync(task.precondition, {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 64 * 1024,
    }).trim();

    if (!output) {
      log('INFO', `Precondition empty for ${task.name}, skipping (zero tokens)`);
      return { pass: false, context: '' };
    }

    log('INFO', `Precondition passed for ${task.name} (${output.split('\n').length} lines)`);
    return { pass: true, context: output };
  } catch (e) {
    // Non-zero exit = precondition failed
    log('INFO', `Precondition failed for ${task.name}: ${e.message.slice(0, 100)}`);
    return { pass: false, context: '' };
  }
}

function executeTask(task, config) {
  const state = loadState();

  if (!checkBudget(config, state)) {
    log('WARN', `Budget exceeded, skipping task: ${task.name}`);
    return { success: false, error: 'budget_exceeded', output: '' };
  }

  // Precondition gate: run a cheap shell check before burning tokens
  const precheck = checkPrecondition(task);
  if (!precheck.pass) {
    state.tasks[task.name] = {
      last_run: new Date().toISOString(),
      status: 'skipped',
      output_preview: 'Precondition not met — no activity',
    };
    saveState(state);
    return { success: true, output: '(skipped — no activity)', skipped: true };
  }

  // Script tasks: run a local script directly (e.g. distill.js), no claude -p
  if (task.type === 'script') {
    log('INFO', `Executing script task: ${task.name} → ${task.command}`);
    try {
      const output = execSync(task.command, {
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, METAME_ROOT: process.env.METAME_ROOT || '' },
      }).trim();

      state.tasks[task.name] = {
        last_run: new Date().toISOString(),
        status: 'success',
        output_preview: output.slice(0, 200),
      };
      saveState(state);
      log('INFO', `Script task ${task.name} completed`);
      return { success: true, output, tokens: 0 };
    } catch (e) {
      log('ERROR', `Script task ${task.name} failed: ${e.message}`);
      state.tasks[task.name] = {
        last_run: new Date().toISOString(),
        status: 'error',
        error: e.message.slice(0, 200),
      };
      saveState(state);
      return { success: false, error: e.message, output: '' };
    }
  }

  const preamble = buildProfilePreamble();
  const model = task.model || 'haiku';
  // If precondition returned context data, append it to the prompt
  let taskPrompt = task.prompt;
  if (precheck.context) {
    taskPrompt += `\n\n以下是相关原始数据:\n\`\`\`\n${precheck.context}\n\`\`\``;
  }
  const fullPrompt = preamble + taskPrompt;

  log('INFO', `Executing task: ${task.name} (model: ${model})`);

  try {
    const output = execSync(
      `claude -p --model ${model}`,
      {
        input: fullPrompt,
        encoding: 'utf8',
        timeout: 120000, // 2 min timeout
        maxBuffer: 1024 * 1024,
      }
    ).trim();

    // Rough token estimate: ~4 chars per token for input + output
    const estimatedTokens = Math.ceil((fullPrompt.length + output.length) / 4);
    recordTokens(state, estimatedTokens);

    // Record task result
    state.tasks[task.name] = {
      last_run: new Date().toISOString(),
      status: 'success',
      output_preview: output.slice(0, 200),
    };
    saveState(state);

    log('INFO', `Task ${task.name} completed (est. ${estimatedTokens} tokens)`);
    return { success: true, output, tokens: estimatedTokens };
  } catch (e) {
    log('ERROR', `Task ${task.name} failed: ${e.message}`);
    state.tasks[task.name] = {
      last_run: new Date().toISOString(),
      status: 'error',
      error: e.message.slice(0, 200),
    };
    saveState(state);
    return { success: false, error: e.message, output: '' };
  }
}

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
// HEARTBEAT SCHEDULER
// ---------------------------------------------------------
function startHeartbeat(config, notifyFn) {
  const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
  if (tasks.length === 0) {
    log('INFO', 'No heartbeat tasks configured');
    return;
  }

  const checkIntervalSec = (config.daemon && config.daemon.heartbeat_check_interval) || 60;
  log('INFO', `Heartbeat scheduler started (check every ${checkIntervalSec}s, ${tasks.length} tasks)`);

  // Track next run times
  const nextRun = {};
  const now = Date.now();
  const state = loadState();

  for (const task of tasks) {
    const intervalSec = parseInterval(task.interval);
    const lastRun = state.tasks[task.name] && state.tasks[task.name].last_run;
    if (lastRun) {
      const elapsed = (now - new Date(lastRun).getTime()) / 1000;
      nextRun[task.name] = now + Math.max(0, (intervalSec - elapsed)) * 1000;
    } else {
      // First run: execute after one check interval
      nextRun[task.name] = now + checkIntervalSec * 1000;
    }
  }

  const timer = setInterval(() => {
    const currentTime = Date.now();
    for (const task of tasks) {
      if (currentTime >= (nextRun[task.name] || 0)) {
        const result = executeTask(task, config);
        const intervalSec = parseInterval(task.interval);
        nextRun[task.name] = currentTime + intervalSec * 1000;

        if (task.notify && notifyFn && !result.skipped) {
          if (result.success) {
            notifyFn(`✅ *${task.name}* completed\n\n${result.output}`);
          } else {
            notifyFn(`❌ *${task.name}* failed: ${result.error}`);
          }
        }
      }
    }
  }, checkIntervalSec * 1000);

  return timer;
}

// ---------------------------------------------------------
// TELEGRAM BOT BRIDGE
// ---------------------------------------------------------
async function startTelegramBridge(config, executeTaskByName) {
  if (!config.telegram || !config.telegram.enabled) return null;
  if (!config.telegram.bot_token) {
    log('WARN', 'Telegram enabled but no bot_token configured');
    return null;
  }

  const { createBot } = require(path.join(__dirname, 'telegram-adapter.js'));
  const bot = createBot(config.telegram.bot_token);
  const allowedIds = config.telegram.allowed_chat_ids || [];

  // Verify bot
  try {
    const me = await bot.getMe();
    log('INFO', `Telegram bot connected: @${me.username}`);
  } catch (e) {
    log('ERROR', `Telegram bot auth failed: ${e.message}`);
    return null;
  }

  let offset = 0;
  let running = true;

  const pollLoop = async () => {
    while (running) {
      try {
        const updates = await bot.getUpdates(offset, 30);
        for (const update of updates) {
          offset = update.update_id + 1;
          if (!update.message) continue;

          const msg = update.message;
          const chatId = msg.chat.id;

          // Security: check whitelist
          if (allowedIds.length > 0 && !allowedIds.includes(chatId)) {
            log('WARN', `Rejected message from unauthorized chat: ${chatId}`);
            continue;
          }

          // Voice/audio without text → hint user
          if ((msg.voice || msg.audio) && !msg.text) {
            await bot.sendMessage(chatId, '🎤 Use Telegram voice-to-text (long press → Transcribe), then send as text.');
            continue;
          }

          // Text message (commands or natural language)
          if (msg.text) {
            await handleTelegramCommand(bot, chatId, msg.text.trim(), config, executeTaskByName);
          }
        }
      } catch (e) {
        log('ERROR', `Telegram poll error: ${e.message}`);
        // Wait before retry
        await sleep(5000);
      }
    }
  };

  pollLoop();

  return {
    stop() { running = false; },
    bot,
  };
}

// Rate limiter for /ask and /run — prevents rapid-fire Claude calls
const _lastClaudeCall = {};
const CLAUDE_COOLDOWN_MS = 10000; // 10s between Claude calls per chat

function checkCooldown(chatId) {
  const now = Date.now();
  const last = _lastClaudeCall[chatId] || 0;
  if (now - last < CLAUDE_COOLDOWN_MS) {
    const wait = Math.ceil((CLAUDE_COOLDOWN_MS - (now - last)) / 1000);
    return { ok: false, wait };
  }
  _lastClaudeCall[chatId] = now;
  return { ok: true };
}

async function handleTelegramCommand(bot, chatId, text, config, executeTaskByName) {
  const state = loadState();

  if (text === '/status') {
    let msg = `🤖 *MetaMe Daemon*\n`;
    msg += `Status: Running\n`;
    msg += `Started: ${state.started_at || 'unknown'}\n`;
    msg += `Budget: ${state.budget.tokens_used}/${(config.budget && config.budget.daily_limit) || 50000} tokens\n`;
    // Profile summary
    try {
      if (fs.existsSync(BRAIN_FILE)) {
        const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
        if (doc.identity) {
          msg += `\nProfile: ${doc.identity.nickname || 'unknown'} (${doc.identity.role || 'unknown'})`;
        }
        if (doc.context && doc.context.focus) {
          msg += `\nFocus: ${doc.context.focus}`;
        }
      }
    } catch { /* ignore */ }
    await bot.sendMarkdown(chatId, msg);
    return;
  }

  if (text === '/tasks') {
    const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
    if (tasks.length === 0) {
      await bot.sendMessage(chatId, 'No heartbeat tasks configured.');
      return;
    }
    let msg = '📋 *Heartbeat Tasks*\n\n';
    for (const t of tasks) {
      const taskState = state.tasks[t.name] || {};
      const status = taskState.status || 'never_run';
      const lastRun = taskState.last_run ? new Date(taskState.last_run).toLocaleString() : 'never';
      msg += `• *${t.name}* (${t.interval})\n  Status: ${status} | Last: ${lastRun}\n`;
    }
    await bot.sendMarkdown(chatId, msg);
    return;
  }

  if (text.startsWith('/run ')) {
    const cd = checkCooldown(chatId);
    if (!cd.ok) { await bot.sendMessage(chatId, `⏳ Cooldown: ${cd.wait}s`); return; }
    const taskName = text.slice(5).trim();
    await bot.sendMessage(chatId, `⏳ Running task: ${taskName}...`);
    const result = executeTaskByName(taskName);
    if (result.success) {
      await bot.sendMarkdown(chatId, `✅ *${taskName}*\n\n${result.output}`);
    } else {
      await bot.sendMessage(chatId, `❌ ${taskName}: ${result.error}`);
    }
    return;
  }

  if (text === '/budget') {
    const limit = (config.budget && config.budget.daily_limit) || 50000;
    const used = state.budget.tokens_used;
    const pct = ((used / limit) * 100).toFixed(1);
    await bot.sendMessage(chatId, `💰 Budget: ${used}/${limit} tokens (${pct}%)\nDate: ${state.budget.date || 'today'}`);
    return;
  }

  if (text.startsWith('/ask ')) {
    const prompt = text.slice(5).trim();
    if (!prompt) {
      await bot.sendMessage(chatId, 'Usage: /ask <your question>');
      return;
    }
    const cd = checkCooldown(chatId);
    if (!cd.ok) { await bot.sendMessage(chatId, `⏳ ${cd.wait}s`); return; }
    await askClaude(bot, chatId, prompt);
    return;
  }

  if (text === '/quiet') {
    try {
      const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      if (!doc.growth) doc.growth = {};
      doc.growth.quiet_until = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
      await bot.sendMessage(chatId, '🤫 Mirror & reflections silenced for 48 hours.');
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error: ${e.message}`);
    }
    return;
  }

  // No slash command matched → treat as natural language ask
  if (text.startsWith('/')) {
    // Unknown slash command → show help
    await bot.sendMessage(chatId, [
      '📖 Commands:',
      '/status — daemon status + profile',
      '/tasks — list heartbeat tasks',
      '/run <name> — run a task now',
      '/budget — token usage',
      '/quiet — silence reflections 48h',
      '/help — this message',
      '',
      '💬 Or just type naturally — no command needed.',
    ].join('\n'));
    return;
  }

  // Natural language → ask Claude directly
  const cd = checkCooldown(chatId);
  if (!cd.ok) { await bot.sendMessage(chatId, `⏳ ${cd.wait}s`); return; }
  if (!checkBudget(loadConfig(), loadState())) {
    await bot.sendMessage(chatId, '⚠️ Daily token budget exceeded.');
    return;
  }
  await askClaude(bot, chatId, text);
}

/**
 * Shared ask logic — sends prompt to claude -p with profile preamble
 */
async function askClaude(bot, chatId, prompt) {
  await bot.sendMessage(chatId, '让我想想...');
  // Keep "typing..." visible until Claude responds
  const typingTimer = setInterval(() => {
    bot.sendTyping(chatId).catch(() => {});
  }, 4000);
  bot.sendTyping(chatId).catch(() => {});

  const preamble = buildProfilePreamble();
  const fullPrompt = preamble + prompt;
  try {
    const output = execSync('claude -p --model haiku', {
      input: fullPrompt,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }).trim();
    clearInterval(typingTimer);

    const estimated = Math.ceil((fullPrompt.length + output.length) / 4);
    recordTokens(loadState(), estimated);

    await bot.sendMarkdown(chatId, output);
  } catch (e) {
    clearInterval(typingTimer);
    await bot.sendMessage(chatId, `❌ ${e.message.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------
// PID MANAGEMENT
// ---------------------------------------------------------
function writePid() {
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
}

function cleanPid() {
  try {
    if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------
// UTILITY
// ---------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------
// MAIN
// ---------------------------------------------------------
async function main() {
  const config = loadConfig();
  if (!config || Object.keys(config).length === 0) {
    console.error('No daemon config found. Run: metame daemon init');
    process.exit(1);
  }

  writePid();
  const state = loadState();
  state.pid = process.pid;
  state.started_at = new Date().toISOString();
  saveState(state);

  log('INFO', `MetaMe daemon started (PID: ${process.pid})`);

  // Task executor lookup
  function executeTaskByName(name) {
    const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
    const task = tasks.find(t => t.name === name);
    if (!task) return { success: false, error: `Task "${name}" not found` };
    return executeTask(task, config);
  }

  // Notification function (sends to all allowed Telegram chats)
  let telegramBridge = null;
  const notifyFn = async (message) => {
    if (!telegramBridge || !telegramBridge.bot) return;
    const allowedIds = config.telegram.allowed_chat_ids || [];
    for (const chatId of allowedIds) {
      try {
        await telegramBridge.bot.sendMarkdown(chatId, message);
      } catch (e) {
        log('ERROR', `Failed to notify chat ${chatId}: ${e.message}`);
      }
    }
  };

  // Start heartbeat scheduler
  const heartbeatTimer = startHeartbeat(config, notifyFn);

  // Start Telegram bridge (if enabled)
  telegramBridge = await startTelegramBridge(config, executeTaskByName);

  // Graceful shutdown
  const shutdown = () => {
    log('INFO', 'Daemon shutting down...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (telegramBridge) telegramBridge.stop();
    cleanPid();
    const s = loadState();
    s.pid = null;
    saveState(s);
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep alive
  log('INFO', 'Daemon running. Send SIGTERM to stop.');
}

// Single-task mode: `node daemon.js --run <taskname>`
if (process.argv.includes('--run')) {
  const idx = process.argv.indexOf('--run');
  const taskName = process.argv[idx + 1];
  if (!taskName) {
    console.error('Usage: node daemon.js --run <task-name>');
    process.exit(1);
  }
  const config = loadConfig();
  const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
  const task = tasks.find(t => t.name === taskName);
  if (!task) {
    console.error(`Task "${taskName}" not found in daemon.yaml`);
    console.error(`Available: ${tasks.map(t => t.name).join(', ') || '(none)'}`);
    process.exit(1);
  }
  const result = executeTask(task, config);
  if (result.success) {
    console.log(result.output);
  } else {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
} else {
  main().catch(e => {
    log('ERROR', `Fatal: ${e.message}`);
    cleanPid();
    process.exit(1);
  });
}

// Export for testing
module.exports = { executeTask, loadConfig, loadState, buildProfilePreamble, parseInterval };
