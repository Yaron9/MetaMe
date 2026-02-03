#!/usr/bin/env node

/**
 * MetaMe Plugin — Profile Injection
 *
 * Reads ~/.claude_profile.yaml and injects the SYSTEM KERNEL
 * protocol header into CLAUDE.md in the current working directory.
 *
 * Extracted from MetaMe index.js for standalone plugin use.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const BRAIN_FILE = path.join(HOME, '.claude_profile.yaml');
const PROJECT_FILE = path.join(process.cwd(), 'CLAUDE.md');

// ---------------------------------------------------------
// SYSTEM KERNEL PROTOCOL
// ---------------------------------------------------------
const CORE_PROTOCOL = `
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
        - **Talents (Genius Zone):** Where do they flow? What is effortless?
        - **Cognition (Mental Models):** Top-down vs Bottom-up? How do they structure chaos?
        - **Context (The Now):** What is the immediate battle? What are the constraints?
        - **Shadows (Hidden Fears):** What are they avoiding? What keeps them awake?
        - **Values (North Star):** Precision vs Speed? Legacy vs Impact?
   * **TERMINATION:**
     - Continue until you have a high-resolution mental map (at least 5-7 exchanges).
     - When finished, summarize everything into the \`~/.claude_profile.yaml\` format.
     - **LOCK** the Core Values using \`# [LOCKED]\`.
     - Announce: "Link Established. I see you now, [Nickname]."
`;

// ---------------------------------------------------------
// TIME-BASED EXPIRY (Startup cleanup)
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

    // context.energy: reset to null on each session start
    if (profile.context && profile.context.energy !== undefined) {
      if (profile.context.energy !== null) {
        profile.context.energy = null;
        changed = true;
      }
    }

    if (changed) {
      const dumped = yaml.dump(profile, { lineWidth: -1 });
      fs.writeFileSync(BRAIN_FILE, dumped, 'utf8');
    }

    // Expire stale pending traits
    const METAME_DIR = path.join(HOME, '.metame');
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
    // Non-fatal
  }
}

// ---------------------------------------------------------
// INJECTION LOGIC
// ---------------------------------------------------------
function inject() {
  // Run expiry cleanup first
  runExpiryCleanup();

  let fileContent = '';

  // Read existing CLAUDE.md if it exists
  if (fs.existsSync(PROJECT_FILE)) {
    fileContent = fs.readFileSync(PROJECT_FILE, 'utf8');
    // Remove any existing SYSTEM KERNEL block
    fileContent = fileContent.replace(/## 🧠 SYSTEM KERNEL[\s\S]*?---\n/g, '');
    fileContent = fileContent.replace(/^\n+/, '');
  }

  // Determine if user is known (calibrated)
  let isKnownUser = false;
  let finalProtocol = CORE_PROTOCOL;

  try {
    const yaml = require('js-yaml');
    if (fs.existsSync(BRAIN_FILE)) {
      const doc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};
      if (doc.identity && doc.identity.nickname && doc.identity.nickname !== 'null') {
        isKnownUser = true;
      }
    }
  } catch {
    // Treat as unknown
  }

  if (!isKnownUser) {
    // Inject Genesis interview protocol
    finalProtocol = finalProtocol.replace('**2. EVOLUTION MECHANISM', GENESIS_PROTOCOL + '\n**2. EVOLUTION MECHANISM');
  }

  // ---------------------------------------------------------
  // MIRROR INJECTION (metacognition observation)
  // ---------------------------------------------------------
  let mirrorLine = '';
  try {
    const yaml = require('js-yaml');
    if (isKnownUser && fs.existsSync(BRAIN_FILE)) {
      const brainDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

      const quietUntil = brainDoc.growth && brainDoc.growth.quiet_until;
      const isQuiet = quietUntil && new Date(quietUntil).getTime() > Date.now();
      const mirrorEnabled = !(brainDoc.growth && brainDoc.growth.mirror_enabled === false);

      if (!isQuiet && mirrorEnabled && brainDoc.growth && Array.isArray(brainDoc.growth.patterns)) {
        const now = Date.now();
        const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

        const candidate = brainDoc.growth.patterns.find(p => {
          if (!p.surfaced) return true;
          return (now - new Date(p.surfaced).getTime()) > COOLDOWN_MS;
        });

        if (candidate) {
          mirrorLine = `\n[MetaMe observation: ${candidate.summary} Do not bring this up proactively — only respond gently if the user naturally mentions a related topic.]\n`;
          candidate.surfaced = new Date().toISOString().slice(0, 10);
          fs.writeFileSync(BRAIN_FILE, yaml.dump(brainDoc, { lineWidth: -1 }), 'utf8');
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // ---------------------------------------------------------
  // REFLECTION PROMPT (conditional)
  // ---------------------------------------------------------
  let reflectionLine = '';
  try {
    const yaml = require('js-yaml');
    if (isKnownUser && fs.existsSync(BRAIN_FILE)) {
      const refDoc = yaml.load(fs.readFileSync(BRAIN_FILE, 'utf8')) || {};

      const quietUntil = refDoc.growth && refDoc.growth.quiet_until;
      const isQuietForRef = quietUntil && new Date(quietUntil).getTime() > Date.now();

      if (!isQuietForRef) {
        const distillCount = (refDoc.evolution && refDoc.evolution.distill_count) || 0;
        const zoneHistory = (refDoc.growth && refDoc.growth.zone_history) || [];

        const trigger7th = distillCount > 0 && distillCount % 7 === 0;
        const lastThree = zoneHistory.slice(-3);
        const triggerComfort = lastThree.length === 3 && lastThree.every(z => z === 'C');

        if (trigger7th || triggerComfort) {
          let hint = '';
          if (triggerComfort) {
            hint = 'Several consecutive sessions in comfort zone. If the user naturally pauses at session end, gently ask: Ready to explore the stretch zone?';
          } else {
            hint = 'This is session #' + distillCount + '. If the session ends naturally, append: One word to describe how this session felt?';
          }
          reflectionLine = `\n[MetaMe reflection: ${hint} Only say this once at session end. If the user doesn't respond, don't push.]\n`;
        }
      }
    }
  } catch {
    // Non-fatal
  }

  // Write the final CLAUDE.md
  const newContent = finalProtocol + mirrorLine + reflectionLine + '\n' + fileContent;
  fs.writeFileSync(PROJECT_FILE, newContent, 'utf8');
}

inject();
