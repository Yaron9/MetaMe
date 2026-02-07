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
const { execSync, execFileSync, spawn } = require('child_process');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const CONFIG_FILE = path.join(METAME_DIR, 'daemon.yaml');
const STATE_FILE = path.join(METAME_DIR, 'daemon_state.json');
const PID_FILE = path.join(METAME_DIR, 'daemon.pid');
const LOG_FILE = path.join(METAME_DIR, 'daemon.log');
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');

const yaml = require('./resolve-yaml');
const { parseInterval, formatRelativeTime, createPathMap } = require('./utils');
if (!yaml) {
  console.error('Cannot find js-yaml module. Ensure metame-cli is installed.');
  process.exit(1);
}

// Provider env for daemon tasks (relay support)
let providerMod = null;
try {
  providerMod = require('./providers');
} catch { /* providers.js not available — use defaults */ }

function getDaemonProviderEnv() {
  if (!providerMod) return {};
  try { return providerMod.buildDaemonEnv(); } catch { return {}; }
}

function getActiveProviderEnv() {
  if (!providerMod) return {};
  try { return providerMod.buildActiveEnv(); } catch { return {}; }
}

// ---------------------------------------------------------
// LOGGING
// ---------------------------------------------------------
let _logMaxSize = 1048576; // cached, refreshed on config reload
function refreshLogMaxSize(cfg) {
  _logMaxSize = (cfg && cfg.daemon && cfg.daemon.log_max_size) || 1048576;
}

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  try {
    // Rotate if over max size
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > _logMaxSize) {
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

function backupConfig() {
  const bak = CONFIG_FILE + '.bak';
  try { fs.copyFileSync(CONFIG_FILE, bak); } catch {}
}

function restoreConfig() {
  const bak = CONFIG_FILE + '.bak';
  if (fs.existsSync(bak)) {
    fs.copyFileSync(bak, CONFIG_FILE);
    config = loadConfig();
    return true;
  }
  return false;
}

let _cachedState = null;

function _readStateFromDisk() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!s.sessions) s.sessions = {};
    return s;
  } catch {
    return {
      pid: null,
      budget: { date: null, tokens_used: 0 },
      tasks: {},
      sessions: {},
      started_at: null,
    };
  }
}

function loadState() {
  if (!_cachedState) _cachedState = _readStateFromDisk();
  return _cachedState;
}

function saveState(state) {
  _cachedState = state;
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log('ERROR', `Failed to save state: ${e.message}`);
  }
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

  // Workflow tasks: multi-step skill chain via --resume session
  if (task.type === 'workflow') {
    return executeWorkflow(task, config);
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

  const claudeArgs = ['-p', '--model', model];
  for (const t of (task.allowedTools || [])) claudeArgs.push('--allowedTools', t);
  log('INFO', `Executing task: ${task.name} (model: ${model})`);

  try {
    const output = execFileSync('claude', claudeArgs, {
      input: fullPrompt,
      encoding: 'utf8',
      timeout: 120000, // 2 min timeout
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...getDaemonProviderEnv() },
    }).trim();

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

// parseInterval — imported from ./utils

// ---------------------------------------------------------
// WORKFLOW EXECUTION (multi-step skill chain via --resume)
// ---------------------------------------------------------
function executeWorkflow(task, config) {
  const state = loadState();
  if (!checkBudget(config, state)) {
    log('WARN', `Budget exceeded, skipping workflow: ${task.name}`);
    return { success: false, error: 'budget_exceeded', output: '' };
  }
  const precheck = checkPrecondition(task);
  if (!precheck.pass) {
    state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'skipped', output_preview: 'Precondition not met' };
    saveState(state);
    return { success: true, output: '(skipped)', skipped: true };
  }
  const steps = task.steps || [];
  if (steps.length === 0) return { success: false, error: 'No steps defined', output: '' };

  const model = task.model || 'sonnet';
  const cwd = task.cwd ? task.cwd.replace(/^~/, HOME) : HOME;
  const sessionId = crypto.randomUUID();
  const outputs = [];
  let totalTokens = 0;
  const allowed = task.allowedTools || [];

  log('INFO', `Workflow ${task.name}: ${steps.length} steps, session ${sessionId.slice(0, 8)}`);

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let prompt = (step.skill ? `/${step.skill} ` : '') + (step.prompt || '');
    if (i === 0 && precheck.context) prompt += `\n\n相关数据:\n\`\`\`\n${precheck.context}\n\`\`\``;
    const args = ['-p', '--model', model];
    for (const tool of allowed) args.push('--allowedTools', tool);
    args.push(i === 0 ? '--session-id' : '--resume', sessionId);

    log('INFO', `Workflow ${task.name} step ${i + 1}/${steps.length}: ${step.skill || 'prompt'}`);
    try {
      const output = execSync(`claude ${args.join(' ')}`, {
        input: prompt, encoding: 'utf8', timeout: step.timeout || 300000, maxBuffer: 5 * 1024 * 1024, cwd, env: { ...process.env, ...getDaemonProviderEnv() },
      }).trim();
      const tk = Math.ceil((prompt.length + output.length) / 4);
      totalTokens += tk;
      outputs.push({ step: i + 1, skill: step.skill || null, output: output.slice(0, 500), tokens: tk });
      log('INFO', `Workflow ${task.name} step ${i + 1} done (${tk} tokens)`);
      if (!checkBudget(config, loadState())) { log('WARN', 'Budget exceeded mid-workflow'); break; }
    } catch (e) {
      log('ERROR', `Workflow ${task.name} step ${i + 1} failed: ${e.message.slice(0, 200)}`);
      outputs.push({ step: i + 1, skill: step.skill || null, error: e.message.slice(0, 200) });
      if (!step.optional) {
        recordTokens(loadState(), totalTokens);
        state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'error', error: `Step ${i + 1} failed`, steps_completed: i, steps_total: steps.length };
        saveState(state);
        return { success: false, error: `Step ${i + 1} failed`, output: outputs.map(o => `Step ${o.step}: ${o.error ? 'FAILED' : 'OK'}`).join('\n'), tokens: totalTokens };
      }
    }
  }
  recordTokens(loadState(), totalTokens);
  const lastOk = [...outputs].reverse().find(o => !o.error);
  state.tasks[task.name] = { last_run: new Date().toISOString(), status: 'success', output_preview: (lastOk ? lastOk.output : '').slice(0, 200), steps_completed: outputs.filter(o => !o.error).length, steps_total: steps.length };
  saveState(state);
  log('INFO', `Workflow ${task.name} done: ${outputs.filter(o => !o.error).length}/${steps.length} steps (${totalTokens} tokens)`);
  return { success: true, output: outputs.map(o => `Step ${o.step} (${o.skill || 'prompt'}): ${o.error ? 'FAILED' : 'OK'}`).join('\n') + '\n\n' + (lastOk ? lastOk.output : ''), tokens: totalTokens };
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

          // Handle inline keyboard button presses
          if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message && cb.message.chat.id;
            bot.answerCallback(cb.id).catch(() => {});
            if (chatId && cb.data) {
              if (!allowedIds.includes(chatId)) continue;
              // callback_data is a command string, e.g. "/resume <session-id>"
              await handleCommand(bot, chatId, cb.data, config, executeTaskByName);
            }
            continue;
          }

          if (!update.message) continue;

          const msg = update.message;
          const chatId = msg.chat.id;

          // Security: check whitelist (empty = deny all)
          if (!allowedIds.includes(chatId)) {
            log('WARN', `Rejected message from unauthorized chat: ${chatId}`);
            continue;
          }

          // Voice/audio without text → hint user
          if ((msg.voice || msg.audio) && !msg.text) {
            await bot.sendMessage(chatId, '🎤 Use Telegram voice-to-text (long press → Transcribe), then send as text.');
            continue;
          }

          // File/document message → download and pass to Claude
          if (msg.document || msg.photo) {
            const fileId = msg.document ? msg.document.file_id : msg.photo[msg.photo.length - 1].file_id;
            const fileName = msg.document ? msg.document.file_name : `photo_${Date.now()}.jpg`;
            const caption = msg.caption || '';

            // Save to project's upload/ folder
            const session = getSession(chatId);
            const cwd = session?.cwd || HOME;
            const uploadDir = path.join(cwd, 'upload');
            if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
            const destPath = path.join(uploadDir, fileName);

            try {
              await bot.downloadFile(fileId, destPath);
              await bot.sendMessage(chatId, `📥 Saved: ${fileName}`);

              // Build prompt - don't ask Claude to read large files automatically
              const prompt = caption
                ? `User uploaded a file to the project: ${destPath}\nUser says: "${caption}"`
                : `User uploaded a file to the project: ${destPath}\nAcknowledge receipt. Only read the file if the user asks you to.`;

              await handleCommand(bot, chatId, prompt, config, executeTaskByName);
            } catch (err) {
              log('ERROR', `File download failed: ${err.message}`);
              await bot.sendMessage(chatId, `❌ Download failed: ${err.message}`);
            }
            continue;
          }

          // Text message (commands or natural language)
          if (msg.text) {
            await handleCommand(bot, chatId, msg.text.trim(), config, executeTaskByName);
          }
        }
      } catch (e) {
        log('ERROR', `Telegram poll error: ${e.message}`);
        // Wait before retry
        await sleep(5000);
      }
    }
  };

  const startPoll = () => {
    pollLoop().catch(e => {
      log('ERROR', `pollLoop crashed: ${e.message} — restarting in 5s`);
      if (running) setTimeout(startPoll, 5000);
    });
  };
  startPoll();

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

// Path shortener — imported from ./utils
const { shortenPath, expandPath } = createPathMap();

/**
 * Send directory picker: recent projects + Browse button
 * @param {string} mode - 'new' or 'cd' (determines callback command)
 */
async function sendDirPicker(bot, chatId, mode, title) {
  const dirs = listProjectDirs();
  const cmd = mode === 'new' ? '/new' : '/cd';
  if (bot.sendButtons) {
    const buttons = dirs.map(d => [{ text: d.label, callback_data: `${cmd} ${shortenPath(d.path)}` }]);
    buttons.push([{ text: 'Browse...', callback_data: `/browse ${mode} ${shortenPath(HOME)}` }]);
    await bot.sendButtons(chatId, title, buttons);
  } else {
    let msg = `${title}\n`;
    dirs.forEach((d, i) => { msg += `${i + 1}. ${d.label}\n   ${cmd} ${d.path}\n`; });
    msg += `\nOr type: ${cmd} /full/path`;
    await bot.sendMessage(chatId, msg);
  }
}

