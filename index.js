#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

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

// Auto-deploy bundled scripts to ~/.metame/
// IMPORTANT: daemon.yaml is USER CONFIG — never overwrite it. Only daemon-default.yaml (template) is synced.
const BUNDLED_SCRIPTS = ['signal-capture.js', 'distill.js', 'schema.js', 'pending-traits.js', 'migrate-v2.js', 'daemon.js', 'telegram-adapter.js', 'feishu-adapter.js', 'daemon-default.yaml', 'providers.js', 'session-analytics.js', 'resolve-yaml.js', 'utils.js', 'skill-evolution.js', 'memory.js', 'memory-extract.js', 'qmd-client.js'];
const scriptsDir = path.join(__dirname, 'scripts');

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

let scriptsUpdated = false;
for (const script of BUNDLED_SCRIPTS) {
  const src = path.join(scriptsDir, script);
  const dest = path.join(METAME_DIR, script);
  try {
    if (fs.existsSync(src)) {
      const srcContent = fs.readFileSync(src, 'utf8');
      const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      if (srcContent !== destContent) {
        fs.writeFileSync(dest, srcContent, 'utf8');
        scriptsUpdated = true;
      }
    }
  } catch {
    // Non-fatal
  }
}

// Daemon restart on script update:
// Don't kill daemon here — daemon's own file watcher detects ~/.metame/daemon.js changes
// and has defer logic (waits for active Claude tasks to finish before restarting).
// Killing here bypasses that and interrupts ongoing conversations.
if (scriptsUpdated) {
  console.log('📦 Scripts synced to ~/.metame/ — daemon will auto-restart when idle.');
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
    console.log('⚠️  daemon.yaml was missing — restored from backup.');
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
    const hookCommand = `node ${SIGNAL_CAPTURE_SCRIPT}`;
    const existing = settings.hooks?.UserPromptSubmit || [];
    const alreadyInstalled = existing.some(entry =>
      entry.hooks?.some(h => h.command === hookCommand)
    );

    if (!alreadyInstalled) {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

      settings.hooks.UserPromptSubmit.push({
        hooks: [{
          type: 'command',
          command: hookCommand
        }]
      });

      fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2), 'utf8');
      console.log("🪝 MetaMe: Signal capture hook installed.");
    }
  } catch (e) {
    // Non-fatal: hook install failure shouldn't block launch
    console.error("⚠️  Hook install skipped:", e.message);
  }
}

ensureHookInstalled();

// ---------------------------------------------------------
// 1.6b ENSURE PROJECT-LEVEL MCP CONFIG
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

