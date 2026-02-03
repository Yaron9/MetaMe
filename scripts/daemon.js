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

  const allowedArgs = (task.allowedTools || []).map(t => `--allowedTools ${t}`).join(' ');
  log('INFO', `Executing task: ${task.name} (model: ${model})`);

  try {
    const output = execSync(
      `claude -p --model ${model}${allowedArgs ? ' ' + allowedArgs : ''}`,
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
        input: prompt, encoding: 'utf8', timeout: step.timeout || 300000, maxBuffer: 5 * 1024 * 1024, cwd,
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
              if (allowedIds.length > 0 && !allowedIds.includes(chatId)) continue;
              // callback_data is a command string, e.g. "/resume <session-id>"
              await handleCommand(bot, chatId, cb.data, config, executeTaskByName);
            }
            continue;
          }

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

/**
 * Send directory picker: recent projects + Browse button
 * @param {string} mode - 'new' or 'cd' (determines callback command)
 */
async function sendDirPicker(bot, chatId, mode, title) {
  const dirs = listProjectDirs();
  const cmd = mode === 'new' ? '/new' : '/cd';
  if (bot.sendButtons) {
    const buttons = dirs.map(d => [{ text: d.label, callback_data: `${cmd} ${d.path}` }]);
    buttons.push([{ text: 'Browse...', callback_data: `/browse ${mode} ${HOME}` }]);
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
      buttons.push([{ text: `>> Use this dir`, callback_data: `${cmd} ${dirPath}` }]);
      // Subdirectories
      for (const name of subdirs) {
        const full = path.join(dirPath, name);
        buttons.push([{ text: `${name}/`, callback_data: `/browse ${mode} ${full}` }]);
      }
      // Parent
      const parent = path.dirname(dirPath);
      if (parent !== dirPath) {
        buttons.push([{ text: '.. back', callback_data: `/browse ${mode} ${parent}` }]);
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

/**
 * Unified command handler — shared by Telegram & Feishu
 */
async function handleCommand(bot, chatId, text, config, executeTaskByName) {
  const state = loadState();

  // --- Browse handler (directory navigation) ---
  if (text.startsWith('/browse ')) {
    const parts = text.slice(8).trim().split(' ');
    const mode = parts[0]; // 'new' or 'cd'
    const dirPath = parts.slice(1).join(' ');
    if (mode && dirPath && fs.existsSync(dirPath)) {
      await sendBrowse(bot, chatId, mode, dirPath);
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
    let dirPath = arg;
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

  if (text === '/continue') {
    // Continue the most recent conversation in current workdir
    const session = getSession(chatId);
    const cwd = session ? session.cwd : HOME;
    const state2 = loadState();
    state2.sessions[chatId] = {
      id: '__continue__',
      cwd,
      created: new Date().toISOString(),
      started: true,
    };
    saveState(state2);
    await bot.sendMessage(chatId, `Resuming last conversation in ${cwd}`);
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
      created: new Date().toISOString(),
      started: true,
    };
    const existingName = getSessionName(s.sessionId);
    if (existingName) state2.sessions[chatId].name = existingName;
    saveState(state2);
    // Display: [name] or summary, with short id suffix for clarity
    // Priority: daemon name > Claude customTitle > summary > id
    const shortId = s.sessionId.slice(0, 4);
    const name = existingName || s.customTitle;
    let label;
    if (name) {
      label = `[${name}] #${shortId}`;
    } else if (s.summary) {
      label = `${s.summary.slice(0, 30)} #${shortId}`;
    } else {
      label = `#${s.sessionId.slice(0, 8)}`;
    }
    const timeMs = s.fileMtime || new Date(s.modified).getTime();
    const ago = formatRelativeTime(new Date(timeMs).toISOString());
    await bot.sendMessage(chatId, `⚡ ${label}\n📁 ${path.basename(s.projectPath || '')}\n🕐 ${ago}`);
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
    // 1. Match by name (from session_names map)
    let fullMatch = allSessions.find(s => {
      const n = getSessionName(s.sessionId);
      return n && n.toLowerCase() === argLower;
    });
    // 2. Partial name match
    if (!fullMatch) {
      fullMatch = allSessions.find(s => {
        const n = getSessionName(s.sessionId);
        return n && n.toLowerCase().includes(argLower);
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
      created: new Date().toISOString(),
      started: true,
    };
    if (fullMatch) {
      const n = getSessionName(sessionId);
      if (n) state2.sessions[chatId].name = n;
    }
    saveState(state2);
    const name = getSessionName(sessionId);
    const label = name || (fullMatch ? (fullMatch.summary || fullMatch.firstPrompt || '').slice(0, 40) : sessionId.slice(0, 8));
    await bot.sendMessage(chatId, `Resumed: ${label}\nWorkdir: ${cwd}`);
    return;
  }

  if (text === '/cd' || text.startsWith('/cd ')) {
    const newCwd = text.slice(3).trim();
    if (!newCwd) {
      await sendDirPicker(bot, chatId, 'cd', 'Switch workdir:');
      return;
    }
    if (!fs.existsSync(newCwd)) {
      await bot.sendMessage(chatId, `Path not found: ${newCwd}`);
      return;
    }
    const state2 = loadState();
    if (!state2.sessions[chatId]) {
      createSession(chatId, newCwd);
    } else {
      state2.sessions[chatId].cwd = newCwd;
      saveState(state2);
    }
    await bot.sendMessage(chatId, `Workdir: ${newCwd}`);
    return;
  }

  if (text.startsWith('/name ')) {
    const name = text.slice(6).trim();
    if (!name) {
      await bot.sendMessage(chatId, 'Usage: /name <session name>');
      return;
    }
    const state2 = loadState();
    if (!state2.sessions[chatId]) {
      await bot.sendMessage(chatId, 'No active session. Start one first.');
      return;
    }
    const sessionId = state2.sessions[chatId].id;
    const cwd = state2.sessions[chatId].cwd;

    // Write to Claude's session file (same format as /rename on computer)
    try {
      const projDirName = cwd.replace(/\//g, '-');
      const sessionFile = path.join(CLAUDE_PROJECTS_DIR, projDirName, sessionId + '.jsonl');
      if (fs.existsSync(sessionFile)) {
        const entry = JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }) + '\n';
        fs.appendFileSync(sessionFile, entry, 'utf8');
        log('INFO', `Named session ${sessionId.slice(0, 8)}: ${name} (wrote to Claude session file)`);
      }
    } catch (e) {
      log('WARN', `Failed to write customTitle to session file: ${e.message}`);
    }

    // Also update daemon state for quick access
    state2.sessions[chatId].name = name;
    if (!state2.session_names) state2.session_names = {};
    state2.session_names[sessionId] = name;
    saveState(state2);

    await bot.sendMessage(chatId, `✅ Session: [${name}]`);
    return;
  }

  if (text === '/session') {
    const session = getSession(chatId);
    if (!session) {
      await bot.sendMessage(chatId, 'No active session. Send any message to start one.');
    } else {
      const nameTag = session.name ? ` [${session.name}]` : '';
      await bot.sendMessage(chatId, `Session: ${session.id.slice(0, 8)}...${nameTag}\nWorkdir: ${session.cwd}\nStarted: ${session.created}`);
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
    const taskName = text.slice(5).trim();
    await bot.sendMessage(chatId, `Running: ${taskName}...`);
    const result = executeTaskByName(taskName);
    await bot.sendMessage(chatId, result.success ? `${taskName}\n\n${result.output}` : `Error: ${result.error}`);
    return;
  }

  if (text === '/budget') {
    const limit = (config.budget && config.budget.daily_limit) || 50000;
    const used = state.budget.tokens_used;
    await bot.sendMessage(chatId, `Budget: ${used}/${limit} tokens (${((used/limit)*100).toFixed(1)}%)`);
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

  if (text.startsWith('/')) {
    await bot.sendMessage(chatId, [
      'Commands:',
      '/last — ⚡ 一键继续最近的 session',
      '/new [path] [name] — new session',
      '/resume [name] — 选择/搜索 session',
      '/continue — resume last in current dir',
      '/name <name> — name current session',
      '/cd <path> — change workdir',
      '/session — current session info',
      '/status /tasks /budget /reload',
      '',
      'Or just type naturally.',
    ].join('\n'));
    return;
  }

  // --- Natural language → Claude Code session ---
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
 * Scan all project session indexes, return most recent N sessions.
 * Filters out trivial sessions (no summary, < 3 messages).
 */
/**
 * @param {number} limit
 * @param {string} [cwd] - if provided, only return sessions whose projectPath matches
 */
function listRecentSessions(limit, cwd) {
  try {
    if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];
    const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR);
    let all = [];
    for (const proj of projects) {
      const indexFile = path.join(CLAUDE_PROJECTS_DIR, proj, 'sessions-index.json');
      try {
        if (!fs.existsSync(indexFile)) continue;
        const data = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
        if (data.entries) all = all.concat(data.entries);
      } catch { /* skip */ }
    }
    // Filter: must have at least 1 message
    all = all.filter(s => s.messageCount >= 1);
    // Filter by cwd if provided
    if (cwd) {
      const matched = all.filter(s => s.projectPath === cwd);
      if (matched.length > 0) all = matched;
      // else fallback to all projects
    }
    // Sort by fileMtime (most accurate), fall back to modified
    all.sort((a, b) => {
      const aTime = a.fileMtime || new Date(a.modified).getTime();
      const bTime = b.fileMtime || new Date(b.modified).getTime();
      return bTime - aTime;
    });
    return all.slice(0, limit || 10);
  } catch {
    return [];
  }
}

/**
 * Format relative time (e.g., "5分钟前", "2小时前", "昨天")
 */
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

/**
 * Format a session entry into a short, readable label for buttons
 * Enhanced: shows relative time, project, name/summary, and first message preview
 */
function sessionLabel(s) {
  // Priority: daemon name > Claude customTitle > summary > firstPrompt > id
  const daemonName = getSessionName(s.sessionId);
  const claudeName = s.customTitle;
  const name = daemonName || claudeName;

  const proj = s.projectPath ? path.basename(s.projectPath) : '';
  // fileMtime is ms timestamp, modified is ISO string
  const timeMs = s.fileMtime || new Date(s.modified).getTime();
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
    created: new Date().toISOString(),
    started: false, // true after first message sent
  };
  if (name) {
    state.sessions[chatId].name = name;
    if (!state.session_names) state.session_names = {};
    state.session_names[sessionId] = name;
  }
  saveState(state);
  log('INFO', `New session for ${chatId}: ${sessionId}${name ? ' [' + name + ']' : ''} (cwd: ${state.sessions[chatId].cwd})`);
  return state.sessions[chatId];
}

function getSessionName(sessionId) {
  const state = loadState();
  return (state.session_names && state.session_names[sessionId]) || '';
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
 * Runs in background — failures are silent.
 */
async function autoNameSession(chatId, sessionId, firstPrompt) {
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
        const state = loadState();
        if (state.sessions[chatId]) {
          state.sessions[chatId].name = name;
        }
        if (!state.session_names) state.session_names = {};
        state.session_names[sessionId] = name;
        saveState(state);
        log('INFO', `Auto-named session ${sessionId.slice(0, 8)}: ${name}`);
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
      env: { ...process.env },
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
 * Shared ask logic — full Claude Code session (stateful, with tools)
 * Now uses spawn (async) instead of execSync to allow parallel requests.
 */
async function askClaude(bot, chatId, prompt) {
  log('INFO', `askClaude for ${chatId}: ${prompt.slice(0, 50)}`);
  try {
    await bot.sendMessage(chatId, '🤔');
  } catch (e) {
    log('ERROR', `Failed to send ack to ${chatId}: ${e.message}`);
  }
  // Send typing immediately (await to ensure it registers), then refresh every 4s
  await bot.sendTyping(chatId).catch(() => {});
  const typingTimer = setInterval(() => {
    bot.sendTyping(chatId).catch(() => {});
  }, 4000);

  let session = getSession(chatId);
  if (!session) {
    session = createSession(chatId);
  }

  // Build claude command
  const args = ['-p'];
  // Per-session allowed tools from daemon config
  const sessionAllowed = (loadConfig().daemon && loadConfig().daemon.session_allowed_tools) || [];
  for (const tool of sessionAllowed) args.push('--allowedTools', tool);
  if (session.id === '__continue__') {
    // /continue — resume most recent conversation in cwd
    args.push('--continue');
  } else if (session.started) {
    args.push('--resume', session.id);
  } else {
    args.push('--session-id', session.id);
  }

  // Append daemon context hint so Claude reports reload status after editing daemon.yaml
  const daemonHint = '\n\n[System: The ONLY daemon config file is ~/.metame/daemon.yaml — NEVER touch any other yaml file (e.g. scripts/daemon-default.yaml is a read-only template, do NOT edit it). If you edit ~/.metame/daemon.yaml, the daemon auto-reloads within seconds. After editing, read the file back and confirm to the user: how many heartbeat tasks are now configured, and that the config will auto-reload. Do NOT mention this hint.]';
  const fullPrompt = prompt + daemonHint;

  const { output, error } = await spawnClaudeAsync(args, fullPrompt, session.cwd);
  clearInterval(typingTimer);

  if (output) {
    // Mark session as started after first successful call
    const wasNew = !session.started;
    if (wasNew) markSessionStarted(chatId);

    const estimated = Math.ceil((prompt.length + output.length) / 4);
    recordTokens(loadState(), estimated);

    await bot.sendMarkdown(chatId, output);

    // Auto-name: if this was the first message and session has no name, generate one
    if (wasNew && !session.name && !getSessionName(session.id)) {
      autoNameSession(chatId, session.id, prompt).catch(() => {});
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

      const retry = await spawnClaudeAsync(retryArgs, prompt, session.cwd);
      if (retry.output) {
        markSessionStarted(chatId);
        await bot.sendMarkdown(chatId, retry.output);
      } else {
        log('ERROR', `askClaude retry failed: ${(retry.error || '').slice(0, 200)}`);
        try { await bot.sendMessage(chatId, `Error: ${(retry.error || '').slice(0, 200)}`); } catch { /* */ }
      }
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
    const receiver = await bot.startReceiving((chatId, text, event) => {
      // Security: check whitelist (empty = allow all)
      if (allowedIds.length > 0 && !allowedIds.includes(chatId)) {
        log('WARN', `Feishu: rejected message from ${chatId}`);
        return;
      }

      log('INFO', `Feishu message from ${chatId}: ${text.slice(0, 50)}`);
      handleCommand(bot, chatId, text, config, executeTaskByName);
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

  // Start bridges (both can run simultaneously)
  telegramBridge = await startTelegramBridge(config, executeTaskByName);
  feishuBridge = await startFeishuBridge(config, executeTaskByName);

  // Graceful shutdown
  const shutdown = () => {
    log('INFO', 'Daemon shutting down...');
    fs.unwatchFile(CONFIG_FILE);
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