/**
 * Send directory browser: list subdirs of a path with .. parent nav
 */
async function sendBrowse(bot, chatId, mode, dirPath) {
  const cmd = mode === 'new' ? '/new' : '/cd';
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const subdirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort()
      .slice(0, 8); // max 8 subdirs per screen

    if (bot.sendButtons) {
      const buttons = [];
      // Select this directory
      buttons.push([{ text: `>> Use this dir`, callback_data: `${cmd} ${shortenPath(dirPath)}` }]);
      // Subdirectories
      for (const name of subdirs) {
        const full = path.join(dirPath, name);
        buttons.push([{ text: `${name}/`, callback_data: `/browse ${mode} ${shortenPath(full)}` }]);
      }
      // Parent
      const parent = path.dirname(dirPath);
      if (parent !== dirPath) {
        buttons.push([{ text: '.. back', callback_data: `/browse ${mode} ${shortenPath(parent)}` }]);
      }
      await bot.sendButtons(chatId, dirPath, buttons);
    } else {
      let msg = `${dirPath}\n\n`;
      subdirs.forEach((name, i) => {
        msg += `${i + 1}. ${name}/\n   /browse ${mode} ${path.join(dirPath, name)}\n`;
      });
      msg += `\nSelect: ${cmd} ${dirPath}\nBack: /browse ${mode} ${path.dirname(dirPath)}`;
      await bot.sendMessage(chatId, msg);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `Cannot read: ${dirPath}`);
  }
}

const DIR_LIST_TYPE_EMOJI = {
  '.md': '📄', '.txt': '📄', '.pdf': '📕',
  '.js': '⚙️', '.ts': '⚙️', '.py': '🐍', '.json': '📋', '.yaml': '📋', '.yml': '📋',
  '.png': '🖼️', '.jpg': '🖼️', '.jpeg': '🖼️', '.gif': '🖼️', '.svg': '🖼️', '.webp': '🖼️',
  '.wav': '🎵', '.mp3': '🎵', '.m4a': '🎵', '.flac': '🎵',
  '.mp4': '🎬', '.mov': '🎬',
  '.csv': '📊', '.xlsx': '📊',
  '.html': '🌐', '.css': '🎨',
  '.sh': '💻', '.bash': '💻',
};

/**
 * List directory contents with file info + download buttons + folder nav buttons.
 * Zero token cost — pure daemon fs operation.
 */
async function sendDirListing(bot, chatId, baseDir, arg) {
  let targetDir = baseDir;
  let globFilter = null;

  if (arg) {
    if (arg.includes('*')) {
      globFilter = arg;
    } else {
      const sub = path.resolve(baseDir, arg);
      if (fs.existsSync(sub) && fs.statSync(sub).isDirectory()) {
        targetDir = sub;
      } else {
        await bot.sendMessage(chatId, `❌ Not found: ${arg}`);
        return;
      }
    }
  }

  try {
    let entries = fs.readdirSync(targetDir, { withFileTypes: true });
    if (globFilter) {
      const pattern = globFilter.replace(/\./g, '\\.').replace(/\*/g, '.*');
      const re = new RegExp('^' + pattern + '$', 'i');
      entries = entries.filter(e => re.test(e.name));
    }
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    entries = entries.filter(e => !e.name.startsWith('.'));

    if (entries.length === 0) {
      await bot.sendMessage(chatId, `📁 ${path.basename(targetDir)}/\n(empty)`);
      return;
    }

    const allButtons = [];
    const MAX_BUTTONS = 20;

    for (const entry of entries.slice(0, MAX_BUTTONS)) {
      const fullPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        // Use absolute path directly for folders (survives daemon restart)
        // Fall back to shortenPath only if path is too long for callback_data (64 byte limit)
        const cbPath = fullPath.length <= 58 ? fullPath : shortenPath(fullPath);
        allButtons.push([{ text: `📂 ${entry.name}/`, callback_data: `/list ${cbPath}` }]);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const emoji = DIR_LIST_TYPE_EMOJI[ext] || '📎';
        let size = '';
        try {
          const stat = fs.statSync(fullPath);
          const bytes = stat.size;
          if (bytes < 1024) size = ` ${bytes}B`;
          else if (bytes < 1048576) size = ` ${(bytes / 1024).toFixed(0)}KB`;
          else size = ` ${(bytes / 1048576).toFixed(1)}MB`;
        } catch { /* ignore */ }
        if (isContentFile(fullPath)) {
          const shortId = cacheFile(fullPath);
          allButtons.push([{ text: `${emoji} ${entry.name}${size}`, callback_data: `/file ${shortId}` }]);
        } else {
          // Non-downloadable files shown as info-only buttons (no action)
          allButtons.push([{ text: `${emoji} ${entry.name}${size}`, callback_data: 'noop' }]);
        }
      }
    }

    const header = `📁 ${path.basename(targetDir)}/` + (entries.length > MAX_BUTTONS ? ` (${MAX_BUTTONS}/${entries.length})` : '');
    if (allButtons.length > 0 && bot.sendButtons) {
      await bot.sendButtons(chatId, header, allButtons);
    } else {
      // Fallback for adapters without button support
      const lines = [header];
      for (const entry of entries.slice(0, MAX_BUTTONS)) {
        const isDir = entry.isDirectory();
        lines.push(isDir ? `  📂 ${entry.name}/` : `  📎 ${entry.name}`);
      }
      await bot.sendMessage(chatId, lines.join('\n'));
    }
  } catch (e) {
    await bot.sendMessage(chatId, `❌ ${e.message}`);
  }
}

/**
 * Unified command handler — shared by Telegram & Feishu
 */
