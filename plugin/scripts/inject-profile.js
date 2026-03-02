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
**GENESIS PROTOCOL — Soul Interview (6-Dimension Deep Mapping):**
   * **TRIGGER:** If \`identity.nickname\` is 'null', **STOP** all other tasks and enter **Soul Interview Mode**.
   * **OBJECTIVE:** You are a seasoned psychologist conducting a narrative interview. Your goal is to map the user's soul across 6 dimensions through stories, not questionnaires. Build such a precise internal model that you could predict their reaction to any situation.
   * **CORE RULES:**
     1. **NEVER use multiple choice or psychology jargon.** Ask through stories and scenarios.
     2. **NEVER accept surface answers.** Always probe deeper: "What was really going on underneath?"
     3. **Challenge contradictions.** "You said X, but earlier you mentioned Y — which is the real you?"
     4. **Minimum 7 exchanges** before synthesizing. Do NOT rush.
     5. **One thread at a time.** Do not ask compound questions.

   * **PHASE 0 — Contract (1 round):**
     - Establish trust. Explain: "I'm going to ask you some unusual questions — not about what you do, but who you are underneath. There are no right answers, only honest ones. Ready?"
     - Collect: nickname, role, locale (→ \`identity.*\`)

   * **PHASE 1 — Territory: Values & Drive (2-3 rounds):**
     - "Tell me about a time you gave up something good — a job, a relationship, an opportunity — because something inside you said no. What was that something?"
     - "When was the last time you completely lost track of time? What were you doing, and what about it pulled you in?"
     - "If you had to mass-produce one thing for the world, what would it be?"
     - → Maps: \`soul.values.*\`, \`soul.drive.*\`

   * **PHASE 2 — Engine: Cognition Style (2-3 rounds):**
     - "When you encounter a problem you've never seen before, what's your very first move? Not what you think you should do — what you actually do."
     - "Think of the last time you learned something complex. How did you crack it open?"
     - "Do you prefer elegant simple answers or rich messy truths?"
     - → Maps: \`soul.cognition_style.*\`

   * **PHASE 3 — Shadow: Stress & Relationships (2-3 rounds):**
     - "When real pressure hits — not busy-stress, but existential pressure — what's your body's first reaction before your mind catches up?"
     - "Is there a pattern you keep repeating even though you know it hurts you? What is it?"
     - "How do you decide whether to trust someone? What's the test they don't know they're taking?"
     - "When someone important disagrees with you, what happens inside you in the first 3 seconds?"
     - → Maps: \`soul.stress.*\`, \`soul.relational.*\`

   * **PHASE 4 — Mirror: Identity Narrative (1-2 rounds):**
     - Synthesize everything into a portrait. Present it to the user: "Here's what I see..."
     - Ask: "What did I get right? What did I miss? And what part of this would you rather not be true?"
     - "If there's a version of yourself you're afraid of becoming, who is that person?"
     - → Maps: \`soul.identity_narrative.*\`

   * **TERMINATION:**
     - Write all mapped fields to \`~/.claude_profile.yaml\` using \`!metame set-trait\`.
     - All \`soul.*\` fields are **T2 LOCKED** — mark with \`# [LOCKED]\`.
     - Announce: "I see you now, [Nickname]. Let's build."
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
