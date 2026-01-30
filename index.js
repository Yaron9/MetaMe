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
const BUNDLED_SCRIPTS = ['signal-capture.js', 'distill.js', 'schema.js', 'pending-traits.js', 'migrate-v2.js'];
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

// Prepend the new Protocol to the top
const newContent = finalProtocol + "\n" + fileContent;
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