# 🔮 MetaMe

<p align="center">
  <img src="./logo.png" alt="MetaMe Logo" width="200"/>
</p>

> **The Cognitive Profile Layer for Claude Code.**
>
> *Knows how you think. Works wherever you are.*

## 📖 Introduction

**Claude Code** is powerful, but it has two pain points:

1. **Project Amnesia** — Switch folders, and it forgets who you are. Your communication style, coding preferences, constraints — gone. Every project, you start from scratch.

2. **Desktop-Bound** — Leave your computer, work stops. You can't continue that debugging session on your phone. You can't vibe with Claude on the train, in bed, or waiting in line.

**MetaMe** solves both — and more:

**🧠 Cognitive Profile** — A persistent "Global Brain" (`~/.claude_profile.yaml`) that travels with you across every project. Unlike ChatGPT/Claude's built-in memory (which stores *facts* like "user lives in X"), MetaMe captures *how you think* — your decision style, cognitive load preferences, and communication traits. It's not a memory system; it's a **Cognitive Mirror**.

**📱 Mobile Bridge** — Full Claude Code from your phone via Telegram or Feishu. Same tools, same files, same conversation history. Start on your computer, continue anywhere. `/cd last` syncs you to exactly where you left off.

**🔔 Remote Wake** — Daemon runs in the background on your computer. Send a message from your phone, and it wakes up Claude Code to do real work — edit files, run commands, commit code — even while you're away from your desk.

**📂 File Transfer** — Send files from your computer to your phone (ask Claude to send any project file). Send files from your phone to your computer (just attach them in chat). Seamless both ways.

**⏰ Heartbeat Tasks** — Schedule Claude to run automatically. Daily summaries, automated workflows, multi-step skill chains — all running on your machine, pushing results to your phone.

## ✨ Key Features

* **🧠 Global Brain (`~/.claude_profile.yaml`):** A single, portable source of truth — your identity, cognitive traits, and preferences travel with you across every project.
* **🧬 Cognitive Evolution Engine:** MetaMe learns how you think through three channels: (1) **Passive** — silently captures your messages and distills cognitive traits via Haiku on next launch; (2) **Manual** — `!metame evolve` for explicit teaching; (3) **Confidence gates** — strong directives ("always"/"from now on") write immediately, normal observations need 3+ consistent sightings before promotion. Schema-enforced (41 fields, 5 tiers, 800 token budget) to prevent bloat.
* **🛡️ Auto-Lock:** Mark any value with `# [LOCKED]` — treated as a constitution, never auto-modified.
* **🪞 Metacognition Layer (v1.3):** MetaMe now observes *how* you think, not just *what* you say. Behavioral pattern detection runs inside the existing Haiku distill call (zero extra cost). It tracks decision patterns, cognitive load, comfort zones, and avoidance topics across sessions. When persistent patterns emerge, MetaMe injects a one-line mirror observation — e.g., *"You tend to avoid testing until forced"* — with a 14-day cooldown per pattern. Conditional reflection prompts appear only when triggered (every 7th distill or 3x consecutive comfort zone). All injection logic runs in Node.js; Claude receives only pre-decided directives, never rules to self-evaluate.
* **📱 Remote Claude Code (v1.3):** Full Claude Code from your phone via Telegram or Feishu (Lark). Stateful sessions with `--resume` — same conversation history, tool use, and file editing as your terminal. Interactive buttons for project/session picking, directory browser, and macOS launchd auto-start.
* **🔄 Workflow Engine (v1.3):** Define multi-step skill chains as heartbeat tasks. Each workflow runs in a single Claude Code session via `--resume`, so step outputs flow as context to the next step. Example: `deep-research` → `tech-writing` → `wechat-publisher` — fully automated content pipeline.

## 🛠 Prerequisites

MetaMe is a wrapper around **Claude Code**. You must have Node.js and the official Claude Code tool installed first.

