'use strict';

const { sleepSync } = require('./platform');

function createPidManager(deps) {
  const { fs, PID_FILE, log } = deps;

  function killExistingDaemon() {
    if (!fs.existsSync(PID_FILE)) return;
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (oldPid && oldPid !== process.pid) {
        process.kill(oldPid, 'SIGTERM');
        log('INFO', `Killed existing daemon (PID: ${oldPid})`);
        for (let i = 0; i < 10; i++) {
          try { process.kill(oldPid, 0); } catch { break; }
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
    activeProcesses,
    getConfig,
    setConfig,
    getHeartbeatTimer,
    setHeartbeatTimer,
    onRestartRequested,
  } = deps;

  function reloadConfig() {
    const strict = typeof loadConfigStrict === 'function'
      ? loadConfigStrict()
      : { ok: true, config: loadConfig() };
    if (!strict.ok) return { success: false, error: strict.error || 'Failed to read config' };
    const newConfig = strict.config;
    setConfig(newConfig);
    refreshLogMaxSize(newConfig);
    const timer = getHeartbeatTimer();
    if (timer) clearInterval(timer);
    setHeartbeatTimer(startHeartbeat(newConfig, notifyFn));
    const { general, project } = getAllTasks(newConfig);
    const totalCount = general.length + project.length;
    log('INFO', `Config reloaded: ${totalCount} tasks (${project.length} in projects)`);
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
          log('INFO', 'daemon.js changed on disk — exiting for restart...');
          onRestartRequested();
        }, 5000);
      }
    }, 2000);
  });

  const origDelete = activeProcesses.delete.bind(activeProcesses);
  activeProcesses.delete = function (key) {
    const result = origDelete(key);
    if (pendingRestart && activeProcesses.size === 0 && !deferredRestartTimer) {
      log('INFO', 'All tasks completed — executing deferred restart in 8s...');
      deferredRestartTimer = setTimeout(onRestartRequested, 8000); // 给 sendMessage/deleteMessage 等 cleanup 留出足够时间
    }
    return result;
  };

  function stop() {
    fs.unwatchFile(CONFIG_FILE);
    fs.unwatchFile(daemonScript);
    if (reloadDebounce) clearTimeout(reloadDebounce);
    if (restartDebounce) clearTimeout(restartDebounce);
    if (deferredRestartTimer) clearTimeout(deferredRestartTimer);
    activeProcesses.delete = origDelete;
  }

  return { reloadConfig, stop };
}

module.exports = { createPidManager, setupRuntimeWatchers };
