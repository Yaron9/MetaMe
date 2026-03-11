#!/usr/bin/env node

// Suppress Node.js experimental warnings (e.g. SQLite)
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { sleepSync, findProcessesByPattern, icon } = require('./scripts/platform');

// On Windows, resolve .cmd wrapper → actual Node.js entry and spawn node directly.
// Completely bypasses cmd.exe, eliminating terminal flash.
function resolveNodeEntry(cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, 'utf8');
    const m = content.match(/"([^"]+\.js)"\s*%\*\s*$/m);
    if (m) {
      const entry = m[1].replace(/%dp0%/gi, path.dirname(cmdPath) + path.sep);
      if (fs.existsSync(entry)) return entry;
    }
  } catch { /* ignore */ }
  return null;
}

function spawnViaNode(cmd, args, options) {
  if (process.platform !== 'win32') return spawn(cmd, args, options);
  try {
    const { execSync: _es } = require('child_process');
    const lines = _es(`where ${cmd}`, { encoding: 'utf8', timeout: 3000 })
      .split('\n').map(l => l.trim()).filter(Boolean);
    const cmdFile = lines.find(l => l.toLowerCase().endsWith(`${cmd}.cmd`)) || lines[0];
    if (cmdFile) {
      const entry = resolveNodeEntry(cmdFile);
      if (entry) return spawn(process.execPath, [entry, ...args], { ...options, windowsHide: true });
      return spawn(cmdFile, args, { ...options, shell: process.env.COMSPEC || true, windowsHide: true });
    }
  } catch { /* ignore */ }
  return spawn(cmd, args, { ...options, shell: process.env.COMSPEC || true, windowsHide: true });
}

function spawnClaude(args, options) {
  return spawnViaNode('claude', args, options);
}

function spawnCodex(args, options) {
  // Sanitize env: unset CODEX_HOME if it points to a non-existent path (corrupted registry value)
  const env = { ...(options && options.env ? options.env : process.env) };
  if (env.CODEX_HOME && !fs.existsSync(env.CODEX_HOME)) delete env.CODEX_HOME;
  return spawnViaNode('codex', args, { ...options, env });
}

function readLatestClaudeSession(projectsRoot, cwd) {
  let bestSession = null;
  const findLatest = (dir) => {
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ id: f.replace('.jsonl', ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0] || null;
    } catch { return null; }
  };

  try {
    const projDir = path.join(projectsRoot, cwd.replace(/\//g, '-'));
    const localBest = findLatest(projDir);
    let globalBest = null;
    try {
      for (const d of fs.readdirSync(projectsRoot)) {
        const s = findLatest(path.join(projectsRoot, d));
        if (s && (!globalBest || s.mtime > globalBest.mtime)) globalBest = s;
      }
    } catch { /* ignore */ }
    if (localBest && globalBest && globalBest.mtime > localBest.mtime) {
      bestSession = { ...globalBest, scope: 'global' };
    } else {
      bestSession = localBest ? { ...localBest, scope: 'local' } : (globalBest ? { ...globalBest, scope: 'global' } : null);
    }
  } catch { /* ignore */ }

  return bestSession ? { ...bestSession, engine: 'claude' } : null;
}

function readLatestCodexSession(cwd) {
  let db;
  try {
    const codeDb = path.join(HOME_DIR, '.codex', 'state_5.sqlite');
    if (!fs.existsSync(codeDb)) return null;
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(codeDb, { readonly: true });
    const row = db.prepare(`
      SELECT id, cwd, updated_at, created_at
      FROM threads
      WHERE COALESCE(has_user_event, 1) = 1
        AND archived = 0
      ORDER BY
        CASE WHEN cwd = ? THEN 0 ELSE 1 END ASC,
        COALESCE(updated_at, created_at, 0) DESC
      LIMIT 1
    `).get(cwd);
    db.close();
    db = null;
    if (!row || !row.id) return null;
    const ts = Number(row.updated_at || row.created_at || 0) * 1000;
    return {
      id: String(row.id),
      mtime: ts || 0,
      engine: 'codex',
      scope: String(row.cwd || '') === String(cwd) ? 'local' : 'global',
    };
  } catch {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    return null;
  }
}

// Quick flags (before heavy init)
const pkgVersion = require('./package.json').version;
if (process.argv.includes('-V') || process.argv.includes('--version')) {
  console.log(`metame/${pkgVersion}`);
  process.exit(0);
}

// ---------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------
const HOME_DIR = os.homedir();
const BRAIN_FILE = path.join(HOME_DIR, '.claude_profile.yaml');
const PROJECT_FILE = path.join(process.cwd(), 'CLAUDE.md');
const METAME_DIR = path.join(HOME_DIR, '.metame');
const CLAUDE_SETTINGS = path.join(HOME_DIR, '.claude', 'settings.json');
const CLAUDE_MCP_CONFIG = path.join(HOME_DIR, '.claude', 'mcp.json'); // legacy, kept for reference
const SIGNAL_CAPTURE_SCRIPT = path.join(METAME_DIR, 'signal-capture.js');
const DAEMON_CONFIG_FILE = path.join(METAME_DIR, 'daemon.yaml');

const METAME_START = '<!-- METAME:START -->';
const METAME_END = '<!-- METAME:END -->';

// ---------------------------------------------------------
// 1.5 ENSURE METAME DIRECTORY + DEPLOY SCRIPTS
// ---------------------------------------------------------
if (!fs.existsSync(METAME_DIR)) {
  fs.mkdirSync(METAME_DIR, { recursive: true });
}

// ---------------------------------------------------------
// DEPLOY PHASE: sync scripts, docs, bin to ~/.metame/
// ---------------------------------------------------------

// Dev mode: when running from git repo, symlink instead of copy.
// This ensures source files and runtime files are always the same,
// preventing agents from accidentally editing copies instead of source.
const IS_DEV_MODE = fs.existsSync(path.join(__dirname, '.git'));

/**
 * Sync files from srcDir to destDir.
 * - Dev mode (git repo): creates symlinks so source === runtime.
 * - Production (npm install): copies files, only writes when content differs.
 * @param {string} srcDir - source directory
 * @param {string} destDir - destination directory
 * @param {object} [opts]
 * @param {string[]} [opts.fileList] - explicit file list (skip readdirSync)
 * @param {number}  [opts.chmod] - chmod after write (e.g. 0o755)
 * @returns {boolean} true if any file was updated
 */
function syncDirFiles(srcDir, destDir, { fileList, chmod } = {}) {
  if (!fs.existsSync(srcDir)) return false;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  let updated = false;
  const files = fileList || fs.readdirSync(srcDir).filter(f => fs.statSync(path.join(srcDir, f)).isFile());
  for (const f of files) {
    const src = path.join(srcDir, f);
    const dest = path.join(destDir, f);
    try {
      if (!fs.existsSync(src)) continue;

      if (IS_DEV_MODE) {
        // Dev mode: symlink dest → src (replace copy/stale symlink if needed)
        const srcReal = fs.realpathSync(src);
        let needLink = true;
        try {
          const existing = fs.lstatSync(dest);
          if (existing.isSymbolicLink()) {
            if (fs.realpathSync(dest) === srcReal) needLink = false;
            else fs.unlinkSync(dest);
          } else {
            // Replace regular file with symlink
            fs.unlinkSync(dest);
          }
        } catch { /* dest doesn't exist */ }
        if (needLink) {
          fs.symlinkSync(srcReal, dest);
          if (chmod) try { fs.chmodSync(dest, chmod); } catch { /* Windows */ }
          updated = true;
        }
      } else {
        // Production: copy when content differs
        const srcContent = fs.readFileSync(src, 'utf8');
        const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
        if (srcContent !== destContent) {
          fs.writeFileSync(dest, srcContent, 'utf8');
          if (chmod) try { fs.chmodSync(dest, chmod); } catch { /* Windows */ }
          updated = true;
        }
      }
    } catch { /* non-fatal per file */ }
  }
  return updated;
}

function readRunningDaemonPid({ pidFile, lockFile }) {
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        return pid;
      }
    } catch { /* stale pid file */ }
  }
  if (fs.existsSync(lockFile)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      const pid = parseInt(lock && lock.pid, 10);
      if (pid && pid !== process.pid) {
        process.kill(pid, 0);
        return pid;
      }
    } catch { /* stale or invalid lock */ }
  }
  return null;
}

function requestDaemonRestart({
  reason = 'manual-restart',
  daemonPidFile = path.join(METAME_DIR, 'daemon.pid'),
  daemonLockFile = path.join(METAME_DIR, 'daemon.lock'),
  daemonScript = path.join(METAME_DIR, 'daemon.js'),
} = {}) {
  const pid = readRunningDaemonPid({ pidFile: daemonPidFile, lockFile: daemonLockFile });
  if (!pid) return { ok: false, status: 'not_running' };

  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGUSR2');
      return { ok: true, status: 'signaled', pid };
    } catch (e) {
      return { ok: false, status: 'signal_failed', pid, error: e.message };
    }
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, status: 'stop_failed', pid, error: e.message };
  }

  let stopped = false;
  for (let i = 0; i < 12; i++) {
    sleepSync(500);
    try { process.kill(pid, 0); } catch { stopped = true; break; }
  }
  if (!stopped) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  const bg = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname, METAME_DEPLOY_RESTART_REASON: reason },
  });
  bg.unref();
  return { ok: true, status: 'restarted', pid, nextPid: bg.pid };
}

// Auto-deploy bundled scripts to ~/.metame/
// IMPORTANT: daemon.yaml is USER CONFIG — never overwrite it. Only daemon-default.yaml (template) is synced.
const scriptsDir = path.join(__dirname, 'scripts');
const BUNDLED_BASE_SCRIPTS = ['platform.js', 'signal-capture.js', 'distill.js', 'schema.js', 'pending-traits.js', 'daemon.js', 'telegram-adapter.js', 'feishu-adapter.js', 'daemon-default.yaml', 'providers.js', 'session-analytics.js', 'resolve-yaml.js', 'utils.js', 'skill-evolution.js', 'memory.js', 'memory-extract.js', 'memory-search.js', 'memory-write.js', 'memory-gc.js', 'qmd-client.js', 'session-summarize.js', 'mentor-engine.js', 'check-macos-control-capabilities.sh', 'usage-classifier.js', 'task-board.js', 'memory-nightly-reflect.js', 'memory-index.js', 'skill-changelog.js', 'agent-layer.js'];
const DAEMON_MODULE_SCRIPTS = (() => {
  try {
    return fs.readdirSync(scriptsDir).filter((f) => /^daemon-[\w-]+\.js$/.test(f));
  } catch {
    return [];
  }
})();
const BUNDLED_SCRIPTS = [...new Set([...BUNDLED_BASE_SCRIPTS, ...DAEMON_MODULE_SCRIPTS])];

// Protect daemon.yaml: create backup before any sync operation
const DAEMON_YAML_BACKUP = path.join(METAME_DIR, 'daemon.yaml.bak');
try {
  if (fs.existsSync(DAEMON_CONFIG_FILE)) {
    const content = fs.readFileSync(DAEMON_CONFIG_FILE, 'utf8');
    // Only backup if it has real config (not just the default template)
    if (content.includes('enabled: true') || content.includes('bot_token:') && !content.includes('bot_token: null')) {
      fs.copyFileSync(DAEMON_CONFIG_FILE, DAEMON_YAML_BACKUP);
    }
  }
} catch { /* non-fatal */ }

// Pre-deploy syntax validation: check all .js files before syncing to ~/.metame/
// Catches bad merges and careless agent edits BEFORE they can crash the daemon.
const { execSync: _execSync } = require('child_process');
const syntaxErrors = [];
for (const f of BUNDLED_SCRIPTS) {
  if (!f.endsWith('.js')) continue;
  const fp = path.join(scriptsDir, f);
  if (!fs.existsSync(fp)) continue;
  try {
    _execSync(`"${process.execPath}" -c "${fp}"`, { timeout: 5000, stdio: 'pipe', windowsHide: true });
  } catch (e) {
    const msg = (e.stderr ? e.stderr.toString().trim() : e.message).split('\n')[0];
    syntaxErrors.push(`${f}: ${msg}`);
  }
}