async function handleCommand(bot, chatId, text, config, executeTaskByName) {
  const state = loadState();

  // --- Browse handler (directory navigation) ---
  if (text.startsWith('/browse ')) {
    const parts = text.slice(8).trim().split(' ');
    const mode = parts[0]; // 'new' or 'cd'
    const dirPath = expandPath(parts.slice(1).join(' '));
    if (mode && dirPath && fs.existsSync(dirPath)) {
      await sendBrowse(bot, chatId, mode, dirPath);
    } else if (/^p\d+$/.test(dirPath)) {
      await bot.sendMessage(chatId, '⚠️ Button expired. Pick again:');
      await sendDirPicker(bot, chatId, mode || 'cd', 'Switch workdir:');
    } else {
      await bot.sendMessage(chatId, 'Invalid browse path.');
    }
    return;
  }

  // --- Session commands ---

  if (text === '/new' || text.startsWith('/new ')) {
    const arg = text.slice(4).trim();
    if (!arg) {
      await sendDirPicker(bot, chatId, 'new', 'Pick a workdir:');
      return;
    }
    // Parse: /new <path> [name] — if arg contains a space after a valid path, rest is name
    let dirPath = expandPath(arg);
    let sessionName = '';
    // Try full arg as path first; if not, split on spaces to find path + name
    if (!fs.existsSync(dirPath)) {
      const spaceIdx = arg.indexOf(' ');
      if (spaceIdx > 0) {
        const maybePath = arg.slice(0, spaceIdx);
        if (fs.existsSync(maybePath)) {
          dirPath = maybePath;
          sessionName = arg.slice(spaceIdx + 1).trim();
        }
      }
      if (!fs.existsSync(dirPath)) {
        await bot.sendMessage(chatId, `Path not found: ${dirPath}`);
        return;
      }
    }
    const session = createSession(chatId, dirPath, sessionName || '');
    const label = sessionName ? `[${sessionName}]` : '';
    await bot.sendMessage(chatId, `New session ${label}\nWorkdir: ${session.cwd}`);
    return;
  }

  // /file <shortId> — send cached file (from button callback)
  if (text.startsWith('/file ')) {
    const shortId = text.slice(6).trim();
    const filePath = getCachedFile(shortId);
    if (!filePath) {
      await bot.sendMessage(chatId, '⏰ 文件链接已过期，请重新生成');
      return;
    }
    if (!fs.existsSync(filePath)) {
      await bot.sendMessage(chatId, '❌ 文件不存在');
      return;
    }
    if (bot.sendFile) {
      try {
        // Insert zero-width space before extension to prevent link parsing
        const basename = path.basename(filePath);
        const dotIdx = basename.lastIndexOf('.');
        const safeBasename = dotIdx > 0 ? basename.slice(0, dotIdx) + '\u200B' + basename.slice(dotIdx) : basename;
        await bot.sendMessage(chatId, `⏳ 正在发送「${safeBasename}」...`);
        await bot.sendFile(chatId, filePath);
      } catch (e) {
        log('ERROR', `File send failed: ${e.message}`);
        await bot.sendMessage(chatId, `❌ 发送失败: ${e.message.slice(0, 100)}`);
      }
    } else {
      await bot.sendMessage(chatId, '❌ 当前平台不支持文件发送');
    }
    return;
  }

  // /last — smart resume: prefer current cwd, then most recent globally
  if (text === '/last') {
    const curSession = getSession(chatId);
    const curCwd = curSession ? curSession.cwd : null;

    // Strategy: try current cwd first, then fall back to global
    let s = null;
    if (curCwd) {
      const cwdSessions = listRecentSessions(1, curCwd);
      if (cwdSessions.length > 0) s = cwdSessions[0];
    }
    if (!s) {
      const globalSessions = listRecentSessions(1);
      if (globalSessions.length > 0) s = globalSessions[0];
    }

    if (!s) {
      // Last resort: use __continue__ to resume whatever Claude thinks is last
      const state2 = loadState();
      state2.sessions[chatId] = {
        id: '__continue__',
        cwd: curCwd || HOME,
        created: new Date().toISOString(),
        started: true,
      };
      saveState(state2);
      await bot.sendMessage(chatId, `⚡ Resuming last session in ${path.basename(curCwd || HOME)}`);
      return;
    }

    const state2 = loadState();
    state2.sessions[chatId] = {
      id: s.sessionId,
      cwd: s.projectPath || HOME,
      started: true,
    };
    saveState(state2);
    // Display: name/summary + id on separate lines
    const name = s.customTitle;
    const shortId = s.sessionId.slice(0, 8);
    let title = name ? `[${name}]` : (s.summary || s.firstPrompt || '').slice(0, 40) || 'Session';
    // Get real file mtime for accuracy
    const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
    const ago = formatRelativeTime(new Date(realMtime || s.fileMtime || new Date(s.modified).getTime()).toISOString());
    await bot.sendMessage(chatId, `⚡ ${title}\n📁 ${path.basename(s.projectPath || '')} #${shortId}\n🕐 ${ago}`);
    return;
  }

  if (text === '/resume' || text.startsWith('/resume ')) {
    const arg = text.slice(7).trim();

    // Get current workdir to scope session list
    const curSession = getSession(chatId);
    const curCwd = curSession ? curSession.cwd : null;
    const recentSessions = listRecentSessions(5, curCwd);

    if (!arg) {
      if (recentSessions.length === 0) {
        await bot.sendMessage(chatId, `No sessions found${curCwd ? ' in ' + path.basename(curCwd) : ''}. Try /new first.`);
        return;
      }
      const title = curCwd ? `Sessions in ${path.basename(curCwd)}:` : 'Recent sessions:';
      if (bot.sendButtons) {
        const buttons = recentSessions.map(s => {
          return [{ text: sessionLabel(s), callback_data: `/resume ${s.sessionId}` }];
        });
        await bot.sendButtons(chatId, title, buttons);
      } else {
        let msg = `${title}\n`;
        recentSessions.forEach((s, i) => {
          msg += `${i + 1}. ${sessionLabel(s)}\n   /resume ${s.sessionId.slice(0, 8)}\n`;
        });
        await bot.sendMessage(chatId, msg);
      }
      return;
    }

    // Argument given → match by name, then by session ID prefix
    const allSessions = listRecentSessions(50);
    const argLower = arg.toLowerCase();
    // 1. Match by customTitle (Claude's native session name)
    let fullMatch = allSessions.find(s => {
      return s.customTitle && s.customTitle.toLowerCase() === argLower;
    });
    // 2. Partial name match
    if (!fullMatch) {
      fullMatch = allSessions.find(s => {
        return s.customTitle && s.customTitle.toLowerCase().includes(argLower);
      });
    }
    // 3. Session ID prefix match
    if (!fullMatch) {
      fullMatch = recentSessions.find(s => s.sessionId.startsWith(arg))
        || allSessions.find(s => s.sessionId.startsWith(arg));
    }
    const sessionId = fullMatch ? fullMatch.sessionId : arg;
    const cwd = (fullMatch && fullMatch.projectPath) || (getSession(chatId) && getSession(chatId).cwd) || HOME;

    const state2 = loadState();
    state2.sessions[chatId] = {
      id: sessionId,
      cwd,
      started: true,
    };
    saveState(state2);
    const name = fullMatch ? fullMatch.customTitle : null;
    const label = name || (fullMatch ? (fullMatch.summary || fullMatch.firstPrompt || '').slice(0, 40) : sessionId.slice(0, 8));
    await bot.sendMessage(chatId, `Resumed: ${label}\nWorkdir: ${cwd}`);
    return;
  }

  if (text === '/cd' || text.startsWith('/cd ')) {
    let newCwd = expandPath(text.slice(3).trim());
    if (!newCwd) {
      await sendDirPicker(bot, chatId, 'cd', 'Switch workdir:');
      return;
    }
    // /cd last — sync to computer: switch to most recent session AND its directory
    if (newCwd === 'last') {
      const currentSession = getSession(chatId);
      const excludeId = currentSession?.id;
      const recent = listRecentSessions(10);
      const filtered = excludeId ? recent.filter(s => s.sessionId !== excludeId) : recent;
      if (filtered.length > 0 && filtered[0].projectPath) {
        const target = filtered[0];
        // Switch to that session (like /resume) AND its directory
        const state2 = loadState();
        state2.sessions[chatId] = {
          id: target.sessionId,
          cwd: target.projectPath,
          started: true,
        };
        saveState(state2);
        const name = target.customTitle || target.summary || '';
        const label = name ? name.slice(0, 40) : target.sessionId.slice(0, 8);
        await bot.sendMessage(chatId, `🔄 Synced to: ${label}\n📁 ${path.basename(target.projectPath)}`);
        await sendDirListing(bot, chatId, target.projectPath, null);
        return;
      } else {
        await bot.sendMessage(chatId, 'No recent session found.');
        return;
      }
    }
    if (!fs.existsSync(newCwd)) {
      // Likely an expired path shortcode (e.g. p16) from a daemon restart
      if (/^p\d+$/.test(newCwd)) {
        await bot.sendMessage(chatId, '⚠️ Button expired (daemon restarted). Pick again:');
        await sendDirPicker(bot, chatId, 'cd', 'Switch workdir:');
      } else {
        await bot.sendMessage(chatId, `Path not found: ${newCwd}`);
      }
      return;
    }
    const state2 = loadState();
    // Try to find existing session in this directory
    const recentInDir = listRecentSessions(1, newCwd);
    if (recentInDir.length > 0 && recentInDir[0].sessionId) {
      // Attach to existing session in this directory
      const target = recentInDir[0];
      state2.sessions[chatId] = {
        id: target.sessionId,
        cwd: newCwd,
        started: true,
      };
      saveState(state2);
      const label = target.customTitle || target.summary?.slice(0, 30) || target.sessionId.slice(0, 8);
      await bot.sendMessage(chatId, `📁 ${path.basename(newCwd)}\n🔄 Attached: ${label}`);
    } else if (!state2.sessions[chatId]) {
      createSession(chatId, newCwd);
      await bot.sendMessage(chatId, `📁 ${path.basename(newCwd)} (new session)`);
    } else {
      state2.sessions[chatId].cwd = newCwd;
      saveState(state2);
      await bot.sendMessage(chatId, `📁 ${path.basename(newCwd)}`);
    }
    await sendDirListing(bot, chatId, newCwd, null);
    return;
  }

  // /list [subdir|glob|fullpath] — list files (zero token, daemon-only)
  if (text === '/list' || text.startsWith('/list ')) {
    const session = getSession(chatId);
    const cwd = session?.cwd || HOME;
    const arg = text.slice(5).trim();
    // If arg is an absolute or ~ path, list that directly
    const expanded = arg ? expandPath(arg) : null;
    if (expanded && /^p\d+$/.test(expanded)) {
      // Expired shortcode from daemon restart
      await bot.sendMessage(chatId, '⚠️ Button expired. Refreshing...');
      await sendDirListing(bot, chatId, cwd, null);
    } else if (expanded && path.isAbsolute(expanded) && fs.existsSync(expanded) && fs.statSync(expanded).isDirectory()) {
      await sendDirListing(bot, chatId, expanded, null);
    } else {
      await sendDirListing(bot, chatId, cwd, arg || null);
    }
    return;
  }

  if (text.startsWith('/name ')) {
    const name = text.slice(6).trim();
    if (!name) {
      await bot.sendMessage(chatId, 'Usage: /name <session name>');
      return;
    }
    const session = getSession(chatId);
    if (!session) {
      await bot.sendMessage(chatId, 'No active session. Start one first.');
      return;
    }

    // Write to Claude's session file (unified with /rename on desktop)
    if (writeSessionName(session.id, session.cwd, name)) {
      await bot.sendMessage(chatId, `✅ Session: [${name}]`);
    } else {
      await bot.sendMessage(chatId, `⚠️ Failed to save name, but session continues.`);
    }
    return;
  }

  if (text === '/session') {
    const session = getSession(chatId);
    if (!session) {
      await bot.sendMessage(chatId, 'No active session. Send any message to start one.');
    } else {
      const name = getSessionName(session.id);
      const nameTag = name ? ` [${name}]` : '';
      await bot.sendMessage(chatId, `Session: ${session.id.slice(0, 8)}...${nameTag}\nWorkdir: ${session.cwd}`);
    }
    return;
  }

  // --- Daemon commands ---

  if (text === '/status') {
    const session = getSession(chatId);
    let msg = `MetaMe Daemon\nStatus: Running\nStarted: ${state.started_at || 'unknown'}\n`;
    msg += `Budget: ${state.budget.tokens_used}/${(config.budget && config.budget.daily_limit) || 50000} tokens`;
    if (session) msg += `\nSession: ${session.id.slice(0, 8)}... (${session.cwd})`;
    try {
      if (fs.existsSync(BRAIN_FILE)) {
        const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
        if (doc.identity) msg += `\nProfile: ${doc.identity.nickname || 'unknown'}`;
        if (doc.context && doc.context.focus) msg += `\nFocus: ${doc.context.focus}`;
      }
    } catch { /* ignore */ }
    await bot.sendMessage(chatId, msg);
    return;
  }

  if (text === '/tasks') {
    const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
    if (tasks.length === 0) { await bot.sendMessage(chatId, 'No heartbeat tasks configured.'); return; }
    let msg = 'Heartbeat Tasks:\n';
    for (const t of tasks) {
      const ts = state.tasks[t.name] || {};
      msg += `- ${t.name} (${t.interval}) ${ts.status || 'never_run'}\n`;
    }
    await bot.sendMessage(chatId, msg);
    return;
  }

  if (text.startsWith('/run ')) {
    const cd = checkCooldown(chatId);
    if (!cd.ok) { await bot.sendMessage(chatId, `Cooldown: ${cd.wait}s`); return; }
    if (activeProcesses.has(chatId)) {
      await bot.sendMessage(chatId, '⏳ 任务进行中，/stop 中断');
      return;
    }
    const taskName = text.slice(5).trim();
    const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
    const task = tasks.find(t => t.name === taskName);
    if (!task) { await bot.sendMessage(chatId, `❌ Task "${taskName}" not found`); return; }

    // Script tasks: quick, run inline
    if (task.type === 'script') {
      await bot.sendMessage(chatId, `Running: ${taskName}...`);
      const result = executeTaskByName(taskName);
      await bot.sendMessage(chatId, result.success ? `${taskName}\n\n${result.output}` : `Error: ${result.error}`);
      return;
    }

    // Claude tasks: run async via spawn
    const precheck = checkPrecondition(task);
    if (!precheck.pass) {
      await bot.sendMessage(chatId, `${taskName}: skipped (no activity)`);
      return;
    }
    const preamble = buildProfilePreamble();
    let taskPrompt = task.prompt;
    if (precheck.context) taskPrompt += `\n\n以下是相关原始数据:\n\`\`\`\n${precheck.context}\n\`\`\``;
    const fullPrompt = preamble + taskPrompt;
    const model = task.model || 'haiku';
    const claudeArgs = ['-p', '--model', model];
    for (const t of (task.allowedTools || [])) claudeArgs.push('--allowedTools', t);

    await bot.sendMessage(chatId, `Running: ${taskName} (${model})...`);
    const { output, error } = await spawnClaudeAsync(claudeArgs, fullPrompt, HOME, 120000);
    if (error) {
      await bot.sendMessage(chatId, `❌ ${taskName}: ${error}`);
    } else {
      const est = Math.ceil((fullPrompt.length + (output || '').length) / 4);
      recordTokens(loadState(), est);
      const st = loadState();
      st.tasks[taskName] = { last_run: new Date().toISOString(), status: 'success', output_preview: (output || '').slice(0, 200) };
      saveState(st);
      let reply = output || '(no output)';
      if (reply.length > 4000) reply = reply.slice(0, 4000) + '\n... (truncated)';
      await bot.sendMessage(chatId, `${taskName}\n\n${reply}`);
    }
    return;
  }

  if (text === '/budget') {
    const limit = (config.budget && config.budget.daily_limit) || 50000;
    const used = state.budget.tokens_used;
    await bot.sendMessage(chatId, `Budget: ${used}/${limit} tokens (${((used/limit)*100).toFixed(1)}%)`);
    return;
  }

  if (text === '/stop') {
    // Clear message queue (don't process queued messages after stop)
    if (messageQueue.has(chatId)) {
      const q = messageQueue.get(chatId);
      if (q.timer) clearTimeout(q.timer);
      messageQueue.delete(chatId);
    }
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      proc.child.kill('SIGINT');
      await bot.sendMessage(chatId, '⏹ Stopping Claude...');
    } else {
      await bot.sendMessage(chatId, 'No active task to stop.');
    }
    return;
  }

  // /quit — restart session process (reloads MCP/config, keeps same session)
  if (text === '/quit') {
    // Stop running task if any
    if (messageQueue.has(chatId)) {
      const q = messageQueue.get(chatId);
      if (q.timer) clearTimeout(q.timer);
      messageQueue.delete(chatId);
    }
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      proc.child.kill('SIGINT');
    }
    const session = getSession(chatId);
    const name = session ? getSessionName(session.id) : null;
    const label = name || (session ? session.id.slice(0, 8) : 'none');
    await bot.sendMessage(chatId, `🔄 Session restarted. MCP/config reloaded.\n📁 ${session ? path.basename(session.cwd) : '~'} [${label}]`);
    return;
  }

  // /publish <otp> — npm publish with OTP (zero latency, no Claude)
  if (text.startsWith('/publish ')) {
    const otp = text.slice(9).trim();
    if (!otp || !/^\d{6}$/.test(otp)) {
      await bot.sendMessage(chatId, '用法: /publish 123456');
      return;
    }
    const session = getSession(chatId);
    const cwd = session?.cwd || HOME;
    await bot.sendMessage(chatId, `📦 npm publish --otp=${otp} ...`);
    try {
      const child = spawn('npm', ['publish', `--otp=${otp}`], { cwd, timeout: 60000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      await new Promise((resolve) => {
        child.on('close', resolve);
        child.on('error', resolve);
      });
      const output = (stdout + stderr).trim();
      if (output.includes('+ metame-cli@') || output.includes('npm notice')) {
        const ver = output.match(/metame-cli@([\d.]+)/);
        await bot.sendMessage(chatId, `✅ Published${ver ? ' v' + ver[1] : ''}!`);
      } else {
        let msg = output.slice(0, 2000) || '(no output)';
        await bot.sendMessage(chatId, `❌ ${msg}`);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ ${e.message}`);
    }
    return;
  }

  // /sh [command] — direct shell execution (emergency lifeline)
  if (text === '/sh' || text.startsWith('/sh ')) {
    const command = text.slice(3).trim();
    if (!command) {
      if (bot.sendButtons) {
        await bot.sendButtons(chatId, '💻 应急命令', [
          [{ text: '📝 最近日志', callback_data: '/sh tail -30 ~/.metame/daemon.log' }],
          [{ text: '📋 原始配置', callback_data: '/sh cat ~/.metame/daemon.yaml' }],
        ]);
      } else {
        await bot.sendMessage(chatId, '用法: /sh <command>');
      }
      return;
    }
    try {
      const child = spawn('sh', ['-c', command], { timeout: 30000 });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      await new Promise((resolve) => {
        child.on('close', resolve);
        child.on('error', resolve);
      });
      let output = (stdout + stderr).trim() || '(no output)';
      if (output.length > 4000) output = output.slice(0, 4000) + '\n... (truncated)';
      await bot.sendMessage(chatId, `💻 $ ${command}\n${output}`);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ ${e.message}`);
    }
    return;
  }

  if (text === '/undo' || text.startsWith('/undo ')) {
    // Clear message queue
    if (messageQueue.has(chatId)) {
      const q = messageQueue.get(chatId);
      if (q.timer) clearTimeout(q.timer);
      messageQueue.delete(chatId);
    }
    // Stop running task first
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child) {
      proc.aborted = true;
      proc.child.kill('SIGINT');
    }

    const session = getSession(chatId);
    if (!session || !session.id || !session.cwd) {
      await bot.sendMessage(chatId, 'No active session to undo.');
      return;
    }

    // Find session .jsonl file (scan Claude's native projects directory)
    const sessionFile = findSessionFile(session.id);
    if (!sessionFile) {
      await bot.sendMessage(chatId, 'Session file not found.');
      return;
    }

    try {
      const fileContent = fs.readFileSync(sessionFile, 'utf8');
      const lines = fileContent.split('\n').filter(l => l.trim());

      // Validate format: first line should be parseable with a known type
      try {
        const first = JSON.parse(lines[0]);
        if (!first.type) {
          await bot.sendMessage(chatId, '⚠️ Session 格式不兼容，Claude Code 可能已升级');
          return;
        }
      } catch {
        await bot.sendMessage(chatId, '⚠️ Session 文件损坏');
        return;
      }

      // Session structure: user → assistant(s) → snapshot(s)
      // A "turn" = a user message. The snapshot BEFORE it = file state before that turn.
      let lastSnapshotIdx = -1;
      const turns = []; // { lineIdx, userPrompt, timestamp, preSnapshotIdx }
      for (let i = 0; i < lines.length; i++) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'file-history-snapshot') {
            lastSnapshotIdx = i;
          } else if (obj.type === 'user') {
            const m = obj.message || {};
            const c = m.content || '';
            let userText = '';
            if (typeof c === 'string') userText = c;
            else if (Array.isArray(c)) {
              for (const b of c) { if (b.type === 'text') { userText = b.text; break; } }
            }
            // Skip system/internal messages
            if (userText && !userText.startsWith('<task-notification') && !userText.startsWith('[Request interrupted')) {
              turns.push({
                lineIdx: i,
                userPrompt: userText.slice(0, 30),
                timestamp: obj.timestamp || '',
                preSnapshotIdx: lastSnapshotIdx,
              });
            }
          }
        } catch {}
      }

      if (turns.length === 0) {
        await bot.sendMessage(chatId, 'Nothing to undo.');
        return;
      }

      const arg = text.slice(5).trim();

      // /undo (no arg) — show recent turns to pick from
      if (!arg) {
        const recent = turns.slice(-6).reverse(); // last 6, newest first
        if (bot.sendButtons) {
          const buttons = recent.map((t) => {
            const ago = t.timestamp ? formatRelativeTime(t.timestamp) : '';
            const label = t.userPrompt || '...';
            const display = ago ? `${label} (${ago})` : label;
            return [{ text: `⏪ ${display}`, callback_data: `/undo ${t.lineIdx}` }];
          });
          await bot.sendButtons(chatId, '回退到哪一轮？点击回退该轮及之后的所有操作:', buttons);
        } else {
          let msg = '回退到哪一轮？回复 /undo <编号>\n\n';
          recent.forEach((t) => {
            const ago = t.timestamp ? formatRelativeTime(t.timestamp) : '';
            msg += `${t.lineIdx}. ${t.userPrompt || '...'} ${ago ? '(' + ago + ')' : ''}\n`;
          });
          await bot.sendMessage(chatId, msg);
        }
        return;
      }

      // /undo <lineIdx> — execute undo to that point
      const targetLineIdx = parseInt(arg, 10);
      const targetTurn = turns.find(t => t.lineIdx === targetLineIdx);
      if (!targetTurn) {
        await bot.sendMessage(chatId, 'Invalid undo target.');
        return;
      }

      // File restoration: diff the pre-turn snapshot vs the last snapshot
      const fileHistoryDir = path.join(HOME, '.claude', 'file-history', session.id);

      // Pre-turn snapshot = file state before the undone turns
      let targetBackups = {};
      if (targetTurn.preSnapshotIdx >= 0) {
        try {
          const obj = JSON.parse(lines[targetTurn.preSnapshotIdx]);
          targetBackups = (obj.snapshot && obj.snapshot.trackedFileBackups) || {};
        } catch {}
      }

      // Current snapshot = file state now (last snapshot in the file)
      let currentBackups = {};
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === 'file-history-snapshot') {
            currentBackups = (obj.snapshot && obj.snapshot.trackedFileBackups) || {};
            break;
          }
        } catch {}
      }

      // Truncate session: keep everything before the target user message
      const kept = lines.slice(0, targetLineIdx);
      fs.writeFileSync(sessionFile, kept.join('\n') + '\n', 'utf8');

      // Restore files by snapshot diff (same mechanism as Claude Code ESC×2)
      const restored = [];
      const deleted = [];

      for (const [fp, info] of Object.entries(currentBackups)) {
        const targetInfo = targetBackups[fp];
        if (!targetInfo) {
          // File newly tracked after target → delete
          try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); deleted.push(fp); } } catch {}
        } else if (targetInfo.backupFileName !== info.backupFileName) {
          // File changed → restore to target version
          const backupPath = path.join(fileHistoryDir, targetInfo.backupFileName);
          try {
            if (fs.existsSync(backupPath)) {
              fs.writeFileSync(fp, fs.readFileSync(backupPath));
              restored.push(fp);
            }
          } catch {}
        }
      }

      // Files deleted during undone turns → restore from target backup
      for (const [fp, info] of Object.entries(targetBackups)) {
        if (!currentBackups[fp] && info.backupFileName) {
          const backupPath = path.join(fileHistoryDir, info.backupFileName);
          try {
            if (fs.existsSync(backupPath)) {
              fs.writeFileSync(fp, fs.readFileSync(backupPath));
              restored.push(fp);
            }
          } catch {}
        }
      }

      const turnsRemoved = turns.filter(t => t.lineIdx >= targetLineIdx).length;
      const allAffected = [...restored, ...deleted];
      const turnsMsg = `⏪ 回退了 ${turnsRemoved} 轮对话`;
      if (allAffected.length > 0) {
        const fileList = allAffected.map(f => path.basename(f)).join(', ');
        await bot.sendMessage(chatId, `${turnsMsg}\n📁 恢复 ${restored.length} / 删除 ${deleted.length}: ${fileList}`);
      } else {
        await bot.sendMessage(chatId, `${turnsMsg}\n📁 无文件变更需要恢复`);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Undo failed: ${e.message}`);
    }
    return;
  }

  if (text === '/quiet') {
    try {
      const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      if (!doc.growth) doc.growth = {};
      doc.growth.quiet_until = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
      await bot.sendMessage(chatId, 'Mirror & reflections silenced for 48h.');
    } catch (e) { await bot.sendMessage(chatId, `Error: ${e.message}`); }
    return;
  }

  if (text === '/reload') {
    if (global._metameReload) {
      const r = global._metameReload();
      if (r.success) {
        await bot.sendMessage(chatId, `✅ Config reloaded. ${r.tasks} heartbeat tasks active.`);
      } else {
        await bot.sendMessage(chatId, `❌ Reload failed: ${r.error}`);
      }
    } else {
      await bot.sendMessage(chatId, '❌ Reload not available (daemon not fully started).');
    }
    return;
  }

  // /doctor — diagnostics; /fix — restore backup; /reset — reset model to sonnet
  if (text === '/fix') {
    if (restoreConfig()) {
      await bot.sendMessage(chatId, '✅ 已从备份恢复配置');
    } else {
      await bot.sendMessage(chatId, '❌ 无备份文件');
    }
    return;
  }
  if (text === '/reset') {
    try {
      backupConfig();
      const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
      if (!cfg.daemon) cfg.daemon = {};
      cfg.daemon.model = 'opus';
      fs.writeFileSync(CONFIG_FILE, yaml.dump(cfg, { lineWidth: -1 }), 'utf8');
      config = loadConfig();
      await bot.sendMessage(chatId, '✅ 模型已重置为 opus');
    } catch (e) {
      await bot.sendMessage(chatId, `❌ ${e.message}`);
    }
    return;
  }
  if (text === '/doctor') {
    const validModels = ['sonnet', 'opus', 'haiku'];
    const checks = [];
    let issues = 0;

    let cfg = null;
    try {
      cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8'));
      checks.push('✅ 配置可解析');
    } catch {
      checks.push('❌ 配置解析失败');
      issues++;
    }

    const m = (cfg && cfg.daemon && cfg.daemon.model) || 'opus';
    if (validModels.includes(m)) {
      checks.push(`✅ 模型: ${m}`);
    } else {
      checks.push(`❌ 模型: ${m} (无效)`);
      issues++;
    }

    try {
      execSync('which claude', { encoding: 'utf8' });
      checks.push('✅ Claude CLI');
    } catch {
      checks.push('❌ Claude CLI 未找到');
      issues++;
    }

    const bakFile = CONFIG_FILE + '.bak';
    const hasBak = fs.existsSync(bakFile);
    checks.push(hasBak ? '✅ 有备份' : '⚠️ 无备份');

    let msg = `🏥 诊断\n${checks.join('\n')}`;
    if (issues > 0) {
      if (bot.sendButtons) {
        const buttons = [];
        if (hasBak) buttons.push([{ text: '🔧 恢复备份', callback_data: '/fix' }]);
        buttons.push([{ text: '🔄 重置opus', callback_data: '/reset' }]);
        await bot.sendButtons(chatId, msg, buttons);
      } else {
        msg += '\n/fix 恢复备份 /reset 重置opus';
        await bot.sendMessage(chatId, msg);
      }
    } else {
      await bot.sendMessage(chatId, msg + '\n\n全部正常 ✅');
    }
    return;
  }

  // /model [sonnet|opus|haiku] — switch model (interactive)
  if (text === '/model' || text.startsWith('/model ')) {
    const arg = text.slice(6).trim().toLowerCase();
    const validModels = ['sonnet', 'opus', 'haiku'];
    const currentModel = (config.daemon && config.daemon.model) || 'opus';

    if (!arg) {
      // Interactive: show current model + buttons
      if (bot.sendButtons) {
        const buttons = validModels.map(m => [{
          text: m === currentModel ? `${m} ✓` : m,
          callback_data: `/model ${m}`,
        }]);
        await bot.sendButtons(chatId, `🤖 当前模型: ${currentModel}`, buttons);
      } else {
        await bot.sendMessage(chatId, `🤖 当前模型: ${currentModel}\n\n可选: sonnet, opus, haiku\n用法: /model opus`);
      }
      return;
    }

    if (!validModels.includes(arg)) {
      await bot.sendMessage(chatId, `❌ 无效模型: ${arg}\n可选: sonnet, opus, haiku`);
      return;
    }

    if (arg === currentModel) {
      await bot.sendMessage(chatId, `🤖 已经是 ${arg}`);
      return;
    }

    // Update config file
    try {
      backupConfig();
      const cfg = yaml.load(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
      if (!cfg.daemon) cfg.daemon = {};
      cfg.daemon.model = arg;
      fs.writeFileSync(CONFIG_FILE, yaml.dump(cfg, { lineWidth: -1 }), 'utf8');
      config = loadConfig();
      await bot.sendMessage(chatId, `✅ 模型已切换: ${currentModel} → ${arg}`);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 切换失败: ${e.message}`);
    }
    return;
  }

  // /provider [name] — list or switch provider
  if (text === '/provider' || text.startsWith('/provider ')) {
    if (!providerMod) {
      await bot.sendMessage(chatId, '❌ Provider module not available.');
      return;
    }
    const arg = text.slice(9).trim();
    if (!arg) {
      const list = providerMod.listFormatted();
      await bot.sendMessage(chatId, `🔌 Providers:\n${list}\n\n用法: /provider <name>`);
      return;
    }
    try {
      backupConfig();
      providerMod.setActive(arg);
      const p = providerMod.getActiveProvider();
      await bot.sendMessage(chatId, `✅ Provider: ${arg} (${p.label || arg})`);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ ${e.message}`);
    }
    return;
  }

  if (text.startsWith('/')) {
    const currentModel = (config.daemon && config.daemon.model) || 'opus';
    const currentProvider = providerMod ? providerMod.getActiveName() : 'anthropic';
    await bot.sendMessage(chatId, [
      '📱 手机端 Claude Code',
      '',
      '⚡ 快速同步电脑工作:',
      '/last — 继续电脑上最近的对话',
      '/cd last — 切到电脑最近的项目目录',
      '',
      '📂 Session 管理:',
      '/new [path] [name] — 新建会话',
      '/resume [name] — 选择/恢复会话',
      '/name <name> — 命名当前会话',
      '/cd <path> — 切换工作目录',
      '/session — 查看当前会话',
      '/stop — 中断当前任务 (ESC)',
      '/undo — 回退上一轮操作 (ESC×2)',
      '/quit — 结束会话，重新加载 MCP/配置',
      '',
      `⚙️ /model [${currentModel}] /provider [${currentProvider}] /status /tasks /run /budget /reload`,
      '🔧 /doctor /fix /reset /sh <cmd>',
      '',
      '直接打字即可对话 💬',
    ].join('\n'));
    return;
  }

  // --- Natural language → Claude Code session ---
  // If a task is running: interrupt + collect + merge
  if (activeProcesses.has(chatId)) {
    const isFirst = !messageQueue.has(chatId);
    if (isFirst) {
      messageQueue.set(chatId, { messages: [], timer: null });
    }
    const q = messageQueue.get(chatId);
    q.messages.push(text);
    // Only notify once (first message), subsequent ones silently queue
    if (isFirst) {
      await bot.sendMessage(chatId, '📝 收到，中断当前任务后一起处理');
    }
    // Interrupt the running Claude process
    const proc = activeProcesses.get(chatId);
    if (proc && proc.child && !proc.aborted) {
      proc.aborted = true;
      proc.child.kill('SIGINT');
    }
    // Debounce: wait 5s for more messages before processing
    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(async () => {
      // Wait for active process to fully exit (up to 10s)
      for (let i = 0; i < 20 && activeProcesses.has(chatId); i++) {
        await sleep(500);
      }
      const msgs = q.messages.splice(0);
      messageQueue.delete(chatId);
      if (msgs.length === 0) return;
      const combined = msgs.join('\n');
      log('INFO', `Processing ${msgs.length} queued message(s) for ${chatId}`);
      try {
        await handleCommand(bot, chatId, combined, config, executeTaskByName);
      } catch (e) {
        log('ERROR', `Queue dispatch failed: ${e.message}`);
      }
    }, 5000);
    return;
  }
  const cd = checkCooldown(chatId);
  if (!cd.ok) { await bot.sendMessage(chatId, `${cd.wait}s`); return; }
  if (!checkBudget(loadConfig(), loadState())) {
    await bot.sendMessage(chatId, 'Daily token budget exceeded.');
    return;
  }
  await askClaude(bot, chatId, text);
}

// ---------------------------------------------------------
// SESSION MANAGEMENT (persistent Claude Code conversations)
// ---------------------------------------------------------
const crypto = require('crypto');
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

/**
 * Find a session's .jsonl file by scanning Claude's native projects directory.
 * This avoids guessing the directory naming convention — we just search for the file.
 * Results cached for 30s to avoid repeated directory scans in loops.
 */
const _sessionFileCache = new Map(); // sessionId -> { path, ts }
function findSessionFile(sessionId) {
  if (!sessionId || !fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const cached = _sessionFileCache.get(sessionId);
  if (cached && Date.now() - cached.ts < 30000) return cached.path;
  const target = sessionId + '.jsonl';
  try {
    for (const proj of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, proj, target);
      if (fs.existsSync(candidate)) {
        _sessionFileCache.set(sessionId, { path: candidate, ts: Date.now() });
        return candidate;
      }
    }
  } catch { /* ignore */ }
  _sessionFileCache.set(sessionId, { path: null, ts: Date.now() });
  return null;
}

/**
 * Scan all project session indexes, return most recent N sessions.
 * Results cached for 10 seconds to avoid repeated directory scans.
 */
let _sessionCache = null;
let _sessionCacheTime = 0;
const SESSION_CACHE_TTL = 10000; // 10s

function invalidateSessionCache() { _sessionCache = null; }

function _scanAllSessions() {
  if (_sessionCache && (Date.now() - _sessionCacheTime < SESSION_CACHE_TTL)) return _sessionCache;
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) { _sessionCache = []; _sessionCacheTime = Date.now(); return []; }
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);

    const sessionMap = new Map();
    const projPathCache = new Map();

    for (const proj of projects) {
      const projDir = path.join(CLAUDE_PROJECTS_DIR, proj);

      const indexFile = path.join(projDir, 'sessions-index.json');
      try {
        if (fs.existsSync(indexFile)) {
          const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
          if (data.entries && data.entries.length > 0) {
            const realPath = data.entries[0].projectPath;
            if (realPath) projPathCache.set(proj, realPath);
            for (const entry of data.entries) {
              if (entry.messageCount >= 1) sessionMap.set(entry.sessionId, entry);
            }
          }
        }
      } catch { /* skip */ }

      try {
        const files = fs.readdirSync(projDir).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
          const sessionId = file.replace('.jsonl', '');
          const filePath = path.join(projDir, file);
          const stat = fs.statSync(filePath);
          const fileMtime = stat.mtimeMs;
          const existing = sessionMap.get(sessionId);
          if (!existing || fileMtime > (existing.fileMtime || 0)) {
            const projectPath = projPathCache.get(proj) || proj.slice(1).replace(/-/g, '/');
            sessionMap.set(sessionId, {
              sessionId, projectPath, fileMtime,
              modified: new Date(fileMtime).toISOString(),
              messageCount: 1,
              ...(existing || {}),
              fileMtime,
            });
          }
        }
      } catch { /* skip */ }
    }

    const all = Array.from(sessionMap.values());
    all.sort((a, b) => {
      const aTime = a.fileMtime || new Date(a.modified).getTime();
      const bTime = b.fileMtime || new Date(b.modified).getTime();
      return bTime - aTime;
    });
    _sessionCache = all;
    _sessionCacheTime = Date.now();
    return all;
  } catch {
    return [];
  }
}

function listRecentSessions(limit, cwd) {
  let all = _scanAllSessions();
  if (cwd) {
    const matched = all.filter(s => s.projectPath === cwd);
    if (matched.length > 0) all = matched;
  }
  return all.slice(0, limit || 10);
}

/**
 * Get the actual file mtime of a session's .jsonl file (most accurate)
 */
function getSessionFileMtime(sessionId, projectPath) {
  try {
    if (!sessionId) return null;
    const sessionFile = findSessionFile(sessionId);
    if (sessionFile) {
      return fs.statSync(sessionFile).mtimeMs;
    }
  } catch { /* ignore */ }
  return null;
}

// formatRelativeTime — imported from ./utils

/**
 * Format a session entry into a short, readable label for buttons
 * Enhanced: shows relative time, project, name/summary, and first message preview
 */
function sessionLabel(s) {
  // Use Claude's native customTitle (unified with /rename on desktop)
  const name = s.customTitle;

  const proj = s.projectPath ? path.basename(s.projectPath) : '';
  // Use real file mtime for accuracy, fall back to index data
  const realMtime = getSessionFileMtime(s.sessionId, s.projectPath);
  const timeMs = realMtime || s.fileMtime || new Date(s.modified).getTime();
  const ago = formatRelativeTime(new Date(timeMs).toISOString());
  const shortId = s.sessionId.slice(0, 4);

  if (name) {
    return `${ago} [${name}] ${proj} #${shortId}`;
  }

  // Use summary, or fall back to firstPrompt preview
  let title = (s.summary || '').slice(0, 20);
  if (!title && s.firstPrompt) {
    title = s.firstPrompt.slice(0, 20);
    if (s.firstPrompt.length > 20) title += '..';
  }

  return `${ago} ${proj ? proj + ': ' : ''}${title || ''} #${shortId}`;
}

