# 🔮 MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

> **The Cognitive Profile Layer for Claude Code.**
>
> *Not a memory system — a cognitive mirror. It knows how you think, decide, and communicate, and it protects your core values.*

## 📖 Introduction

**Claude Code** is a powerful tool, but it suffers from "Project Amnesia." Every time you switch folders, it forgets who you are, your communication style, and your specific constraints.

**MetaMe** solves this by wrapping Claude in a  **Cognitive Profile Layer** . It creates a persistent "Global Brain" that travels with you across every project. Unlike ChatGPT/Claude/Gemini's built-in memory (which stores *facts* like "user lives in X"), MetaMe captures *how you think* — your decision style, cognitive load preferences, motivation patterns, and communication traits.

It is not a memory system; it is a  **Cognitive Mirror** .

## ✨ Key Features

* **🧠 Global Brain (`~/.claude_profile.yaml`):** A single source of truth for your identity, storing your nickname, stress status, and cognitive traits.
* **🧬 Evolution Mechanism:** You are in control. Use `!metame evolve` to manually teach Claude about your new preferences or constraints, ensuring it gets smarter with every interaction.
* **🤝 Dynamic Handshake Protocol:** The "Canary Test." MetaMe verifies its connection to your profile by addressing you by your chosen **Codename** in the very first sentence. If it doesn't, you know the link is broken.
* **🛡️ Auto-Lock Mechanism:** Mark any value in your profile with `# [LOCKED]`, and MetaMe will treat it as a constitution that cannot be overwritten.
* **🔌 Smart Injection:** Automatically injects your profile context into the `CLAUDE.md` of any project you enter, ensuring seamless context switching.
* **🧠 Passive Distillation:** MetaMe silently captures your messages via Claude Code hooks and, on next launch, uses a lightweight LLM (Haiku) to extract cognitive traits and preferences — automatically merging them into your profile with confidence-based upsert. Zero manual effort required.
* **📊 Schema-Enforced Profile:** A 41-field whitelist across 5 tiers (T1-T5) prevents profile bloat. Fields have type validation, enum constraints, and token budget limits (800 tokens max).
* **🎯 Confidence-Based Learning:** Strong directives ("always"/"以后一律") write directly. Normal observations accumulate in a pending queue and only promote to the profile after 3 consistent observations — preventing single-session bias.

## 🛠 Prerequisites

MetaMe is a wrapper around **Claude Code**. You must have Node.js and the official Claude Code tool installed first.

1. **Node.js**: Version 14 or higher.
2. **Claude Code**: Ensure `claude` is available in your PATH and you are logged in.

## 📦 Installation

Install MetaMe globally via NPM:

**Bash**

```
npm install -g metame-cli
```

*(Note: If you encounter permission errors on Mac/Linux, use `sudo npm install -g metame-cli`)*

## 🚀 Usage

Forget the `claude` command. From now on, simply type:

**Bash**

```
metame
```