let scriptsUpdated = false;
if (syntaxErrors.length > 0) {
  console.error(`${icon("warn")} DEPLOY BLOCKED — syntax errors in ${syntaxErrors.length} file(s):`);
  for (const err of syntaxErrors) console.error(`  ${err}`);
  console.error('Fix the errors before deploying. Daemon continues running with old code.');
} else {
  scriptsUpdated = syncDirFiles(scriptsDir, METAME_DIR, { fileList: BUNDLED_SCRIPTS });
  if (scriptsUpdated) {
    console.log(`${icon("pkg")} Scripts ${IS_DEV_MODE ? 'symlinked' : 'synced'} to ~/.metame/.`);
  }
}

// Docs: lazy-load references for CLAUDE.md pointer instructions
syncDirFiles(path.join(__dirname, 'scripts', 'docs'), path.join(METAME_DIR, 'docs'));
// Bin: CLI tools (dispatch_to etc.)
const binUpdated = syncDirFiles(path.join(__dirname, 'scripts', 'bin'), path.join(METAME_DIR, 'bin'), { chmod: 0o755 });
// Hooks: Claude Code event hooks (Stop, PostToolUse, etc.)
const hooksUpdated = syncDirFiles(path.join(__dirname, 'scripts', 'hooks'), path.join(METAME_DIR, 'hooks'));

const daemonCodeUpdated = scriptsUpdated || binUpdated || hooksUpdated;
const shouldAutoRestartAfterDeploy = (() => {
  const [cmd] = process.argv.slice(2);
  if (!cmd) return true;
  if (cmd === 'daemon') return false;
  if (['start', 'stop', 'restart', 'status', 'logs'].includes(cmd)) return false;
  return ['codex', 'continue', 'sync'].includes(cmd);
})();
if (daemonCodeUpdated && shouldAutoRestartAfterDeploy) {
  const restartResult = requestDaemonRestart({ reason: 'deploy-sync' });
  if (restartResult.ok) {
    console.log(`${icon("reload")} Daemon restart requested after deploy${restartResult.pid ? ` (PID: ${restartResult.pid})` : ''}.`);
  } else if (restartResult.status === 'not_running') {
    console.log(`${icon("info")}  Deploy finished. Daemon not running, so restart was skipped.`);
  } else {
    console.log(`${icon("warn")}  Deploy finished, but daemon restart failed: ${restartResult.error || restartResult.status}`);
  }
}

// ---------------------------------------------------------
// Deploy bundled skills to ~/.claude/skills/
// Only installs if not already present — never overwrites user customizations.
// ---------------------------------------------------------
const CLAUDE_SKILLS_DIR = path.join(HOME_DIR, '.claude', 'skills');
const bundledSkillsDir = path.join(__dirname, 'skills');
if (fs.existsSync(bundledSkillsDir)) {
  try {
    if (!fs.existsSync(CLAUDE_SKILLS_DIR)) {
      fs.mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true });
    }
    const skillsInstalled = [];
    for (const skillName of fs.readdirSync(bundledSkillsDir)) {
      const srcSkill = path.join(bundledSkillsDir, skillName);
      const destSkill = path.join(CLAUDE_SKILLS_DIR, skillName);
      if (!fs.statSync(srcSkill).isDirectory()) continue;
      if (fs.existsSync(destSkill)) continue; // already installed, respect user's version
      // Copy skill directory recursively
      const copyDir = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src)) {
          const s = path.join(src, entry);
          const d = path.join(dest, entry);
          if (fs.statSync(s).isDirectory()) copyDir(s, d);
          else fs.copyFileSync(s, d);
        }
      };
      copyDir(srcSkill, destSkill);
      skillsInstalled.push(skillName);
    }
    if (skillsInstalled.length > 0) {
      console.log(`${icon("brain")} Skills installed: ${skillsInstalled.join(', ')}`);
    }
  } catch {
    // Non-fatal
  }
}


// Ensure ~/.codex/skills and ~/.agents/skills are symlinks to ~/.claude/skills
// This keeps skill evolution unified across all engines.
for (const altDir of [
  path.join(HOME_DIR, '.codex', 'skills'),
  path.join(HOME_DIR, '.agents', 'skills'),
]) {
  try {
    const stat = fs.lstatSync(altDir);
    if (stat.isSymbolicLink()) continue; // already a symlink, good
    // Physical directory exists — back it up, then replace with symlink
    const backupDir = altDir + '.bak.' + Date.now();
    fs.renameSync(altDir, backupDir);
    console.log(`[metame] Backed up existing ${altDir} → ${backupDir}`);
    fs.symlinkSync(CLAUDE_SKILLS_DIR, altDir);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Parent dir or target doesn't exist — try creating symlink
      try {
        fs.mkdirSync(path.dirname(altDir), { recursive: true });
        fs.symlinkSync(CLAUDE_SKILLS_DIR, altDir);
      } catch { /* non-fatal */ }
    }
    // Other errors (e.g. engine not installed): non-fatal, skip
  }
}

// Load daemon config for local launch flags
let daemonCfg = {};
try {
  if (fs.existsSync(DAEMON_CONFIG_FILE)) {
    const _yaml = require(path.join(__dirname, 'node_modules', 'js-yaml'));
    const raw = _yaml.load(fs.readFileSync(DAEMON_CONFIG_FILE, 'utf8')) || {};
    daemonCfg = raw.daemon || {};
  }
} catch { /* non-fatal */ }

// Ensure daemon.yaml exists (restore backup or copy from template)
if (!fs.existsSync(DAEMON_CONFIG_FILE)) {
  if (fs.existsSync(DAEMON_YAML_BACKUP)) {
    // Restore from backup — user had real config that was lost
    fs.copyFileSync(DAEMON_YAML_BACKUP, DAEMON_CONFIG_FILE);
    console.log(`${icon("warn")}  daemon.yaml was missing — restored from backup.`);
  } else {
    const daemonTemplate = path.join(scriptsDir, 'daemon-default.yaml');
    if (fs.existsSync(daemonTemplate)) {
      fs.copyFileSync(daemonTemplate, DAEMON_CONFIG_FILE);
    }
  }
}

// ---------------------------------------------------------
// 1.6 AUTO-INSTALL SIGNAL CAPTURE HOOK
// ---------------------------------------------------------
function ensureHookInstalled() {
  try {
    // Ensure ~/.claude/ exists
    const claudeDir = path.join(HOME_DIR, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    }

    // Check if our hook is already configured
    // Use forward slashes + quotes — Claude Code runs hooks via bash even on Windows
    const scriptPathForHook = SIGNAL_CAPTURE_SCRIPT.replace(/\\/g, '/');
    const hookCommand = `node "${scriptPathForHook}"`;
    const existing = settings.hooks?.UserPromptSubmit || [];
    const alreadyInstalled = existing.some(entry =>
      entry.hooks?.some(h => h.command && h.command.includes('signal-capture.js'))
    );

    // Remove stale hooks with backslash paths (old Windows format)
    if (settings.hooks?.UserPromptSubmit) {
      for (const entry of settings.hooks.UserPromptSubmit) {
        if (entry.hooks) {
          entry.hooks = entry.hooks.filter(h =>
            !(h.command && h.command.includes('signal-capture.js') && h.command.includes('\\'))
          );
        }
      }
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
        entry => entry.hooks && entry.hooks.length > 0
      );
    }

    // Re-check after cleanup
    const stillInstalled = (settings.hooks?.UserPromptSubmit || []).some(entry =>
      entry.hooks?.some(h => h.command && h.command.includes('signal-capture.js'))
    );

    let modified = false;

    if (!stillInstalled) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

      settings.hooks.UserPromptSubmit.push({
        hooks: [{
          type: 'command',
          command: hookCommand
        }]
      });
      modified = true;
      console.log(`${icon("hook")} MetaMe: Signal capture hook installed.`);
    }

    // Ensure Stop hook (session-logger + tool-failure capture) is installed
    const stopHookScript = path.join(METAME_DIR, 'hooks', 'stop-session-capture.js').replace(/\\/g, '/');
    const stopHookCommand = `node "${stopHookScript}"`;
    const stopHookInstalled = (settings.hooks?.Stop || []).some(entry =>
      entry.hooks?.some(h => h.command && h.command.includes('stop-session-capture.js'))
    );

    if (!stopHookInstalled) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.Stop) settings.hooks.Stop = [];

      settings.hooks.Stop.push({
        hooks: [{
          type: 'command',
          command: stopHookCommand
        }]
      });
      modified = true;
      console.log(`${icon("hook")} MetaMe: Stop session capture hook installed.`);
    }

    // Migrate: remove standalone team-context.js hook (superseded by intent-engine)
    if (settings.hooks?.UserPromptSubmit) {
      const before = settings.hooks.UserPromptSubmit.length;
      for (const entry of settings.hooks.UserPromptSubmit) {
        if (entry.hooks) {
          entry.hooks = entry.hooks.filter(h => !(h.command && h.command.includes('team-context.js')));
        }
      }
      settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit.filter(
        entry => entry.hooks && entry.hooks.length > 0
      );
      if (settings.hooks.UserPromptSubmit.length !== before) modified = true;
    }

    // Ensure intent-engine hook (unified intent detection + hint injection)
    const intentEngineScript = path.join(METAME_DIR, 'hooks', 'intent-engine.js').replace(/\\/g, '/');
    const intentEngineCommand = `node "${intentEngineScript}"`;
    const intentEngineInstalled = (settings.hooks?.UserPromptSubmit || []).some(entry =>
      entry.hooks?.some(h => h.command && h.command.includes('intent-engine.js'))
    );

    if (!intentEngineInstalled) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

      settings.hooks.UserPromptSubmit.push({
        hooks: [{
          type: 'command',
          command: intentEngineCommand,
        }]
      });
      modified = true;
      console.log(`${icon("hook")} MetaMe: Intent engine hook installed.`);
    }

    if (modified) {
      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
    }
  } catch (e) {
    // Non-fatal: hook install failure shouldn't block launch
    console.error(`${icon("warn")}  Hook install skipped:`, e.message);
  }
}

ensureHookInstalled();

// ---------------------------------------------------------
// 1.6b LOCAL ACTIVITY HEARTBEAT
// ---------------------------------------------------------
// Touch ~/.metame/local_active so the daemon knows the user is active on desktop.
// This prevents dream tasks (require_idle: true) from firing during live Claude sessions.
try {
  const localActiveFile = path.join(METAME_DIR, 'local_active');
  // Ensure file exists (open with 'a' is a no-op if it already exists)
  fs.closeSync(fs.openSync(localActiveFile, 'a'));
  // Update mtime so daemon idle detection sees fresh activity
  const now = new Date();
  fs.utimesSync(localActiveFile, now, now);
} catch { /* non-fatal */ }

// ---------------------------------------------------------
// 1.6c ENSURE PROJECT-LEVEL MCP CONFIG
// ---------------------------------------------------------
// MCP servers are registered per-project via .mcp.json (not user-scope ~/.claude.json)
// so they only load when working in projects that need them.
// The daemon's heartbeat tasks use cwd: ~/AGI/Digital_Me which has its own .mcp.json.

// ---------------------------------------------------------
// 1.7 PASSIVE DISTILLATION (Background, post-launch)
// ---------------------------------------------------------
function shouldDistill() {
  const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
  if (!fs.existsSync(bufferFile)) return false;
  const content = fs.readFileSync(bufferFile, 'utf8').trim();
  return content.length > 0;
}

function needsBootstrap() {
  try {
    const sessionLogFile = path.join(METAME_DIR, 'session_log.yaml');
    if (!fs.existsSync(sessionLogFile)) return true;
    const yaml = require('js-yaml');
    const log = yaml.load(fs.readFileSync(sessionLogFile, 'utf8'));
    return !log || !Array.isArray(log.sessions) || log.sessions.length < 5;
  } catch { return true; }
}

