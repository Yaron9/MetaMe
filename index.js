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
const SIGNAL_CAPTURE_SCRIPT = path.join(METAME_DIR, 'signal-capture.js');

// ---------------------------------------------------------
// 1.5 ENSURE METAME DIRECTORY + DEPLOY SCRIPTS
// ---------------------------------------------------------
if (!fs.existsSync(METAME_DIR)) {
  fs.mkdirSync(METAME_DIR, { recursive: true });
}

// Auto-deploy bundled scripts to ~/.metame/
const BUNDLED_SCRIPTS = ['signal-capture.js', 'distill.js', 'schema.js', 'pending-traits.js', 'migrate-v2.js', 'daemon.js', 'telegram-adapter.js', 'feishu-adapter.js', 'daemon-default.yaml'];
const scriptsDir = path.join(__dirname, 'scripts');

for (const script of BUNDLED_SCRIPTS) {
  const src = path.join(scriptsDir, script);
  const dest = path.join(METAME_DIR, script);
  try {
    if (fs.existsSync(src)) {
      const srcContent = fs.readFileSync(src, 'utf8');
      const destContent = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
      if (srcContent !== destContent) {
        fs.writeFileSync(dest, srcContent, 'utf8');
      }
    }
  } catch {
    // Non-fatal
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
// 1.7 PASSIVE DISTILLATION (Background, post-launch)
// ---------------------------------------------------------
function shouldDistill() {
  const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
  if (!fs.existsSync(bufferFile)) return false;
  const content = fs.readFileSync(bufferFile, 'utf8').trim();
  return content.length > 0;
}

function spawnDistillBackground() {
  const distillPath = path.join(METAME_DIR, 'distill.js');
  if (!fs.existsSync(distillPath)) return;
  if (!shouldDistill()) return;

  const bufferFile = path.join(METAME_DIR, 'raw_signals.jsonl');
  const lines = fs.readFileSync(bufferFile, 'utf8').trim().split('\n').filter(l => l.trim());
  console.log(`🧠 MetaMe: Distilling ${lines.length} moment${lines.length > 1 ? 's' : ''} in background...`);

  // Spawn as detached background process — won't block Claude launch
  const bg = spawn('node', [distillPath], {
    detached: true,
    stdio: 'ignore'
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
  nickname: null
status:
  focus: Initializing
`;
  fs.writeFileSync(BRAIN_FILE, initialProfile, 'utf8');
}

// ---------------------------------------------------------
// 3. DEFINE SYSTEM KERNEL (The Protocol)
// ---------------------------------------------------------
const CORE_PROTOCOL = `
---
## 🧠 SYSTEM KERNEL: SHADOW_MODE (Active)

**1. THE HANDSHAKE (Dynamic Verification):**
   * **SOURCE:** Check \`$HOME/.claude_profile.yaml\`.
   * **RULE:** Look for \`identity.nickname\`.
     * **IF FOUND:** You MUST address the user by that nickname in the very first sentence.
     * **IF NULL/MISSING:** Address user as "User" and immediately trigger Genesis to fix it.
   * **SIGNAL:** This nickname is the "Canary Test". If you omit it, the user assumes the system is broken.

**2. THE BRAIN (Source of Truth):**
   * **FILE:** \`$HOME/.claude_profile.yaml\`
   * **RULE:** This file is your Ground Truth. If context is compressed (/compact), **RE-READ** this file immediately.
   * **AUTO-LOCK:** Never edit lines marked \`# [LOCKED]\` (Core Values).
   * **EVOLUTION:** Silently overwrite outdated status/focus.

**3. EVOLUTION MECHANISM (Manual Sync):**
   *   **PHILOSOPHY:** You respect the User's flow. You do NOT interrupt.
   *   **TOOLS:**
       1. **Log Insight:** \`!metame evolve "Insight"\` (For additive knowledge).
       2. **Surgical Update:** \`!metame set-trait key value\` (For overwriting specific fields, e.g., \`!metame set-trait status.focus "API Design"\`).
   *   **RULE:** Only use these tools when the User **EXPLICITLY** instructs you.
   *   **REMINDER:** If the User expresses a strong persistent preference, you may gently ask *at the end of the task*: "Should I save this preference to your MetaMe profile?"
---
`;

const GENESIS_PROTOCOL = `
**GENESIS PROTOCOL (Deep Cognitive Mapping):**
   * **TRIGGER:** If \`identity.role\` is 'Unknown' OR \`identity.nickname\` is 'null', **STOP** and enter **Calibration Mode**.
   * **OBJECTIVE:** You are not a chatbot; you are a Psychologist and a Mirror. Your goal is to map the User's soul to build the perfect "Meta Avatar".
   * **INSTRUCTIONS:**
     1. **Do NOT use multiple choice.** Ask deep, open-ended questions.
     2. **TRUTHFULNESS PACT:** Start by explicitly warning the user: *"For me to be your true Meta Avatar, I need your raw, unfiltered truth. No masks. Are you ready to be honest with yourself?"*
     3. **ITERATIVE DISCOVERY:** Probe their Talents, Anxieties, Mental Models, and Current State.
     4. **BE PROVOCATIVE:** Challenge their assumptions ("You say you want speed, but your anxiety about quality suggests otherwise...").
     5. **THE DIMENSIONS (Map these):**
        - **🌟 Talents (Genius Zone):** Where do they flow? What is effortless?
        - **🧠 Cognition (Mental Models):** Top-down vs Bottom-up? How do they structure chaos?
        - **🌍 Context (The Now):** What is the immediate battle? What are the constraints?
        - **😨 Shadows (Hidden Fears):** What are they avoiding? What keeps them awake?
        - **❤️ Values (North Star):** Precision vs Speed? Legacy vs Impact?
   * **TERMINATION:**
     - Continue until you have a high-resolution mental map (at least 5-7 exchanges).
     - When finished, summarize everything into the \`~/.claude_profile.yaml\` format.
     - **LOCK** the Core Values using \`# [LOCKED]\`.
     - Announce: "Link Established. I see you now, [Nickname]."
`;

// ---------------------------------------------------------
// 4. INJECT PROTOCOL (Smart Update)
// ---------------------------------------------------------
let fileContent = "";

// Read existing CLAUDE.md if it exists
if (fs.existsSync(PROJECT_FILE)) {
  fileContent = fs.readFileSync(PROJECT_FILE, 'utf8');

  // Robust Regex: Removes any existing "## 🧠 SYSTEM KERNEL" block down to the separator
  fileContent = fileContent.replace(/## 🧠 SYSTEM KERNEL[\s\S]*?---\n/g, '');

  // Clean up any leading newlines left over
  fileContent = fileContent.replace(/^\n+/, '');
}

// Logic: Only inject Genesis if the user is UNKNOWN
let finalProtocol = CORE_PROTOCOL;
const yaml = require('js-yaml');

// Quick check of the brain file
let isKnownUser = false;
try {
  if (fs.existsSync(BRAIN_FILE)) {
    const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
    // If nickname exists and is not null/empty, we assume they are "calibrated"
    if (doc.identity && doc.identity.nickname && doc.identity.nickname !== 'null') {
      isKnownUser = true;
    }
  }
} catch (e) {
  // Ignore error, treat as unknown
}

if (!isKnownUser) {
  // Inject the interview instructions into the Core Protocol
  // We insert it before the Evolution Mechanism
  finalProtocol = finalProtocol.replace('**3. EVOLUTION MECHANISM', GENESIS_PROTOCOL + '\n**3. EVOLUTION MECHANISM');
  console.log("🆕 User Unknown: Injecting Deep Genesis Protocol...");
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

      if (trigger7th || triggerComfort) {
        let hint = '';
        if (triggerComfort) {
          hint = '连续几次都在熟悉领域。如果用户在session结束时自然停顿，可以温和地问：🪞 准备好探索拉伸区了吗？';
        } else {
          hint = '这是第' + distillCount + '次session。如果session自然结束，可以附加一句：🪞 一个词形容这次session的感受？';
        }
        reflectionLine = `\n[MetaMe reflection: ${hint} 只在session即将结束时说一次。如果用户没回应就不要追问。]\n`;
      }
    }
  }
} catch {
  // Non-fatal
}

// Prepend the new Protocol to the top
const newContent = finalProtocol + mirrorLine + reflectionLine + "\n" + fileContent;
fs.writeFileSync(PROJECT_FILE, newContent, 'utf8');

console.log("🔮 MetaMe: Link Established.");
console.log("🧬 Protocol: Dynamic Handshake Active");

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
// 5.6 DAEMON SUBCOMMANDS
// ---------------------------------------------------------
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
    // Create config from template
    if (fs.existsSync(DAEMON_CONFIG)) {
      console.log("⚠️  daemon.yaml already exists at ~/.metame/daemon.yaml");
      console.log("   Delete it first if you want to re-initialize.");
    } else {
      const templateSrc = fs.existsSync(DAEMON_DEFAULT)
        ? DAEMON_DEFAULT
        : path.join(METAME_DIR, 'daemon-default.yaml');
      if (fs.existsSync(templateSrc)) {
        fs.copyFileSync(templateSrc, DAEMON_CONFIG);
      } else {
        console.error("❌ Template not found. Reinstall MetaMe.");
        process.exit(1);
      }
      // Ensure directory permissions (700)
      try { fs.chmodSync(METAME_DIR, 0o700); } catch { /* ignore on Windows */ }
      console.log("✅ MetaMe daemon initialized.");
      console.log(`   Config: ${DAEMON_CONFIG}`);
    }

    console.log("\n📱 Telegram Setup (optional):");
    console.log("   1. Message @BotFather on Telegram → /newbot");
    console.log("   2. Copy the bot token");
    console.log("   3. Edit ~/.metame/daemon.yaml:");
    console.log("      telegram:");
    console.log("        enabled: true");
    console.log("        bot_token: \"YOUR_TOKEN\"");
    console.log("        allowed_chat_ids: [YOUR_CHAT_ID]");
    console.log("   4. To find your chat_id: message your bot, then run:");
    console.log("      curl https://api.telegram.org/botYOUR_TOKEN/getUpdates");
    console.log("\n📘 Feishu Setup (optional):");
    console.log("   1. Go to open.feishu.cn → Create App → get app_id & app_secret");
    console.log("   2. Enable Bot capability + im:message events");
    console.log("   3. Enable 'Long Connection' (长连接) mode in Event Subscription");
    console.log("   4. Edit ~/.metame/daemon.yaml:");
    console.log("      feishu:");
    console.log("        enabled: true");
    console.log("        app_id: \"YOUR_APP_ID\"");
    console.log("        app_secret: \"YOUR_APP_SECRET\"");
    console.log("        allowed_chat_ids: [CHAT_ID]");

    console.log("\n   Then: metame daemon start");

    // Optional launchd setup (macOS only)
    if (process.platform === 'darwin') {
      const plistDir = path.join(HOME_DIR, 'Library', 'LaunchAgents');
      const plistPath = path.join(plistDir, 'com.metame.daemon.plist');
      console.log("\n🍎 Auto-start on macOS (optional):");
      console.log("   To start daemon automatically on login:");
      console.log(`   metame daemon start  (first time to verify it works)`);
      console.log(`   Then create: ${plistPath}`);
      console.log("   Or run: metame daemon install-launchd");
    }
    process.exit(0);
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

  if (subCmd === 'start') {
    // Check if already running
    if (fs.existsSync(DAEMON_PID)) {
      const existingPid = parseInt(fs.readFileSync(DAEMON_PID, 'utf8').trim(), 10);
      try {
        process.kill(existingPid, 0); // test if alive
        console.log(`⚠️  Daemon already running (PID: ${existingPid})`);
        console.log("   Use 'metame daemon stop' first.");
        process.exit(1);
      } catch {
        // Stale PID file — clean up
        fs.unlinkSync(DAEMON_PID);
      }
    }
    if (!fs.existsSync(DAEMON_CONFIG)) {
      console.error("❌ No config found. Run: metame daemon init");
      process.exit(1);
    }
    if (!fs.existsSync(DAEMON_SCRIPT)) {
      console.error("❌ daemon.js not found. Reinstall MetaMe.");
      process.exit(1);
    }
    const bg = spawn(process.execPath, [DAEMON_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: HOME_DIR, METAME_ROOT: __dirname },
    });
    bg.unref();
    console.log(`✅ MetaMe daemon started (PID: ${bg.pid})`);
    console.log("   Logs: metame daemon logs");
    console.log("   Stop: metame daemon stop");
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
      console.log(`✅ Daemon stopped (PID: ${pid})`);
    } catch (e) {
      console.log(`⚠️  Process ${pid} not found (may have already exited).`);
      fs.unlinkSync(DAEMON_PID);
    }
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
  console.log("   metame daemon init           — initialize config");
  console.log("   metame daemon start           — start background daemon");
  console.log("   metame daemon stop            — stop daemon");
  console.log("   metame daemon status          — show status & budget");
  console.log("   metame daemon logs            — tail log file");
  console.log("   metame daemon run <name>      — run a task once");
  if (process.platform === 'darwin') {
    console.log("   metame daemon install-launchd — auto-start on macOS");
  }
  process.exit(0);
}

// ---------------------------------------------------------
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
// Spawn the official claude tool with our marker
const child = spawn('claude', process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, METAME_ACTIVE_SESSION: 'true' }
});

child.on('error', (err) => {
  console.error("\n❌ Error: Could not launch 'claude'.");
  console.error("   Please make sure Claude Code is installed globally:");
  console.error("   npm install -g @anthropic-ai/claude-code");
});

// Launch background distillation AFTER Claude starts — no blocking
spawnDistillBackground();