function spawnDistillBackground() {
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
    const profilePath = path.join(process.env.HOME || '', '.claude_profile.yaml');
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

  if (hasSignals) {
    const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
    const lines = fs.readFileSync(bufferFile, 'utf8').trim().split('\n').filter(l => l.trim());
    console.log(`🧠 MetaMe: Distilling ${lines.length} moment${lines.length > 1 ? 's' : ''} in background...`);
  }
  if (bootstrap) {
    console.log('📊 MetaMe: Bootstrapping session history...');
  }

  // Spawn as detached background process — won't block Claude launch
  // Remove CLAUDECODE env var so distill.js can call `claude -p` without nested-session rejection
  const distillEnvClean = { ...process.env };
  delete distillEnvClean.CLAUDECODE;
  const bg = spawn('node', [distillPath], {
    detached: true,
    stdio: 'ignore',
    env: distillEnvClean,
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
## 🧠 SYSTEM KERNEL: SHADOW_MODE (Active)

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
## 🧠 SYSTEM KERNEL: SHADOW_MODE (Active)

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

**3. SETUP WIZARD (Phase 2 — Optional):**

After writing the profile, ask: *"Want to set up mobile access so you can reach me from your phone? (Telegram / Feishu / Skip)"*

- If **Telegram:**
  1. Tell user to open Telegram, search @BotFather, send /newbot, create a bot, copy the token.
  2. Ask user to paste the bot token.
  3. Tell user to open their new bot in Telegram and send it any message.
  4. Ask user to confirm they sent a message, then use the Telegram API to fetch the chat ID:
     \`curl -s https://api.telegram.org/bot<TOKEN>/getUpdates | jq '.result[0].message.chat.id'\`
  5. Write both \`bot_token\` and \`allowed_chat_ids\` into \`~/.metame/daemon.yaml\` under the \`telegram:\` section, set \`enabled: true\`.
  6. Tell user to run \`metame start\` to activate.

- If **Feishu:**
  1. Guide through: open.feishu.cn/app → create app → get App ID + Secret → enable bot → add event subscription (long connection mode) → add permissions (im:message, im:message.p2p_msg:readonly, im:message.group_at_msg:readonly, im:message:send_as_bot, im:resource) → publish.
  2. Ask user to paste App ID and App Secret.
  3. Write \`app_id\` and \`app_secret\` into \`~/.metame/daemon.yaml\` under \`feishu:\` section, set \`enabled: true\`.
  4. Tell user: "Now open Feishu and send any message to your new bot, then tell me you're done."
  5. After user confirms, auto-fetch the chat ID:
     \`\`\`bash
     TOKEN=$(curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal -H "Content-Type: application/json" -d '{"app_id":"<APP_ID>","app_secret":"<APP_SECRET>"}' | jq -r '.tenant_access_token')
     curl -s -H "Authorization: Bearer $TOKEN" https://open.feishu.cn/open-apis/im/v1/chats | jq '.data.items[] | {chat_id, name, chat_type}'
     \`\`\`
  6. Write the discovered \`chat_id\`(s) into \`allowed_chat_ids\` in \`~/.metame/daemon.yaml\`.
  7. Tell user to run \`metame start\` to activate.

- If **Skip:** Say "No problem. You can run \`metame daemon init\` anytime to set this up later." Then begin normal work.

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
const yaml = require('js-yaml');
let isKnownUser = false;
try {
  if (fs.existsSync(BRAIN_FILE)) {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    if (doc.identity && doc.identity.locale && doc.identity.locale !== 'null') {
      isKnownUser = true;
    }
  }
} catch (e) {
  // Ignore error, treat as unknown
}

let finalProtocol;
if (isKnownUser) {
  finalProtocol = PROTOCOL_NORMAL;
} else {
  finalProtocol = PROTOCOL_ONBOARDING;
  console.log("🆕 New user detected — entering Genesis interview mode...");
}

// ---------------------------------------------------------
// 4.5 MIRROR INJECTION (Phase C — metacognition observation)
// ---------------------------------------------------------
let mirrorLine = '';
try {
  if (isKnownUser && fs.existsSync(BRAIN_FILE)) {
    const brainDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

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

// ---------------------------------------------------------
// 4.6 REFLECTION PROMPT (Phase C — conditional, NOT static)
// ---------------------------------------------------------
// Only inject when trigger conditions are met at startup.
// This ensures reflections don't fire every session.
let reflectionLine = '';
try {
  if (isKnownUser && fs.existsSync(BRAIN_FILE)) {
    const refDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

    // Check quiet mode
    const quietUntil = refDoc.growth && refDoc.growth.quiet_until;
    const isQuietForRef = quietUntil && new Date(quietUntil).getTime() > Date.now();

    if (!isQuietForRef) {
      const distillCount = (refDoc.evolution && refDoc.evolution.distill_count) || 0;
      const zoneHistory = (refDoc.growth && refDoc.growth.zone_history) || [];

      // Trigger 1: Every 7th session
      const trigger7th = distillCount > 0 && distillCount % 7 === 0;

      // Trigger 2: Three consecutive comfort-zone sessions
      const lastThree = zoneHistory.slice(-3);
      const triggerComfort = lastThree.length === 3 && lastThree.every(z => z === 'C');

      // Trigger 3: Persistent goal drift (2+ drifted in last 3 sessions)
      let triggerDrift = false;
      let driftDeclaredFocus = null;
      try {
        const sessionLogFile = path.join(METAME_DIR, 'session_log.yaml');
        if (fs.existsSync(sessionLogFile)) {
          const driftLog = yaml.load(fs.readFileSync(sessionLogFile, 'utf8'));
          if (driftLog && Array.isArray(driftLog.sessions)) {
            const recentSessions = driftLog.sessions.slice(-3);
            const driftCount = recentSessions.filter(s =>
              s.goal_alignment === 'drifted' || s.goal_alignment === 'partial'
            ).length;
            if (driftCount >= 2 && recentSessions.length >= 2) {
              driftDeclaredFocus = refDoc.status?.focus || refDoc.context?.focus;
              if (driftDeclaredFocus) triggerDrift = true;
            }
          }
        }
      } catch { /* non-fatal */ }

      if (triggerDrift || triggerComfort || trigger7th) {
        let hint = '';
        if (triggerDrift) {
          hint = `最近几个session的方向和"${driftDeclaredFocus}"有偏差。请在对话开始时温和地问：🪞 是方向有意调整了，还是不小心偏了？`;
        } else if (triggerComfort) {
          hint = '连续几次都在熟悉领域。如果用户在session结束时自然停顿，可以温和地问：🪞 准备好探索拉伸区了吗？';
        } else {
          hint = '这是第' + distillCount + '次session。如果session自然结束，可以附加一句：🪞 一个词形容这次session的感受？';
        }
        const timing = triggerDrift ? '在对话开始时就问一次' : '只在session即将结束时说一次';
        reflectionLine = `\n[MetaMe reflection: ${hint} ${timing}。如果用户没回应就不要追问。]\n`;
      }
    }
  }
} catch {
  // Non-fatal
}

// Prepend the new Protocol to the top (mirror + reflection inside markers)
const newContent = finalProtocol + mirrorLine + reflectionLine + METAME_END + "\n" + fileContent;
fs.writeFileSync(PROJECT_FILE, newContent, 'utf8');

console.log("🔮 MetaMe: Link Established.");
console.log("🧬 Protocol: Dynamic Handshake Active");

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
    console.log(`🧠 Memory: ${factCount} facts · ${tagCount} sessions tagged`);
  }
} catch { /* non-fatal */ }

// ---------------------------------------------------------
// 5. LAUNCH CLAUDE (OR HOT RELOAD)
// ---------------------------------------------------------

// Check for "refresh" command (Hot Reload)
const isRefresh = process.argv.includes('refresh') || process.argv.includes('--refresh');

if (isRefresh) {
  console.log("✅ MetaMe configuration re-injected.");
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
    console.error("❌ Error: Missing insight.");
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

      console.log("🧠 MetaMe Brain Updated.");
      console.log(`   Added insight: "${insight}"`);
      console.log("   (Run 'metame refresh' to apply this to the current session)");
    } else {
      console.error("❌ Error: No profile found. Run 'metame' first to initialize.");
    }
  } catch (e) {
    console.error("❌ Error updating profile:", e.message);
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
    console.error("❌ Error: Missing key or value.");
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

      console.log(`🧠 MetaMe Brain Surgically Updated.`);
      console.log(`   Set \`${key}\` = "${value}"`);
      console.log("   (Run 'metame refresh' to apply this to the current session)");
    } else {
      console.error("❌ Error: No profile found.");
    }
  } catch (e) {
    console.error("❌ Error updating profile:", e.message);
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
    console.log("🤫 MetaMe: Mirror & reflections silenced for 48 hours.");
  } catch (e) {
    console.error("❌ Error:", e.message);
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
      console.log("🔍 MetaMe: No patterns detected yet. Keep using MetaMe and patterns will emerge after ~5 sessions.");
    } else {
      console.log("🪞 MetaMe Insights:\n");
      patterns.forEach((p, i) => {
        const icon = p.type === 'avoidance' ? '⚠️' : p.type === 'growth' ? '🌱' : p.type === 'energy' ? '⚡' : '🔄';
        console.log(`   ${icon} [${p.type}] ${p.summary} (confidence: ${(p.confidence * 100).toFixed(0)}%)`);
        console.log(`      Detected: ${p.detected}${p.surfaced ? `, Last shown: ${p.surfaced}` : ''}`);
      });
      if (zoneHistory.length > 0) {
        console.log(`\n   📊 Recent zone history: ${zoneHistory.join(' → ')}`);
        console.log(`      (C=Comfort, S=Stretch, P=Panic)`);
      }
      const answered = (doc.growth && doc.growth.reflections_answered) || 0;
      const skipped = (doc.growth && doc.growth.reflections_skipped) || 0;
      if (answered + skipped > 0) {
        console.log(`\n   💭 Reflections: ${answered} answered, ${skipped} skipped`);
      }
    }
  } catch (e) {
    console.error("❌ Error:", e.message);
  }
  process.exit(0);
}