function spawnDistillBackground(engine) {
  const distillPath = path.join(METAME_DIR, 'distill.js');
  if (!fs.existsSync(distillPath)) return;

  // Early exit if distillation already in progress (prevents duplicate spawns across terminals)
  const lockFile = path.join(METAME_DIR, 'distill.lock');
  if (fs.existsSync(lockFile)) {
    try {
      const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
      if (lockAge < 120000) return;
    } catch { /* stale lock, proceed */ }
  }

  // 4-hour cooldown: check last distill timestamp from profile
  const cooldownMs = 4 * 60 * 60 * 1000;
  try {
    const profilePath = path.join(HOME_DIR, '.claude_profile.yaml');
    if (fs.existsSync(profilePath)) {
      const yaml = require('js-yaml');
      const profile = yaml.load(fs.readFileSync(profilePath, 'utf8'));
      const distillLog = profile && profile.evolution && profile.evolution.auto_distill;
      if (Array.isArray(distillLog) && distillLog.length > 0) {
        const lastTs = new Date(distillLog[distillLog.length - 1].ts).getTime();
        if (Date.now() - lastTs < cooldownMs) return;
      }
    }
  } catch { /* non-fatal, proceed */ }

  const hasSignals = shouldDistill();
  const bootstrap = needsBootstrap();

  if (!hasSignals && !bootstrap) return;

  // Note: status display is handled separately in startup output — no log here
  if (bootstrap) {
    // Background bootstrap — silent, no need to inform user
  }


  // Spawn as detached background process — won't block session launch
  // Remove CLAUDECODE env var so distill.js can call the engine without nested-session rejection
  const distillEnvClean = { ...process.env };
  delete distillEnvClean.CLAUDECODE;
  if (engine) distillEnvClean.METAME_ENGINE = engine;
  const bg = spawn('node', [distillPath], {
    detached: true,
    stdio: 'ignore',
    env: distillEnvClean,
    windowsHide: true,
  });
  bg.unref();
}