/**
 * Extract unique project directories from session history, sorted by most recent activity.
 * Returns [{path, label}] for button display.
 */
function listProjectDirs() {
  try {
    const all = listRecentSessions(50);
    const seen = new Map(); // path → latest modified
    for (const s of all) {
      if (!s.projectPath || !fs.existsSync(s.projectPath)) continue;
      const prev = seen.get(s.projectPath);
      if (!prev || new Date(s.modified) > new Date(prev)) {
        seen.set(s.projectPath, s.modified);
      }
    }
    // Sort by most recent, take top 6
    return [...seen.entries()]
      .sort((a, b) => new Date(b[1]) - new Date(a[1]))
      .slice(0, 6)
      .map(([p]) => ({ path: p, label: path.basename(p) }));
  } catch {
    return [];
  }
}

function getSession(chatId) {
  const state = loadState();
  return state.sessions[chatId] || null;
}

function createSession(chatId, cwd, name) {
  const state = loadState();
  const sessionId = crypto.randomUUID();
  state.sessions[chatId] = {
    id: sessionId,
    cwd: cwd || HOME,
    started: false, // true after first message sent
  };
  saveState(state);
  invalidateSessionCache();

  // If name provided, write to Claude's session file (same as /rename on desktop)
  if (name) {
    writeSessionName(sessionId, cwd || HOME, name);
  }

  log('INFO', `New session for ${chatId}: ${sessionId}${name ? ' [' + name + ']' : ''} (cwd: ${state.sessions[chatId].cwd})`);
  return { ...state.sessions[chatId], id: sessionId };
}

