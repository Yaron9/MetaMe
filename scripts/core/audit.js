'use strict';

function createAudit(deps) {
  const {
    fs,
    logFile,
    stateFile,
    stdout = process.stdout,
    stderr = process.stderr,
    usageRetentionDaysDefault = 30,
  } = deps;

  let logMaxSize = 1048576;
  let cachedState = null;

  function ensureUsageShape(state) {
    if (!state.usage || typeof state.usage !== 'object') state.usage = {};
    if (!state.usage.categories || typeof state.usage.categories !== 'object') state.usage.categories = {};
    if (!state.usage.daily || typeof state.usage.daily !== 'object') state.usage.daily = {};
    const keepDays = Number(state.usage.retention_days);
    state.usage.retention_days = Number.isFinite(keepDays) && keepDays >= 7
      ? Math.floor(keepDays)
      : usageRetentionDaysDefault;
  }

  function ensureStateShape(state) {
    if (!state || typeof state !== 'object') return {
      pid: null,
      budget: { date: null, tokens_used: 0 },
      tasks: {},
      sessions: {},
      started_at: null,
      usage: { retention_days: usageRetentionDaysDefault, categories: {}, daily: {} },
    };
    if (!state.budget || typeof state.budget !== 'object') state.budget = { date: null, tokens_used: 0 };
    if (typeof state.budget.tokens_used !== 'number') state.budget.tokens_used = Number(state.budget.tokens_used) || 0;
    if (!Object.prototype.hasOwnProperty.call(state.budget, 'date')) state.budget.date = null;
    if (!state.tasks || typeof state.tasks !== 'object') state.tasks = {};
    if (!state.sessions || typeof state.sessions !== 'object') state.sessions = {};
    ensureUsageShape(state);
    return state;
  }

  function pruneDailyUsage(usage, todayIso) {
    const keepDays = usage.retention_days || usageRetentionDaysDefault;
    const cutoff = new Date(`${todayIso}T00:00:00.000Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - (keepDays - 1));
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    for (const day of Object.keys(usage.daily || {})) {
      if (day < cutoffIso) delete usage.daily[day];
    }
  }

  function readStateFromDisk() {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return ensureStateShape(state);
    } catch {
      return ensureStateShape({
        pid: null,
        budget: { date: null, tokens_used: 0 },
        tasks: {},
        sessions: {},
        started_at: null,
      });
    }
  }

  function refreshLogMaxSize(cfg) {
    logMaxSize = (cfg && cfg.daemon && cfg.daemon.log_max_size) || 1048576;
  }

  function log(level, msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${msg}\n`;
    try {
      if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        if (stat.size > logMaxSize) {
          const bakFile = logFile + '.bak';
          if (fs.existsSync(bakFile)) fs.unlinkSync(bakFile);
          fs.renameSync(logFile, bakFile);
        }
      }
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {
      stderr.write(line);
    }
    if (stdout && !stdout.isTTY && typeof stdout.write === 'function') {
      stdout.write(line);
    }
  }

  function loadState() {
    if (!cachedState) cachedState = readStateFromDisk();
    return cachedState;
  }

  function saveState(state) {
    const next = ensureStateShape(state);
    if (cachedState && cachedState !== next) {
      const current = ensureStateShape(cachedState);

      const currentBudgetDate = String(current.budget.date || '');
      const nextBudgetDate = String(next.budget.date || '');
      const currentBudgetTokens = Math.max(0, Math.floor(Number(current.budget.tokens_used) || 0));
      const nextBudgetTokens = Math.max(0, Math.floor(Number(next.budget.tokens_used) || 0));
      if (currentBudgetDate && (!nextBudgetDate || currentBudgetDate > nextBudgetDate)) {
        next.budget.date = currentBudgetDate;
        next.budget.tokens_used = currentBudgetTokens;
      } else if (currentBudgetDate && currentBudgetDate === nextBudgetDate) {
        next.budget.tokens_used = Math.max(currentBudgetTokens, nextBudgetTokens);
      }

      const currentKeepDays = Number(current.usage.retention_days) || usageRetentionDaysDefault;
      const nextKeepDays = Number(next.usage.retention_days) || usageRetentionDaysDefault;
      next.usage.retention_days = Math.max(currentKeepDays, nextKeepDays);

      for (const [category, curMeta] of Object.entries(current.usage.categories || {})) {
        if (!next.usage.categories[category] || typeof next.usage.categories[category] !== 'object') {
          next.usage.categories[category] = {};
        }
        const curTotal = Math.max(0, Math.floor(Number(curMeta && curMeta.total) || 0));
        const nextTotal = Math.max(0, Math.floor(Number(next.usage.categories[category].total) || 0));
        if (curTotal > nextTotal) next.usage.categories[category].total = curTotal;

        const curUpdated = String(curMeta && curMeta.updated_at || '');
        const nextUpdated = String(next.usage.categories[category].updated_at || '');
        if (curUpdated && curUpdated > nextUpdated) next.usage.categories[category].updated_at = curUpdated;
      }

      for (const [day, curDayUsageRaw] of Object.entries(current.usage.daily || {})) {
        const curDayUsage = (curDayUsageRaw && typeof curDayUsageRaw === 'object') ? curDayUsageRaw : {};
        if (!next.usage.daily[day] || typeof next.usage.daily[day] !== 'object') {
          next.usage.daily[day] = {};
        }
        const nextDayUsage = next.usage.daily[day];
        for (const [key, curValue] of Object.entries(curDayUsage)) {
          const curNum = Math.max(0, Math.floor(Number(curValue) || 0));
          const nextNum = Math.max(0, Math.floor(Number(nextDayUsage[key]) || 0));
          if (curNum > nextNum) nextDayUsage[key] = curNum;
        }
        const categorySum = Object.entries(nextDayUsage)
          .filter(([key]) => key !== 'total')
          .reduce((sum, [, value]) => sum + Math.max(0, Math.floor(Number(value) || 0)), 0);
        nextDayUsage.total = Math.max(Math.max(0, Math.floor(Number(nextDayUsage.total) || 0)), categorySum);
      }

      const currentUsageUpdated = String(current.usage.updated_at || '');
      const nextUsageUpdated = String(next.usage.updated_at || '');
      if (currentUsageUpdated && currentUsageUpdated > nextUsageUpdated) {
        next.usage.updated_at = currentUsageUpdated;
      }

      if (current.sessions && typeof current.sessions === 'object') {
        if (!next.sessions || typeof next.sessions !== 'object') next.sessions = {};
        for (const [key, curSession] of Object.entries(current.sessions)) {
          if (!next.sessions[key]) {
            next.sessions[key] = curSession;
          } else {
            const curActive = Number(curSession && curSession.last_active) || 0;
            const nextActive = Number(next.sessions[key] && next.sessions[key].last_active) || 0;
            if (curActive > nextActive) next.sessions[key] = curSession;
          }
        }
      }
    }

    cachedState = next;
    try {
      fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
      log('ERROR', `Failed to save state: ${e.message}`);
    }
  }

  return {
    refreshLogMaxSize,
    log,
    loadState,
    saveState,
    ensureUsageShape,
    ensureStateShape,
    pruneDailyUsage,
  };
}

module.exports = {
  createAudit,
};