// ---------------------------------------------------------
// 1.8 TIME-BASED EXPIRY (Startup cleanup)
// ---------------------------------------------------------
function runExpiryCleanup() {
  try {
    const yaml = require('js-yaml');
    if (!fs.existsSync(BRAIN_FILE)) return;

    const rawProfile = fs.readFileSync(BRAIN_FILE, 'utf8');
    const profile = yaml.load(rawProfile);
    if (!profile || typeof profile !== 'object') return;

    const now = Date.now();
    let changed = false;

    // context.focus: if focus_since > 30 days, auto-clear
    if (profile.context && profile.context.focus_since) {
      const focusSince = new Date(profile.context.focus_since).getTime();
      if (now - focusSince > 30 * 24 * 60 * 60 * 1000) {
        profile.context.focus = null;
        profile.context.focus_since = null;
        changed = true;
      }
    }

    // context.blockers: if > 14 days, auto-clear
    // (blockers are arrays — clear entire array if stale)
    if (profile.context && Array.isArray(profile.context.blockers) && profile.context.blockers.length > 0) {
      // If we don't have a blockers_since timestamp, just leave them
      // Future: add per-item timestamps
    }

    // context.energy: reset to null on each session start
    if (profile.context && profile.context.energy !== undefined) {
      if (profile.context.energy !== null) {
        profile.context.energy = null;
        changed = true;
      }
    }

    if (changed) {
      // Preserve comments
      const commentMatch = rawProfile.match(/^(\s*[\w_]+\s*:.+?)\s+(#.+)$/gm);
      const dumped = yaml.dump(profile, { lineWidth: -1 });
      fs.writeFileSync(BRAIN_FILE, dumped, 'utf8');
    }

    // Expire stale pending traits
    const pendingFile = path.join(METAME_DIR, 'pending_traits.yaml');
    if (fs.existsSync(pendingFile)) {
      const pending = yaml.load(fs.readFileSync(pendingFile, 'utf8')) || {};
      const cutoff = 30 * 24 * 60 * 60 * 1000;
      let expiredCount = 0;
      for (const [key, meta] of Object.entries(pending)) {
        if (meta.last_seen) {
          const lastSeen = new Date(meta.last_seen).getTime();
          if (now - lastSeen > cutoff) {
            delete pending[key];
            expiredCount++;
          }
        }
      }
      if (expiredCount > 0) {
        fs.writeFileSync(pendingFile, yaml.dump(pending, { lineWidth: -1 }), 'utf8');
      }
    }
  } catch {
    // Non-fatal — expiry cleanup failure shouldn't block launch
  }
}

runExpiryCleanup();

// ---------------------------------------------------------
// 2. BRAIN INITIALIZATION (Cold Start)
// ---------------------------------------------------------
// Ensure the Brain exists.
if (!fs.existsSync(BRAIN_FILE)) {
  const initialProfile = `identity:
  role: Unknown
  locale: null
status:
  focus: Initializing
`;
  fs.writeFileSync(BRAIN_FILE, initialProfile, 'utf8');
}

// ---------------------------------------------------------
// 3. DEFINE SYSTEM KERNEL (The Protocol)
// ---------------------------------------------------------
const PROTOCOL_NORMAL = `${METAME_START}
---
## ${icon("brain")} SYSTEM KERNEL: SHADOW_MODE (Active)

**1. THE BRAIN (Source of Truth):**
   * **FILE:** \`$HOME/.claude_profile.yaml\`
   * **RULE:** This file is your Ground Truth. If context is compressed (/compact), **RE-READ** this file immediately.
   * **AUTO-LOCK:** Never edit lines marked \`# [LOCKED]\` (Core Values).
   * **EVOLUTION:** Silently overwrite outdated status/focus.

**2. EVOLUTION MECHANISM (Manual Sync):**
   *   **PHILOSOPHY:** You respect the User's flow. You do NOT interrupt.
   *   **TOOLS:**
       1. **Log Insight:** \`!metame evolve "Insight"\` (For additive knowledge).
       2. **Surgical Update:** \`!metame set-trait key value\` (For overwriting specific fields, e.g., \`!metame set-trait status.focus "API Design"\`).
   *   **RULE:** Only use these tools when the User **EXPLICITLY** instructs you.
   *   **REMINDER:** If the User expresses a strong persistent preference, you may gently ask *at the end of the task*: "Should I save this preference to your MetaMe profile?"

**3. MEMORY SYSTEM (Three-Layer Recall):**
   * **Long-term Facts** → injected as \`<!-- FACTS:START -->\` blocks. Follow implicitly, never repeat to user.
   * **Session Summary** → injected as \`[上次对话摘要，供参考]\` when resuming after 2h+ gap. Use for continuity, do NOT quote back to user.
   * **Background Pipeline:** Sleep mode triggers memory consolidation automatically. Memory improves over time without user action.
   * **Search:** \`node ~/.metame/memory-search.js "<keyword>"\` to recall facts manually.
---
`;

const PROTOCOL_ONBOARDING = `${METAME_START}
---
## ${icon("brain")} SYSTEM KERNEL: SHADOW_MODE (Active)

**1. THE BRAIN (Source of Truth):**
   * **FILE:** \`$HOME/.claude_profile.yaml\`
   * **RULE:** This file is your Ground Truth. If context is compressed (/compact), **RE-READ** this file immediately.
   * **AUTO-LOCK:** Never edit lines marked \`# [LOCKED]\` (Core Values).
   * **EVOLUTION:** Silently overwrite outdated status/focus.

**2. GENESIS PROTOCOL — Deep Cognitive Mapping:**

You are entering **Calibration Mode**. You are not a chatbot; you are a Psychologist and a Mirror. Your goal is to build the User's cognitive profile through a structured deep interview.

**RULES:**
- Ask ONE question at a time, then STOP and wait for the answer.
- Open-ended questions ONLY — never give multiple choice options.
- Challenge assumptions. If the user says something surface-level, probe deeper ("You say X, but that contradicts Y — which is the real you?").
- Be warm but unflinching. You are mapping their soul, not making small talk.

**THE 6 STEPS:**

1. **Trust Contract:** Start with: *"I'm about to become your digital shadow — an AI that knows how you think, what you avoid, and what drives you. For this to work, I need raw honesty. No masks. Ready?"* — Wait for consent before proceeding.

2. **The Now (Context):** What are you working on right now? What's the immediate battle? What constraints are you under?

3. **Cognition (Mental Models):** How do you think? Top-down architect or bottom-up explorer? How do you handle chaos and ambiguity?

4. **Values (North Star):** What do you optimize for? Speed vs precision? Impact vs legacy? What's non-negotiable?

5. **Shadows (Hidden Fears):** What are you avoiding? What pattern do you keep repeating? What keeps you up at night?

6. **Identity (Role + Locale):** Based on everything learned, propose a role summary and confirm their preferred language (locale). Ask if it resonates.

**TERMINATION:**
- After 5-7 exchanges, synthesize everything into \`~/.claude_profile.yaml\`.
- **LOCK** Core Values with \`# [LOCKED]\`.
- Announce: "Link Established. Profile calibrated."
- Then proceed to **Phase 2** below.

**3. SETUP WIZARD (Phase 2 — Mobile Access):**

After writing the profile, ask: *"Want to set up mobile access so you can reach me from your phone? (Telegram / Feishu / Skip)"*

**Step A: Create Bot & Connect Private Chat (必做)**

This step connects the bot to the user's PRIVATE chat — this is the admin channel.

- If **Telegram:**
  1. Tell user to open Telegram, search @BotFather, send /newbot, create a bot, copy the token.
  2. Ask user to paste the bot token.
  3. Tell user to open their new bot in Telegram and send it any message.
  4. Ask user to confirm they sent a message, then use the Telegram API to fetch the chat ID:
     \`curl -s https://api.telegram.org/bot<TOKEN>/getUpdates | jq '.result[0].message.chat.id'\`
  5. Write both \`bot_token\` and \`allowed_chat_ids\` into \`~/.metame/daemon.yaml\` under the \`telegram:\` section, set \`enabled: true\`.
  6. Tell user to run \`metame start\` to activate.

- If **Feishu:**
  Walk the user through these steps IN ORDER. Confirm each step before proceeding to the next.

  **阶段一：创建应用，获取凭证（先拿到钥匙）**
  1. 打开 open.feishu.cn → 开发者后台 → 创建企业自建应用，填写名称和描述（随意）。
  2. 进入应用 →「凭证与基础信息」→ 复制 App ID 和 App Secret。
  3. 进入「应用功能」→「机器人」→ 开启机器人功能（点击启用）。
  4. 进入「权限管理」→ 依次搜索并开通以下权限：
     - \`im:message\`
     - \`im:message.p2p_msg:readonly\`
     - \`im:message.group_at_msg:readonly\`
     - \`im:message:send_as_bot\`
     - \`im:resource\`
  5. Ask user to paste their App ID and App Secret.
  6. Write \`app_id\` and \`app_secret\` into \`~/.metame/daemon.yaml\` under \`feishu:\` section, set \`enabled: true\`.

  **阶段二：启动 daemon，建立长连接（必须先跑起来）**
  7. Tell user to run \`metame start\`.
  8. Run \`metame status\` and confirm the output contains "Feishu bot connected". **${icon("warn")} 必须看到这行才能继续** — 飞书控制台只有在检测到活跃连接后才允许保存事件配置。

  **阶段三：飞书控制台完成事件订阅（回去点保存）**
  9. 回到飞书开放平台 →「事件与回调」→「事件配置」→ 选择「使用长连接接收事件」。
  10. 点击「添加事件」→ 搜索并添加「接收消息 im.message.receive_v1」。
  11. **${icon("warn")} 关键：** 点击该事件右侧「申请权限」→ 勾选「获取群组中所有消息」。不勾选则 bot 在群聊中只能收到 @ 它的消息。
  12. 点击「保存配置」。此时控制台检测长连接，daemon 已在线，保存会通过。
  13. 进入「版本管理与发布」→ 创建版本 → 申请发布（企业自建应用可直接发布，无需审核）。

  **阶段四：获取 chat_id，完成私聊绑定**
  14. Tell user: 在飞书里搜索刚创建的机器人名称，打开私聊，发送任意一条消息（如"你好"）。
  15. After user confirms, auto-fetch the private chat ID:
     \`\`\`bash
     TOKEN=$(curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \\
       -H "Content-Type: application/json" \\
       -d '{"app_id":"<APP_ID>","app_secret":"<APP_SECRET>"}' | jq -r '.tenant_access_token')
     curl -s -H "Authorization: Bearer $TOKEN" \\
       "https://open.feishu.cn/open-apis/im/v1/chats?chat_type=p2p" | jq '.data.items[] | {chat_id, name}'
     \`\`\`
  16. Write the discovered \`chat_id\` into \`allowed_chat_ids\` in \`~/.metame/daemon.yaml\`.
  17. Run \`metame stop && metame start\` to reload config.
  18. Tell user to send a message in the Feishu private chat — they should receive a reply from MetaMe. Setup complete.

- If **Skip:** Say "No problem. You can run \`metame daemon init\` anytime to set this up later." Then begin normal work.

**Step B: Create Your First Agent (引导用户建立第一个 Agent)**

After bot is connected, explain the Agent concept and guide the user to create their first one:

Tell the user: *"Now let's create your first AI Agent. Each Agent is an independent AI workspace bound to a specific project folder and chat group."*

1. Tell user to create a new group chat in Telegram/Feishu, add the bot to the group, and name it (e.g. "Personal Assistant" or "My Project").
2. Tell user to send \`/agent bind <name>\` in that group (e.g. \`/agent bind personal\`). This will show a directory picker — user taps to select the working directory.
3. Once bound, that group becomes a dedicated Agent channel — messages there go to that Agent's Claude session.
4. Tell user: *"Want to create more Agents? Just repeat: create a group → add bot → send /agent bind <name>. Each group becomes an independent Agent."*

**4. EVOLUTION MECHANISM (Manual Sync):**
   *   **PHILOSOPHY:** You respect the User's flow. You do NOT interrupt.
   *   **TOOLS:**
       1. **Log Insight:** \`!metame evolve "Insight"\` (For additive knowledge).
       2. **Surgical Update:** \`!metame set-trait key value\` (For overwriting specific fields, e.g., \`!metame set-trait status.focus "API Design"\`).
   *   **RULE:** Only use these tools when the User **EXPLICITLY** instructs you.
   *   **REMINDER:** If the User expresses a strong persistent preference, you may gently ask *at the end of the task*: "Should I save this preference to your MetaMe profile?"
---
`;

// ---------------------------------------------------------
// 4. INJECT PROTOCOL (Smart Update)
// ---------------------------------------------------------
let fileContent = "";

// Read existing CLAUDE.md if it exists
if (fs.existsSync(PROJECT_FILE)) {
  fileContent = fs.readFileSync(PROJECT_FILE, 'utf8');

  // Remove any previous MetaMe injection (marker-based, reliable)
  fileContent = fileContent.replace(/<!-- METAME:START -->[\s\S]*?<!-- METAME:END -->\n?/g, '');

  // Legacy cleanup: remove old-style SYSTEM KERNEL blocks that lack markers
  // Handles both "## 🧠 SYSTEM KERNEL" and "## SYSTEM KERNEL" variants
  // Match from "---\n## ...SYSTEM KERNEL" to next "---\n" (or end of file)
  fileContent = fileContent.replace(/---\n##\s*(?:🧠\s*)?SYSTEM KERNEL[\s\S]*?(?:---\n|$)/g, '');

  // Clean up any leading newlines left over
  fileContent = fileContent.replace(/^\n+/, '');
}

// Determine if this is a known (calibrated) user
// Cache the parsed doc to avoid re-reading BRAIN_FILE in mirror/reflection sections below.
const yaml = require('js-yaml');
let isKnownUser = false;
let _brainDoc = null;
try {
  if (fs.existsSync(BRAIN_FILE)) {
    _brainDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    const id = _brainDoc.identity || {};
    const hasLocale = id.locale && id.locale !== 'null' && id.locale !== null;
    // Exclude default placeholder values written by genesis scaffolding
    const hasName = id.name && id.name !== 'Unknown' && id.name !== 'null';
    const hasRole = id.role && id.role !== 'Unknown' && id.role !== 'null';
    const hasOtherFields = hasName || hasRole || id.timezone ||
      (_brainDoc.status && _brainDoc.status.focus && _brainDoc.status.focus !== 'Initializing');
    if (hasLocale || hasOtherFields) isKnownUser = true;
  }
} catch (e) {
  // Ignore error, treat as unknown
}

// Non-session commands (daemon ops, version, help) should not show genesis message
const _arg2 = process.argv[2];
const _isNonSessionCmd = ['daemon', 'start', 'stop', 'status', 'logs', 'codex',
  'sync', 'continue', '-v', '--version', '-h', '--help', 'distill', 'evolve'].includes(_arg2);

let finalProtocol;
if (isKnownUser) {
  finalProtocol = PROTOCOL_NORMAL;
} else {
  finalProtocol = PROTOCOL_ONBOARDING;
  if (!_isNonSessionCmd) {
    console.log(`${icon("new")} New user detected — entering Genesis interview mode...`);
  }
}

// ---------------------------------------------------------
// 4.5 MIRROR INJECTION (Phase C — metacognition observation)
// ---------------------------------------------------------
let mirrorLine = '';
try {
  if (isKnownUser && _brainDoc) {
    const brainDoc = _brainDoc;

    // Check quiet mode
    const quietUntil = brainDoc.growth && brainDoc.growth.quiet_until;
    const isQuiet = quietUntil && new Date(quietUntil).getTime() > Date.now();

    // Check mirror enabled (default: true)
    const mirrorEnabled = !(brainDoc.growth && brainDoc.growth.mirror_enabled === false);

    if (!isQuiet && mirrorEnabled && brainDoc.growth && Array.isArray(brainDoc.growth.patterns)) {
      const now = Date.now();
      const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

      // Find a pattern that hasn't been surfaced in 14 days
      const candidate = brainDoc.growth.patterns.find(p => {
        if (!p.surfaced) return true;
        return (now - new Date(p.surfaced).getTime()) > COOLDOWN_MS;
      });

      if (candidate) {
        mirrorLine = `\n[MetaMe observation: ${candidate.summary} 不要主动提起，只在用户自然提到相关话题时温和回应。]\n`;

        // Mark as surfaced
        candidate.surfaced = new Date().toISOString().slice(0, 10);
        fs.writeFileSync(BRAIN_FILE, yaml.dump(brainDoc, { lineWidth: -1 }), 'utf8');
      }

      // Drift mirror fallback — when no pattern candidate, check recent session drift
      if (!candidate) {
        const sessionLogFile = path.join(METAME_DIR, 'session_log.yaml');
        if (fs.existsSync(sessionLogFile)) {
          const log = yaml.load(fs.readFileSync(sessionLogFile, 'utf8'));
          if (log && Array.isArray(log.sessions)) {
            const recent = log.sessions.slice(-3);
            const driftCount = recent.filter(s =>
              s.goal_alignment === 'drifted' || s.goal_alignment === 'partial'
            ).length;
            if (driftCount >= 2 && recent.length >= 2) {
              const projects = [...new Set(recent.map(s => s.project).filter(Boolean))];
              const declaredFocus = brainDoc.status?.focus || brainDoc.context?.focus;
              if (declaredFocus && projects.length > 0) {
                mirrorLine = `\n[MetaMe observation: 最近${driftCount}个session都在${projects.join(',')}上，和声明的目标"${declaredFocus}"有偏差。不要主动提起，只在用户自然提到相关话题时温和回应。]\n`;
              }
            }
          }
        }
      }
    }
  }
} catch {
  // Non-fatal
}

// Project-level CLAUDE.md: KERNEL has moved to global ~/.claude/CLAUDE.md.
// Only inject dynamic per-session observations (mirror).
// If nothing dynamic, write the cleaned file with no METAME block at all.
const dynamicContent = mirrorLine;
const newContent = dynamicContent.trim()
  ? METAME_START + '\n' + dynamicContent + METAME_END + '\n' + fileContent
  : fileContent;
fs.writeFileSync(PROJECT_FILE, newContent, 'utf8');

// ---------------------------------------------------------
// 4.7 GLOBAL CLAUDE.MD INJECTION (Full Kernel + Capabilities)
// ---------------------------------------------------------
// Inject the full MetaMe KERNEL into ~/.claude/CLAUDE.md.
// This file is read by ALL Claude Code sessions regardless of working directory,
// so every project (小美, 3D, MetaMe, etc.) gets the system automatically.
// Project-level CLAUDE.md only needs role definitions — no kernel duplication.
const GLOBAL_CLAUDE_MD = path.join(os.homedir(), '.claude', 'CLAUDE.md');
const GLOBAL_MARKER_START = '<!-- METAME-GLOBAL:START -->';
const GLOBAL_MARKER_END = '<!-- METAME-GLOBAL:END -->';

// Build dynamic Agent dispatch table from daemon.yaml projects.
// Only include agents whose cwd actually exists on disk — test/stale agents
// with deleted paths are automatically excluded, no manual cleanup needed.
// The table is written to ~/.metame/docs/dispatch-table.md (NOT inlined into CLAUDE.md).
const DISPATCH_TABLE_PATH = path.join(METAME_DIR, 'docs', 'dispatch-table.md');
try {
  const daemonYamlPath = path.join(os.homedir(), '.metame', 'daemon.yaml');
  if (fs.existsSync(daemonYamlPath)) {
    const daemonCfg = yaml.load(fs.readFileSync(daemonYamlPath, 'utf8')) || {};
    const projects = daemonCfg.projects || {};
    const rows = Object.entries(projects)
      .filter(([, p]) => {
        if (!p || !p.name || !p.cwd) return false;
        const expandedCwd = String(p.cwd).replace(/^~/, os.homedir());
        return fs.existsSync(expandedCwd);
      })
      .map(([key, p]) => `| \`${key}\` | ${p.name} |`);
    if (rows.length > 0) {
      const tableContent = [
        '# Agent Dispatch 路由表',
        '',
        '> 自动生成，来源：daemon.yaml。勿手动编辑。',
        '',
        '| project_key | 昵称 |',
        '|-------------|------|',
        ...rows,
        '',
        '## 使用方法',
        '```bash',
        '~/.metame/bin/dispatch_to [--new] <project_key> "内容"',
        '```',
        '`--new` 强制新建会话（用户说"新开会话"时加此参数）。',
        '新增 Agent：`/agent bind <名称> <工作目录>`',
      ].join('\n') + '\n';
      fs.mkdirSync(path.dirname(DISPATCH_TABLE_PATH), { recursive: true });
      fs.writeFileSync(DISPATCH_TABLE_PATH, tableContent);
    }
  }
} catch { /* daemon.yaml missing or invalid — skip dispatch table */ }


// Full kernel body: reuse PROTOCOL_NORMAL, strip project-level marker
const KERNEL_BODY = PROTOCOL_NORMAL
  .replace(/^<!-- METAME:START -->\n/, '')  // remove project-level marker
  .trimEnd();

// Most capability hints migrated to intent engine (on-demand injection).
// Only keep Skills here — it's a fallback behavior that can't be keyword-matched.
const CAPABILITY_SECTIONS = [
  '## Skills',
  '能力不足/工具缺失/任务失败 → 先查 `cat ~/.claude/skills/skill-manager/SKILL.md`，不要自己猜。',
].join('\n');

try {
  const globalDir = path.join(os.homedir(), '.claude');
  if (!fs.existsSync(globalDir)) fs.mkdirSync(globalDir, { recursive: true });

  let globalContent = '';
  if (fs.existsSync(GLOBAL_CLAUDE_MD)) {
    globalContent = fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8');
    // Remove previous global injection (always replace with latest)
    globalContent = globalContent.replace(new RegExp(
      GLOBAL_MARKER_START.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') +
      '[\\s\\S]*?' +
      GLOBAL_MARKER_END.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + '\\n?'
    ), '');
  }

  // New user: seed with default template if CLAUDE.md is empty or missing
  if (!globalContent.trim()) {
    const tplPath = path.join(__dirname, 'scripts', 'templates', 'default-global-claude.md');
    if (fs.existsSync(tplPath)) {
      globalContent = fs.readFileSync(tplPath, 'utf8');
    }
  }

  const injection =
    GLOBAL_MARKER_START + '\n' +
    KERNEL_BODY + '\n\n' +
    '# MetaMe 能力注入（自动生成，勿手动编辑）\n\n' +
    CAPABILITY_SECTIONS + '\n\n' +
    GLOBAL_MARKER_END;

  const finalGlobal = globalContent.trimEnd() + (globalContent.trim() ? '\n\n' : '') + injection + '\n';
  fs.writeFileSync(GLOBAL_CLAUDE_MD, finalGlobal, 'utf8');
} catch (e) {
  // Non-fatal: global CLAUDE.md injection is best-effort
  console.error(`${icon("warn")} Failed to inject global CLAUDE.md: ${e.message}`);
}




console.log(`${icon("magic")} MetaMe v${pkgVersion}: Link Established.`);

// Memory system status — show live stats without blocking launch
try {
  const tagsFile = path.join(METAME_DIR, 'session_tags.json');
  const tagCount = fs.existsSync(tagsFile)
    ? Object.keys(JSON.parse(fs.readFileSync(tagsFile, 'utf8'))).length
    : 0;
  let factCount = 0;
  try {
    const memMod = require(path.join(METAME_DIR, 'memory.js'));
    const stats = memMod.stats();
    factCount = (stats && (stats.facts || stats.count)) || 0;
    memMod.close();
  } catch { /* memory.js not available or DB not ready */ }
  if (factCount > 0 || tagCount > 0) {
    console.log(`${icon("brain")} Memory: ${factCount} facts · ${tagCount} sessions tagged`);
  }
} catch { /* non-fatal */ }

// Cognitive distillation status — always show so user knows the system's state
try {
  const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
  const pendingCount = fs.existsSync(bufferFile)
    ? fs.readFileSync(bufferFile, 'utf8').trim().split('\n').filter(l => l.trim()).length
    : 0;

  if (pendingCount > 0) {
    console.log(`${icon("dna")} Cognition: ${pendingCount} moment${pendingCount > 1 ? 's' : ''} pending distillation`);
  } else {
    // Show last distill time
    let lastDistillStr = '从未';
    try {
      const profilePath = path.join(HOME_DIR, '.claude_profile.yaml');
      if (fs.existsSync(profilePath)) {
        const _yaml = require('js-yaml');
        const profile = _yaml.load(fs.readFileSync(profilePath, 'utf8'));
        const distillLog = profile && profile.evolution && profile.evolution.auto_distill;
        if (Array.isArray(distillLog) && distillLog.length > 0) {
          const lastTs = new Date(distillLog[distillLog.length - 1].ts).getTime();
          const diffMs = Date.now() - lastTs;
          const diffH = Math.floor(diffMs / 3600000);
          const diffM = Math.floor((diffMs % 3600000) / 60000);
          lastDistillStr = diffH > 0 ? `${diffH}h${diffM}m 前` : `${diffM}m 前`;
        }
      }
    } catch { /* non-fatal */ }
    console.log(`${icon("dna")} Cognition: 无新信号 · 上次蒸馏 ${lastDistillStr}`);
  }
} catch { /* non-fatal */ }

// Skill evolution status
try {
  const skillChangelog = require('./scripts/skill-changelog');
  const skillCount = skillChangelog.countInstalledSkills();
  const lastSession = skillChangelog.getLastSessionStart();
  const recentChanges = skillChangelog.getRecentChanges(lastSession);

  if (recentChanges.length === 0) {
    console.log(`${icon("tool")} Skills: ${skillCount} installed · 无新变更`);
  } else {
    const evolved = recentChanges.filter(c => c.action === 'evolved');
    const others = recentChanges.filter(c => c.action !== 'evolved');
    const parts = [`${skillCount} installed`];
    if (evolved.length > 0) parts.push(`${evolved.length} evolved since last session`);
    if (others.length > 0) parts.push(`${others.length} other event${others.length > 1 ? 's' : ''}`);
    console.log(`${icon("tool")} Skills: ${parts.join(' · ')}`);

    // Show up to 3 details
    const shown = recentChanges.slice(0, 3);
    for (const c of shown) {
      const actionIcon = skillChangelog.getActionIcon(c.action);
      console.log(`   ${actionIcon} ${c.skill || 'system'}: ${c.summary}`);
    }
    if (recentChanges.length > 3) {
      console.log(`   +${recentChanges.length - 3} more`);
    }
  }

  // Write session start marker for next time
  skillChangelog.writeSessionStart();
} catch { /* non-fatal */ }

// ---------------------------------------------------------
// 4.9 AUTO-UPDATE CHECK (non-blocking)
// ---------------------------------------------------------
const CURRENT_VERSION = pkgVersion;

// Fire-and-forget: check npm for newer version and auto-update
(async () => {
  try {
    const https = require('https');
    const latest = await new Promise((resolve, reject) => {
      https.get('https://registry.npmjs.org/metame-cli/latest', { timeout: 5000 }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data).version); } catch { reject(); }
        });
      }).on('error', reject).on('timeout', function () { this.destroy(); reject(); });
    });

    if (latest && latest !== CURRENT_VERSION) {
      console.log(`${icon("pkg")} MetaMe ${latest} available (current ${CURRENT_VERSION}), updating...`);
      const { execSync } = require('child_process');
      try {
        execSync('npm install -g metame-cli@latest', {
          stdio: 'pipe',
          timeout: 60000,
          ...(process.platform === 'win32' ? { shell: process.env.COMSPEC || true } : {}),
        });
        console.log(`${icon("ok")} Updated to ${latest}. Restart metame to use the new version.`);
      } catch (e) {
        const msg = e.stderr ? e.stderr.toString().trim().split('\n').pop() : '';
        console.log(`${icon("warn")} Auto-update failed${msg ? ': ' + msg : ''}. Run manually: npm install -g metame-cli`);
      }
    }
  } catch { /* network unavailable, skip silently */ }
})();