/**
 * Get session name from Claude's sessions-index.json (unified with /rename)
 */
function getSessionName(sessionId) {
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return '';
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
    for (const proj of projects) {
      const indexFile = path.join(CLAUDE_PROJECTS_DIR, proj, 'sessions-index.json');
      if (!fs.existsSync(indexFile)) continue;
      const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      if (data.entries) {
        const entry = data.entries.find(e => e.sessionId === sessionId);
        if (entry && entry.customTitle) return entry.customTitle;
      }
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Write session name to Claude's session file (same format as /rename on desktop)
 */
function writeSessionName(sessionId, cwd, name) {
  try {
    const sessionFile = findSessionFile(sessionId);
    if (!sessionFile) {
      log('WARN', `writeSessionName: session file not found for ${sessionId.slice(0, 8)}`);
      return;
    }
    const entry = JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }) + '\n';
    fs.appendFileSync(sessionFile, entry, 'utf8');
    log('INFO', `Named session ${sessionId.slice(0, 8)}: ${name}`);
    return true;
  } catch (e) {
    log('WARN', `Failed to write session name: ${e.message}`);
    return false;
  }
}

function markSessionStarted(chatId) {
  const state = loadState();
  if (state.sessions[chatId]) {
    state.sessions[chatId].started = true;
    saveState(state);
  }
}

