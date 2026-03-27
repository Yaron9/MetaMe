'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const yaml = require('./resolve-yaml');
const { pruneObsoleteMissions, scanLogs } = require('./ops-mission-queue');
const { bootstrapReactiveProject } = require('./daemon-reactive-lifecycle');

const HOME = os.homedir();
const METAME_DIR = path.join(HOME, '.metame');
const CONFIG_PATH = path.join(METAME_DIR, 'daemon.yaml');
const STATE_PATH = path.join(METAME_DIR, 'daemon_state.json');
const PROJECT_KEY = 'metame_ops';

function loadConfig() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { reactive: {}, budget: { tokens_used: 0 } };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function checkBudget(config, state) {
  const budget = config?.daemon?.daily_token_budget;
  const used = Number(state?.budget?.tokens_used || 0);
  if (!Number.isFinite(budget) || budget <= 0) return true;
  return used < budget;
}

function dispatchReactiveItem(item) {
  const dispatchBin = path.join(METAME_DIR, 'bin', 'dispatch_to');
  const args = [dispatchBin];
  if (item.new_session) args.push('--new');
  if (item.from) args.push('--from', item.from);
  args.push(item.target, item.prompt);
  execFileSync(args[0], args.slice(1), {
    encoding: 'utf8',
    timeout: 30000,
    env: process.env,
  });
  return { success: true };
}

function main() {
  const config = loadConfig();
  const project = config?.projects?.[PROJECT_KEY];
  if (!project || !project.cwd) {
    process.stdout.write(JSON.stringify({ success: false, skipped: true, reason: 'project_missing' }) + '\n');
    return;
  }

  const cwd = project.cwd.replace(/^~/, HOME);
  const pruned = pruneObsoleteMissions(cwd);
  const scanned = scanLogs(cwd);

  const result = bootstrapReactiveProject(PROJECT_KEY, config, {
    metameDir: METAME_DIR,
    loadState,
    saveState,
    checkBudget,
    handleDispatchItem: dispatchReactiveItem,
    log: () => {},
    notifyUser: () => {},
  });

  process.stdout.write(JSON.stringify({
    success: true,
    pruned: pruned.pruned || 0,
    new_missions: scanned.new_missions || 0,
    total_pending: scanned.total_pending || 0,
    bootstrap: result,
  }) + '\n');
}

if (require.main === module) main();