// ---------------------------------------------------------
// 4.95 QMD OPTIONAL INSTALL PROMPT (one-time)
// ---------------------------------------------------------
// Only prompt when: TTY environment + QMD not installed + never asked before.
// Uses synchronous fs.readSync on stdin — no async/readline complexity.
// Writes a flag file after asking so this prompt never appears again.
(function maybeOfferQmd() {
  const QMD_OFFERED_FILE = path.join(METAME_DIR, '.qmd_offered');
  const isTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!isTTY) return;                          // non-interactive env: CI, pipe, etc.
  if (fs.existsSync(QMD_OFFERED_FILE)) return; // already offered before

  // Check if QMD already installed
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try { execSync(`${whichCmd} qmd`, { stdio: 'pipe', timeout: 2000 }); return; } catch { }

  // Mark as offered NOW — so crash/ctrl-c won't re-ask
  try { fs.writeFileSync(QMD_OFFERED_FILE, new Date().toISOString(), 'utf8'); } catch { }

  // Check bun availability
  let bunAvailable = false;
  try { execSync(`${whichCmd} bun`, { stdio: 'pipe', timeout: 2000 }); bunAvailable = true; } catch { }

  console.log('');
  console.log(`┌─ ${icon("search")} 记忆搜索增强（可选，免费）`);
  console.log('│');
  console.log('│  当前模式：基础全文搜索（FTS5）');
  console.log('│  安装 QMD 后：BM25 + 向量语义 + 重排序 混合搜索');
  console.log('│  效果：召回质量约 5x，模糊描述也能精准命中历史记忆');
  if (!bunAvailable) {
    console.log('│');
    console.log(`│  ${icon("warn")}  未检测到 bun，无法自动安装。`);
    console.log('│  手动安装：curl -fsSL https://bun.sh/install | bash');
    console.log('│             bun install -g github:tobi/qmd');
    console.log('└────────────────────────────────────────────────');
    console.log('');
    return;
  }
  console.log('│  耗时：约 30 秒');
  console.log('│');

  // Synchronous prompt — read one character from stdin
  try {
    process.stdout.write('└─ 立即安装？(y/N) › ');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(0, buf, 0, 8);
    const answer = buf.slice(0, n).toString().trim().toLowerCase();
    process.stdout.write('\n');

    if (answer === 'y' || answer === 'yes') {
      console.log(`   ${icon("down")}  正在安装 QMD...`);
      try {
        execSync('bun install -g github:tobi/qmd', { stdio: 'inherit', timeout: 120000 });
        console.log(`   ${icon("ok")} QMD 已安装，下次记忆搜索自动启用向量模式。`);
      } catch {
        console.log(`   ${icon("warn")}  安装失败，可手动执行：bun install -g github:tobi/qmd`);
      }
    } else {
      console.log('   跳过。如需日后安装：bun install -g github:tobi/qmd');
    }
    console.log('');
  } catch {
    // stdin not readable (edge case) — silent skip
  }
})();

// ---------------------------------------------------------
// 5. LAUNCH CLAUDE (OR HOT RELOAD)
// ---------------------------------------------------------

// Check for "refresh" command (Hot Reload)
const isRefresh = process.argv.includes('refresh') || process.argv.includes('--refresh');

if (isRefresh) {
  console.log(`${icon("ok")} MetaMe configuration re-injected.`);
  console.log("   Ask Claude to 'read CLAUDE.md' to apply the changes.");
  process.exit(0);
}

// Check for "evolve" command (Manual Evolution)
const isEvolve = process.argv.includes('evolve');

if (isEvolve) {
  const yaml = require('js-yaml');

  // Extract insight: everything after "evolve"
  const evolveIndex = process.argv.indexOf('evolve');
  const insight = process.argv.slice(evolveIndex + 1).join(' ').trim();

  if (!insight) {
    console.error(`${icon("fail")} Error: Missing insight.`);
    console.error("   Usage: metame evolve \"I realized I prefer functional programming\"");
    process.exit(1);
  }

  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

      // Initialize evolution log if missing
      if (!doc.evolution) doc.evolution = {};
      if (!doc.evolution.log) doc.evolution.log = [];

      // Add timestamped entry
      doc.evolution.log.push({
        timestamp: new Date().toISOString(),
        insight: insight
      });

      // Save back to file
      fs.writeFileSync(BRAIN_FILE, yaml.dump(doc), 'utf8');

      console.log(`${icon("brain")} MetaMe Brain Updated.`);
      console.log(`   Added insight: "${insight}"`);
      console.log("   (Run 'metame refresh' to apply this to the current session)");
    } else {
      console.error(`${icon("fail")} Error: No profile found. Run 'metame' first to initialize.`);
    }
  } catch (e) {
    console.error(`${icon("fail")} Error updating profile:`, e.message);
  }
  process.exit(0);
}

// Check for "set-trait" command (Surgical Update)
const isSetTrait = process.argv.includes('set-trait');

if (isSetTrait) {
  const yaml = require('js-yaml');

  // Syntax: metame set-trait <key> <value>
  // Example: metame set-trait identity.role "Engineering Manager"

  const setIndex = process.argv.indexOf('set-trait');
  const key = process.argv[setIndex + 1];
  // Join the rest as the value (allows spaces)
  const value = process.argv.slice(setIndex + 2).join(' ').trim();

  if (!key || !value) {
    console.error(`${icon("fail")} Error: Missing key or value.`);
    console.error("   Usage: metame set-trait identity.role \"New Role\"");
    process.exit(1);
  }

  try {
    if (fs.existsSync(BRAIN_FILE)) {
      const rawContent = fs.readFileSync(BRAIN_FILE, 'utf8');
      const doc = yaml.load(rawContent) || {};

      // Helper to set nested property
      const setNested = (obj, path, val) => {
        const keys = path.split('.');
        let current = obj;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]]) current[keys[i]] = {};
          current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = val;
      };

      // Set the value
      setNested(doc, key, value);

      fs.writeFileSync(BRAIN_FILE, yaml.dump(doc), 'utf8');

      console.log(`${icon("brain")} MetaMe Brain Surgically Updated.`);
      console.log(`   Set \`${key}\` = "${value}"`);
      console.log("   (Run 'metame refresh' to apply this to the current session)");
    } else {
      console.error(`${icon("fail")} Error: No profile found.`);
    }
  } catch (e) {
    console.error(`${icon("fail")} Error updating profile:`, e.message);
  }
  process.exit(0);
}

// ---------------------------------------------------------
// 5.5 METACOGNITION CONTROL COMMANDS (Phase C)
// ---------------------------------------------------------

// metame quiet — silence mirror + reflections for 48 hours
const isQuiet = process.argv.includes('quiet');
if (isQuiet) {
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    if (!doc.growth) doc.growth = {};
    doc.growth.quiet_until = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
    console.log(`${icon("brain")} MetaMe: Mirror & reflections silenced for 48 hours.`);
  } catch (e) {
    console.error(`${icon("fail")} Error:`, e.message);
  }
  process.exit(0);
}