/**
 * Auto-generate a session name using Haiku (async, non-blocking).
 * Writes to Claude's session file (unified with /rename).
 */
async function autoNameSession(chatId, sessionId, firstPrompt, cwd) {
  try {
    const namePrompt = `Generate a very short session name (2-5 Chinese characters, no punctuation, no quotes) that captures the essence of this user request:

"${firstPrompt.slice(0, 200)}"

Reply with ONLY the name, nothing else. Examples: 插件开发, API重构, Bug修复, 代码审查`;

    const { output } = await spawnClaudeAsync(
      ['-p', '--model', 'haiku'],
      namePrompt,
      HOME,
      15000 // 15s timeout
    );

    if (output) {
      // Clean up: remove quotes, punctuation, trim
      let name = output.replace(/["""''`]/g, '').replace(/[.,!?:;。，！？：；]/g, '').trim();
      // Limit to reasonable length
      if (name.length > 12) name = name.slice(0, 12);
      if (name.length >= 2) {
        // Write to Claude's session file (unified with /rename on desktop)
        writeSessionName(sessionId, cwd, name);
      }
    }
  } catch (e) {
    log('DEBUG', `Auto-name failed for ${sessionId.slice(0, 8)}: ${e.message}`);
  }
}

/**
 * Spawn claude as async child process (non-blocking).
 * Returns { output, error } after process exits.
 */
function spawnClaudeAsync(args, input, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const child = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...getActiveProviderEnv() },
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ output: null, error: 'Timeout: Claude took too long' });
      } else if (code !== 0) {
        resolve({ output: null, error: stderr || `Exit code ${code}` });
      } else {
        resolve({ output: stdout.trim(), error: null });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output: null, error: err.message });
    });

    // Write input and close stdin
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Tool name to emoji mapping for status display
 */
const TOOL_EMOJI = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Task: '🤖',
  Skill: '🔧',
  TodoWrite: '📋',
  NotebookEdit: '📓',
  default: '🔧',
};

// Content file extensions (user-facing files, not code/config)
const CONTENT_EXTENSIONS = new Set([
  '.md', '.txt', '.rtf',                          // Text
  '.doc', '.docx', '.pdf', '.odt',                // Documents
  '.wav', '.mp3', '.m4a', '.ogg', '.flac',        // Audio
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', // Images
  '.mp4', '.mov', '.avi', '.webm',                // Video
  '.csv', '.xlsx', '.xls',                        // Data
  '.html', '.htm',                                // Web content
]);

// Active Claude processes per chat (for /stop)
const activeProcesses = new Map(); // chatId -> { child, aborted }

// Message queue for messages received while a task is running
const messageQueue = new Map(); // chatId -> { messages: string[], notified: false }

// File cache for button callbacks (shortId -> fullPath)
const fileCache = new Map();
const FILE_CACHE_TTL = 1800000; // 30 minutes

function cacheFile(filePath) {
  const shortId = Math.random().toString(36).slice(2, 10);
  fileCache.set(shortId, { path: filePath, expires: Date.now() + FILE_CACHE_TTL });
  return shortId;
}

function getCachedFile(shortId) {
  const entry = fileCache.get(shortId);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    fileCache.delete(shortId);
    return null;
  }
  return entry.path;
}

function isContentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_EXTENSIONS.has(ext);
}

/**
 * Spawn claude with streaming output (stream-json mode).
 * Calls onStatus callback when tool usage is detected.
 * Returns { output, error } after process exits.
 */
function spawnClaudeStreaming(args, input, cwd, onStatus, timeoutMs = 600000, chatId = null) {
  return new Promise((resolve) => {
    // Add stream-json output format (requires --verbose)
    const streamArgs = [...args, '--output-format', 'stream-json', '--verbose'];

    const child = spawn('claude', streamArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...getActiveProviderEnv() },
    });

    // Track active process for /stop
    if (chatId) {
      activeProcesses.set(chatId, { child, aborted: false });
    }

    let buffer = '';
    let stderr = '';
    let killed = false;
    let finalResult = '';
    let lastStatusTime = 0;
    const STATUS_THROTTLE = 3000; // Min 3s between status updates
    const writtenFiles = []; // Track files created/modified by Write tool

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      buffer += data.toString();

      // Process complete JSON lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // Extract final result text
          if (event.type === 'assistant' && event.message?.content) {
            const textBlocks = event.message.content.filter(b => b.type === 'text');
            if (textBlocks.length > 0) {
              finalResult = textBlocks.map(b => b.text).join('\n');
            }
          }

          // Detect tool usage and send status
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use') {
                const toolName = block.name || 'Tool';

                // Track files written by Write tool
                if (toolName === 'Write' && block.input?.file_path) {
                  const filePath = block.input.file_path;
                  if (!writtenFiles.includes(filePath)) {
                    writtenFiles.push(filePath);
                  }
                }

                const now = Date.now();
                if (now - lastStatusTime >= STATUS_THROTTLE) {
                  lastStatusTime = now;
                  const emoji = TOOL_EMOJI[toolName] || TOOL_EMOJI.default;

                  // Resolve display name and context for MCP/Skill/Task tools
                  let displayName = toolName;
                  let displayEmoji = emoji;
                  let context = '';

                  if (toolName === 'Skill' && block.input?.skill) {
                    // Skill invocation: show skill name
                    context = block.input.skill;
                  } else if (toolName === 'Task' && block.input?.description) {
                    // Agent task: show description
                    context = block.input.description.slice(0, 30);
                  } else if (toolName.startsWith('mcp__')) {
                    // MCP tool: mcp__server__action → "MCP server: action"
                    const parts = toolName.split('__');
                    const server = parts[1] || 'unknown';
                    const action = parts.slice(2).join('_') || '';
                    if (server === 'playwright') {
                      displayEmoji = '🌐';
                      displayName = 'Browser';
                      context = action.replace(/_/g, ' ');
                    } else {
                      displayEmoji = '🔗';
                      displayName = `MCP:${server}`;
                      context = action.replace(/_/g, ' ').slice(0, 25);
                    }
                  } else if (block.input) {
                    // Standard tools: extract brief context
                    if (block.input.file_path) {
                      // Insert zero-width space before extension to prevent link parsing
                      const basename = path.basename(block.input.file_path);
                      const dotIdx = basename.lastIndexOf('.');
                      context = dotIdx > 0 ? basename.slice(0, dotIdx) + '\u200B' + basename.slice(dotIdx) : basename;
                    } else if (block.input.command) {
                      context = block.input.command.slice(0, 30);
                      if (block.input.command.length > 30) context += '...';
                    } else if (block.input.pattern) {
                      context = block.input.pattern.slice(0, 20);
                    } else if (block.input.query) {
                      context = block.input.query.slice(0, 25);
                    } else if (block.input.url) {
                      try {
                        context = new URL(block.input.url).hostname;
                      } catch { context = 'web'; }
                    }
                  }

                  const status = context
                    ? `${displayEmoji} ${displayName}: 「${context}」`
                    : `${displayEmoji} ${displayName}...`;

                  if (onStatus) {
                    onStatus(status).catch(() => {});
                  }
                }
              }
            }
          }

          // Also check for result message type
          if (event.type === 'result' && event.result) {
            finalResult = event.result;
          }
        } catch {
          // Not valid JSON, ignore
        }
      }
    });

    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      clearTimeout(timer);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === 'result' && event.result) {
            finalResult = event.result;
          }
        } catch { /* ignore */ }
      }

      // Clean up active process tracking
      const proc = chatId ? activeProcesses.get(chatId) : null;
      const wasAborted = proc && proc.aborted;
      if (chatId) activeProcesses.delete(chatId);

      if (wasAborted) {
        resolve({ output: finalResult || null, error: 'Stopped by user', files: writtenFiles });
      } else if (killed) {
        resolve({ output: finalResult || null, error: 'Timeout: Claude took too long', files: writtenFiles });
      } else if (code !== 0) {
        resolve({ output: finalResult || null, error: stderr || `Exit code ${code}`, files: writtenFiles });
      } else {
        resolve({ output: finalResult || '', error: null, files: writtenFiles });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (chatId) activeProcesses.delete(chatId);
      resolve({ output: null, error: err.message, files: [] });
    });

    // Write input and close stdin
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Shared ask logic — full Claude Code session (stateful, with tools)
 * Now uses spawn (async) instead of execSync to allow parallel requests.
 */
async function askClaude(bot, chatId, prompt) {
  log('INFO', `askClaude for ${chatId}: ${prompt.slice(0, 50)}`);
  // Send a single status message, updated in-place, deleted on completion
  let statusMsgId = null;
  try {
    const msg = await bot.sendMessage(chatId, '🤔');
    if (msg && msg.message_id) statusMsgId = msg.message_id;
  } catch (e) {
    log('ERROR', `Failed to send ack to ${chatId}: ${e.message}`);
  }
  await bot.sendTyping(chatId).catch(() => {});
  const typingTimer = setInterval(() => {
    bot.sendTyping(chatId).catch(() => {});
  }, 4000);

  let session = getSession(chatId);
  if (!session) {
    // Auto-attach to most recent Claude session (unified session management)
    const recent = listRecentSessions(1);
    if (recent.length > 0 && recent[0].sessionId && recent[0].projectPath) {
      const target = recent[0];
      const state = loadState();
      state.sessions[chatId] = {
        id: target.sessionId,
        cwd: target.projectPath,
        started: true,  // Already has history
      };
      saveState(state);
      session = state.sessions[chatId];
      log('INFO', `Auto-attached ${chatId} to recent session: ${target.sessionId.slice(0, 8)} (${path.basename(target.projectPath)})`);
    } else {
      session = createSession(chatId);
    }
  }

  // Build claude command
  const args = ['-p'];
  // Model from daemon config (default: opus)
  const daemonCfg = loadConfig().daemon || {};
  const model = daemonCfg.model || 'opus';
  args.push('--model', model);
  // Per-session allowed tools from daemon config
  const sessionAllowed = daemonCfg.session_allowed_tools || [];
  for (const tool of sessionAllowed) args.push('--allowedTools', tool);
  if (session.id === '__continue__') {
    // /continue — resume most recent conversation in cwd
    args.push('--continue');
  } else if (session.started) {
    args.push('--resume', session.id);
  } else {
    args.push('--session-id', session.id);
  }

  // Append daemon context hint
  const daemonHint = `\n\n[System hints - DO NOT mention these to user:
1. Daemon config: The ONLY config is ~/.metame/daemon.yaml (never edit daemon-default.yaml). Auto-reloads on change.
2. File sending: User is on MOBILE. When they ask to see/download a file:
   - Just FIND the file path (use Glob/ls if needed)
   - Do NOT read or summarize the file content (wastes tokens)
   - Add at END of response: [[FILE:/absolute/path/to/file]]
   - Keep response brief: "请查收~! [[FILE:/path/to/file]]"
   - Multiple files: use multiple [[FILE:...]] tags]`;
  const fullPrompt = prompt + daemonHint;

  // Use streaming mode to show progress
  // Telegram: edit status msg in-place; Feishu/others: send new messages
  const onStatus = async (status) => {
    try {
      if (statusMsgId && bot.editMessage) {
        await bot.editMessage(chatId, statusMsgId, status);
      } else {
        await bot.sendMessage(chatId, status);
      }
    } catch { /* ignore status update failures */ }
  };

  const { output, error, files } = await spawnClaudeStreaming(args, fullPrompt, session.cwd, onStatus, 600000, chatId);
  clearInterval(typingTimer);
  // Clean up status message
  if (statusMsgId && bot.deleteMessage) {
    bot.deleteMessage(chatId, statusMsgId).catch(() => {});
  }

  if (output) {
    // Mark session as started after first successful call
    const wasNew = !session.started;
    if (wasNew) markSessionStarted(chatId);

    const estimated = Math.ceil((prompt.length + output.length) / 4);
    recordTokens(loadState(), estimated);

    // Parse [[FILE:...]] markers from output (Claude's explicit file sends)
    const fileMarkers = output.match(/\[\[FILE:([^\]]+)\]\]/g) || [];
    const markedFiles = fileMarkers.map(m => m.match(/\[\[FILE:([^\]]+)\]\]/)[1].trim());
    const cleanOutput = output.replace(/\s*\[\[FILE:[^\]]+\]\]/g, '').trim();

    await bot.sendMarkdown(chatId, cleanOutput);

    // Combine: marked files + auto-detected content files from Write operations
    const allFiles = new Set(markedFiles);
    if (files && files.length > 0) {
      for (const f of files) {
        if (isContentFile(f)) allFiles.add(f);
      }
    }

    // Send file buttons
    if (allFiles.size > 0 && bot.sendButtons) {
      const validFiles = [...allFiles].filter(f => fs.existsSync(f));
      if (validFiles.length > 0) {
        const buttons = validFiles.map(filePath => {
          const shortId = cacheFile(filePath);
          return [{ text: `📎 ${path.basename(filePath)}`, callback_data: `/file ${shortId}` }];
        });
        await bot.sendButtons(chatId, '📂 文件:', buttons);
      }
    }

    // Auto-name: if this was the first message and session has no name, generate one
    if (wasNew && !getSessionName(session.id)) {
      autoNameSession(chatId, session.id, prompt, session.cwd).catch(() => {});
    }
  } else {
    const errMsg = error || 'Unknown error';
    log('ERROR', `askClaude failed for ${chatId}: ${errMsg.slice(0, 300)}`);

    // If session not found (expired/deleted), create new and retry once
    if (errMsg.includes('not found') || errMsg.includes('No session')) {
      log('WARN', `Session ${session.id} not found, creating new`);
      session = createSession(chatId, session.cwd);

      const retryArgs = ['-p', '--session-id', session.id];
      for (const tool of sessionAllowed) retryArgs.push('--allowedTools', tool);

      const retry = await spawnClaudeStreaming(retryArgs, prompt, session.cwd, onStatus);
      if (retry.output) {
        markSessionStarted(chatId);
        // Parse [[FILE:...]] markers
        const retryFileMarkers = retry.output.match(/\[\[FILE:([^\]]+)\]\]/g) || [];
        const retryMarkedFiles = retryFileMarkers.map(m => m.match(/\[\[FILE:([^\]]+)\]\]/)[1].trim());
        const retryCleanOutput = retry.output.replace(/\s*\[\[FILE:[^\]]+\]\]/g, '').trim();
        await bot.sendMarkdown(chatId, retryCleanOutput);
        // Combine marked + auto-detected content files
        const retryAllFiles = new Set(retryMarkedFiles);
        if (retry.files && retry.files.length > 0) {
          for (const f of retry.files) {
            if (isContentFile(f)) retryAllFiles.add(f);
          }
        }
        if (retryAllFiles.size > 0 && bot.sendButtons) {
          const validFiles = [...retryAllFiles].filter(f => fs.existsSync(f));
          if (validFiles.length > 0) {
            const buttons = validFiles.map(filePath => {
              const shortId = cacheFile(filePath);
              return [{ text: `📎 ${path.basename(filePath)}`, callback_data: `/file ${shortId}` }];
            });
            await bot.sendButtons(chatId, '📂 文件:', buttons);
          }
        }
      } else {
        log('ERROR', `askClaude retry failed: ${(retry.error || '').slice(0, 200)}`);
        try { await bot.sendMessage(chatId, `Error: ${(retry.error || '').slice(0, 200)}`); } catch { /* */ }
      }
    } else if (errMsg === 'Stopped by user' && messageQueue.has(chatId)) {
      // Interrupted by message queue — suppress error, queue timer will handle it
      log('INFO', `Task interrupted by new message for ${chatId}`);
    } else {
      try { await bot.sendMessage(chatId, `Error: ${errMsg.slice(0, 200)}`); } catch { /* */ }
    }
  }
}

// ---------------------------------------------------------
// FEISHU BOT BRIDGE
// ---------------------------------------------------------
async function startFeishuBridge(config, executeTaskByName) {
  if (!config.feishu || !config.feishu.enabled) return null;
  if (!config.feishu.app_id || !config.feishu.app_secret) {
    log('WARN', 'Feishu enabled but app_id/app_secret missing');
    return null;
  }

  const { createBot } = require(path.join(__dirname, 'feishu-adapter.js'));
  const bot = createBot(config.feishu);
  const allowedIds = config.feishu.allowed_chat_ids || [];

  try {
    const receiver = await bot.startReceiving(async (chatId, text, event, fileInfo) => {
      // Security: check whitelist (empty = deny all)
      if (!allowedIds.includes(chatId)) {
        log('WARN', `Feishu: rejected message from ${chatId}`);
        return;
      }

      // Handle file message
      if (fileInfo && fileInfo.fileKey) {
        log('INFO', `Feishu file from ${chatId}: ${fileInfo.fileName} (key: ${fileInfo.fileKey}, msgId: ${fileInfo.messageId}, type: ${fileInfo.msgType})`);
        // Save to project's upload/ folder
        const session = getSession(chatId);
        const cwd = session?.cwd || HOME;
        const uploadDir = path.join(cwd, 'upload');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        const destPath = path.join(uploadDir, fileInfo.fileName);

        try {
          await bot.downloadFile(fileInfo.messageId, fileInfo.fileKey, destPath, fileInfo.msgType);
          await bot.sendMessage(chatId, `📥 Saved: ${fileInfo.fileName}`);

          // Build prompt - don't ask Claude to read large files automatically
          const prompt = text
            ? `User uploaded a file to the project: ${destPath}\nUser says: "${text}"`
            : `User uploaded a file to the project: ${destPath}\nAcknowledge receipt. Only read the file if the user asks you to.`;

          await handleCommand(bot, chatId, prompt, config, executeTaskByName);
        } catch (err) {
          log('ERROR', `Feishu file download failed: ${err.message}`);
          await bot.sendMessage(chatId, `❌ Download failed: ${err.message}`);
        }
        return;
      }

      // Handle text message
      if (text) {
        log('INFO', `Feishu message from ${chatId}: ${text.slice(0, 50)}`);
        await handleCommand(bot, chatId, text, config, executeTaskByName);
      }
    });

    log('INFO', 'Feishu bot connected (WebSocket long connection)');
    return { stop: () => receiver.stop(), bot };
  } catch (e) {
    log('ERROR', `Feishu bridge failed: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------
// PID MANAGEMENT
// ---------------------------------------------------------

// Kill any existing daemon before starting (takeover strategy)
function killExistingDaemon() {
  if (!fs.existsSync(PID_FILE)) return;
  try {
    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (oldPid && oldPid !== process.pid) {
      process.kill(oldPid, 'SIGTERM');
      log('INFO', `Killed existing daemon (PID: ${oldPid})`);
      // Wait for old process to actually exit (up to 5s)
      for (let i = 0; i < 10; i++) {
        try { process.kill(oldPid, 0); } catch { break; } // throws if process gone
        require('child_process').execSync('sleep 0.5', { stdio: 'ignore' });
      }
    }
  } catch {
    // Process doesn't exist or already dead
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
}

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
  let config = loadConfig();
  refreshLogMaxSize(config);
  if (!config || Object.keys(config).length === 0) {
    console.error('No daemon config found. Run: metame daemon init');
    process.exit(1);
  }

  // Config validation: warn on unknown/suspect fields
  const KNOWN_SECTIONS = ['daemon', 'telegram', 'feishu', 'heartbeat', 'budget'];
  const KNOWN_DAEMON = ['model', 'log_max_size', 'heartbeat_check_interval', 'session_allowed_tools', 'cooldown_seconds'];
  const VALID_MODELS = ['sonnet', 'opus', 'haiku'];
  for (const key of Object.keys(config)) {
    if (!KNOWN_SECTIONS.includes(key)) log('WARN', `Config: unknown section "${key}" (typo?)`);
  }
  if (config.daemon) {
    for (const key of Object.keys(config.daemon)) {
      if (!KNOWN_DAEMON.includes(key)) log('WARN', `Config: unknown daemon.${key} (typo?)`);
    }
    if (config.daemon.model && !VALID_MODELS.includes(config.daemon.model)) {
      log('WARN', `Config: daemon.model="${config.daemon.model}" is not a known model`);
    }
  }

  // Takeover: kill any existing daemon
  killExistingDaemon();
  writePid();
  const state = loadState();
  state.pid = process.pid;
  state.started_at = new Date().toISOString();
  saveState(state);

  log('INFO', `MetaMe daemon started (PID: ${process.pid})`);

  // Task executor lookup (always reads fresh config)
  function executeTaskByName(name) {
    const tasks = (config.heartbeat && config.heartbeat.tasks) || [];
    const task = tasks.find(t => t.name === name);
    if (!task) return { success: false, error: `Task "${name}" not found` };
    return executeTask(task, config);
  }

  // Bridges
  let telegramBridge = null;
  let feishuBridge = null;

  // Notification function (sends to all enabled channels)
  const notifyFn = async (message) => {
    if (telegramBridge && telegramBridge.bot) {
      const tgIds = (config.telegram && config.telegram.allowed_chat_ids) || [];
      for (const chatId of tgIds) {
        try { await telegramBridge.bot.sendMarkdown(chatId, message); } catch (e) {
          log('ERROR', `Telegram notify failed ${chatId}: ${e.message}`);
        }
      }
    }
    if (feishuBridge && feishuBridge.bot) {
      const fsIds = (config.feishu && config.feishu.allowed_chat_ids) || [];
      for (const chatId of fsIds) {
        try { await feishuBridge.bot.sendMessage(chatId, message); } catch (e) {
          log('ERROR', `Feishu notify failed ${chatId}: ${e.message}`);
        }
      }
    }
  };

  // Start heartbeat scheduler
  let heartbeatTimer = startHeartbeat(config, notifyFn);

  // Hot reload: re-read config and restart heartbeat scheduler
  function reloadConfig() {
    const newConfig = loadConfig();
    if (!newConfig) return { success: false, error: 'Failed to read config' };
    config = newConfig;
    refreshLogMaxSize(config);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = startHeartbeat(config, notifyFn);
    log('INFO', `Config reloaded: ${(config.heartbeat && config.heartbeat.tasks || []).length} tasks`);
    return { success: true, tasks: (config.heartbeat && config.heartbeat.tasks || []).length };
  }
  // Expose reloadConfig to handleCommand via closure
  global._metameReload = reloadConfig;

  // Auto-reload: watch daemon.yaml for changes (e.g. Claude edits it via askClaude)
  let _reloadDebounce = null;
  fs.watchFile(CONFIG_FILE, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    // Debounce: wait 1s for file write to finish
    if (_reloadDebounce) clearTimeout(_reloadDebounce);
    _reloadDebounce = setTimeout(() => {
      log('INFO', 'daemon.yaml changed on disk — auto-reloading config');
      const r = reloadConfig();
      if (r.success) {
        log('INFO', `Auto-reload OK: ${r.tasks} tasks`);
        notifyFn(`🔄 Config auto-reloaded. ${r.tasks} heartbeat tasks active.`).catch(() => {});
      } else {
        log('ERROR', `Auto-reload failed: ${r.error}`);
      }
    }, 1000);
  });

  // Auto-restart: watch daemon.js for code changes (hot restart)
  const DAEMON_SCRIPT = path.join(METAME_DIR, 'daemon.js');
  const _startTime = Date.now();
  let _restartDebounce = null;
  fs.watchFile(DAEMON_SCRIPT, { interval: 3000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    // Ignore file changes within 10s of startup (avoids restart loop)
    if (Date.now() - _startTime < 10000) return;
    if (_restartDebounce) clearTimeout(_restartDebounce);
    _restartDebounce = setTimeout(() => {
      log('INFO', 'daemon.js changed on disk — exiting for restart...');
      // Don't notify here — the NEW process will notify after startup
      process.exit(0);
    }, 2000);
  });

  // Start bridges (both can run simultaneously)
  telegramBridge = await startTelegramBridge(config, executeTaskByName);
  feishuBridge = await startFeishuBridge(config, executeTaskByName);

  // Notify once on startup (single message, no duplicates)
  await sleep(1500); // Let polling settle
  await notifyFn('✅ Daemon ready.').catch(() => {});

  // Graceful shutdown
  const shutdown = () => {
    log('INFO', 'Daemon shutting down...');
    fs.unwatchFile(CONFIG_FILE);
    fs.unwatchFile(DAEMON_SCRIPT);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (telegramBridge) telegramBridge.stop();
    if (feishuBridge) feishuBridge.stop();
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