// metame mirror on/off — toggle mirror injection
const isMirror = process.argv.includes('mirror');
if (isMirror) {
  const mirrorIndex = process.argv.indexOf('mirror');
  const toggle = process.argv[mirrorIndex + 1];
  if (toggle !== 'on' && toggle !== 'off') {
    console.error("❌ Usage: metame mirror on|off");
    process.exit(1);
  }
  try {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    if (!doc.growth) doc.growth = {};
    doc.growth.mirror_enabled = (toggle === 'on');
    fs.writeFileSync(BRAIN_FILE, yaml.dump(doc, { lineWidth: -1 }), 'utf8');
    console.log(`🪞 MetaMe: Mirror ${toggle === 'on' ? 'enabled' : 'disabled'}.`);
  } catch (e) {
    console.error("❌ Error:", e.message);
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
    console.log(`🔌 MetaMe Providers (active: ${active ? active.name : 'anthropic'})`);
    console.log(providers.listFormatted());
    process.exit(0);
  }

  if (subCmd === 'use') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error("❌ Usage: metame provider use <name>");
      process.exit(1);
    }
    try {
      providers.setActive(name);
      const p = providers.getActiveProvider();
      console.log(`✅ Provider switched → ${name} (${p.label || name})`);
      if (name !== 'anthropic') {
        console.log(`   Base URL: ${p.base_url || 'not set'}`);
      }
    } catch (e) {
      console.error(`❌ ${e.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (subCmd === 'add') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error("❌ Usage: metame provider add <name>");
      process.exit(1);
    }
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise(r => rl.question(q, r));

    (async () => {
      console.log(`\n🔌 Add Provider: ${name}\n`);
      console.log("The relay must accept Anthropic Messages API format.");
      console.log("(Most quality relays like OpenRouter, OneAPI, etc. support this.)\n");

      const label = (await ask("Display name (e.g. OpenRouter): ")).trim() || name;
      const base_url = (await ask("Base URL (e.g. https://openrouter.ai/api/v1): ")).trim();
      const api_key = (await ask("API Key: ")).trim();

      if (!base_url) {
        console.error("❌ Base URL is required.");
        rl.close();
        process.exit(1);
      }

      const config = { label };
      if (base_url) config.base_url = base_url;
      if (api_key) config.api_key = api_key;

      try {
        providers.addProvider(name, config);
        console.log(`\n✅ Provider "${name}" added.`);
        console.log(`   Switch to it: metame provider use ${name}`);
      } catch (e) {
        console.error(`❌ ${e.message}`);
      }
      rl.close();
      process.exit(0);
    })();
    return; // Prevent further execution while async runs
  }

  if (subCmd === 'remove') {
    const name = process.argv[providerIndex + 2];
    if (!name) {
      console.error("❌ Usage: metame provider remove <name>");
      process.exit(1);
    }
    try {
      providers.removeProvider(name);
      console.log(`✅ Provider "${name}" removed.`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
    }
    process.exit(0);
  }

  if (subCmd === 'set-role') {
    const role = process.argv[providerIndex + 2]; // distill | daemon
    const name = process.argv[providerIndex + 3]; // provider name or empty to clear
    if (!role) {
      console.error("❌ Usage: metame provider set-role <distill|daemon> [provider-name]");
      console.error("   Omit provider name to reset to active provider.");
      process.exit(1);
    }
    try {
      providers.setRole(role, name || null);
      console.log(`✅ ${role} provider ${name ? `set to "${name}"` : 'reset to active'}.`);
    } catch (e) {
      console.error(`❌ ${e.message}`);
    }
    process.exit(0);
  }

  if (subCmd === 'test') {
    const targetName = process.argv[providerIndex + 2];
    const prov = providers.loadProviders();
    const name = targetName || prov.active;
    const p = prov.providers[name];
    if (!p) {
      console.error(`❌ Provider "${name}" not found.`);
      process.exit(1);
    }

    console.log(`🔍 Testing provider: ${name} (${p.label || name})`);
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
        console.log(`   ✅ Connected (${elapsed}ms)`);
      } else {
        console.log(`   ⚠️  Response received (${elapsed}ms) but unexpected: ${result.slice(0, 80)}`);
      }
    } catch (e) {
      console.error(`   ❌ Failed: ${e.message.split('\n')[0]}`);
    }
    process.exit(0);
  }

  // Unknown subcommand — show help
  console.log("🔌 MetaMe Provider Commands:");
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
const DAEMON_SHORTCUTS = ['start', 'stop', 'status', 'logs'];
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
        console.error("❌ Template not found. Reinstall MetaMe.");
        process.exit(1);
      }
      try { fs.chmodSync(METAME_DIR, 0o700); } catch { /* ignore on Windows */ }
      console.log("✅ Config created: ~/.metame/daemon.yaml\n");
    } else {
      console.log("✅ Config exists: ~/.metame/daemon.yaml\n");
    }

    const yaml = require(path.join(__dirname, 'node_modules', 'js-yaml'));
    let cfg = yaml.load(fs.readFileSync(DAEMON_CONFIG, 'utf8')) || {};

    // --- Telegram Setup ---
    console.log("━━━ 📱 Telegram Setup ━━━");
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
          console.log(`  ✅ Found chat ID(s): ${chatIds.join(', ')}`);
        } else {
          console.log("  ⚠️  No messages found. Make sure you messaged the bot.");
          console.log("     You can set allowed_chat_ids manually in daemon.yaml later.");
        }
      } catch {
        console.log("  ⚠️  Could not fetch chat ID. Set it manually in daemon.yaml.");
      }
      console.log("  ✅ Telegram configured!\n");
    } else {
      console.log("  Skipped.\n");
    }

    // --- Feishu Setup ---
    console.log("━━━ 📘 Feishu (Lark) Setup ━━━");
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
        console.log("  ✅ Feishu configured!");
        console.log("  Note: allowed_chat_ids is empty = allow all users.");
        console.log("        To restrict, add chat IDs to daemon.yaml later.\n");
      }
    } else {
      console.log("  Skipped.\n");
    }

    // Write config
    fs.writeFileSync(DAEMON_CONFIG, yaml.dump(cfg, { lineWidth: -1 }), 'utf8');
    console.log("━━━ ✅ Setup Complete ━━━");
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
      console.error("❌ launchd is macOS-only.");
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
    console.log(`✅ launchd plist installed: ${plistPath}`);
    console.log("   Load now: launchctl load " + plistPath);
    console.log("   Unload:   launchctl unload " + plistPath);
    process.exit(0);
  }

  if (subCmd === 'install-systemd') {
    if (process.platform === 'darwin') {
      console.error("❌ Use 'metame daemon install-launchd' on macOS.");
      process.exit(1);
    }

    // Check if systemd is available
    try {
      require('child_process').execSync('systemctl --user --no-pager status 2>/dev/null || true');
    } catch {
      console.error("❌ systemd not available.");
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

    console.log(`✅ systemd service installed: ${servicePath}`);
    console.log("   Status:  systemctl --user status metame-daemon");
    console.log("   Logs:    journalctl --user -u metame-daemon -f");
    console.log("   Disable: systemctl --user disable metame-daemon");

    // WSL-specific guidance
    const isWSL = fs.existsSync('/proc/version') &&
      fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    if (isWSL) {
      console.log("\n   📌 WSL auto-boot tip:");
      console.log("   Add this to Windows Task Scheduler (run at login):");
      console.log(`   wsl -d ${process.env.WSL_DISTRO_NAME || 'Ubuntu'} -- sh -c 'nohup sleep infinity &'`);
      console.log("   This keeps WSL alive so the daemon stays running.");
    }
    process.exit(0);
  }

  if (subCmd === 'start') {
    // Kill any lingering daemon.js processes to avoid Feishu WebSocket conflicts
    try {
      const { execSync: es } = require('child_process');
      const pids = es("pgrep -f 'node.*daemon\\.js' 2>/dev/null || true", { encoding: 'utf8' }).trim();
      if (pids) {
        for (const p of pids.split('\n').filter(Boolean)) {
          const n = parseInt(p, 10);
          if (n && n !== process.pid) try { process.kill(n, 'SIGKILL'); } catch { /* */ }
        }
        es('sleep 1');
      }
    } catch { /* ignore */ }
    // Check if already running
    if (fs.existsSync(DAEMON_PID)) {
      try { fs.unlinkSync(DAEMON_PID); } catch { /* */ }
    }
    if (!fs.existsSync(DAEMON_CONFIG)) {
      console.error("❌ No config found. Run: metame daemon init");
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error("❌ daemon.js not found. Reinstall MetaMe.");
      process.exit(1);
    }
    // Use caffeinate on macOS/Linux to prevent sleep while daemon is running
    const isNotWindows = process.platform !== 'win32';
    const cmd = isNotWindows ? 'caffeinate' : process.execPath;
    const args = isNotWindows ? ['-i', process.execPath, DAEMON_SCRIPT] : [DAEMON_SCRIPT];
    const bg = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname },
    });
    bg.unref();
    console.log(`✅ MetaMe daemon started (PID: ${bg.pid})`);
    console.log("   Logs: metame logs");
    console.log("   Stop: metame stop");
    process.exit(0);
  }

  if (subCmd === 'stop') {
    if (!fs.existsSync(DAEMON_PID)) {
      console.log("ℹ️  No daemon running (no PID file).");
      process.exit(0);
    }
    const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
    try {
      process.kill(pid, 'SIGTERM');
      // Wait for process to die (up to 3s), then force kill
      let dead = false;
      for (let i = 0; i < 6; i++) {
        const { execSync: es } = require('child_process');
        es('sleep 0.5');
        try { process.kill(pid, 0); } catch { dead = true; break; }
      }
      if (!dead) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      console.log(`✅ Daemon stopped (PID: ${pid})`);
    } catch (e) {
      console.log(`⚠️  Process ${pid} not found (may have already exited).`);
    }
    try { fs.unlinkSync(DAEMON_PID); } catch { /* ignore */ }
    process.exit(0);
  }

  if (subCmd === 'status') {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(DAEMON_STATE, 'utf8')); } catch { /* empty */ }

    // Check if running
    let isRunning = false;
    if (fs.existsSync(DAEMON_PID)) {
      const pid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
      try { process.kill(pid, 0); isRunning = true; } catch { /* dead */ }
    }

    console.log(`🤖 MetaMe Daemon: ${isRunning ? '🟢 Running' : '🔴 Stopped'}`);
    if (state.started_at) console.log(`   Started: ${state.started_at}`);
    if (state.pid) console.log(`   PID: ${state.pid}`);

    // Budget
    const budget = state.budget || {};
    const config = {};
    try { Object.assign(config, yaml.load(fs.readFileSync(DAEMON_CONFIG, 'utf8'))); } catch { /* empty */ }
    const limit = (config.budget && config.budget.daily_limit) || 50000;
    console.log(`   Budget: ${budget.tokens_used || 0}/${limit} tokens (${budget.date || 'no data'})`);

    // Tasks
    const tasks = state.tasks || {};
    if (Object.keys(tasks).length > 0) {
      console.log("   Recent tasks:");
      for (const [name, info] of Object.entries(tasks)) {
        const icon = info.status === 'success' ? '✅' : '❌';
        console.log(`     ${icon} ${name}: ${info.last_run || 'unknown'}`);
        if (info.output_preview) console.log(`        ${info.output_preview.slice(0, 80)}...`);
      }
    }
    process.exit(0);
  }

  if (subCmd === 'logs') {
    if (!fs.existsSync(DAEMON_LOG)) {
      console.log("ℹ️  No log file yet. Start the daemon first.");
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
      console.error("❌ Usage: metame daemon run <task-name>");
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error("❌ daemon.js not found. Reinstall MetaMe.");
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
  console.log("📖 MetaMe Daemon Commands:");
  console.log("   metame start                  — start background daemon");
  console.log("   metame stop                   — stop daemon");
  console.log("   metame status                 — show status & budget");
  console.log("   metame logs                   — tail log file");
  console.log("   metame daemon init            — initialize config");
  console.log("   metame daemon run <name>      — run a task once");
  if (process.platform === 'darwin') {
    console.log("   metame daemon install-launchd — auto-start on macOS");
  } else {
    console.log("   metame daemon install-systemd — auto-start on Linux/WSL");
  }
  process.exit(0);
}

// ---------------------------------------------------------
// 5.8 CONTINUE/SYNC — resume latest session from terminal
// ---------------------------------------------------------
// Usage: exit Claude first, then run `metame continue` from terminal.
// Finds the most recent session and launches Claude with --resume.
const isSync = process.argv.includes('sync') || process.argv.includes('continue');
if (isSync) {
  const projectsRoot = path.join(HOME_DIR, '.claude', 'projects');
  let bestSession = null;
  try {
    const cwd = process.cwd();
    const projDir = path.join(projectsRoot, cwd.replace(/\//g, '-'));
    const findLatest = (dir) => {
      try {
        return fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => ({ id: f.replace('.jsonl', ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)[0] || null;
      } catch { return null; }
    };
    bestSession = findLatest(projDir);
    if (!bestSession) {
      for (const d of fs.readdirSync(projectsRoot)) {
        const s = findLatest(path.join(projectsRoot, d));
        if (s && (!bestSession || s.mtime > bestSession.mtime)) bestSession = s;
      }
    }
  } catch {}

  if (!bestSession) {
    console.error('No session found.');
    process.exit(1);
  }

  console.log(`\n🔄 Resuming session ${bestSession.id.slice(0, 8)}...\n`);
  const providerEnv = (() => { try { return require(path.join(__dirname, 'scripts', 'providers.js')).buildActiveEnv(); } catch { return {}; } })();
  const resumeArgs = ['--resume', bestSession.id];
  if (daemonCfg.dangerously_skip_permissions) resumeArgs.push('--dangerously-skip-permissions');
  const syncChild = spawn('claude', resumeArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...providerEnv, METAME_ACTIVE_SESSION: 'true' }
  });
  syncChild.on('error', () => {
    console.error("Could not launch 'claude'. Is Claude Code installed?");
  });
  syncChild.on('close', (c) => process.exit(c || 0));
  return;
}

// ---------------------------------------------------------
// 6. SAFETY GUARD: RECURSION PREVENTION (v2)
// ---------------------------------------------------------
// We rely on our own scoped variable to detect nesting,
// ignoring the leaky CLAUDE_CODE_SSE_PORT from IDEs.
if (process.env.METAME_ACTIVE_SESSION === 'true') {
  console.error("\n🚫 ACTION BLOCKED: Nested Session Detected");
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
  console.log(`🔌 Provider: ${activeProviderName}`);
}

// Build launch args — inject system prompt for new users
const launchArgs = process.argv.slice(2);
if (daemonCfg.dangerously_skip_permissions && !launchArgs.includes('--dangerously-skip-permissions')) {
  launchArgs.push('--dangerously-skip-permissions');
}
if (!isKnownUser) {
  launchArgs.push(
    '--append-system-prompt',
    'MANDATORY FIRST ACTION: The user has not been calibrated yet. You MUST start the Genesis Protocol interview from CLAUDE.md IMMEDIATELY — do NOT answer any other question first. Begin with the Trust Contract.'
  );
}

// RAG: inject relevant facts based on current project (desktop-side equivalent of daemon RAG)
try {
  const memory = require(path.join(__dirname, 'scripts', 'memory.js'));
  // Derive project key from git repo name or cwd basename
  let projectQuery = path.basename(process.cwd());
  try {
    const { execSync } = require('child_process');
    const remote = execSync('git remote get-url origin 2>/dev/null || true', { encoding: 'utf8', stdio: 'pipe' }).trim();
    if (remote) projectQuery = path.basename(remote, '.git');
  } catch { /* not a git repo, use dirname */ }

  const facts = memory.searchFacts(projectQuery, { limit: 5 });
  if (facts.length > 0) {
    const factBlock = facts.map(f => `- [${f.relation}] ${f.value}`).join('\n');
    launchArgs.push(
      '--append-system-prompt',
      `<!-- FACTS:START -->\n[Relevant knowledge for this project. Follow implicitly:\n${factBlock}]\n<!-- FACTS:END -->`
    );
  }
  memory.close();
} catch { /* memory not available, non-fatal */ }

// Spawn the official claude tool with our marker + provider env
const child = spawn('claude', launchArgs, {
  stdio: 'inherit',
  env: { ...process.env, ...activeProviderEnv, METAME_ACTIVE_SESSION: 'true' }
});

child.on('error', () => {
  console.error("\n❌ Error: Could not launch 'claude'.");
  console.error("   Please make sure Claude Code is installed globally:");
  console.error("   npm install -g @anthropic-ai/claude-code");
});

child.on('close', (code) => process.exit(code || 0));

// Launch background distillation AFTER Claude starts — no blocking
spawnDistillBackground();