1. **Node.js**: Version 14 or higher.
2. **Claude Code**: Ensure `claude` is available in your PATH and you are logged in.

## 📦 Installation

**Option A: NPM (recommended)** — full CLI with daemon, mobile bridge, interview

```bash
npm install -g metame-cli
```

**Option B: Claude Code Plugin** — lightweight, profile injection + slash commands

```bash
claude plugin install github:Yaron9/MetaMe/plugin
```

*(NPM note: If you encounter permission errors on Mac/Linux, use `sudo npm install -g metame-cli`)*

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

**Automatic (zero effort):** A global hook captures your messages. On next launch, Haiku distills cognitive traits in the background. Strong directives ("always"/"from now on") write immediately; normal observations need 3+ consistent sightings. All writes are schema-validated (41 fields, 800 token budget). You'll see:

```
🧠 MetaMe: Distilling 7 moments in background...
```

**Manual:** Update a specific trait directly:

```bash
metame set-trait status.focus "Learning Rust"
metame evolve "I prefer functional programming patterns"
```

**Episodic memory (keyframe, not full log):** MetaMe is not a memory system, but it captures two types of experiential "keyframes" that pure personality traits can't replace:

* **Anti-patterns** (`context.anti_patterns`, max 5): Cross-project failure lessons — e.g., *"Promise.all rejects all on single failure, use Promise.allSettled"*. Auto-expires after 60 days. Prevents the AI from repeating the same mistakes across sessions.
* **Milestones** (`context.milestones`, max 3): Recent completed landmarks — e.g., *"MetaMe v1.3 published"*. Provides continuity so Claude knows where you left off without you having to recap.

**Anti-bias safeguards:** single observations ≠ traits, contradictions are tracked not overwritten, pending traits expire after 30 days, context fields auto-clear on staleness.

**Metacognition controls:**

```bash
metame quiet            # Silence mirror observations & reflections for 48h
metame insights         # Show detected behavioral patterns
metame mirror on|off    # Toggle mirror injection
```

### Remote Claude Code — Telegram & Feishu (v1.3)

Full Claude Code from your phone — stateful sessions with conversation history, tool use, and file editing. Supports both Telegram and Feishu (Lark).

**Setup:**

```bash
metame daemon init                    # Create config + setup guide
```

Edit `~/.metame/daemon.yaml`:

```yaml
telegram:
  enabled: true
  bot_token: "YOUR_BOT_TOKEN"         # From @BotFather
  allowed_chat_ids:
    - 123456789                        # Your Telegram chat ID

feishu:
  enabled: true
  app_id: "YOUR_APP_ID"              # From Feishu Developer Console
  app_secret: "YOUR_APP_SECRET"
  allowed_chat_ids: []                # Empty = allow all
```

**Start the daemon:**

```bash
metame daemon start                   # Background process
metame daemon status                  # Check if running
metame daemon logs                    # Tail the log
metame daemon stop                    # Shutdown
metame daemon install-launchd         # macOS auto-start (RunAtLoad + KeepAlive)
```

**Session commands (interactive buttons on Telegram & Feishu):**

