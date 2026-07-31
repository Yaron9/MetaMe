#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.metame', 'daemon.yaml');
const STATE_DIR = path.join(HOME, '.metame', 'research-radar');
const PROJECT_KEY = 'scientist';
const DAILY_TASK = 'research-radar-daily';
const FIRST_TASK = 'research-radar-first-report';
const COMMAND = 'node ~/AGI/AgentScientist/research-radar/scripts/production-run.js';

function writeAtomic(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, content, { mode });
  fs.renameSync(tempPath, filePath);
}

function nextMinute(now, offsetMinutes = 2) {
  const value = new Date(now);
  value.setSeconds(0, 0);
  value.setMinutes(value.getMinutes() + offsetMinutes);
  return `${String(value.getHours()).padStart(2, '0')}:` +
    `${String(value.getMinutes()).padStart(2, '0')}`;
}

function task(name, { at, scheduleEnabled, oneShot = false }) {
  return {
    name,
    type: 'script',
    command: COMMAND,
    engine: 'agy',
    model_backed: false,
    at,
    days: 'daily',
    timeout: 1800,
    require_idle: false,
    notify: true,
    enabled: true,
    schedule_enabled: scheduleEnabled,
    one_shot: oneShot,
  };
}

function upsertTask(tasks, next) {
  const index = tasks.findIndex(item => item && item.name === next.name);
  if (index === -1) tasks.push(next);
  else tasks[index] = { ...tasks[index], ...next };
}

function hasScientistChat(config) {
  const allowed = new Set(config.feishu?.allowed_chat_ids || []);
  return Object.entries(config.feishu?.chat_agent_map || {})
    .some(([chatId, project]) => allowed.has(chatId) && project === PROJECT_KEY);
}

function latestSuccessfulReceipt(stateDir) {
  const receiptDir = path.join(stateDir, 'delivery-receipts');
  if (!fs.existsSync(receiptDir)) return null;
  const receipts = fs.readdirSync(receiptDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try {
        return JSON.parse(fs.readFileSync(path.join(receiptDir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(item => item.deliveryStatus === 'success')
    .filter(item => ['success', 'partial'].includes(item.payload?.scanStatus))
    .sort((left, right) => (
      String(right.deliveredAt).localeCompare(String(left.deliveredAt))
    ));
  return receipts[0] || null;
}

function liveBaselinePassed(stateDir) {
  const markerPath = path.join(stateDir, 'live-baseline-pass.json');
  if (!fs.existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return marker.passed === true && marker.mode === 'baseline-no-delivery';
  } catch {
    return false;
  }
}

function configureDaemon(config, { mode, now, stateDir }) {
  if (!config.projects || !config.projects[PROJECT_KEY]) {
    throw new Error('scientist project is not configured');
  }
  if (!hasScientistChat(config)) {
    throw new Error('no existing Feishu chat is bound to scientist');
  }
  const project = config.projects[PROJECT_KEY];
  project.notification_channel = 'feishu';
  project.strict_notify_target = true;
  if (!Array.isArray(project.heartbeat_tasks)) project.heartbeat_tasks = [];

  const staged = mode === 'stage-first';
  const activated = mode === 'activate';
  const rollback = mode === 'rollback';
  if ((staged || activated) && !liveBaselinePassed(stateDir)) {
    throw new Error('live no-delivery baseline has not passed');
  }
  if (activated && !latestSuccessfulReceipt(stateDir)) {
    throw new Error('first 科研总管 delivery receipt is missing or failed');
  }
  const existingDaily = project.heartbeat_tasks.find(item => item?.name === DAILY_TASK);
  const existingFirst = project.heartbeat_tasks.find(item => item?.name === FIRST_TASK);
  const dailyScheduleEnabled = activated
    ? true
    : rollback || staged
      ? false
      : existingDaily?.schedule_enabled === true;
  const firstScheduleEnabled = staged
    ? true
    : rollback || activated
      ? false
      : existingFirst?.schedule_enabled === true;
  upsertTask(project.heartbeat_tasks, task(DAILY_TASK, {
    at: '21:30',
    scheduleEnabled: dailyScheduleEnabled,
  }));
  upsertTask(project.heartbeat_tasks, task(FIRST_TASK, {
    at: nextMinute(now),
    scheduleEnabled: firstScheduleEnabled,
    oneShot: true,
  }));
  return config;
}

function setup({
  mode = 'install',
  configPath = CONFIG_PATH,
  stateDir = STATE_DIR,
  now = new Date(),
} = {}) {
  if (!['install', 'stage-first', 'activate', 'rollback'].includes(mode)) {
    throw new Error(`unsupported setup mode: ${mode}`);
  }
  const config = yaml.load(fs.readFileSync(configPath, 'utf8')) || {};
  const next = configureDaemon(config, { mode, now, stateDir });
  writeAtomic(configPath, yaml.dump(next, { lineWidth: -1, noRefs: true }));
  const project = next.projects[PROJECT_KEY];
  const tasks = Object.fromEntries(project.heartbeat_tasks
    .filter(item => [DAILY_TASK, FIRST_TASK].includes(item.name))
    .map(item => [item.name, {
      at: item.at,
      scheduleEnabled: item.schedule_enabled,
      engine: item.engine,
    }]));
  return {
    mode,
    project: PROJECT_KEY,
    target: 'existing scientist Feishu chat',
    tasks,
  };
}

function parseMode(argv) {
  if (argv.includes('--stage-first')) return 'stage-first';
  if (argv.includes('--activate')) return 'activate';
  if (argv.includes('--rollback')) return 'rollback';
  return 'install';
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(setup({ mode: parseMode(process.argv) }), null, 2));
  } catch (error) {
    console.error(`[research-radar-setup] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  configureDaemon,
  hasScientistChat,
  latestSuccessfulReceipt,
  liveBaselinePassed,
  nextMinute,
  setup,
};