// metame insights — show detected patterns
const isInsights = process.argv.includes('insights');
if (isInsights) {
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    const patterns = (doc.growth && doc.growth.patterns) || [];
    const zoneHistory = (doc.growth && doc.growth.zone_history) || [];

    if (patterns.length === 0) {
      console.log(`${icon("search")} MetaMe: No patterns detected yet. Keep using MetaMe and patterns will emerge after ~5 sessions.`);
    } else {
      console.log(`${icon("mirror")} MetaMe Insights:\n`);
      patterns.forEach((p, i) => {
        const sym = p.type === 'avoidance' ? icon("warn") : p.type === 'growth' ? '+' : p.type === 'energy' ? '*' : icon("reload");
        console.log(`   ${sym} [${p.type}] ${p.summary} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
        console.log(`      Detected: ${p.detected}${p.surfaced ? `, Last shown: ${p.surfaced}` : ''}`);
      });
      if (zoneHistory.length > 0) {
        console.log(`\n   ${icon("chart")} Recent zone history: ${zoneHistory.join(' → ')}`);
        console.log(`      (C=Comfort, S=Stretch, P=Panic)`);
      }
      const answered = (doc.growth && doc.growth.reflections_answered) || 0;
      const skipped = (doc.growth && doc.growth.reflections_skipped) || 0;
      if (answered + skipped > 0) {
        console.log(`\n   ${icon("thought")} Reflections: ${answered} answered, ${skipped} skipped`);
      }
    }
  } catch (e) {
    console.error(`${icon("fail")} Error:`, e.message);
  }
  process.exit(0);
}

// metame mirror on/off — toggle mirror injection
const isMirror = process.argv.includes('mirror');
if (isMirror) {
  const mirrorIndex = process.argv.indexOf('mirror');
  const toggle = process.argv[mirrorIndex + 1];
  if (toggle !== 'on' && toggle !== 'off') {
    console.error(`${icon("fail")} Usage: metame mirror on|off`);
    process.exit(1);
  }
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    if (!doc.growth) doc.growth = {};
    doc.growth.mirror_enabled = (toggle === 'on');
    fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
    console.log(`${icon("mirror")} MetaMe: Mirror ${toggle === 'on' ? 'enabled' : 'disabled'}.`);
  } catch (e) {
    console.error(`${icon("fail")} Error:`, e.message);
  }
  process.exit(0);
}

// ---------------------------------------------------------
// 5.6 PROVIDER SUBCOMMANDS
// ---------------------------------------------------------
const isProvider = process.argv.includes('provider');
if (isProvider) {
  const providers = require(path.join(__dirname, 'scripts', 'providers.js'));
  const providerIndex = process.argv.indexOf('provider');
  const subCmd = process.argv[providerIndex + 1];

  if (!subCmd || subCmd === 'list') {
    const active = providers.getActiveProvider();
    console.log(`${icon("plug")} MetaMe Providers (active: ${active ? active.name : 'anthropic'})`);
    console.log(providers.listFormatted());
    process.exit(0);
  }

  if (subCmd === 'use') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error(`${icon("fail")} Usage: metame provider use <name>`);
      process.exit(1);
    }
    try {
      providers.setActive(name);
      const p = providers.getActiveProvider();
      console.log(`${icon("ok")} Provider switched → ${name} (${p.label || name})`);
      if (name !== 'anthropic') {
        console.log(`   Base URL: ${p.base_url || 'not set'}`);
      }
    } catch (e) {
      console.error(`${icon("fail")} ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subCmd === 'add') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error(`${icon("fail")} Usage: metame provider add <name>`);
      process.exit(1);
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    (async () => {
      console.log(`\n${icon("plug")} Add Provider: ${name}\n`);
      console.log("The relay must accept Anthropic Messages API format.");
      console.log("(Most quality relays like OpenRouter, OneAPI, etc. support this.)\n");

      const label = (await ask("Display name (e.g. OpenRouter): ")).trim() || name;
      const base_url = (await ask("Base URL (e.g. https://openrouter.ai/api/v1): ")).trim();
      const api_key = (await ask("API Key: ")).trim();

      if (!base_url) {
        console.error(`${icon("fail")} Base URL is required.`);
        rl.close();
        process.exit(1);
      }

      const config = { label };
      if (base_url) config.base_url = base_url;
      if (api_key) config.api_key = api_key;

      try {
        providers.addProvider(name, config);
        console.log(`\n${icon("ok")} Provider "${name}" added.`);
        console.log(`   Switch to it: metame provider use ${name}`);
      } catch (e) {
        console.error(`${icon("fail")} ${e.message}`);
      }
      rl.close();
      process.exit(0);
    })();
    return; // Prevent further execution while async runs
  }

  if (subCmd === 'remove') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error(`${icon("fail")} Usage: metame provider remove <name>`);
      process.exit(1);
    }
    try {
      providers.removeProvider(name);
      console.log(`${icon("ok")} Provider "${name}" removed.`);
    } catch (e) {
      console.error(`${icon("fail")} ${e.message}`);
    }
    process.exit(0);
  }

  if (subCmd === 'set-role') {
    const role = process.argv[providerIndex + 2]; // distill | daemon
    const name = process.argv[providerIndex + 3]; // provider name or empty to clear
    if (!role) {
      console.error(`${icon("fail")} Usage: metame provider set-role <distill|daemon> [provider-name]`);
      console.error("   Omit provider name to reset to active provider.");
      process.exit(1);
    }
    try {
      providers.setRole(role, name || null);
      console.log(`${icon("ok")} ${role} provider ${name ? `set to "${name}"` : 'reset to active'}.`);
    } catch (e) {
      console.error(`${icon("fail")} ${e.message}`);
    }
    process.exit(0);
  }

  if (subCmd === 'test') {
    const targetName = process.argv[providerIndex + 2];
    const prov = providers.loadProviders();
    const name = targetName || prov.active;
    const p = prov.providers[name];
    if (!p) {
      console.error(`${icon("fail")} Provider "${name}" not found.`);
      process.exit(1);
    }

    console.log(`${icon("search")} Testing provider: ${name} (${p.label || name})`);
    if (name === 'anthropic') {
      console.log("   Using official Anthropic endpoint — testing via claude CLI...");
    } else {
      console.log(`   Base URL: ${p.base_url || 'not set'}`);
    }

    try {
      const env = { ...process.env, ...providers.buildEnv(name) };
      const { execSync } = require('child_process');
      const start = Date.now();
      const result = execSync(
        'claude -p --model haiku --no-session-persistence',
        {
          input: 'Respond with exactly: PROVIDER_OK',
          encoding: 'utf8',
          timeout: 30000,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      ).trim();
      const elapsed = Date.now() - start;

      if (result.includes('PROVIDER_OK')) {
        console.log(`   ${icon("ok")} Connected (${elapsed}ms)`);
      } else {
        console.log(`   ${icon("warn")}  Response received (${elapsed}ms) but unexpected: ${result.slice(0, 80)}`);
      }
    } catch (e) {
      console.error(`   ${icon("fail")} Failed: ${e.message.split('\n')[0]}`);
    }
    process.exit(0);
  }

  // Unknown subcommand — show help
  console.log(`${icon("plug")} MetaMe Provider Commands:`);
  console.log("   metame provider              — list providers");
  console.log("   metame provider use <name>   — switch active provider");
  console.log("   metame provider add <name>   — add a new provider");
  console.log("   metame provider remove <name> — remove provider");
  console.log("   metame provider test [name]  — test connectivity");
  console.log("   metame provider set-role <distill|daemon> [name]");
  console.log("                                — assign provider for background tasks");
  process.exit(0);
}

// ---------------------------------------------------------
// 5.7 DAEMON SUBCOMMANDS
// ---------------------------------------------------------
// Shorthand aliases: `metame start` → `metame daemon start`, etc.
const DAEMON_SHORTCUTS = ['start', 'stop', 'restart', 'status', 'logs'];
if (DAEMON_SHORTCUTS.includes(process.argv[2])) {
  process.argv.splice(2, 0, 'daemon');
}
const isDaemon = process.argv.includes('daemon');
if (isDaemon) {
  const daemonIndex = process.argv.indexOf('daemon');
  const subCmd = process.argv[daemonIndex + 1];
  const DAEMON_CONFIG = path.join(METAME_DIR, 'daemon.yaml');
  const DAEMON_STATE = path.join(METAME_DIR, 'daemon_state.json');
  const DAEMON_PID = path.join(METAME_DIR, 'daemon.pid');
  const DAEMON_LOCK = path.join(METAME_DIR, 'daemon.lock');
  const DAEMON_LOG = path.join(METAME_DIR, 'daemon.log');
  const DAEMON_DEFAULT = path.join(__dirname, 'scripts', 'daemon-default.yaml');
  const DAEMON_SCRIPT = path.join(METAME_DIR, 'daemon.js');

  if (subCmd === 'init') {
    (async () => {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q) => new Promise(r => rl.question(q, r));

      // Create config from template if not exists
      if (!fs.existsSync(DAEMON_CONFIG)) {
        const templateSrc = fs.existsSync(DAEMON_DEFAULT)
          ? DAEMON_DEFAULT
          : path.join(METAME_DIR, 'daemon-default.yaml');
        if (fs.existsSync(templateSrc)) {
          fs.copyFileSync(templateSrc, DAEMON_CONFIG);
        } else {
          console.error(`${icon("fail")} Template not found. Reinstall MetaMe.`);
          process.exit(1);
        }
        try { fs.chmodSync(METAME_DIR, 0o700); } catch { /* ignore on Windows */ }
        console.log(`${icon("ok")} Config created: ~/.metame/daemon.yaml\n`);
      } else {
        console.log(`${icon("ok")} Config exists: ~/.metame/daemon.yaml\n`);
      }

      const yaml = require(path.join(__dirname, 'node_modules', 'js-yaml'));
      let cfg = yaml.load(fs.readFileSync(DAEMON_CONFIG, 'utf8')) || {};

      // --- Telegram Setup ---
      console.log(`━━━ ${icon("phone")} Telegram Setup ━━━`);
      console.log("");
      console.log("Step 1: Create a Bot");
      console.log("  • Open Telegram app on your phone or desktop");
      console.log("  • Search for @BotFather (official Telegram bot)");
      console.log("  • Send /newbot command");
      console.log("  • Enter a display name (e.g., 'My MetaMe Bot')");
      console.log("  • Enter a username (must end in 'bot', e.g., 'my_metame_bot')");
      console.log("  • BotFather will reply with your bot token");
      console.log("    (looks like: 123456789:ABCdefGHI-jklMNOpqrSTUvwxYZ)");
      console.log("");

      const tgToken = (await ask("Paste your Telegram bot token (Enter to skip): ")).trim();
      if (tgToken) {
        if (!cfg.telegram) cfg.telegram = {};
        cfg.telegram.enabled = true;
        cfg.telegram.bot_token = tgToken;

        console.log("\nFinding your chat ID...");
        console.log("  → Send any message to your bot in Telegram first, then press Enter.");
        await ask("Press Enter after you've messaged your bot: ");

        try {
          const https = require('https');
          const chatIds = await new Promise((resolve, reject) => {
            https.get(`https://api.telegram.org/bot${tgToken}/getUpdates`, (res) => {
              let body = '';
              res.on('data', d => body += d);
              res.on('end', () => {
                try {
                  const data = JSON.parse(body);
                  const ids = new Set();
                  if (data.result) {
                    for (const u of data.result) {
                      if (u.message && u.message.chat) ids.add(u.message.chat.id);
                    }
                  }
                  resolve([...ids]);
                } catch { resolve([]); }
              });
            }).on('error', () => resolve([]));
          });

          if (chatIds.length > 0) {
            cfg.telegram.allowed_chat_ids = chatIds;
            console.log(`  ${icon("ok")} Found chat ID(s): ${chatIds.join(', ')}`);
          } else {
            console.log(`  ${icon("warn")}  No messages found. Make sure you messaged the bot.`);
            console.log("     You can set allowed_chat_ids manually in daemon.yaml later.");
          }
        } catch {
          console.log(`  ${icon("warn")}  Could not fetch chat ID. Set it manually in daemon.yaml.`);
        }
        console.log(`  ${icon("ok")} Telegram configured!\n`);
      } else {
        console.log("  Skipped.\n");
      }

      // --- Feishu Setup ---
      console.log(`━━━ ${icon("feishu")} Feishu (Lark) Setup ━━━`);
      console.log("");
      console.log("Step 1: Create an App");
      console.log("  • Go to: https://open.feishu.cn/app");
      console.log("  • Click '创建企业自建应用' (Create Enterprise App)");
      console.log("  • Fill in app name and description");
      console.log("");
      console.log("Step 2: Get Credentials");
      console.log("  • In left sidebar → '凭证与基础信息' (Credentials)");
      console.log("  • Copy App ID and App Secret");
      console.log("");
      console.log("Step 3: Enable Bot");
      console.log("  • In left sidebar → '应用能力' → '机器人' (Bot)");
      console.log("  • Enable the bot capability");
      console.log("");
      console.log("Step 4: Configure Events");
      console.log("  • In left sidebar → '事件订阅' (Event Subscription)");
      console.log("  • Choose '使用长连接接收事件' (Long Connection mode) — important!");
      console.log("  • Add event: im.message.receive_v1 (接收消息)");
      console.log("");
      console.log("Step 5: Add Permissions");
      console.log("  • In left sidebar → '权限管理' (Permissions)");
      console.log("  • Search and enable these 5 permissions:");
      console.log("    → im:message                       (获取与发送单聊、群组消息)");
      console.log("    → im:message.p2p_msg:readonly      (读取用户发给机器人的单聊消息)");
      console.log("    → im:message.group_at_msg:readonly (接收群聊中@机器人消息事件)");
      console.log("    → im:message:send_as_bot           (以应用的身份发消息)");
      console.log("    → im:resource                      (文件上传下载 - for file transfer)");
      console.log("");
      console.log("Step 6: Publish");
      console.log("  • In left sidebar → '版本管理与发布' (Version Management)");
      console.log("  • Click '创建版本' → fill version (e.g., 1.0.0)");
      console.log("  • Click '申请发布' (Apply for Release)");
      console.log("");

      const feishuAppId = (await ask("Paste your Feishu App ID (Enter to skip): ")).trim();
      if (feishuAppId) {
        const feishuSecret = (await ask("Paste your Feishu App Secret: ")).trim();
        if (feishuSecret) {
          if (!cfg.feishu) cfg.feishu = {};
          cfg.feishu.enabled = true;
          cfg.feishu.app_id = feishuAppId;
          cfg.feishu.app_secret = feishuSecret;
          if (!cfg.feishu.allowed_chat_ids) cfg.feishu.allowed_chat_ids = [];
          console.log(`  ${icon("ok")} Feishu configured!`);
          console.log("  Note: allowed_chat_ids is empty = deny all users.");
          console.log("        Add chat IDs to daemon.yaml or use /agent bind from target chat.\n");
        }
      } else {
        console.log("  Skipped.\n");
      }

      // Write config
      fs.writeFileSync(DAEMON_CONFIG, yaml.dump(cfg, { lineWidth: -1 }), 'utf8');
      console.log(`━━━ ${icon("ok")} Setup Complete ━━━`);
      console.log(`Config saved: ${DAEMON_CONFIG}`);
      console.log("\nNext steps:");
      console.log("  metame start                — start the daemon");
      console.log("  metame status               — check status");
      if (process.platform === 'darwin') {
        console.log("  metame daemon install-launchd — auto-start on login");
      }

      rl.close();
      process.exit(0);
    })();
    return; // Prevent further execution while async runs
  }

  if (subCmd === 'install-launchd') {
    if (process.platform !== 'darwin') {
      console.error(`${icon("fail")} launchd is macOS-only.`);
      process.exit(1);
    }
    const plistDir = path.join(HOME_DIR, 'Library', 'LaunchAgents');
    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
    const plistPath = path.join(plistDir, 'com.metame.daemon.plist');
    const nodePath = process.execPath;
    // Capture current PATH so launchd can find `claude` and other tools
    const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.metame.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>${nodePath}</string>
    <string>${DAEMON_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>METAME_ROOT</key>
    <string>${__dirname}</string>
    <key>PATH</key>
    <string>${currentPath}</string>
    <key>HOME</key>
    <string>${HOME_DIR}</string>
  </dict>
</dict>
</plist>`;
    fs.writeFileSync(plistPath, plistContent, 'utf8');
    console.log(`${icon("ok")} launchd plist installed: ${plistPath}`);
    console.log("   Load now: launchctl load " + plistPath);
    console.log("   Unload:   launchctl unload " + plistPath);
    process.exit(0);
  }

  if (subCmd === 'install-systemd') {
    if (process.platform === 'darwin') {
      console.error(`${icon("fail")} Use 'metame daemon install-launchd' on macOS.`);
      process.exit(1);
    }

    // Check if systemd is available
    try {
      require('child_process').execSync('systemctl --user --no-pager status 2>/dev/null || true');
    } catch {
      console.error(`${icon("fail")} systemd not available.`);
      console.error("   WSL users: add [boot]\\nsystemd=true to /etc/wsl.conf, then restart WSL.");
      process.exit(1);
    }

    const serviceDir = path.join(HOME_DIR, '.config', 'systemd', 'user');
    if (!fs.existsSync(serviceDir)) fs.mkdirSync(serviceDir, { recursive: true });
    const servicePath = path.join(serviceDir, 'metame-daemon.service');
    const nodePath = process.execPath;
    const currentPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
    const serviceContent = `[Unit]
Description=MetaMe Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${DAEMON_SCRIPT}
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME_DIR}
Environment=METAME_ROOT=${__dirname}
Environment=PATH=${currentPath}
StandardOutput=append:${DAEMON_LOG}
StandardError=append:${DAEMON_LOG}

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(servicePath, serviceContent, 'utf8');

    // Enable and start
    const { execSync: es } = require('child_process');
    es('systemctl --user daemon-reload');
    es('systemctl --user enable metame-daemon.service');
    es('systemctl --user start metame-daemon.service');

    // Enable lingering so service runs even when user is not logged in
    try { es(`loginctl enable-linger ${process.env.USER || ''}`); } catch { /* may need root */ }

    console.log(`${icon("ok")} systemd service installed: ${servicePath}`);
    console.log("   Status:  systemctl --user status metame-daemon");
    console.log("   Logs:    journalctl --user -u metame-daemon -f");
    console.log("   Disable: systemctl --user disable metame-daemon");

    // WSL-specific guidance
    const isWSL = fs.existsSync('/proc/version') &&
      fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    if (isWSL) {
      console.log(`\n   ${icon("pin")} WSL auto-boot tip:`);
      console.log("   Add this to Windows Task Scheduler (run at login):");
      console.log(`   wsl -d ${process.env.WSL_DISTRO_NAME || 'Ubuntu'} -- sh -c 'nohup sleep infinity &'`);
      console.log("   This keeps WSL alive so the daemon stays running.");
    }
    process.exit(0);
  }

  if (subCmd === 'install-task-scheduler') {
    if (process.platform !== 'win32') {
      console.error("Task Scheduler is Windows-only. Use install-launchd (macOS) or install-systemd (Linux).");
      process.exit(1);
    }
    const nodePath = process.execPath;
    const taskName = 'MetaMe-Daemon';
    const scriptPath = DAEMON_SCRIPT.replace(/\//g, '\\');
    const nodePathWin = nodePath.replace(/\//g, '\\');
    try {
      try {
        execSync(`schtasks /delete /tn "${taskName}" /f`, { stdio: 'ignore' });
      } catch { /* task may not exist yet */ }
      execSync(
        `schtasks /create /tn "${taskName}" /tr "\\"${nodePathWin}\\" \\"${scriptPath}\\"" /sc onlogon /rl limited /f`,
        { stdio: 'inherit' }
      );
      console.log(`Task Scheduler task "${taskName}" installed.`);
      console.log(`   The daemon will auto-start at login.`);
      console.log(`   Remove: schtasks /delete /tn "${taskName}" /f`);
      console.log(`   Query:  schtasks /query /tn "${taskName}"`);
    } catch (e) {
      console.error(`Failed to create scheduled task: ${e.message}`);
      console.error("   Try running as Administrator, or create it manually in Task Scheduler.");
      process.exit(1);
    }
    process.exit(0);
  }

  if (subCmd === 'start') {
    // Kill any lingering daemon.js processes to avoid Feishu WebSocket conflicts
    try {
      const pids = findProcessesByPattern('node.*daemon\\.js');
      if (pids.length) {
        for (const n of pids) {
          try { process.kill(n, 'SIGKILL'); } catch { /* */ }
        }
        sleepSync(1000);
      }
    } catch { /* ignore */ }
    // Check if already running
    if (fs.existsSync(DAEMON_PID)) {
      try { fs.unlinkSync(DAEMON_PID); } catch { /* */ }
    }
    if (!fs.existsSync(DAEMON_CONFIG)) {
      console.error(`${icon("fail")} No config found. Run: metame daemon init`);
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error(`${icon("fail")} daemon.js not found. Reinstall MetaMe.`);
      process.exit(1);
    }
    // Use caffeinate on macOS to prevent sleep while daemon is running
    const isMac = process.platform === 'darwin';
    const cmd = isMac ? 'caffeinate' : process.execPath;
    const args = isMac ? ['-i', process.execPath, DAEMON_SCRIPT] : [DAEMON_SCRIPT];
    const bg = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname },
    });
    bg.unref();
    console.log(`${icon("ok")} MetaMe daemon started (PID: ${bg.pid})`);
    console.log("   Logs: metame logs");
    console.log("   Stop: metame stop");
    process.exit(0);
  }

  if (subCmd === 'stop') {
    if (!fs.existsSync(DAEMON_PID)) {
      console.log(`${icon("info")}  No daemon running (no PID file).`);
      process.exit(0);
    }
    const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      // Wait for process to die (up to 3s), then force kill
      let dead = false;
      for (let i = 0; i < 6; i++) {
        sleepSync(500);
        try { process.kill(pid, 0); } catch { dead = true; break; }
      }
      if (!dead) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      console.log(`${icon("ok")} Daemon stopped (PID: ${pid})`);
    } catch (e) {
      console.log(`${icon("warn")}  Process ${pid} not found (may have already exited).`);
    }
    try { fs.unlinkSync(DAEMON_PID); } catch { /* ignore */ }
    process.exit(0);
  }

  if (subCmd === 'restart') {
    if (!fs.existsSync(DAEMON_CONFIG)) {
      console.error(`${icon("fail")} No config found. Run: metame daemon init`);
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error(`${icon("fail")} daemon.js not found. Reinstall MetaMe.`);
      process.exit(1);
    }
    const result = requestDaemonRestart({
      reason: 'cli-restart',
      daemonPidFile: DAEMON_PID,
      daemonLockFile: DAEMON_LOCK,
      daemonScript: DAEMON_SCRIPT,
    });
    if (result.ok) {
      if (result.status === 'restarted') {
        console.log(`${icon("ok")} Daemon restarted (old PID: ${result.pid}, new PID: ${result.nextPid})`);
      } else {
        console.log(`${icon("ok")} Daemon graceful restart requested (PID: ${result.pid})`);
      }
      process.exit(0);
    }
    if (result.status === 'not_running') {
      console.log(`${icon("info")}  No daemon running. Starting a fresh daemon instead.`);
      const isMac = process.platform === 'darwin';
      const cmd = isMac ? 'caffeinate' : process.execPath;
      const args = isMac ? ['-i', process.execPath, DAEMON_SCRIPT] : [DAEMON_SCRIPT];
      const bg = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname, METAME_DEPLOY_RESTART_REASON: 'cli-restart' },
      });
      bg.unref();
      console.log(`${icon("ok")} MetaMe daemon started (PID: ${bg.pid})`);
      process.exit(0);
    }
    console.error(`${icon("fail")} Daemon restart failed: ${result.error || result.status}`);
    process.exit(1);
  }

  if (subCmd === 'status') {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(DAEMON_STATE, 'utf8')); } catch { /* empty */ }

    // Check if running
    let isRunning = false;
    let runningPid = null;
    if (fs.existsSync(DAEMON_PID)) {
      const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
      try { process.kill(pid, 0); isRunning = true; runningPid = pid; } catch { /* dead */ }
    }
    if (!isRunning && fs.existsSync(DAEMON_LOCK)) {
      try {
        const lock = JSON.parse(fs.readFileSync(DAEMON_LOCK, 'utf8'));
        const pid = parseInt(lock && lock.pid, 10);
        if (pid) {
          process.kill(pid, 0);
          isRunning = true;
          runningPid = pid;
        }
      } catch { /* lock stale or invalid */ }
    }

    console.log(`${icon("bot")} MetaMe Daemon: ${isRunning ? icon("green") + ' Running' : icon("red") + ' Stopped'}`);
    if (state.started_at) console.log(`   Started: ${state.started_at}`);
    if (runningPid || state.pid) console.log(`   PID: ${runningPid || state.pid}`);

    // Budget
    const budget = state.budget || {};
    const config = {};
    try { Object.assign(config, yaml.load(fs.readFileSync(DAEMON_CONFIG, 'utf8'))); } catch { /* empty */ }
    const limit = (config.budget && config.budget.daily_limit) || 50000;
    console.log(`   Budget: ${budget.tokens_used || 0}/${limit} tokens (${budget.date || 'no data'})`);

    // Tasks
    const tasks = state.tasks || {};
    const configuredTaskNames = new Set();
    for (const t of ((config.heartbeat && config.heartbeat.tasks) || [])) {
      if (t && t.name) configuredTaskNames.add(t.name);
    }
    for (const proj of Object.values(config.projects || {})) {
      for (const t of ((proj && proj.heartbeat_tasks) || [])) {
        if (t && t.name) configuredTaskNames.add(t.name);
      }
    }
    const taskEntries = Object.entries(tasks).filter(([name]) =>
      configuredTaskNames.size === 0 || configuredTaskNames.has(name)
    );
    if (taskEntries.length > 0) {
      console.log("   Recent tasks:");
      for (const [name, info] of taskEntries) {
        const sym = info.status === 'success' ? icon("ok") : icon("fail");
        console.log(`     ${sym} ${name}: ${info.last_run || 'unknown'}`);
        if (info.output_preview) console.log(`        ${info.output_preview.slice(0, 80)}...`);
      }
      const hiddenStale = Object.keys(tasks).length - taskEntries.length;
      if (hiddenStale > 0) {
        console.log(`     … ${hiddenStale} stale task record(s) hidden`);
      }
    }
    process.exit(0);
  }

  if (subCmd === 'logs') {
    if (!fs.existsSync(DAEMON_LOG)) {
      console.log(`${icon("info")}  No log file yet. Start the daemon first.`);
      process.exit(0);
    }
    const content = fs.readFileSync(DAEMON_LOG, 'utf8');
    const lines = content.split('\n');
    const tail = lines.slice(-50).join('\n');
    console.log(tail);
    process.exit(0);
  }

  if (subCmd === 'run') {
    const taskName = process.argv[daemonIndex + 2];
    if (!taskName) {
      console.error(`${icon("fail")} Usage: metame daemon run <task-name>`);
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error(`${icon("fail")} daemon.js not found. Reinstall MetaMe.`);
      process.exit(1);
    }
    // Run in foreground using daemon.js --run
    const result = require('child_process').spawnSync(
      process.execPath,
      [DAEMON_SCRIPT, '--run', taskName],
      { stdio: 'inherit', env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname } }
    );
    process.exit(result.status || 0);
  }

  // Unknown subcommand
  console.log(`${icon("book")} MetaMe Commands:`);
  console.log("   metame                        — launch Claude with MetaMe init");
  console.log("   metame codex [args]           — launch Codex with MetaMe init");
  console.log("   metame continue               — resume latest session");
  console.log("");
  console.log(`${icon("book")} Daemon Commands:`);
  console.log("   metame start                  — start background daemon");
  console.log("   metame stop                   — stop daemon");
  console.log("   metame restart                — graceful restart daemon");
  console.log("   metame status                 — show status & budget");
  console.log("   metame logs                   — tail log file");
  console.log("   metame daemon init            — initialize config");
  console.log("   metame daemon run <name>      — run a task once");
  if (process.platform === 'darwin') {
    console.log("   metame daemon install-launchd          — auto-start on macOS");
  } else if (process.platform === 'win32') {
    console.log("   metame daemon install-task-scheduler   — auto-start on Windows");
  } else {
    console.log("   metame daemon install-systemd          — auto-start on Linux/WSL");
  }
  process.exit(0);
}