| Command | Description |
|---------|-------------|
| `/last` | **Quick resume** — prefers current directory's recent session, falls back to global recent |
| `/new` | Start new session — pick project directory from button list |
| `/new <name>` | Start new session with a name (e.g., `/new API Refactor`) |
| `/resume` | Resume a session — clickable list, shows session names + real-time timestamps |
| `/resume <name>` | Resume by name (supports partial match, cross-project) |
| `/name <name>` | Name the current session (syncs with computer's `/rename`) |
| `/cd` | Change working directory — with directory browser |
| `/cd last` | **Sync to computer** — jump to the most recent session's directory |
| `/session` | Current session info |
| `/stop` | Interrupt current Claude task (like pressing ESC in terminal) |
| `/undo` | Undo turns with file restoration (like pressing ESC×2 in terminal) |

Just type naturally for conversation — every message stays in the same Claude Code session with full context.

**Session naming:** Sessions can be named via `/new <name>`, `/name <name>` (mobile), or Claude Code's `/rename` (desktop). Names are stored in Claude's native session index and sync across all interfaces — name it on your phone, see it on your computer.

**How it works:**

Each chat gets a persistent session via `claude -p --resume <session-id>`. This is the same Claude Code engine as your terminal — same tools (file editing, bash, code search), same conversation history. You can start work on your computer and `/resume` from your phone, or vice versa.

**Parallel request handling:** The daemon uses async spawning, so multiple users or overlapping requests don't block each other. Each Claude call runs in a non-blocking subprocess.

**Streaming status (v1.3.7):** See Claude's work progress in real-time on your phone:

```
📖 Read: 「config.yaml」
✏️ Edit: 「daemon.js」
💻 Bash: 「git status」
```

**File transfer (v1.3.8):** Seamlessly move files between your phone and computer.

*Computer → Phone (download):* Ask Claude to send any project file:

```
You: Send me report.md
Claude: Here you go!
        [📎 report.md]  ← tap to download
```

Works for documents, audio, images, etc. Click button to download. Links valid for 30 minutes.

*Phone → Computer (upload):* Send files directly to your project:

```
[📎 You send a PDF, image, or any file]
Claude: 📥 Saved: document.pdf
        File is in your project's upload/ folder.
```

Uploaded files are saved to `<project>/upload/`. Claude won't read large files automatically — just tell it when you want it to process them.

- **Telegram:** Works out of the box
- **Feishu:** Requires `im:resource` + `im:message` permissions in app settings

**Other commands:**

| Command | Description |
|---------|-------------|
| `/status` | Daemon status + profile summary |
| `/tasks` | List scheduled heartbeat tasks |
| `/run <name>` | Run a task immediately |
| `/model [name]` | View/switch model (sonnet, opus, haiku) |
| `/budget` | Today's token usage |
| `/quiet` | Silence mirror/reflections for 48h |
| `/reload` | Manually reload daemon.yaml (also auto-reloads on file change) |

**Heartbeat Tasks:**

Define scheduled tasks in `daemon.yaml`:

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

* `precondition`: Shell command — empty output → task skipped, zero tokens.
* `type: "script"`: Run a local script directly instead of `claude -p`.
* `notify: true`: Push results to Telegram/Feishu.

**Workflow tasks** (multi-step skill chains):

```yaml
heartbeat:
  tasks:
    - name: "daily-wechat"
      type: "workflow"
      interval: "24h"
      model: "sonnet"
      notify: true
      steps:
        - skill: "deep-research"
          prompt: "Today's top 3 AI news stories"
        - skill: "tech-writing"
          prompt: "Write a WeChat article based on the research above"
        - skill: "wechat-publisher"
          prompt: "Publish the article"
          optional: true
```

Each step runs in the same Claude Code session. Step outputs automatically become context for the next step. Set `optional: true` on steps that may fail without aborting the workflow.

**Auto-reload:** The daemon watches `daemon.yaml` for changes. When Claude (or you) edits the config file, the daemon automatically reloads — no restart or `/reload` needed. A notification is pushed to confirm.

**Token efficiency:**

* Polling, slash commands, directory browsing: **zero tokens**
* Stateful sessions: same cost as using Claude Code in terminal (conversation history managed by Claude CLI)
* Budget tracking with daily limit (default 50k tokens)
* 10-second cooldown between Claude calls

**Security:**

* `allowed_chat_ids` whitelist — unauthorized users silently ignored
* No `--dangerously-skip-permissions` — standard `-p` mode permissions
* `~/.metame/` directory set to mode 700
* Bot tokens stored locally, never transmitted

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


**Q: Is my data sent to a third party?**
A: No. Your profile stays local at `~/.claude_profile.yaml`. MetaMe simply passes text to the official Claude Code tool.

## 📄 License

MIT License. Feel free to fork, modify, and evolve your own Meta-Cognition.
