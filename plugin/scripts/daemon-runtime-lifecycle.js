'use strict';

const { execSync } = require('child_process');
const { sleepSync } = require('./platform');

function createPidManager(deps) {
  const { fs, PID_FILE, log } = deps;

  function killExistingDaemon() {
    if (!fs.existsSync(PID_FILE)) return;
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        process.kill(oldPid, 'SIGTERM');
        log('INFO', `Killing existing daemon (PID: ${oldPid}) with SIGTERM`);
        let alive = true;
        for (let i = 0; i < 10; i++) {
          try { process.kill(oldPid, 0); } catch { alive = false; break; }
          sleepSync(500);
        }
        // Escalate to SIGKILL if SIGTERM didn't work within 5s
        if (alive) {
          try {
            process.kill(oldPid, 'SIGKILL');
            log('WARN', `Old daemon (PID: ${oldPid}) did not respond to SIGTERM — sent SIGKILL`);
          } catch { /* already dead */ }
          sleepSync(500);
        }
      }
    } catch {
      // Process doesn't exist or already dead
    }
    try { fs.unlinkSync(PID_FILE); } catch { }
  }

  function writePid() {
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  }

  function cleanPid() {
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
    } catch { /* ignore */ }
  }

  return { killExistingDaemon, writePid, cleanPid };
}

