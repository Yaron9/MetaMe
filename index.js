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
   *   **TOOL:** You have the capability to save insights using \`!metame evolve "Insight"\`.
   *   **RULE:** Only use this tool when the User **EXPLICITLY** instructs you to "remember this", "save this preference", or "update my profile".
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

// ---------------------------------------------------------
// 6. SAFETY GUARD: PREVENT RECURSION
// ---------------------------------------------------------
// If we are already running inside Claude (detected via environment variable),
// and we did NOT trigger a refresh above, it usually means a typo or user error.
// Spawning a nested Claude session here creates confusion.
if (process.env.CLAUDE_CODE_SSE_PORT) {
  console.error("\n⚠️  SAFETY GUARD TRIGGERED: Nested Session Detected");
  console.error("   You are trying to spawn Claude **inside** an existing Claude session.");
  console.error("   This often happens if you made a typo (e.g., !metame regresh).");
  console.error("\n   👉 If you wanted to reload config, run: !metame refresh");
  console.error("   👉 If you really want a nested session, unset CLAUDE_CODE_SSE_PORT first.\n");
  process.exit(1);
}

// ---------------------------------------------------------
// 7. LAUNCH CLAUDE
// ---------------------------------------------------------
// Spawn the official claude tool
const child = spawn('claude', process.argv.slice(2), { stdio: 'inherit' });

child.on('error', (err) => {
  console.error("\n❌ Error: Could not launch 'claude'.");
  console.error("   Please make sure Claude Code is installed globally:");
  console.error("   npm install -g @anthropic-ai/claude-code");
});