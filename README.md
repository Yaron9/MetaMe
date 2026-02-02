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

* **🧠 Global Brain (`~/.claude_profile.yaml`):** A single, portable source of truth — your identity, cognitive traits, and preferences travel with you across every project.
* **🧬 Cognitive Evolution Engine:** MetaMe learns how you think through three channels: (1) **Passive** — silently captures your messages and distills cognitive traits via Haiku on next launch; (2) **Manual** — `!metame evolve` for explicit teaching; (3) **Confidence gates** — strong directives ("always"/"以后一律") write immediately, normal observations need 3+ consistent sightings before promotion. Schema-enforced (41 fields, 5 tiers, 800 token budget) to prevent bloat.
* **🤝 Dynamic Handshake:** The "Canary Test." Claude must address you by your **Codename** in the first sentence. If it doesn't, the link is broken.
* **🛡️ Auto-Lock:** Mark any value with `# [LOCKED]` — treated as a constitution, never auto-modified.
* **📱 Telegram Bot + Daemon (v1.3):** Talk to Claude from your phone. Send a message, get a profile-aware response. Background daemon with scheduled heartbeat tasks, precondition gates (zero tokens when idle), and macOS launchd auto-start.

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

### Cognitive Evolution

MetaMe learns who you are through two paths:

**Automatic (zero effort):** A global hook captures your messages. On next launch, Haiku distills cognitive traits in the background. Strong directives ("always"/"以后一律") write immediately; normal observations need 3+ consistent sightings. All writes are schema-validated (41 fields, 800 token budget). You'll see:

```
🧠 MetaMe: Distilling 7 moments in background...
```

**Manual:** Update a specific trait directly:

```bash
metame set-trait status.focus "Learning Rust"
metame evolve "I prefer functional programming patterns"
```

**Anti-bias safeguards:** single observations ≠ traits, contradictions are tracked not overwritten, pending traits expire after 30 days, context fields auto-clear on staleness.

### Telegram Bot & Daemon (v1.3)

Wake up Claude from your phone — no terminal, no IDE. Just text your Telegram bot.

**Setup:**

```bash
metame daemon init                    # Create config + Telegram setup guide
```

Edit `~/.metame/daemon.yaml`:

```yaml
telegram:
  enabled: true
  bot_token: "YOUR_BOT_TOKEN"         # From @BotFather
  allowed_chat_ids:
    - 123456789                        # Your Telegram chat ID
```

**Start the daemon:**

```bash
metame daemon start                   # Background process
metame daemon status                  # Check if running
metame daemon logs                    # Tail the log
metame daemon stop                    # Shutdown
```

**Auto-start on macOS:**

```bash
metame daemon install-launchd         # Creates launchd plist (RunAtLoad + KeepAlive)
launchctl load ~/Library/LaunchAgents/com.metame.daemon.plist
```

**Talking to your bot:**

Just type naturally — no commands needed. Your message goes to Claude with your profile context injected.

Slash commands are also available:

| Command | Description |
|---------|-------------|
| `/status` | Daemon status + profile summary |
| `/tasks` | List scheduled heartbeat tasks |
| `/run <name>` | Run a task immediately |
| `/budget` | Today's token usage |
| `/quiet` | Silence mirror/reflections for 48h |

**Heartbeat Tasks:**

Define scheduled tasks in `daemon.yaml`. They run automatically at the configured interval:

```yaml
heartbeat:
  tasks:
    - name: "morning-news"
      prompt: "Summarize today's top 3 AI news stories."
      interval: "24h"
      model: "haiku"
      notify: true
      precondition: "curl -s -o /dev/null -w '%{http_code}' https://news.ycombinator.com | grep 200"
```

* `precondition`: A shell command that must produce non-empty output. If empty → task is skipped, zero tokens burned.
* `type: "script"`: Run a local script directly instead of `claude -p`.
* `notify: true`: Push the result to your Telegram.

**Token efficiency:**

* Telegram polling and slash commands: **zero tokens**
* Profile injection uses lightweight mode (core fields only, no evolution history)
* Budget tracking with daily limit (default 50k tokens)
* 10-second cooldown between Claude calls to prevent rate limiting

**Security:**

* `allowed_chat_ids` whitelist — unauthorized users are silently ignored
* No arbitrary code execution — daemon only runs `claude -p` or predefined scripts
* `~/.metame/` directory set to mode 700
* Bot token stored locally, never transmitted

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

### 3. Stop the Daemon (if running)

```bash
metame daemon stop
launchctl unload ~/Library/LaunchAgents/com.metame.daemon.plist 2>/dev/null
rm -f ~/Library/LaunchAgents/com.metame.daemon.plist
```

### 4. Remove Passive Distillation Data (Optional)

Remove the signal capture scripts:

**Bash**

```
rm -rf ~/.metame
```

### 5. Remove the Signal Capture Hook (Optional)

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

### 6. Cleanup Project Files (Optional)

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