function setupRuntimeWatchers(deps) {
  const {
    fs,
    path,
    CONFIG_FILE,
    METAME_DIR,
    loadConfig,
    loadConfigStrict,
    refreshLogMaxSize,
    startHeartbeat,
    getAllTasks,
    log,
    notifyFn,
    adminNotifyFn,
    notifyPersonalFn,
    activeProcesses,
    getConfig,
    setConfig,
    getHeartbeatTimer,
    setHeartbeatTimer,
    onRestartRequested,
    // Agent soul layer auto-repair — optional, gracefully skipped if absent
    repairAgentLayer,
    writeConfigSafe,
    expandPath,
    HOME,
  } = deps;

  /**
   * After every config reload: ensure all project agent soul layers are healthy.
   *
   * For each project:
   *   1. If cwd changed vs oldConfig → remove stale SOUL.md/MEMORY.md symlinks from old dir
   *   2. Call repairAgentLayer (idempotent)
   *   3. Persist missing agent_id back to daemon.yaml
   */
  function autoRepairAgentLayers(oldConfig, newConfig) {
    if (typeof repairAgentLayer !== 'function') return;
    const projects = newConfig && newConfig.projects;
    if (!projects || typeof projects !== 'object') return;

    const normCwd = (raw) => {
      if (!raw) return null;
      try {
        const expanded = typeof expandPath === 'function'
          ? expandPath(String(raw))
          : String(raw).replace(/^~/, HOME || require('os').homedir());
        return path.resolve(expanded);
      } catch { return null; }
    };

    let repaired = 0;
    let agentIdFixed = 0;
    let needsWrite = false;

    for (const [projectKey, project] of Object.entries(projects)) {
      if (!project || !project.cwd) continue;
      const newCwd = normCwd(project.cwd);
      if (!newCwd) continue;

      // Clean stale symlinks when cwd changed
      const oldProject = oldConfig && oldConfig.projects && oldConfig.projects[projectKey];
      if (oldProject && oldProject.cwd) {
        const oldCwd = normCwd(oldProject.cwd);
        if (oldCwd && oldCwd !== newCwd) {
          for (const fname of ['SOUL.md', 'MEMORY.md']) {
            const stale = path.join(oldCwd, fname);
            try {
              if (fs.existsSync(stale) && fs.lstatSync(stale).isSymbolicLink()) {
                fs.unlinkSync(stale);
                log('INFO', `[agent-repair] Removed stale ${fname} from ${oldCwd}`);
              }
            } catch { /* non-critical */ }
          }
        }
      }

      // Repair soul layer (idempotent — safe every reload)
      try {
        const ensured = repairAgentLayer(projectKey, project, HOME);
        if (ensured) {
          repaired++;
          if (!project.agent_id && ensured.agentId) {
            newConfig.projects[projectKey] = { ...project, agent_id: ensured.agentId };
            needsWrite = true;
            agentIdFixed++;
          }
        }
      } catch (e) {
        log('WARN', `[agent-repair] ${projectKey}: ${e.message}`);
      }
    }

    if (needsWrite && typeof writeConfigSafe === 'function') {
      try {
        writeConfigSafe(newConfig);
        log('INFO', `[agent-repair] Persisted ${agentIdFixed} agent_id(s) to daemon.yaml`);
      } catch (e) {
        log('WARN', `[agent-repair] writeConfigSafe failed: ${e.message}`);
      }
    }

    if (repaired > 0) log('INFO', `[agent-repair] ${repaired} layer(s) ensured${agentIdFixed ? `, ${agentIdFixed} agent_id(s) added` : ''}`);
  }

  function reloadConfig() {
    const oldConfig = typeof getConfig === 'function' ? getConfig() : null;
    const strict = typeof loadConfigStrict === 'function'
      ? loadConfigStrict()
      : { ok: true, config: loadConfig() };
    if (!strict.ok) return { success: false, error: strict.error || 'Failed to read config' };
    const newConfig = strict.config;
    setConfig(newConfig);
    refreshLogMaxSize(newConfig);
    const timer = getHeartbeatTimer();
    if (timer) clearInterval(timer);
    setHeartbeatTimer(startHeartbeat(newConfig, notifyFn, notifyPersonalFn));
    const { general, project } = getAllTasks(newConfig);
    const totalCount = general.length + project.length;
    log('INFO', `Config reloaded: ${totalCount} tasks (${project.length} in projects)`);
    // Auto-repair agent soul layers on every config change (idempotent, fire-and-forget)
    try { autoRepairAgentLayers(oldConfig, newConfig); } catch (e) {
      log('WARN', `[agent-repair] Unexpected error: ${e.message}`);
    }
    return { success: true, tasks: totalCount };
  }

  let reloadDebounce = null;
  fs.watchFile(CONFIG_FILE, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      log('INFO', 'daemon.yaml changed on disk — auto-reloading config');
      const r = reloadConfig();
      if (r.success) {
        log('INFO', `Auto-reload OK: ${r.tasks} tasks`);
        adminNotifyFn(`🔄 Config auto-reloaded. ${r.tasks} heartbeat tasks active.`).catch(() => { });
      } else {
        log('ERROR', `Auto-reload failed: ${r.error}`);
      }
    }, 1000);
  });

  // ── Pre-restart syntax validation ──────────────────────────────────────────
  // Catches the most common class of hot-reload failures: syntax errors from
  // bad merges or careless agent edits. Runs `node -c` on all .js files in
  // METAME_DIR before allowing the daemon to exit for restart.
  function validateScriptsSyntax() {
    try {
      const jsFiles = fs.readdirSync(METAME_DIR).filter(f => f.endsWith('.js'));
      const errors = [];
      for (const f of jsFiles) {
        const fp = path.join(METAME_DIR, f);
        try {
          execSync(`"${process.execPath}" -c "${fp}"`, {
            timeout: 5000,
            stdio: 'pipe',
            windowsHide: true,
          });
        } catch (e) {
          const msg = (e.stderr ? e.stderr.toString().trim() : e.message).split('\n')[0];
          errors.push(`${f}: ${msg}`);
        }
      }
      if (errors.length > 0) {
        return { ok: false, errors };
      }
      return { ok: true };
    } catch (e) {
      // If validation itself fails (e.g. can't read dir), allow restart
      log('WARN', `Syntax validation skipped: ${e.message}`);
      return { ok: true };
    }
  }

  // ── Last-good backup ─────────────────────────────────────────────────────
  const LAST_GOOD_DIR = path.join(METAME_DIR, '.last-good');

  function backupLastGood() {
    try {
      if (!fs.existsSync(LAST_GOOD_DIR)) fs.mkdirSync(LAST_GOOD_DIR, { recursive: true });
      const jsFiles = fs.readdirSync(METAME_DIR).filter(f => f.endsWith('.js'));
      for (const f of jsFiles) {
        fs.copyFileSync(path.join(METAME_DIR, f), path.join(LAST_GOOD_DIR, f));
      }
      log('INFO', `[BACKUP] Saved ${jsFiles.length} scripts to .last-good/`);
    } catch (e) {
      log('WARN', `[BACKUP] Failed: ${e.message}`);
    }
  }

  function restoreFromLastGood() {
    try {
      if (!fs.existsSync(LAST_GOOD_DIR)) return false;
      const files = fs.readdirSync(LAST_GOOD_DIR).filter(f => f.endsWith('.js'));
      if (files.length === 0) return false;
      for (const f of files) {
        fs.copyFileSync(path.join(LAST_GOOD_DIR, f), path.join(METAME_DIR, f));
      }
      log('INFO', `[RESTORE] Restored ${files.length} scripts from .last-good/`);
      return true;
    } catch (e) {
      log('ERROR', `[RESTORE] Failed: ${e.message}`);
      return false;
    }
  }

  // Delay initial backup: only backup after daemon has been running stably for 60s.
  // This prevents backing up broken code that passed syntax check but fails at runtime.
  const STABLE_BACKUP_DELAY_MS = 60 * 1000;
  const stableBackupTimer = setTimeout(() => {
    backupLastGood();
  }, STABLE_BACKUP_DELAY_MS);

  // ── Crash-loop detection ─────────────────────────────────────────────────
  // Uses a consecutive crash counter (not just single boot timestamp) to avoid
  // false positives from one-off crashes caused by user input rather than bad code.
  const restartFromPid = process.env.METAME_RESTART_FROM_PID;
  const bootFile = path.join(METAME_DIR, '.last-boot-ts');
  const crashCountFile = path.join(METAME_DIR, '.crash-count');
  if (restartFromPid) {
    try {
      if (fs.existsSync(bootFile)) {
        const lastBoot = Number(fs.readFileSync(bootFile, 'utf8').trim());
        const elapsed = Date.now() - lastBoot;
        if (elapsed > 0 && elapsed < 30000) {
          // Increment crash counter
          let crashCount = 1;
          try { crashCount = Number(fs.readFileSync(crashCountFile, 'utf8').trim()) + 1; } catch { /* first crash */ }
          fs.writeFileSync(crashCountFile, String(crashCount), 'utf8');
          log('FATAL', `[CRASH-LOOP] Previous daemon lived only ${Math.round(elapsed / 1000)}s (consecutive: ${crashCount})`);
          if (crashCount >= 2) {
            log('FATAL', `[CRASH-LOOP] ${crashCount} consecutive fast crashes — restoring from .last-good`);
            const restored = restoreFromLastGood();
            if (restored) {
              adminNotifyFn('⚠️ 检测到 daemon 连续崩溃，已从上一个正常版本恢复。请检查最近的代码改动。').catch(() => {});
              try { fs.writeFileSync(crashCountFile, '0', 'utf8'); } catch { /* non-fatal */ }
            }
          }
        } else {
          // Previous daemon ran long enough — reset crash counter
          try { fs.writeFileSync(crashCountFile, '0', 'utf8'); } catch { /* non-fatal */ }
        }
      }
    } catch { /* non-fatal */ }
  }
  // Record boot timestamp for next crash-loop check
  try { fs.writeFileSync(bootFile, String(Date.now()), 'utf8'); } catch { /* non-fatal */ }

  // ── Safe restart: validate then proceed ──────────────────────────────────
  function safeRestart() {
    // Guard: if a new task started during the deferred-restart grace period,
    // re-defer instead of killing active processes (fixes team-agent concurrency bug).
    if (activeProcesses.size > 0) {
      log('INFO', `[RESTART] Re-deferred — ${activeProcesses.size} active task(s) started during grace period`);
      deferredRestartTimer = null;
      // pendingRestart stays true → next activeProcesses.delete will re-trigger
      return;
    }
    const validation = validateScriptsSyntax();
    if (!validation.ok) {
      const errSummary = validation.errors.slice(0, 3).join('\n');
      log('ERROR', `[RESTART BLOCKED] Syntax errors detected:\n${errSummary}`);
      adminNotifyFn(`🚫 Daemon 热重载已阻止 — 新代码有语法错误:\n${errSummary}\n\n当前 daemon 继续运行。`).catch(() => {});
      pendingRestart = false;
      return;
    }
    // Backup current known-good set before restarting with new code
    backupLastGood();
    onRestartRequested();
  }

  const daemonScript = path.join(METAME_DIR, 'daemon.js');
  const startTime = Date.now();
  let restartDebounce = null;
  let pendingRestart = false;
  let deferredRestartTimer = null; // guard: prevent duplicate deferred restart timers

  fs.watchFile(daemonScript, { interval: 3000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (Date.now() - startTime < 10000) return;
    if (restartDebounce) clearTimeout(restartDebounce);
    restartDebounce = setTimeout(() => {
      if (activeProcesses.size > 0) {
        log('INFO', `daemon.js changed on disk — deferring restart (${activeProcesses.size} active task(s))`);
        pendingRestart = true;
      } else {
        // Even with no active processes, wait 5s for any in-flight cleanup
        // (sendCard/sendMarkdown may still be running after activeProcesses.delete)
        log('INFO', 'daemon.js changed on disk — no active tasks, restarting in 5s...');
        if (deferredRestartTimer) clearTimeout(deferredRestartTimer);
        deferredRestartTimer = setTimeout(() => {
          if (activeProcesses.size > 0) {
            log('INFO', `Deferred restart cancelled — ${activeProcesses.size} task(s) started during grace period`);
            deferredRestartTimer = null;
            pendingRestart = true;
            return;
          }
          log('INFO', 'daemon.js changed on disk — validating before restart...');
          safeRestart();
        }, 5000);
      }
    }, 2000);
  });

  const origDelete = activeProcesses.delete.bind(activeProcesses);
  activeProcesses.delete = function (key) {
    const result = origDelete(key);
    if (pendingRestart && activeProcesses.size === 0 && !deferredRestartTimer) {
      log('INFO', 'All tasks completed — validating deferred restart in 8s...');
      deferredRestartTimer = setTimeout(safeRestart, 8000); // 给 sendMessage/deleteMessage 等 cleanup 留出足够时间
    }
    return result;
  };

  function stop() {
    fs.unwatchFile(CONFIG_FILE);
    fs.unwatchFile(daemonScript);
    if (reloadDebounce) clearTimeout(reloadDebounce);
    if (restartDebounce) clearTimeout(restartDebounce);
    if (deferredRestartTimer) clearTimeout(deferredRestartTimer);
    if (stableBackupTimer) clearTimeout(stableBackupTimer);
    activeProcesses.delete = origDelete;
  }

  return { reloadConfig, stop };
}

module.exports = { createPidManager, setupRuntimeWatchers };