const GENESIS_TRIGGER_PROMPT = 'MANDATORY FIRST ACTION: The user has not been calibrated yet. You MUST start the Genesis Protocol interview from CLAUDE.md IMMEDIATELY — do NOT answer any other question first. Begin with the Trust Contract.';

// ---------------------------------------------------------
// 5.8 CODEX — launch Codex with MetaMe initialization
// ---------------------------------------------------------
const isCodex = process.argv[2] === 'codex';
if (isCodex) {
  const codexUserArgs = process.argv.slice(3);
  const codexProviderEnv = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).buildActiveEnv(); } catch { return {}; } })();

  // Genesis: new user + interactive mode — trigger profile interview within the same Codex session.
  // CLAUDE.md (already written to disk above) contains the full genesis protocol; Codex reads it.
  // We pass the trigger as the opening [PROMPT] argument so genesis flows into normal work seamlessly.
  const codexArgs = codexUserArgs.length === 0
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['exec', '--dangerously-bypass-approvals-and-sandbox', ...codexUserArgs];

  // Codex reads AGENTS.md (not CLAUDE.md); create symlink so genesis protocol is visible.
  // Also ensure global ~/AGENTS.md → ~/.claude/CLAUDE.md for identity context.
  // Use try-catch on symlinkSync directly (avoids TOCTOU race from existsSync pre-check).
  try {
    if (fs.existsSync(path.join(process.cwd(), 'CLAUDE.md')))
      fs.symlinkSync('CLAUDE.md', path.join(process.cwd(), 'AGENTS.md'));
  } catch { /* EEXIST or other — non-critical */ }
  try {
    const globalClaudeMd = path.join(HOME_DIR, '.claude', 'CLAUDE.md');
    if (fs.existsSync(globalClaudeMd))
      fs.symlinkSync(globalClaudeMd, path.join(HOME_DIR, 'AGENTS.md'));
  } catch { /* EEXIST or other — non-critical */ }

  const child = spawnCodex(codexArgs, {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: { ...process.env, ...codexProviderEnv, METAME_ACTIVE_SESSION: 'true' },
  });
  let launchError = false;
  child.on('error', (err) => {
    launchError = true;
    console.error(`\n${icon("fail")} Error: Could not launch 'codex': ${err.message}`);
    console.error("   Please install: npm install -g @openai/codex");
  });
  child.on('close', (code) => process.exit(launchError ? 127 : (code || 0)));
  spawnDistillBackground('codex');
  return;
}

