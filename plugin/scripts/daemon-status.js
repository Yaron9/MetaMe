'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { icon: defaultIcon } = require('./platform');

const DAEMON_LABEL = 'com.metame.npm-daemon';

/**
 * Recognize the status commands before index.js performs any runtime
 * bootstrap.  Keep the command boundary narrow so unrelated commands cannot
 * accidentally bypass the worktree guard.
 */
function isDaemonStatusCommand(argv = process.argv) {
  const args = Array.from(argv).slice(2).map(arg => String(arg).trim().toLowerCase());
  return (args.length === 2 && args[0] === 'daemon' && args[1] === 'status')
    || (args.length === 1 && args[0] === 'status');
}

function readJsonFile(fsModule, filePath, fallback = {}) {
  try {
    return JSON.parse(fsModule.readFileSync(filePath, 'utf8')) || fallback;
  } catch {
    return fallback;
  }
}

function readYamlFile(fsModule, filePath, yamlModule) {
  try {
    return yamlModule.load(fsModule.readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function isPidAlive(processModule, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processModule.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLaunchdPid({ fsModule, processModule, plistPath, execFileSyncFn }) {
  if (processModule.platform !== 'darwin' || !fsModule.existsSync(plistPath)) return null;
  try {
    const output = execFileSyncFn('launchctl', ['list', DAEMON_LABEL], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = String(output).match(/"PID"\s*=\s*(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function collectDaemonStatus({
  homeDir = os.homedir(),
  fsModule = fs,
  processModule = process,
  execFileSyncFn = execFileSync,
  yamlModule = require('js-yaml'),
} = {}) {
  const metameDir = path.join(homeDir, '.metame');
  const statePath = path.join(metameDir, 'daemon_state.json');
  const pidPath = path.join(metameDir, 'daemon.pid');
  const lockPath = path.join(metameDir, 'daemon.lock');
  const configPath = path.join(metameDir, 'daemon.yaml');
  const launchdPlistPath = path.join(
    homeDir,
    'Library',
    'LaunchAgents',
    `${DAEMON_LABEL}.plist`,
  );

  const state = readJsonFile(fsModule, statePath);
  const config = readYamlFile(fsModule, configPath, yamlModule);
  let isRunning = false;
  let runningPid = null;

  if (fsModule.existsSync(pidPath)) {
    const pid = Number.parseInt(fsModule.readFileSync(pidPath, 'utf8').trim(), 10);
    if (isPidAlive(processModule, pid)) {
      isRunning = true;
      runningPid = pid;
    }
  }

  if (!isRunning && fsModule.existsSync(lockPath)) {
    const lock = readJsonFile(fsModule, lockPath, null);
    const pid = Number.parseInt(lock && lock.pid, 10);
    if (isPidAlive(processModule, pid)) {
      isRunning = true;
      runningPid = pid;
    }
  }

  if (!isRunning) {
    const launchdPid = readLaunchdPid({
      fsModule,
      processModule,
      plistPath: launchdPlistPath,
      execFileSyncFn,
    });
    if (launchdPid) {
      isRunning = true;
      runningPid = launchdPid;
    }
  }

  return { config, isRunning, runningPid, state };
}

function renderDaemonStatus({
  homeDir = os.homedir(),
  fsModule = fs,
  processModule = process,
  execFileSyncFn = execFileSync,
  yamlModule = require('js-yaml'),
  icon = defaultIcon,
} = {}) {
  const { config, isRunning, runningPid, state } = collectDaemonStatus({
    homeDir,
    fsModule,
    processModule,
    execFileSyncFn,
    yamlModule,
  });
  const lines = [
    `${icon('bot')} MetaMe Daemon: ${isRunning ? `${icon('green')} Running` : `${icon('red')} Stopped`}`,
  ];

  if (state.started_at) lines.push(`   Started: ${state.started_at}`);
  if (runningPid || state.pid) lines.push(`   PID: ${runningPid || state.pid}`);

  const budget = state.budget || {};
  const limit = (config.budget && config.budget.daily_limit) || 50000;
  lines.push(`   Budget: ${budget.tokens_used || 0}/${limit} tokens (${budget.date || 'no data'})`);

  const tasks = state.tasks || {};
  const configuredTaskNames = new Set();
  for (const task of ((config.heartbeat && config.heartbeat.tasks) || [])) {
    if (task && task.name) configuredTaskNames.add(task.name);
  }
  for (const project of Object.values(config.projects || {})) {
    for (const task of ((project && project.heartbeat_tasks) || [])) {
      if (task && task.name) configuredTaskNames.add(task.name);
    }
  }
  const taskEntries = Object.entries(tasks).filter(([name]) =>
    configuredTaskNames.size === 0 || configuredTaskNames.has(name)
  );
  if (taskEntries.length > 0) {
    lines.push('   Recent tasks:');
    for (const [name, info] of taskEntries) {
      const taskInfo = info || {};
      const symbol = taskInfo.status === 'success' ? icon('ok') : icon('fail');
      lines.push(`     ${symbol} ${name}: ${taskInfo.last_run || 'unknown'}`);
      if (taskInfo.output_preview) {
        lines.push(`        ${String(taskInfo.output_preview).slice(0, 80)}...`);
      }
    }
    const hiddenStale = Object.keys(tasks).length - taskEntries.length;
    if (hiddenStale > 0) lines.push(`     … ${hiddenStale} stale task record(s) hidden`);
  }

  return lines.join('\n');
}

function printDaemonStatus(options = {}) {
  const output = renderDaemonStatus(options);
  (options.consoleModule || console).log(output);
  return output;
}

module.exports = {
  collectDaemonStatus,
  isDaemonStatusCommand,
  printDaemonStatus,
  renderDaemonStatus,
};