Or, if you prefer mixed case (it's the same command):

**Bash**

```
MetaMe
```

### The First Run (Genesis)

When you run MetaMe for the first time, it will detect that your profile is empty. It will pause the AI and enter **Calibration Mode**:

1. It will ask you for a **Codename** (Nickname).
2. It will initiate a **Deep Cognitive Interview** to map your talents, mental models, and hidden anxieties.
3. **Be Honest**: It acts as a mirror. The more raw truth you provide, the better it can shadow you.
4. Once finished, it saves your "Source Code" and launches Claude.

### Daily Workflow

1. `cd` into any project folder.
2. Run `metame`.
3. Claude will start and immediately say: *"Ready, [Your Name]..."*
4. Start coding. MetaMe manages the context in the background.

### Global Initialization (Reset/Interview)

If you want to restart the **Genesis Interview** to update your psychological profile:

**Bash**

```
metame interview
```
(Command to be implemented in v1.3 - currently you can manually edit `~/.claude_profile.yaml` or use `set-trait`)

### Surgical Update (Manual Override)

If you need to update a specific trait without editing the file manually:

**Bash**

```
metame set-trait status.focus "Learning Rust"
```

### Passive Distillation (Automatic)

MetaMe automatically learns your cognitive patterns from conversations — no action needed.

**How it works:**

1. A global Claude Code hook captures every message, tagging each with a **confidence level** (high for strong directives like "always"/"以后一律", normal otherwise).
2. On your next `metame` launch, a background Haiku model analyzes the buffer and extracts cognitive traits and preferences.
3. **High-confidence** traits write directly to your profile. **Normal-confidence** traits enter a pending queue (`~/.metame/pending_traits.yaml`) and only promote after 3+ consistent observations.
4. All writes are validated against a **41-field schema whitelist** — unknown keys are silently dropped, enum fields are type-checked, and a **token budget** (800 max) prevents bloat.
5. The buffer is cleared, and Claude starts with a clean context.

**Anti-bias safeguards:**
- Single observations are treated as states, not traits
- Contradictions are tracked, not blindly overwritten
- Pending traits expire after 30 days without re-observation
- Context fields (focus, energy) auto-expire on staleness

You'll see this in the startup log:

```
🧠 MetaMe: Distilling 7 moments in background...
```

The hook is installed automatically on first run to `~/.claude/settings.json` (global scope — works across all projects).

### Hot Reload (Refresh)

If you update your profile or need to fix a broken context **without restarting your session**:

*   **Inside Claude**: Run `!metame refresh`
*   **External Terminal**: Run `metame refresh`

This re-injects your latest profile into `CLAUDE.md` instantly.

## ⚙️ Configuration & The "Global Brain"

Your profile is stored in a hidden YAML file in your home directory.

**Location:** `~/.claude_profile.yaml`

You can edit this file manually to update your status or lock your values.

**Example Profile (v2 Schema):**

**YAML**

```
# === T1: Identity (LOCKED) ===
identity:
  nickname: Neo              # [LOCKED]
  role: Senior Architect
  locale: en-US              # [LOCKED]

# === T2: Core Traits (LOCKED) ===
core_traits:
  crisis_reflex: Analysis    # [LOCKED]
  flow_trigger: Debugging    # [LOCKED]
  learning_style: Hands-on   # [LOCKED]

# === T3: Preferences (auto-learnable) ===
preferences:
  code_style: concise
  communication: direct
  explanation_depth: brief_rationale

# === T3b: Cognition (auto-learnable, slow to change) ===
cognition:
  decision_style: analytical
  info_processing:
    entry_point: big_picture
    preferred_format: structured
  cognitive_load:
    chunk_size: medium
    preferred_response_length: moderate

# === T4: Context (auto-overwrite) ===
context:
  focus: "Refactoring Legacy Code"
  energy: high

# === T5: Evolution (system-managed) ===
evolution:
  distill_count: 12
  last_distill: "2026-01-30T10:00:00Z"
```

* **T1-T2 fields** marked `# [LOCKED]` are never auto-modified.
* **T3 fields** are auto-learned with confidence thresholds.
* **T4 fields** are freely overwritten as your context changes.
* **T5 fields** are managed by the distillation system.

### Profile Migration (v1 → v2)

If you have an existing v1 profile, run the migration script:

```
node ~/.metame/migrate-v2.js --dry-run   # preview changes
node ~/.metame/migrate-v2.js             # apply migration (auto-backup created)
```

## 🗑️ Uninstallation

If you wish to remove MetaMe completely from your system, follow these steps:

### 1. Remove the Package

Uninstall the CLI tool:

**Bash**

```
npm uninstall -g metame-cli
```

### 2. Remove the Global Brain (Optional)

If you want to delete your stored profile data:

**Bash**

```
rm ~/.claude_profile.yaml
```

### 3. Remove Passive Distillation Data (Optional)

Remove the signal capture scripts:

**Bash**

```
rm -rf ~/.metame
```

### 4. Remove the Signal Capture Hook (Optional)

MetaMe installs a global hook in `~/.claude/settings.json`. To remove it, edit the file and delete the `UserPromptSubmit` entry under `hooks`, or run:

**Bash**

```
node -e "
const fs = require('fs');
const p = require('os').homedir() + '/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
if (s.hooks) { delete s.hooks.UserPromptSubmit; }
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('Hook removed.');
"
```

### 5. Cleanup Project Files (Optional)

MetaMe adds a header to `CLAUDE.md` files in your projects. To restore them to their original state (if you have many), you can use a text editor to remove the block starting with `## 🧠 SYSTEM KERNEL`.

## ⚡ Performance & Cost

You might worry: *"Does this eat up my context window?"*

**Short answer: No. It likely saves you money.**

*   **Context Cost**: The entire MetaMe kernel + your profile takes up **~800-1000 tokens**.
*   **Impact**: On a 200k context window, this is **0.5%** of the memory.
*   **ROI**: By pre-loading your context, you avoid the "instructional drift" and repetitive correction loops that usually waste thousands of tokens at the start of every session.
*   **Passive Distillation Cost**: The signal capture hook is a local Node.js script (zero API calls). The Haiku distillation on launch processes only a small buffer of filtered messages — typically a few hundred tokens at Haiku's very low cost.

## ❓ FAQ

**Q: Does this replace `CLAUDE.md`?**
A: No. It *prepends* its meta-cognitive protocol to your existing `CLAUDE.md`. Your project-specific notes remain intact.

**Q: What if Claude stops calling me by my nickname?**
A: This is the "Canary Test." It means the context window has been compressed or the file link is broken. Run `/compact` in Claude or restart `metame` to fix it.

**Q: Is my data sent to a third party?**
A: No. Your profile stays local at `~/.claude_profile.yaml`. MetaMe simply passes text to the official Claude Code tool.

## 📄 License

MIT License. Feel free to fork, modify, and evolve your own Meta-Cognition.