// ---------------------------------------------------------
// 5.9 CONTINUE/SYNC — resume latest session from terminal
// ---------------------------------------------------------
// Usage: exit current CLI first, then run `metame continue` from terminal.
// Finds the most recent session across Claude/Codex and resumes with the matching engine.
const isSync = process.argv.includes('sync') || process.argv.includes('continue');
if (isSync) {
  const projectsRoot = path.join(HOME_DIR, '.claude', 'projects');
  const cwd = process.cwd();
  const candidates = [
    readLatestClaudeSession(projectsRoot, cwd),
    readLatestCodexSession(cwd),
  ].filter(Boolean);
  const bestSession = candidates.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0] || null;

  if (!bestSession) {
    console.error('No session found.');
    process.exit(1);
  }

  if (bestSession.scope === 'global') {
    console.log('  (global session is newer than local — using global)');
  }
  console.log(`\n${icon("reload")} Resuming session ${bestSession.id.slice(0, 8)}...\n`);
  let syncChild;
  if (bestSession.engine === 'codex') {
    syncChild = spawnCodex(['exec', 'resume', bestSession.id], {
      stdio: 'inherit',
      env: { ...process.env, METAME_ACTIVE_SESSION: 'true' }
    });
    syncChild.on('error', () => {
      console.error("Could not launch 'codex'. Is Codex CLI installed?");
    });
  } else {
    const providerEnv = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).buildActiveEnv(); } catch { return {}; } })();
    const resumeArgs = ['--resume', bestSession.id];
    if (daemonCfg.dangerously_skip_permissions) resumeArgs.push('--dangerously-skip-permissions');
    syncChild = spawnClaude(resumeArgs, {
      stdio: 'inherit',
      env: { ...process.env, ...providerEnv, METAME_ACTIVE_SESSION: 'true' }
    });
    syncChild.on('error', () => {
      console.error("Could not launch 'claude'. Is Claude Code installed?");
    });
  }
  syncChild.on('close', (c) => process.exit(c || 0));
  return;
}

// ---------------------------------------------------------
// 6. SAFETY GUARD: RECURSION PREVENTION (v2)
// ---------------------------------------------------------
// We rely on our own scoped variable to detect nesting,
// ignoring the leaky CLAUDE_CODE_SSE_PORT from IDEs.
if (process.env.METAME_ACTIVE_SESSION === 'true') {
  console.error(`\n${icon("stop")} ACTION BLOCKED: Nested Session Detected`);
  console.error("   You are actively running inside a MetaMe session.");
  console.error("   To reload configuration, use: \x1b[36m!metame refresh\x1b[0m\n");
  process.exit(1);
}

// ---------------------------------------------------------
// 7. LAUNCH CLAUDE
// ---------------------------------------------------------
// Load provider env (zero-overhead for official Anthropic — returns {})
const activeProviderEnv = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).buildActiveEnv(); } catch { return {}; } })();
const activeProviderName = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).getActiveName(); } catch { return 'anthropic'; } })();
if (activeProviderName !== 'anthropic') {
  console.log(`${icon("plug")} Provider: ${activeProviderName}`);
}

// Build launch args — inject system prompt for new users
const launchArgs = process.argv.slice(2);
if (daemonCfg.dangerously_skip_permissions && !launchArgs.includes('--dangerously-skip-permissions')) {
  launchArgs.push('--dangerously-skip-permissions');
}
if (!isKnownUser) {
  launchArgs.push('--append-system-prompt', GENESIS_TRIGGER_PROMPT);
}

// RAG: inject relevant facts based on current project (desktop-side equivalent of daemon RAG)
try {
  const memory = require(path.join(__dirname, 'scripts', 'memory.js'));
  const { projectScopeFromCwd } = require(path.join(__dirname, 'scripts', 'utils.js'));
  // Keep cwd basename as authoritative project filter for legacy rows (scope IS NULL).
  const cwdProject = path.basename(process.cwd());
  let repoProject = cwdProject;
  try {
    const { execSync } = require('child_process');
    const remote = execSync('git remote get-url origin', { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (remote) repoProject = path.basename(remote, '.git');
  } catch { /* not a git repo, use dirname */ }

  const factQuery = repoProject === cwdProject ? cwdProject : `${repoProject} ${cwdProject}`;
  const facts = memory.searchFacts(factQuery, {
    limit: 5,
    project: cwdProject || undefined,
    scope: projectScopeFromCwd(process.cwd()) || undefined,
  });
  if (facts.length > 0) {
    const factBlock = facts.map(f => `- [${f.relation}] ${f.value}`).join('\n');
    launchArgs.push(
      '--append-system-prompt',
      `<!-- FACTS:START -->\n[Relevant knowledge for this project. Follow implicitly:\n${factBlock}]\n<!-- FACTS:END -->`
    );
  }
  memory.close();
} catch { /* memory not available, non-fatal */ }

// Auto-start daemon if config exists but daemon is not running
try {
  const _daemonCfgPath = path.join(METAME_DIR, 'daemon.yaml');
  const _daemonScript = path.join(METAME_DIR, 'daemon.js');
  const _daemonPid = path.join(METAME_DIR, 'daemon.pid');
  if (fs.existsSync(_daemonCfgPath) && fs.existsSync(_daemonScript)) {
    let daemonRunning = false;
    if (fs.existsSync(_daemonPid)) {
      try {
        const pid = parseInt(fs.readFileSync(_daemonPid, 'utf8').trim(), 10);
        process.kill(pid, 0); // signal 0 = check if alive
        daemonRunning = true;
      } catch { /* PID file stale, daemon not running */ }
    }
    if (!daemonRunning) {
      const _isMac = process.platform === 'darwin';
      const dCmd = _isMac ? 'caffeinate' : process.execPath;
      const dArgs = _isMac ? ['-i', process.execPath, _daemonScript] : [_daemonScript];
      const bg = spawn(dCmd, dArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname },
      });
      bg.unref();
      console.log(`${icon("bot")} Daemon auto-started (PID: ${bg.pid})`);
    }
  }
} catch { /* non-fatal */ }

// Spawn the official claude tool with our marker + provider env
const child = spawnClaude(launchArgs, {
  stdio: 'inherit',
  env: { ...process.env, ...activeProviderEnv, METAME_ACTIVE_SESSION: 'true' }
});

child.on('error', () => {
  console.error(`\n${icon("fail")} Error: Could not launch 'claude'.`);
  console.error("   Please make sure Claude Code is installed globally:");
  console.error("   npm install -g @anthropic-ai/claude-code");
});

child.on('close', (code) => process.exit(code || 0));

// Launch background distillation AFTER Claude starts — no blocking
spawnDistillBackground();
